// Google Antigravity CLI (agy, Gemini) as a session source (see src/core/agy.ts). Strictly read-only: lists the conversation
// folders under ~/.gemini/antigravity-cli/brain (and ~/.gemini/antigravity/brain), tails each one's
// .system_generated/logs/transcript.jsonl, and reads nothing else there (never Google's login or settings files).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent } from '@core/events';
import { AGY, AgyConverter, agyPeek, agySessionId } from '@core/agy';
import { newSession, type SessionState, type SessionSummary } from '@core/state';
import { apply } from '@core/reducer';
import { projectName } from '@core/history';
import { FileTail } from './tail';
import { LIVE_MS } from './indexer';
import type { Foldable } from './kiln';

export interface AgyOptions {
  enabled: boolean;
}

/**
 * The Antigravity data folders that hold `brain/<conversationId>/`. agy reports ~/.gemini/antigravity/… but writes under
 * ~/.gemini/antigravity-cli/… (Kiln's lead/companion.ts reads whichever exists); both are listed.
 */
export function agyDataDirs(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string[] {
  const test = env.CLAUDE_VIS_AGY_DIR?.trim();
  if (test) return test.split(path.delimiter).filter(Boolean);
  // tests that point CLAUDE_VIS_HOME at a fixture must never read the real Antigravity data of the machine they run on
  if (env.CLAUDE_VIS_HOME?.trim()) return [];
  return [path.join(home, '.gemini', 'antigravity-cli'), path.join(home, '.gemini', 'antigravity')];
}

export const agyTranscriptPath = (dataDir: string, conversationId: string) =>
  path.join(dataDir, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');

const FILE_PREFIX = 'agy:';
const MAX_SESSIONS = 200;
const MAX_DIRS = 2000;
/** the head read for the sidebar title and model */
const HEAD_BYTES = 64 * 1024;
const UUIDISH = /^[\w-]{8,80}$/;

interface Head {
  size: number;
  title: string | null;
  model: string | null;
  cwd: string | null;
}

export class AgySource {
  private enabled = true;
  private heads = new Map<string, Head>();
  private busy = false;
  private cache: SessionSummary[] = [];
  /** the folder Kiln launched a conversation in (its lead_sessions row), by conversation id */
  cwdOf: (conversationId: string) => string | null = () => null;

  setConfig(o: AgyOptions) {
    this.enabled = o.enabled;
    if (!o.enabled) this.cache = [];
  }

  get active(): boolean {
    return this.enabled;
  }

  private async readHead(file: string, size: number): Promise<Head> {
    const fh = await fsp.open(file, 'r');
    try {
      const len = Math.min(size, HEAD_BYTES);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, 0);
      const text = buf.subarray(0, bytesRead).toString('utf8');
      // the last line may be cut off: drop it unless the whole file was read
      const lines = text.split('\n');
      if (bytesRead < size) lines.pop();
      const p = agyPeek(lines);
      return { size, title: p.title, model: p.model, cwd: p.cwd };
    } finally {
      await fh.close();
    }
  }

  /** Sidebar rows, newest first. A conversation without a transcript (an IDE-only one) is not listed. */
  async scan(): Promise<SessionSummary[]> {
    if (!this.enabled) return (this.cache = []);
    if (this.busy) return this.cache;
    this.busy = true;
    try {
      const found = new Map<string, { file: string; mtime: number; size: number }>();
      for (const dir of agyDataDirs()) {
        let ids: string[];
        try {
          ids = await fsp.readdir(path.join(dir, 'brain'));
        } catch {
          continue;
        }
        for (const id of ids.slice(0, MAX_DIRS)) {
          if (!UUIDISH.test(id)) continue;
          const file = agyTranscriptPath(dir, id);
          let st: fs.Stats;
          try {
            st = await fsp.stat(file);
          } catch {
            continue;
          }
          const prev = found.get(id);
          if (!prev || st.mtimeMs > prev.mtime) found.set(id, { file, mtime: st.mtimeMs, size: st.size });
        }
      }
      const newest = [...found.entries()].sort((a, b) => b[1].mtime - a[1].mtime).slice(0, MAX_SESSIONS);
      const now = Date.now();
      const rows: SessionSummary[] = [];
      for (const [id, f] of newest) {
        let head = this.heads.get(id);
        if (!head || (head.size !== f.size && (!head.title || !head.model) && head.size < HEAD_BYTES)) {
          try {
            head = await this.readHead(f.file, f.size);
            this.heads.set(id, head);
          } catch {
            continue;
          }
        }
        const cwd = this.cwdOf(id) ?? head.cwd;
        rows.push({
          id: agySessionId(id),
          file: FILE_PREFIX + f.file,
          projectDir: cwd ?? path.dirname(path.dirname(path.dirname(f.file))),
          project: projectName(cwd, cwd ? cwd : 'antigravity'),
          cwd,
          title: head.title,
          mtime: Math.round(f.mtime),
          size: f.size,
          live: now - f.mtime < LIVE_MS,
          entrypoint: AGY,
          source: AGY,
        });
      }
      if (this.heads.size > MAX_SESSIONS * 2) for (const k of [...this.heads.keys()].slice(0, MAX_SESSIONS)) this.heads.delete(k);
      this.cache = rows;
      return rows;
    } finally {
      this.busy = false;
    }
  }

  static isFile(file: string): boolean {
    return file.startsWith(FILE_PREFIX);
  }

  watcher(sessionId: string, file: string): AgyWatcher {
    return new AgyWatcher(sessionId, file, this);
  }
}

/** One agy conversation, tailed like a Claude Code transcript. */
export class AgyWatcher implements Foldable {
  state: SessionState;
  primed = false;
  backlogSink: ((events: AgentEvent[]) => void) | null = null;
  private tail: FileTail;
  private conv: AgyConverter;
  private recent: AgentEvent[] = [];
  private busy = false;
  readonly conversationId: string;

  constructor(
    readonly sessionId: string,
    readonly mainFile: string,
    private src: AgySource,
  ) {
    this.state = newSession(sessionId);
    const file = mainFile.slice(FILE_PREFIX.length);
    this.tail = new FileTail(file);
    this.conversationId = path.basename(path.dirname(path.dirname(path.dirname(file))));
    this.conv = new AgyConverter(sessionId, src.cwdOf(this.conversationId));
  }

  get mtimeMs(): number {
    return this.tail.mtimeMs;
  }

  drainRecent(): AgentEvent[] {
    const r = this.recent;
    this.recent = [];
    return r;
  }

  ingest(events: AgentEvent[]) {
    for (const e of events) apply(this.state, e);
    if (this.primed) this.recent.push(...events);
  }

  /** Read new steps. Returns true when the state changed. */
  async poll(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      let lines = await this.tail.read();
      if (lines === 'truncated') {
        // rewritten from the start: build again
        this.tail.reset();
        this.state = newSession(this.sessionId);
        this.conv = new AgyConverter(this.sessionId, this.src.cwdOf(this.conversationId));
        this.primed = false;
        lines = await this.tail.read();
      }
      const events: AgentEvent[] = [];
      this.conv.setCwd(this.src.cwdOf(this.conversationId), events);
      if (Array.isArray(lines)) events.push(...this.conv.pushLines(lines));
      events.push(...this.conv.flushStale(Date.now()));
      const before = this.state.eventCount;
      if (!this.primed) this.backlogSink?.(events);
      this.ingest(events);
      const was = this.primed;
      this.primed = true;
      return !was || this.state.eventCount !== before;
    } finally {
      this.busy = false;
    }
  }

  async collectAllEvents(): Promise<AgentEvent[]> {
    const w = new AgyWatcher(this.sessionId, this.mainFile, this.src);
    let all: AgentEvent[] = [];
    w.backlogSink = (evs) => (all = evs);
    await w.poll();
    return all;
  }
}
