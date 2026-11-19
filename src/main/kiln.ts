// Kiln as a session source (see src/core/kiln.ts). Read-only: tails Kiln's events file (and its one rotation), never writes
// there and never talks to Kiln or its model server. Runs a Claude session handed off are injected into that session's
// watcher as child agents; runs nobody claims are listed as sessions of their own.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AgentEvent } from '@core/events';
import { KILN, KilnLog, kilnRunEvents, kilnTitle, matchKilnRun, parseKilnLine, runEnded, sameDir, withKilnRuns, type KilnRun } from '@core/kiln';
import { MAIN, newSession, type SessionState, type SessionSummary } from '@core/state';
import { apply } from '@core/reducer';
import { projectName } from '@core/history';
import { FileTail } from './tail';
import { LIVE_MS } from './indexer';

export interface KilnOptions {
  enabled: boolean;
  /** the events file; '' = Kiln's default (~/.config/kiln/events.jsonl, or KILN_EVENTS_PATH / XDG_CONFIG_HOME) */
  file: string;
}

/** Where Kiln writes its events (kiln/events.py events_path). */
export function kilnEventsPath(override: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | null {
  const test = env.CLAUDE_VIS_KILN_EVENTS?.trim();
  if (test) return test;
  // tests that point CLAUDE_VIS_HOME at a fixture must never read the real Kiln data of the machine they run on
  if (env.CLAUDE_VIS_HOME?.trim()) return null;
  if (override.trim()) return override.trim();
  if (env.KILN_EVENTS_PATH?.trim()) return env.KILN_EVENTS_PATH.trim().replace(/^~(?=[\\/]|$)/, home);
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg || path.join(home, '.config'), 'kiln', 'events.jsonl');
}

/** Whether a process id is still running on this computer. EPERM means it exists but belongs to someone else. */
function alive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** a run with no news for this long is checked for a dead process */
const QUIET_MS = 20_000;
/** a run with no end after this long is treated as lost, whatever its pid says (pids get reused) */
const STALE_MS = 6 * 3_600_000;
const LIVENESS_MS = 5_000;
/** another computer's runs (an SSH mirror): their pids mean nothing here, so a run this quiet is treated as lost */
const REMOTE_QUIET_MS = 30 * 60_000;
const MAX_SESSIONS = 200;
/** a followed session that has not claimed a run in its folder this long after it started does not own it */
const UNCLAIMED_MS = 60_000;

interface Link {
  runId: string;
  sent: number;
  /** run.version-like stamp of what was sent */
  stamp: string;
}

/** Anything that folds events into a session state (SessionWatcher, OpenCodeWatcher, KilnWatcher). */
export interface Foldable {
  readonly sessionId: string;
  state: SessionState;
  primed: boolean;
  ingest(events: AgentEvent[]): void;
}

const stampOf = (r: KilnRun) => `${r.steps.length}|${r.finishedAt ?? ''}|${r.lost}|${r.task.length}|${r.lastAt}`;

export class KilnSource {
  log = new KilnLog();
  file: string | null = null;
  /** the file is a copy of another computer's (pids cannot be checked) */
  private remote = false;
  private tail: FileTail | null = null;
  private busy = false;
  private lastLiveness = 0;
  /** run id -> "<sessionId>:<toolUseId>" of the call that claimed it */
  private claimed = new Map<string, string>();
  /** per session state object (a watcher that rebuilds its state starts over) */
  private links = new WeakMap<SessionState, Map<string, Link>>();
  private summaryCache: SessionSummary[] = [];
  private summaryKey = '';

  setConfig(o: KilnOptions) {
    this.useFile(o.enabled ? kilnEventsPath(o.file) : null);
  }

  /** Follow this events file as it is (an SSH remote's mirrored copy: `remote`), or nothing. */
  useFile(file: string | null, remote = false) {
    this.file = file;
    this.remote = remote;
    this.tail = null;
    this.log = new KilnLog();
    this.claimed.clear();
    this.links = new WeakMap();
    this.summaryKey = '';
  }

  get enabled(): boolean {
    return !!this.file;
  }

  runs(): KilnRun[] {
    return this.log.list();
  }

  /** Read new lines. Returns true when any run changed. */
  async poll(): Promise<boolean> {
    if (!this.file || this.busy) return false;
    this.busy = true;
    const before = this.log.version;
    try {
      if (!this.tail) {
        this.tail = new FileTail(this.file);
        await this.readRotated();
      }
      let lines = await this.tail.read();
      if (lines === 'truncated') {
        // Kiln rotated the file (events.jsonl -> events.jsonl.1): the lines we had not read yet are now in .1
        this.tail.reset();
        await this.readRotated();
        lines = await this.tail.read();
      }
      if (Array.isArray(lines)) this.addLines(lines);
      if (Date.now() - this.lastLiveness > LIVENESS_MS) this.checkLiveness();
    } catch {
      /* unreadable right now: try again next time */
    } finally {
      this.busy = false;
    }
    return this.log.version !== before;
  }

  private async readRotated() {
    if (!this.file) return;
    try {
      const text = await fs.promises.readFile(this.file + '.1', 'utf8');
      this.addLines(text.split('\n'));
    } catch {
      /* no rotation yet */
    }
  }

  private addLines(lines: string[]) {
    for (const l of lines) {
      const e = parseKilnLine(l);
      if (e) this.log.add(e);
    }
  }

  private checkLiveness() {
    this.lastLiveness = Date.now();
    const now = Date.now();
    for (const r of this.log.runs.values()) {
      if (runEnded(r) || now - r.lastAt < QUIET_MS) continue;
      if (now - r.lastAt > (this.remote ? REMOTE_QUIET_MS : STALE_MS) || (!this.remote && !alive(r.pid))) {
        r.lost = true;
        this.log.version++;
      }
    }
  }

  /**
   * Attach the runs a Claude session's delegate_task calls started, as child agents of the calling agent, and keep them
   * up to date. Returns true when the session's state changed.
   */
  link(w: Foldable): boolean {
    if (!this.file || !w.primed) return false;
    const calls = w.state.internal.kilnCalls;
    if (!calls) return false;
    let links = this.links.get(w.state);
    if (!links) this.links.set(w.state, (links = new Map()));
    let changed = false;
    const runs = this.log.runs;
    for (const [toolUseId, c] of Object.entries(calls)) {
      const key = `${w.sessionId}:${toolUseId}`;
      let l = links.get(toolUseId);
      if (!l) {
        const r = matchKilnRun({ toolUseId, agentId: c.agentId, ts: c.ts, task: c.task, cwd: c.cwd, endTs: c.endTs }, runs.values(), (id) => {
          const by = this.claimed.get(id);
          return !!by && by !== key;
        });
        if (!r) continue;
        this.claimed.set(r.id, key);
        links.set(toolUseId, (l = { runId: r.id, sent: 0, stamp: '' }));
      }
      const r = runs.get(l.runId);
      if (!r) continue;
      const stamp = stampOf(r);
      if (stamp === l.stamp) continue;
      l.stamp = stamp;
      const evs = kilnRunEvents(r, w.sessionId, toolUseId);
      if (evs.length > l.sent) {
        w.ingest(evs.slice(l.sent));
        l.sent = evs.length;
        changed = true;
      } else if (r.task && evs.length < l.sent) {
        // the run lost steps to the cap: nothing sensible to re-send
        l.sent = evs.length;
      }
    }
    return changed;
  }

  /** For replay: a Claude session's events plus the runs it handed off. */
  withRuns(events: AgentEvent[], sessionId: string): AgentEvent[] {
    return this.file ? withKilnRuns(events, this.runs(), sessionId) : events;
  }

  /** The session (if any) that claimed a run. */
  claimedBy(runId: string): string | null {
    const k = this.claimed.get(runId);
    return k ? k.slice(0, k.indexOf(':')) : null;
  }

  /**
   * Runs no Claude session claims, as sidebar rows. A run is left out when a Claude session in the same folder was active
   * since it started and is not followed yet: opening that session shows it (its watcher claims it then). A session that is
   * followed had its chance: a run it has not claimed a minute after starting gets its own row rather than vanishing.
   */
  scan(claude: readonly SessionSummary[], followed: (sessionId: string) => boolean = () => false): SessionSummary[] {
    if (!this.file) {
      this.summaryCache = [];
      return this.summaryCache;
    }
    const now = Date.now();
    const runs = this.runs().filter((r) => r.task && !this.claimed.has(r.id));
    const accounted = (r: KilnRun) =>
      claude.some((s) => s.cwd && sameDir(s.cwd, r.cwd) && s.mtime >= r.startedAt - 60_000 && !(followed(s.id) && now - r.startedAt > UNCLAIMED_MS));
    const orphans = runs.filter((r) => !accounted(r)).slice(0, MAX_SESSIONS);
    const key = this.log.version + ':' + orphans.map((r) => r.id).join(',') + ':' + orphans.filter((r) => now - r.lastAt < LIVE_MS).length;
    if (key === this.summaryKey) return this.summaryCache;
    this.summaryKey = key;
    this.summaryCache = orphans.map((r) => ({
      id: kilnSessionId(r.id),
      file: `kiln:${r.id}`,
      projectDir: r.cwd,
      project: projectName(r.cwd || null, r.cwd || 'kiln'),
      cwd: r.cwd || null,
      title: kilnTitle(r.task),
      mtime: r.lastAt,
      size: 0,
      live: !runEnded(r) && now - r.lastAt < LIVE_MS,
      entrypoint: KILN,
      source: KILN,
    }));
    return this.summaryCache;
  }

  watcher(sessionId: string): KilnWatcher {
    return new KilnWatcher(sessionId, this);
  }
}

export const kilnSessionId = (runId: string) => `kiln-${runId}`;
const runIdOf = (sessionId: string) => sessionId.replace(/^kiln-/, '');

/** One unclaimed Kiln run shown as a session: the run is the main agent. */
export class KilnWatcher implements Foldable {
  state: SessionState;
  primed = false;
  readonly mainFile: string;
  backlogSink: ((events: AgentEvent[]) => void) | null = null;
  private sent = 0;
  private stamp = '';
  private recent: AgentEvent[] = [];

  constructor(
    readonly sessionId: string,
    private src: KilnSource,
  ) {
    this.state = newSession(sessionId);
    this.mainFile = `kiln:${runIdOf(sessionId)}`;
  }

  get mtimeMs(): number {
    return this.state.lastActivity ?? 0;
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

  async poll(): Promise<boolean> {
    const r = this.src.log.runs.get(runIdOf(this.sessionId));
    if (!r) {
      const was = this.primed;
      this.primed = true;
      return !was;
    }
    const stamp = stampOf(r);
    if (this.primed && stamp === this.stamp) return false;
    this.stamp = stamp;
    const evs = kilnRunEvents(r, this.sessionId, null);
    const fresh = evs.slice(this.sent);
    this.sent = evs.length;
    if (!this.primed) this.backlogSink?.(evs);
    this.ingest(fresh);
    if (runEnded(r)) this.state.agents[MAIN].status = 'idle';
    this.primed = true;
    return fresh.length > 0;
  }

  async collectAllEvents(): Promise<AgentEvent[]> {
    const r = this.src.log.runs.get(runIdOf(this.sessionId));
    return r ? kilnRunEvents(r, this.sessionId, null) : [];
  }
}
