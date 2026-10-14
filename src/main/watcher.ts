import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent } from '@core/events';
import { normalizeJournalLine, normalizeLine, normalizeMeta } from '@core/normalize';
import { apply } from '@core/reducer';
import { newSession, type SessionState } from '@core/state';
import { FileTail, type TailSnapshot } from './tail';

interface AgentFile {
  tail: FileTail;
  agentId: string;
  workflowRunId?: string;
  spawned: boolean;
  firstSeen: number;
}

/** Everything a worker learned from the initial read, enough for the main thread to carry on tailing. */
export interface BacklogSnapshot {
  state: SessionState;
  main: TailSnapshot;
  agents: { file: string; agentId: string; workflowRunId?: string; spawned: boolean; firstSeen: number; tail: TailSnapshot }[];
  journals: { runId: string; file: string; tail: TailSnapshot }[];
  titleMtime: number;
  /** the sorted backlog, only when requested (replay) */
  events?: AgentEvent[];
}

/** Loads a session's initial backlog off the main thread. */
export type BacklogLoader = (sessionId: string, mainFile: string, wantEvents: boolean) => Promise<BacklogSnapshot>;

const AGENT_RE = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;

/**
 * Follows one session: the main transcript, its subagent transcripts (including workflow
 * agents under subagents/workflows/<runId>/), their meta files and workflow journals.
 */
export class SessionWatcher {
  state: SessionState;
  private main: FileTail;
  private agents = new Map<string, AgentFile>();
  private journals = new Map<string, FileTail>();
  private titleMtime = 0;
  private busy = false;
  private lastDirScan = 0;
  /** events applied since the last drain, for listeners (notifications) */
  private recent: AgentEvent[] = [];
  /** true once the initial backlog has been read */
  primed = false;

  constructor(
    readonly sessionId: string,
    readonly mainFile: string,
    private loader?: BacklogLoader,
  ) {
    this.state = newSession(sessionId);
    this.main = new FileTail(mainFile);
  }

  get dir(): string {
    return path.join(path.dirname(this.mainFile), this.sessionId);
  }

  get mtimeMs(): number {
    let m = this.main.mtimeMs;
    for (const a of this.agents.values()) m = Math.max(m, a.tail.mtimeMs);
    return m;
  }

  /** during the initial load, events from all files are collected and applied in time order */
  private buffer: AgentEvent[] | null = null;
  /** receives the sorted initial backlog (used for replay) */
  backlogSink: ((events: AgentEvent[]) => void) | null = null;

  ingest(events: AgentEvent[]) {
    if (this.buffer) {
      for (const e of events) this.buffer.push(e);
      return;
    }
    for (const e of events) apply(this.state, e);
    if (this.primed) this.recent.push(...events);
  }

  /** Stable time sort; a spawn is moved before its agent's first line. */
  static sortEvents(events: AgentEvent[]): AgentEvent[] {
    const first = new Map<string, number>();
    for (const e of events) {
      const id = e.ref.agentId;
      if (id && e.ts && (!first.has(id) || e.ts < first.get(id)!)) first.set(id, e.ts);
    }
    for (const e of events) {
      if (e.k === 'agent.spawn') {
        const f = first.get(e.spawn.childId);
        if (f !== undefined && f < e.ts) e.ts = f - 1;
      }
    }
    return events
      .map((e, i) => [e, i] as const)
      .sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1])
      .map(([e]) => e);
  }

  drainRecent(): AgentEvent[] {
    const r = this.recent;
    this.recent = [];
    return r;
  }

  private reset() {
    this.state = newSession(this.sessionId);
    this.main.reset();
    this.agents.clear();
    this.journals.clear();
    this.titleMtime = 0;
  }

  /** Snapshot of the folded state and tail positions, for handing over to another thread. */
  snapshot(events?: AgentEvent[]): BacklogSnapshot {
    return {
      state: this.state,
      main: this.main.snapshot(),
      agents: [...this.agents.values()].map((a) => ({ file: a.tail.file, agentId: a.agentId, workflowRunId: a.workflowRunId, spawned: a.spawned, firstSeen: a.firstSeen, tail: a.tail.snapshot() })),
      journals: [...this.journals.entries()].map(([runId, t]) => ({ runId, file: t.file, tail: t.snapshot() })),
      titleMtime: this.titleMtime,
      events,
    };
  }

  private restore(s: BacklogSnapshot) {
    this.state = s.state;
    this.main.restore(s.main);
    this.agents.clear();
    for (const a of s.agents) {
      const tail = new FileTail(a.file);
      tail.restore(a.tail);
      this.agents.set(a.file, { tail, agentId: a.agentId, workflowRunId: a.workflowRunId, spawned: a.spawned, firstSeen: a.firstSeen });
    }
    this.journals.clear();
    for (const j of s.journals) {
      const tail = new FileTail(j.file);
      tail.restore(j.tail);
      this.journals.set(j.runId, tail);
    }
    this.titleMtime = s.titleMtime;
    // files created while the worker ran are picked up by the next directory scan
    this.lastDirScan = 0;
  }

  /** Initial load on a worker; events ingested meanwhile are queued and applied after the backlog. */
  private async loadOffThread(): Promise<boolean> {
    this.buffer = [];
    const snap = await this.loader!(this.sessionId, this.mainFile, !!this.backlogSink);
    const queued = this.buffer;
    this.buffer = null;
    this.restore(snap);
    if (snap.events) this.backlogSink?.(snap.events);
    this.primed = true;
    this.ingest(queued);
    return true;
  }

  /** Read anything new. Returns true if state changed. */
  async poll(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    if (!this.primed && this.loader) {
      try {
        return await this.loadOffThread();
      } catch (e) {
        console.error('worker load failed, loading in-process', this.sessionId, e);
        this.loader = undefined;
        this.buffer = null;
        this.reset();
      } finally {
        this.busy = false;
      }
      return this.poll();
    }
    if (!this.primed) this.buffer = [];
    try {
      const before = this.state.eventCount;
      let lines = await this.main.read();
      if (lines === 'truncated') {
        this.reset();
        lines = await this.main.read();
      }
      if (Array.isArray(lines)) this.applyLines(lines, null);

      const now = Date.now();
      if (now - this.lastDirScan > 1500 || !this.primed) {
        this.lastDirScan = now;
        await this.scanDir();
      }
      for (const a of this.agents.values()) await this.pollAgent(a);
      for (const j of this.journals.values()) {
        const jl = await j.read();
        if (Array.isArray(jl)) for (const l of jl) this.ingest(normalizeJournalLine(l, this.sessionId, j.mtimeMs || now));
      }
      if (this.buffer) {
        const all = SessionWatcher.sortEvents(this.buffer);
        this.buffer = null;
        this.backlogSink?.(all);
        this.ingest(all);
      }
      const changed = this.state.eventCount !== before;
      this.primed = true;
      return changed;
    } finally {
      this.buffer = null;
      this.busy = false;
    }
  }

  private applyLines(lines: string[], agentId: string | null) {
    let lastTs = this.state.lastActivity ?? 0;
    for (const line of lines) {
      const evs = normalizeLine(line, { sessionId: this.sessionId, agentId }, lastTs);
      if (evs.length) lastTs = evs[evs.length - 1].ts || lastTs;
      this.ingest(evs);
    }
  }

  private async pollAgent(a: AgentFile) {
    if (!a.spawned) {
      const metaFile = a.tail.file.replace(/\.jsonl$/, '.meta.json');
      let meta: Record<string, unknown> | null = null;
      try {
        meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
      } catch {
        // meta is usually written alongside the transcript; give it a moment before going without
        if (Date.now() - a.firstSeen < 3000 && this.primed) return;
      }
      let ts = Date.now();
      try {
        ts = (await fs.stat(metaFile)).birthtimeMs || ts;
      } catch {
        try {
          ts = (await fs.stat(a.tail.file)).birthtimeMs || ts;
        } catch {
          /* ignore */
        }
      }
      this.ingest([normalizeMeta(meta ?? {}, a.agentId, this.sessionId, ts, a.workflowRunId)]);
      a.spawned = true;
    }
    const lines = await a.tail.read();
    if (lines === 'truncated') {
      a.tail.reset();
      return;
    }
    if (Array.isArray(lines)) this.applyLines(lines, a.agentId);
  }

  private addAgentFile(file: string, agentId: string, workflowRunId?: string) {
    if (this.agents.has(file)) return;
    this.agents.set(file, { tail: new FileTail(file), agentId, workflowRunId, spawned: false, firstSeen: Date.now() });
  }

  private async scanDir() {
    const dir = this.dir;
    // session title written by the desktop app
    try {
      const tf = path.join(dir, 'custom-title.json');
      const st = await fs.stat(tf);
      if (st.mtimeMs !== this.titleMtime) {
        this.titleMtime = st.mtimeMs;
        const t = JSON.parse(await fs.readFile(tf, 'utf8'));
        if (typeof t?.customTitle === 'string') {
          this.ingest([{ ts: st.mtimeMs, src: 'transcript', ref: { sessionId: this.sessionId, agentId: null }, k: 'title', title: t.customTitle, kind: 'custom' }]);
        }
      }
    } catch {
      /* no title file */
    }
    const sub = path.join(dir, 'subagents');
    let entries: string[];
    try {
      entries = await fs.readdir(sub);
    } catch {
      return;
    }
    const files = entries.filter((f) => AGENT_RE.test(f)).sort();
    for (const f of files) this.addAgentFile(path.join(sub, f), AGENT_RE.exec(f)![1]);
    if (entries.includes('workflows')) {
      let runs: string[] = [];
      try {
        runs = await fs.readdir(path.join(sub, 'workflows'));
      } catch {
        /* ignore */
      }
      for (const runId of runs) {
        const rdir = path.join(sub, 'workflows', runId);
        let rfiles: string[] = [];
        try {
          rfiles = await fs.readdir(rdir);
        } catch {
          continue;
        }
        for (const f of rfiles.filter((x) => AGENT_RE.test(x)).sort()) this.addAgentFile(path.join(rdir, f), AGENT_RE.exec(f)![1], runId);
        if (rfiles.includes('journal.jsonl') && !this.journals.has(runId)) this.journals.set(runId, new FileTail(path.join(rdir, 'journal.jsonl')));
      }
    }
  }

  /** Every event in the session across all files, sorted by time (for replay). */
  async collectAllEvents(): Promise<AgentEvent[]> {
    const fresh = new SessionWatcher(this.sessionId, this.mainFile, this.loader);
    let all: AgentEvent[] = [];
    fresh.backlogSink = (evs) => (all = evs);
    await fresh.poll();
    return all;
  }
}

/** Same load as the worker performs, on the calling thread (tests, and the worker itself). */
export const loadBacklogInProcess: BacklogLoader = async (sessionId, mainFile, wantEvents) => {
  const w = new SessionWatcher(sessionId, mainFile);
  let events: AgentEvent[] | undefined;
  if (wantEvents) w.backlogSink = (evs) => (events = evs);
  await w.poll();
  return w.snapshot(events);
};
