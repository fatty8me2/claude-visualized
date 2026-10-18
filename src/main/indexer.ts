import fs from 'node:fs/promises';
import path from 'node:path';
import type { SessionSummary } from '@core/state';
import { cleanPrompt } from '@core/normalize';
import { DesktopSessionIndex } from './desktopSessions';
import { projectsDir } from './paths';

const HEAD = 96 * 1024;
const TAIL = 128 * 1024;
export const LIVE_MS = 10 * 60_000;
const MAX_SESSIONS = 300;

interface Cached {
  mtime: number;
  size: number;
  title: string | null;
  titleRank: number;
  cwd: string | null;
  entrypoint: string | null;
  /** newest timestamp on any transcript line seen; file mtimes lie (the desktop app appends untimestamped bookkeeping) */
  lastTs: number;
}

async function readRange(file: string, start: number, len: number): Promise<string> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/** "C--Users-me-Desktop-my-app" -> "my-app" when no cwd is known */
function projectName(cwd: string | null, dirName: string): string {
  if (cwd) {
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? cwd;
  }
  const parts = dirName.split('-').filter(Boolean);
  return parts[parts.length - 1] ?? dirName;
}

/** Scans ~/.claude/projects for session transcripts; caches per-file metadata by mtime/size. */
export class SessionIndexer {
  private cache = new Map<string, Cached>();
  readonly desktop = new DesktopSessionIndex();

  async scan(): Promise<SessionSummary[]> {
    const root = projectsDir();
    await this.desktop.scan();
    let projects: string[];
    try {
      projects = await fs.readdir(root);
    } catch {
      return [];
    }
    const found: { file: string; projectDir: string; id: string; mtime: number; size: number }[] = [];
    for (const p of projects) {
      const pdir = path.join(root, p);
      let files: string[];
      try {
        files = await fs.readdir(pdir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(pdir, f);
        try {
          const st = await fs.stat(file);
          found.push({ file, projectDir: p, id: f.slice(0, -6), mtime: st.mtimeMs, size: st.size });
        } catch {
          /* vanished */
        }
      }
    }
    found.sort((a, b) => b.mtime - a.mtime);
    const now = Date.now();
    const out: SessionSummary[] = [];
    for (const f of found.slice(0, MAX_SESSIONS)) {
      const meta = await this.meta(f.file, f.id, f.mtime, f.size);
      if (!meta) continue;
      const desk = this.desktop.byCliId.get(f.id);
      let activity = Math.max(meta.lastTs, desk?.lastActivityAt ?? 0);
      // background subagents keep a session busy while its main transcript is quiet
      if (now - f.mtime < LIVE_MS) activity = Math.max(activity, await newestSubagentWrite(path.join(path.dirname(f.file), f.id)));
      out.push({
        id: f.id,
        file: f.file,
        projectDir: f.projectDir,
        project: projectName(meta.cwd, f.projectDir),
        cwd: meta.cwd,
        title: desk?.title ?? meta.title,
        mtime: activity,
        size: f.size,
        live: now - activity < LIVE_MS,
        entrypoint: meta.entrypoint,
        desktopId: desk?.localId ?? null,
        archived: desk?.archived ?? false,
      });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  private async meta(file: string, id: string, mtime: number, size: number): Promise<Cached | null> {
    const c = this.cache.get(file);
    if (c && c.size === size && c.mtime === mtime) return c;
    const next: Cached = {
      mtime,
      size,
      title: c?.title ?? null,
      titleRank: c?.titleRank ?? 0,
      cwd: c?.cwd ?? null,
      entrypoint: c?.entrypoint ?? null,
      lastTs: c?.lastTs ?? 0,
    };
    try {
      const head = c ? '' : await readRange(file, 0, Math.min(size, HEAD));
      const tail = size > HEAD || c ? await readRange(file, Math.max(0, size - TAIL), Math.min(size, TAIL)) : '';
      let hasConversation = !!c;
      for (const line of (head + '\n' + tail).split('\n')) {
        if (!line.startsWith('{')) continue;
        let o: Record<string, any>;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o.type === 'user' || o.type === 'assistant') hasConversation = true;
        if (typeof o.timestamp === 'string') {
          const t = Date.parse(o.timestamp);
          if (t > next.lastTs) next.lastTs = t;
        }
        if (!next.cwd && typeof o.cwd === 'string') next.cwd = o.cwd;
        if (!next.entrypoint && typeof o.entrypoint === 'string') next.entrypoint = o.entrypoint;
        if (o.type === 'custom-title' && typeof o.customTitle === 'string') {
          next.title = o.customTitle;
          next.titleRank = 3;
        } else if (o.type === 'ai-title' && typeof o.aiTitle === 'string' && next.titleRank <= 2) {
          next.title = o.aiTitle;
          next.titleRank = 2;
        } else if (next.titleRank < 1 && o.type === 'user' && !o.isSidechain && !o.isMeta && typeof o.message?.content === 'string') {
          const t = cleanPrompt(o.message.content);
          if (t && !t.startsWith('<')) {
            next.title = t.replace(/\s+/g, ' ').slice(0, 80);
            next.titleRank = 1;
          }
        }
      }
      try {
        const t = JSON.parse(await fs.readFile(path.join(path.dirname(file), id, 'custom-title.json'), 'utf8'));
        if (typeof t?.customTitle === 'string') {
          next.title = t.customTitle;
          next.titleRank = 3;
        }
      } catch {
        /* none */
      }
      if (!hasConversation) return null;
    } catch {
      return null;
    }
    this.cache.set(file, next);
    return next;
  }
}

async function newestSubagentWrite(sessionDir: string): Promise<number> {
  let newest = 0;
  const visit = async (dir: string, depth: number) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 2) await visit(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) {
        try {
          newest = Math.max(newest, (await fs.stat(p)).mtimeMs);
        } catch {
          /* vanished */
        }
      }
    }
  };
  await visit(path.join(sessionDir, 'subagents'), 0);
  return newest;
}
