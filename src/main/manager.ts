import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { normalizeHook } from '@core/normalize';
import { MAIN, toView, type AgentStatus, type SessionSummary, type SessionView } from '@core/state';
import { SessionIndexer, LIVE_MS } from './indexer';
import { SessionWatcher } from './watcher';
import { claudeDeepLink } from './desktopSessions';

const POLL_MS = 600;
const SCAN_MS = 2500;
const PUSH_MS = 200;
const MAX_LIVE_WATCHERS = 12;
const OVERVIEW_MS = 500;
/** log lines kept per session in overview snapshots */
const OVERVIEW_LOG = 40;

export interface NotifyRequest {
  title: string;
  body: string;
  sessionId: string;
}

/**
 * Owns the session index and one SessionWatcher per followed session (the selected one plus
 * recently live ones, so the tray can show what's running everywhere).
 *
 * Events: 'sessions' (SessionSummary[]), 'state' (SessionView | null), 'notify' (NotifyRequest),
 * 'overview' (SessionView[] of every live session, only while an overview is open)
 */
export class SessionManager extends EventEmitter {
  private indexer = new SessionIndexer();
  private watchers = new Map<string, SessionWatcher>();
  private summaries: SessionSummary[] = [];
  private selectedId: string | null = null;
  private dirty = false;
  private overviewDirty = false;
  /** number of windows currently showing the all-sessions overview */
  overviewViewers = 0;
  private timers: NodeJS.Timeout[] = [];
  private lastHookBySession = new Map<string, number>();
  followActive = true;
  notifyAttention = true;
  notifyAgentDone = false;

  start() {
    void this.scan();
    this.timers.push(setInterval(() => void this.scan(), SCAN_MS));
    this.timers.push(setInterval(() => void this.pollAll(), POLL_MS));
    this.timers.push(
      setInterval(() => {
        if (this.dirty) {
          this.dirty = false;
          this.emit('state', this.currentView());
        }
      }, PUSH_MS),
    );
    this.timers.push(
      setInterval(() => {
        if (this.overviewDirty && this.overviewViewers > 0) {
          this.overviewDirty = false;
          this.emit('overview', this.overview());
        }
      }, OVERVIEW_MS),
    );
  }

  /** Snapshots of every live session (log trimmed), most recently active first. */
  overview(): SessionView[] {
    const out: SessionView[] = [];
    for (const s of this.summaries) {
      if (!s.live) continue;
      const w = this.watchers.get(s.id);
      if (!w || !w.primed) continue;
      const v = toView(w.state);
      v.log = [...v.log].sort((a, b) => a.ts - b.ts || a.seq - b.seq).slice(-OVERVIEW_LOG);
      out.push(v);
    }
    return out;
  }

  markOverviewDirty() {
    this.overviewDirty = true;
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  get selected(): string | null {
    return this.selectedId;
  }

  /** claude:// link that opens this session in the desktop app */
  deepLink(id: string): string {
    return claudeDeepLink(id, this.indexer.desktop.byCliId.get(id));
  }

  getSummaries(): SessionSummary[] {
    return this.summaries;
  }

  currentView(): SessionView | null {
    if (!this.selectedId) return null;
    const w = this.watchers.get(this.selectedId);
    return w && w.primed ? toView(w.state) : null;
  }

  select(id: string | null, manual = true) {
    if (manual) this.followActive = false;
    this.selectedId = id;
    if (id) {
      const w = this.ensureWatcher(id);
      if (w) void w.poll().then(() => this.markDirty());
    }
    this.markDirty();
    this.emit('selected', id);
  }

  setFollow(on: boolean) {
    this.followActive = on;
    if (on) this.autoSelect();
  }

  private markDirty() {
    this.dirty = true;
  }

  private ensureWatcher(id: string, file?: string): SessionWatcher | null {
    let w = this.watchers.get(id);
    if (w) return w;
    const f = file ?? this.summaries.find((s) => s.id === id)?.file;
    if (!f) return null;
    w = new SessionWatcher(id, f);
    this.watchers.set(id, w);
    return w;
  }

  private async scan() {
    try {
      this.summaries = await this.indexer.scan();
    } catch (e) {
      console.error('scan failed', e);
      return;
    }
    // follow recently live sessions; drop watchers that are neither live nor selected
    const live = this.summaries.filter((s) => s.live).slice(0, MAX_LIVE_WATCHERS);
    for (const s of live) this.ensureWatcher(s.id, s.file);
    const keep = new Set([...live.map((s) => s.id), this.selectedId, ...this.recentHookSessions()]);
    for (const id of [...this.watchers.keys()]) if (!keep.has(id)) this.watchers.delete(id);
    if (this.followActive) this.autoSelect();
    this.emitSessions();
    this.overviewDirty = true;
  }

  private recentHookSessions(): string[] {
    const now = Date.now();
    return [...this.lastHookBySession.entries()].filter(([, t]) => now - t < LIVE_MS).map(([id]) => id);
  }

  private emitSessions() {
    for (const s of this.summaries) {
      const w = this.watchers.get(s.id);
      if (w && w.primed) {
        const agents = Object.values(w.state.agents);
        s.running = agents.filter((a) => a.id !== MAIN && a.status === 'running').length;
        s.mode = w.state.mode;
        s.waiting = w.state.agents[MAIN]?.status === 'waiting';
        if (w.state.title && w.state.titleKind !== 'prompt') s.title = w.state.title;
        // transcript timestamps only: file mtimes move when the desktop app rewrites old transcripts
        const act = w.state.lastActivity ?? 0;
        if (act > s.mtime) s.mtime = act;
        const main = w.state.agents[MAIN];
        // a long tool call writes nothing until it returns, but the session is still working
        const busy = !!main?.currentTool || main?.status === 'waiting' || agents.some((a) => a.status === 'running' && a.currentTool && Date.now() - a.lastActivity < 30 * 60_000);
        s.live = !w.state.ended && (Date.now() - s.mtime < LIVE_MS || (busy && Date.now() - s.mtime < 60 * 60_000));
      }
    }
    this.emit('sessions', this.summaries);
  }

  private autoSelect() {
    const best = this.summaries.filter((s) => s.live).sort((a, b) => b.mtime - a.mtime)[0];
    if (!best) {
      if (!this.selectedId && this.summaries[0]) this.select(this.summaries[0].id, false);
      return;
    }
    if (best.id === this.selectedId) return;
    const cur = this.summaries.find((s) => s.id === this.selectedId);
    // avoid flapping between two busy sessions
    if (cur && cur.live && best.mtime - cur.mtime < 5000) return;
    this.select(best.id, false);
  }

  private async pollAll() {
    let sessionsChanged = false;
    for (const w of [...this.watchers.values()]) {
      const wasPrimed = w.primed;
      let changed = false;
      try {
        changed = await w.poll();
      } catch (e) {
        console.error('poll failed', w.sessionId, e);
        continue;
      }
      this.notifyTransitions(w, wasPrimed);
      const q = w.state.quota;
      if (q && q.ts > (this.quotaSeen.get(w.sessionId) ?? 0)) {
        this.quotaSeen.set(w.sessionId, q.ts);
        this.emit('quota', q);
      }
      if (!changed && wasPrimed) continue;
      sessionsChanged = true;
      if (w.sessionId === this.selectedId) this.markDirty();
      this.overviewDirty = true;
    }
    if (sessionsChanged) this.emitSessions();
  }

  /** last seen agent statuses per session, to detect transitions from any source */
  private prevStatus = new Map<string, Map<string, AgentStatus>>();
  private quotaSeen = new Map<string, number>();

  private notifyTransitions(w: SessionWatcher, wasPrimed: boolean) {
    const before = this.prevStatus.get(w.sessionId);
    const now = new Map<string, AgentStatus>();
    for (const a of Object.values(w.state.agents)) now.set(a.id, a.status);
    this.prevStatus.set(w.sessionId, now);
    const recent = w.drainRecent();
    if (!wasPrimed || !before) return;
    const title = w.state.title ?? 'Claude session';
    for (const e of recent) {
      if (e.k === 'attention' && e.kind !== 'error' && this.notifyAttention && Date.now() - e.ts < 60_000) {
        this.emit('notify', { title: `Needs you · ${title}`, body: e.detail, sessionId: w.sessionId } satisfies NotifyRequest);
      }
    }
    if (!this.notifyAgentDone) return;
    for (const a of Object.values(w.state.agents)) {
      if (a.id === MAIN) continue;
      const was = before.get(a.id);
      if (was === 'running' && (a.status === 'done' || a.status === 'error')) {
        this.emit('notify', {
          title: `${a.agentType} ${a.status === 'done' ? 'finished' : 'failed'}`,
          body: a.description || title,
          sessionId: w.sessionId,
        } satisfies NotifyRequest);
      }
    }
  }

  /** Called by the hook server for every POSTed hook payload. */
  ingestHook(payload: Record<string, unknown>) {
    const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
    if (!sessionId) return;
    this.lastHookBySession.set(sessionId, Date.now());
    let w = this.watchers.get(sessionId);
    if (!w) {
      const tp = typeof payload.transcript_path === 'string' ? payload.transcript_path : null;
      if (tp && path.basename(tp, '.jsonl') === sessionId && fs.existsSync(tp)) w = this.ensureWatcher(sessionId, tp) ?? undefined;
      if (!w) return;
    }
    // hooks for an unprimed watcher would be applied before the backlog; the transcript will carry them
    if (!w.primed) return;
    w.ingest(normalizeHook(payload, Date.now()));
    if (sessionId === this.selectedId) this.markDirty();
    this.overviewDirty = true;
    if (this.followActive && sessionId !== this.selectedId) {
      void this.scan();
    }
  }

  /** Full sorted event list for replay of any session. */
  async replayEvents(id: string) {
    const f = this.summaries.find((s) => s.id === id)?.file ?? this.watchers.get(id)?.mainFile;
    if (!f) return [];
    return new SessionWatcher(id, f).collectAllEvents();
  }
}
