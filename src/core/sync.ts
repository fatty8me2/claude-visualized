// Incremental transport for SessionView. The main process used to push the WHOLE view (up to 1500 log
// entries and every agent, ~1.5 MB for 300 agents) every 200 ms. Now the first push (and any push after a
// resync) is a full view, and later ones carry only what changed:
//   - agents: per-field patches for agents whose JSON changed (new agents are sent whole)
//   - log: entries newer than the last one sent
//   - meta: every other top-level field, only when it changed
// The decoder rebuilds an ordinary SessionView and keeps object identity for everything that did not change,
// so React.memo on agents / log works. Pure: no Electron, no DOM.

import type { AgentNode, LogEntry, SessionView } from './state';
import { LOG_CAP } from './state';

type ViewMeta = Omit<SessionView, 'agents' | 'log'>;

export type ViewMsg =
  | { t: 'none' }
  | { t: 'full'; seq: number; view: SessionView }
  | {
      t: 'delta';
      seq: number;
      /** seq of the message this one applies on top of */
      base: number;
      id: string;
      meta?: ViewMeta;
      /** changed agents: a partial for known ones, the whole node for new ones */
      agents?: Record<string, Partial<AgentNode>>;
      removed?: string[];
      /** log entries newer than anything sent before */
      log?: LogEntry[];
    };

/** One entry per session in the all-sessions overview. */
export interface OverviewMsg {
  items: ViewMsg[];
}

function splitMeta(v: SessionView): ViewMeta {
  const { agents: _a, log: _l, ...meta } = v;
  return meta;
}

export class ViewEncoder {
  private seq = 0;
  private sent = false;
  private id = '';
  private eventCount = 0;
  private logSeq = 0;
  private metaJson = '';
  private agentJson = new Map<string, string>();

  /** The next encode() sends a full view (a window asked for a snapshot, or loaded). */
  reset() {
    this.sent = false;
  }

  encode(view: SessionView | null): ViewMsg {
    if (!view) {
      this.sent = false;
      return { t: 'none' };
    }
    let lastLog = 0;
    for (const l of view.log) if (l.seq > lastLog) lastLog = l.seq;
    const full = !this.sent || view.id !== this.id || view.eventCount < this.eventCount || lastLog < this.logSeq;
    const prevLogSeq = this.logSeq;
    this.sent = true;
    this.id = view.id;
    this.eventCount = view.eventCount;
    this.logSeq = lastLog;
    const meta = splitMeta(view);
    const metaJson = JSON.stringify(meta);
    const metaChanged = metaJson !== this.metaJson;
    this.metaJson = metaJson;
    if (full) {
      this.agentJson.clear();
      for (const [k, a] of Object.entries(view.agents)) this.agentJson.set(k, JSON.stringify(a));
      return { t: 'full', seq: ++this.seq, view };
    }
    const base = this.seq;
    const msg: Extract<ViewMsg, { t: 'delta' }> = { t: 'delta', seq: ++this.seq, base, id: view.id };
    if (metaChanged) msg.meta = meta;
    const seen = new Set<string>();
    for (const [k, a] of Object.entries(view.agents)) {
      seen.add(k);
      const json = JSON.stringify(a);
      const old = this.agentJson.get(k);
      if (old === json) continue;
      this.agentJson.set(k, json);
      (msg.agents ??= {})[k] = old === undefined ? a : changedFields(JSON.parse(old) as AgentNode, a);
    }
    for (const k of [...this.agentJson.keys()]) {
      if (!seen.has(k)) {
        this.agentJson.delete(k);
        (msg.removed ??= []).push(k);
      }
    }
    if (lastLog > prevLogSeq) {
      msg.log = view.log.filter((l) => l.seq > prevLogSeq);
    }
    return msg;
  }
}

function changedFields(old: AgentNode, a: AgentNode): Partial<AgentNode> {
  const out: Record<string, unknown> = {};
  const rec = a as unknown as Record<string, unknown>;
  const prev = old as unknown as Record<string, unknown>;
  for (const k of Object.keys(rec)) if (JSON.stringify(rec[k]) !== JSON.stringify(prev[k])) out[k] = rec[k];
  return out as Partial<AgentNode>;
}

export class ViewDecoder {
  view: SessionView | null = null;
  private seq = -1;
  constructor(private logCap = LOG_CAP) {}

  /** Returns the new view (null = no session), or undefined when the stream is out of step and a snapshot must be fetched. */
  apply(msg: ViewMsg): SessionView | null | undefined {
    if (msg.t === 'none') {
      this.view = null;
      this.seq = -1;
      return null;
    }
    if (msg.t === 'full') {
      this.view = msg.view;
      this.seq = msg.seq;
      return this.view;
    }
    const prev = this.view;
    if (!prev || msg.base !== this.seq || msg.id !== prev.id) return undefined;
    let agents = prev.agents;
    if (msg.agents || msg.removed) {
      agents = { ...prev.agents };
      for (const [k, patch] of Object.entries(msg.agents ?? {})) {
        const cur = agents[k];
        agents[k] = cur ? { ...cur, ...patch } : (patch as AgentNode);
      }
      for (const k of msg.removed ?? []) delete agents[k];
    }
    let log = prev.log;
    if (msg.log && msg.log.length) {
      let last = 0;
      for (const l of log) if (l.seq > last) last = l.seq;
      const add = msg.log.filter((l) => l.seq > last);
      if (add.length) {
        log = log.concat(add);
        if (log.length > this.logCap * 1.2) log = log.slice(-this.logCap);
      }
    }
    this.view = { ...prev, ...msg.meta, agents, log };
    this.seq = msg.seq;
    return this.view;
  }

  /** Adopt a snapshot fetched on request; the encoder's next message is then a full view. */
  adopt(view: SessionView | null) {
    this.view = view;
    this.seq = -1;
  }
}

/** Encodes then decodes in-process (replay builds its views locally): same identity-preserving views as the live stream. */
export class LocalViewStream {
  private enc = new ViewEncoder();
  private dec = new ViewDecoder();
  next(view: SessionView): SessionView {
    // structuredClone mimics the IPC copy: the reducer keeps mutating the state the view points into
    const out = this.dec.apply(structuredClone(this.enc.encode(view)));
    return out ?? view;
  }
}

/** Overview: one encoder per session id; sessions that disappear are forgotten. */
export class OverviewEncoder {
  private encoders = new Map<string, ViewEncoder>();
  reset() {
    this.encoders.clear();
  }
  encode(views: SessionView[]): OverviewMsg {
    const items: ViewMsg[] = [];
    const keep = new Set<string>();
    for (const v of views) {
      keep.add(v.id);
      let e = this.encoders.get(v.id);
      if (!e) this.encoders.set(v.id, (e = new ViewEncoder()));
      items.push(e.encode(v));
    }
    for (const id of [...this.encoders.keys()]) if (!keep.has(id)) this.encoders.delete(id);
    return { items };
  }
}

export class OverviewDecoder {
  private decoders = new Map<string, ViewDecoder>();
  private views: SessionView[] = [];
  constructor(private logCap = 40) {}

  /** undefined = out of step, fetch a snapshot. */
  apply(msg: OverviewMsg): SessionView[] | undefined {
    const next = new Map<string, ViewDecoder>();
    const out: SessionView[] = [];
    for (const item of msg.items) {
      const id = item.t === 'full' ? item.view.id : item.t === 'delta' ? item.id : null;
      if (!id) continue;
      const d = this.decoders.get(id) ?? new ViewDecoder(this.logCap);
      const v = d.apply(item);
      if (!v) return undefined;
      next.set(id, d);
      out.push(v);
    }
    this.decoders = next;
    // keep the array identity when nothing changed
    const same = out.length === this.views.length && out.every((v, i) => v === this.views[i]);
    if (!same) this.views = out;
    return this.views;
  }

  adopt(views: SessionView[]) {
    this.decoders.clear();
    for (const v of views) {
      const d = new ViewDecoder(this.logCap);
      d.adopt(v);
      this.decoders.set(v.id, d);
    }
    this.views = views;
  }
}
