// Incremental indexer: walks ~/.claude/projects, reads only the bytes appended since last time, and feeds them to HistoryDb.
// Read-only toward Claude data. Runs inside a worker thread (historyWorker.ts) but has no thread-specific code, so tests call it directly.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractDelta } from '@core/history';
import type { HistoryDb, FileRow } from './historyDb';

const SIG_BYTES = 128;
const AGENT_FILE = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;

export interface SessionFiles {
  id: string;
  projectDir: string;
  main: string;
  /** subagent transcripts (including workflow agents) */
  subs: { file: string; agentId: string }[];
}

export interface IndexProgress {
  phase: 'scan' | 'sessions' | 'rollup';
  done: number;
  total: number;
}

export interface IndexResult {
  scanned: number;
  indexed: number;
  reset: number;
  pruned: number;
  bytesRead: number;
  ms: number;
}

async function readAt(fh: fs.FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

const sha = (b: Buffer) => crypto.createHash('sha1').update(b).digest('hex').slice(0, 16);

async function listSubs(sessionDir: string): Promise<{ file: string; agentId: string }[]> {
  const out: { file: string; agentId: string }[] = [];
  const visit = async (dir: string, depth: number) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 3) await visit(p, depth + 1);
        continue;
      }
      const m = AGENT_FILE.exec(e.name);
      if (m) out.push({ file: p, agentId: m[1] });
    }
  };
  await visit(path.join(sessionDir, 'subagents'), 0);
  return out;
}

/** Every session under the projects dir with its subagent files, newest transcript first. */
export async function discoverSessions(projectsDir: string): Promise<SessionFiles[]> {
  let projects: string[];
  try {
    projects = await fs.readdir(projectsDir);
  } catch {
    return [];
  }
  const found: { s: SessionFiles; mtime: number }[] = [];
  for (const p of projects) {
    const pdir = path.join(projectsDir, p);
    let files: string[];
    try {
      files = await fs.readdir(pdir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      const main = path.join(pdir, f);
      let mtime = 0;
      try {
        const st = await fs.stat(main);
        if (!st.isFile()) continue;
        mtime = st.mtimeMs;
      } catch {
        continue;
      }
      found.push({ s: { id, projectDir: p, main, subs: await listSubs(path.join(pdir, id)) }, mtime });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.map((x) => x.s);
}

interface Probe {
  file: string;
  agentId: string | null;
  size: number;
  mtime: number;
  row: FileRow | undefined;
  /** the file is the same one we saw, only longer */
  grew: boolean;
  /** truncated or rewritten: everything known about the session must be re-read */
  rewritten: boolean;
  unchanged: boolean;
}

async function probe(file: string, agentId: string | null, row: FileRow | undefined): Promise<Probe | null> {
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return null;
  }
  const p: Probe = { file, agentId, size: st.size, mtime: st.mtimeMs, row, grew: false, rewritten: false, unchanged: false };
  if (!row) return p;
  if (st.size === row.size && st.mtimeMs === row.mtime) {
    p.unchanged = true;
    return p;
  }
  if (st.size < row.offset) {
    p.rewritten = true;
    return p;
  }
  // same length (or longer) but different bytes in what we already read: the file was rewritten in place
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(file, 'r');
    const head = await readAt(fh, 0, Math.min(SIG_BYTES, row.offset));
    const tailStart = Math.max(0, row.offset - SIG_BYTES);
    const tail = await readAt(fh, tailStart, row.offset - tailStart);
    if (sha(head) !== row.headSig || sha(tail) !== row.tailSig) p.rewritten = true;
    else if (st.size === row.size) p.unchanged = true;
    else p.grew = true;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
  return p;
}

async function readMeta(agentFile: string): Promise<{ agentType?: string; description?: string; phase?: string } | null> {
  try {
    const m = JSON.parse(await fs.readFile(agentFile.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    return {
      agentType: typeof m?.agentType === 'string' ? m.agentType : undefined,
      description: typeof m?.description === 'string' ? m.description : undefined,
      phase: typeof m?.workflowPhase === 'string' ? m.workflowPhase : undefined,
    };
  } catch {
    return null;
  }
}

/** Read the new complete lines of a file, from the saved offset. */
async function readNew(p: Probe, from: number): Promise<{ lines: string[]; offset: number; headSig: string; tailSig: string; bytes: number }> {
  const fh = await fs.open(p.file, 'r');
  try {
    const len = Math.max(0, p.size - from);
    const buf = await readAt(fh, from, len);
    const nl = buf.lastIndexOf(0x0a);
    const complete = nl === -1 ? Buffer.alloc(0) : buf.subarray(0, nl + 1);
    const offset = from + complete.length;
    const headLen = Math.min(SIG_BYTES, offset);
    const head = await readAt(fh, 0, headLen);
    const tailStart = Math.max(0, offset - SIG_BYTES);
    const tail = await readAt(fh, tailStart, offset - tailStart);
    return { lines: complete.toString('utf8').split('\n'), offset, headSig: sha(head), tailSig: sha(tail), bytes: buf.length };
  } finally {
    await fh.close();
  }
}

const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

export interface IndexOptions {
  projectsDir: string;
  onProgress?: (p: IndexProgress) => void;
  /** return true to stop early (a rebuild was asked for) */
  cancelled?: () => boolean;
  now?: () => number;
}

/** One indexing pass. Safe to run repeatedly: unchanged files cost one stat each. */
export async function runIndex(db: HistoryDb, opts: IndexOptions): Promise<IndexResult> {
  const t0 = Date.now();
  const res: IndexResult = { scanned: 0, indexed: 0, reset: 0, pruned: 0, bytesRead: 0, ms: 0 };
  opts.onProgress?.({ phase: 'scan', done: 0, total: 0 });
  const sessions = await discoverSessions(opts.projectsDir);
  res.scanned = sessions.length;
  const known = db.allFiles();

  // decide which sessions have work: any of their files new, grown or rewritten
  const work: { s: SessionFiles; probes: Probe[]; reset: boolean }[] = [];
  let i = 0;
  for (const s of sessions) {
    const probes: Probe[] = [];
    const files: { file: string; agentId: string | null }[] = [{ file: s.main, agentId: null }, ...s.subs.map((x) => ({ file: x.file, agentId: x.agentId }))];
    for (const f of files) {
      const p = await probe(f.file, f.agentId, known.get(f.file));
      if (p) probes.push(p);
    }
    if (probes.some((p) => !p.unchanged)) work.push({ s, probes, reset: probes.some((p) => p.rewritten) });
    if (++i % 50 === 0) {
      opts.onProgress?.({ phase: 'scan', done: i, total: sessions.length });
      await yieldLoop();
    }
  }
  const recover = db.getMeta('rollup') === 'dirty' ? db.markAllDirty() : [];
  if (work.length) db.setMeta('rollup', 'dirty');
  const pruned = db.pruneSessions(new Set(sessions.map((s) => s.id)));
  res.pruned = pruned;

  const touched: string[] = [...recover];
  let done = 0;
  opts.onProgress?.({ phase: 'sessions', done: 0, total: work.length });
  for (const w of work) {
    if (opts.cancelled?.()) break;
    try {
      const bytes = await indexSession(db, w.s, w.probes, w.reset, opts.now?.() ?? Date.now());
      res.bytesRead += bytes;
      res.indexed++;
      if (w.reset) res.reset++;
      touched.push(w.s.id);
    } catch (e) {
      // one unreadable session must not stop the rest; it is retried next pass because its file rows were not written
      console.error('history: indexing failed for', w.s.id, e);
    }
    opts.onProgress?.({ phase: 'sessions', done: ++done, total: work.length });
    await yieldLoop();
    // roll up in chunks so partial results show up while a first full index is still running
    if (touched.length >= 40) {
      db.finishBatch(touched.splice(0), opts.now?.() ?? Date.now());
    }
  }
  opts.onProgress?.({ phase: 'rollup', done, total: work.length });
  db.finishBatch(touched, opts.now?.() ?? Date.now());
  db.setMeta('rollup', 'clean');
  if (work.length) db.checkpoint();
  res.ms = Date.now() - t0;
  return res;
}

async function indexSession(db: HistoryDb, s: SessionFiles, probes: Probe[], reset: boolean, now: number): Promise<number> {
  let bytes = 0;
  const ref = { id: s.id, projectDir: s.projectDir };
  if (reset) db.transaction(() => db.dropSession(s.id));
  // the main transcript first so the session row (cwd, title) exists before the subagents are merged in
  const ordered = [...probes].sort((a, b) => (a.agentId === null ? -1 : 0) - (b.agentId === null ? -1 : 0));
  for (const p of ordered) {
    if (p.unchanged && !reset) continue;
    const from = reset || !p.row ? 0 : p.row.offset;
    const r = await readNew(p, from);
    bytes += r.bytes;
    const delta = extractDelta(s.id, p.agentId, r.lines);
    const meta = p.agentId ? await readMeta(p.file) : null;
    db.transaction(() => {
      db.applyDelta(ref, delta, meta, p.agentId, now);
      db.putFile({ path: p.file, sessionId: s.id, size: p.size, mtime: p.mtime, offset: r.offset, headSig: r.headSig, tailSig: r.tailSig });
    });
  }
  return bytes;
}
