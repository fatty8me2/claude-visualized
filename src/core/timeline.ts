// Pure helpers for the timeline (Gantt) view: lane ordering, the time axis, tick bucketing and idle-gap detection.
// No DOM, no React: everything here is unit-tested and cheap enough to run on every render.

import { MAIN, type AgentNode } from './state';

export const IDLE_GAP_MS = 60_000;
/** a running agent that has been silent this long is drawn as ended at its last activity */
export const STALE_MS = 5 * 60_000;

export interface Lane {
  id: string;
  parentId: string | null;
  /** indent level in the lane tree (not necessarily AgentNode.depth when parents are missing) */
  depth: number;
  kind: AgentNode['kind'];
  /** has child lanes (workflow groups get a collapse toggle) */
  hasChildren: boolean;
  /** true when the lane is the last child of its parent, for drawing the connector */
  last: boolean;
}

/**
 * Order agents as a tree: main first, children under their parent sorted by start time.
 * Agents whose parent is unknown hang under main. Children of `collapsed` lanes are left out.
 */
export function orderLanes(agents: Record<string, AgentNode>, collapsed: ReadonlySet<string> = new Set()): Lane[] {
  const ids = Object.keys(agents);
  const kids = new Map<string, AgentNode[]>();
  const roots: AgentNode[] = [];
  for (const id of ids) {
    const a = agents[id];
    if (id === MAIN) continue;
    const p = a.parentId && a.parentId !== id && agents[a.parentId] ? a.parentId : agents[MAIN] ? MAIN : null;
    if (p === null) roots.push(a);
    else (kids.get(p) ?? kids.set(p, []).get(p)!).push(a);
  }
  const byStart = (x: AgentNode, y: AgentNode) => x.startedAt - y.startedAt || (x.id < y.id ? -1 : 1);
  const out: Lane[] = [];
  const seen = new Set<string>();
  const walk = (a: AgentNode, depth: number, last: boolean) => {
    if (seen.has(a.id)) return;
    seen.add(a.id);
    const ch = (kids.get(a.id) ?? []).sort(byStart);
    out.push({ id: a.id, parentId: a.parentId, depth, kind: a.kind, hasChildren: ch.length > 0, last });
    if (collapsed.has(a.id)) return;
    ch.forEach((c, i) => walk(c, depth + 1, i === ch.length - 1));
  };
  if (agents[MAIN]) walk(agents[MAIN], 0, true);
  roots.sort(byStart).forEach((a, i) => walk(a, 0, i === roots.length - 1));
  return out;
}

/** Where an agent's bar ends: its end, else its last activity if it is done or has gone quiet, else now. */
export function barEnd(a: AgentNode, now: number): number {
  if (a.endedAt != null) return Math.max(a.endedAt, a.startedAt);
  if (a.status === 'done' || a.status === 'error') return Math.max(a.lastActivity, a.startedAt);
  if (now - a.lastActivity > STALE_MS) return Math.max(a.lastActivity, a.startedAt);
  return Math.max(now, a.startedAt);
}

/** Time range covering every agent, or null with no agents. */
export function fitRange(agents: Record<string, AgentNode>, now: number): { t0: number; t1: number } | null {
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const a of Object.values(agents)) {
    if (a.startedAt <= 0) continue; // a placeholder main agent that has not seen an event yet
    t0 = Math.min(t0, a.startedAt);
    t1 = Math.max(t1, barEnd(a, now));
  }
  if (!isFinite(t0)) return null;
  if (t1 - t0 < 1000) t1 = t0 + 1000;
  const pad = (t1 - t0) * 0.02;
  return { t0: t0 - pad, t1: t1 + pad };
}

// ---------- time axis ----------

export interface TimeRange {
  t0: number;
  t1: number;
}

export const MIN_SPAN_MS = 2000;
export const MAX_SPAN_MS = 400 * 86_400_000;

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const STEPS = [S, 2 * S, 5 * S, 10 * S, 15 * S, 30 * S, M, 2 * M, 5 * M, 10 * M, 15 * M, 30 * M, H, 2 * H, 3 * H, 6 * H, 12 * H, D, 2 * D, 7 * D];

export interface AxisTick {
  t: number;
  label: string;
  /** a tick on a coarser boundary (minute, hour or day) */
  major: boolean;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** Wall-clock label for a tick: seconds are shown only when the step is under a minute, the date when it is a day or more. */
export function tickLabel(t: number, step: number): string {
  const d = new Date(t);
  if (step >= D) return `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  if (step >= M) return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** The tick step (ms) giving about one tick per `minPx` pixels. */
export function pickStep(spanMs: number, widthPx: number, minPx = 90): number {
  const want = (spanMs / Math.max(1, widthPx)) * minPx;
  return STEPS.find((s) => s >= want) ?? STEPS[STEPS.length - 1];
}

/** Auto-scaled ticks aligned to local wall-clock multiples of the step. */
export function axisTicks(range: TimeRange, widthPx: number, minPx = 90): { step: number; ticks: AxisTick[] } {
  const span = range.t1 - range.t0;
  if (!(span > 0) || widthPx <= 0) return { step: S, ticks: [] };
  const step = pickStep(span, widthPx, minPx);
  const off = new Date(range.t0).getTimezoneOffset() * M; // local = utc - off
  const first = Math.ceil((range.t0 - off) / step) * step + off;
  const ticks: AxisTick[] = [];
  for (let t = first; t <= range.t1 && ticks.length < 400; t += step) {
    const local = t - off;
    const coarse = step >= D ? 0 : step >= H ? D : step >= M ? H : M;
    ticks.push({ t, label: tickLabel(t, step), major: coarse === 0 || local % coarse === 0 });
  }
  return { step, ticks };
}

export interface Scale {
  x: (t: number) => number;
  t: (x: number) => number;
}

export function makeScale(range: TimeRange, widthPx: number): Scale {
  const span = Math.max(1, range.t1 - range.t0);
  const k = widthPx / span;
  return { x: (t) => (t - range.t0) * k, t: (x) => range.t0 + x / k };
}

export function clampRange(r: TimeRange, bounds?: TimeRange): TimeRange {
  let span = Math.min(MAX_SPAN_MS, Math.max(MIN_SPAN_MS, r.t1 - r.t0));
  let t0 = r.t0;
  if (bounds) {
    const slack = Math.max(span * 0.5, 10 * S);
    span = Math.min(span, Math.max(MIN_SPAN_MS, bounds.t1 - bounds.t0 + slack * 2));
    t0 = Math.min(Math.max(t0, bounds.t0 - slack), bounds.t1 + slack - span);
  }
  return { t0, t1: t0 + span };
}

/** Zoom by `factor` (>1 zooms in) keeping the time under the cursor fixed; `frac` is the cursor position across the plot, 0..1. */
export function zoomRange(r: TimeRange, factor: number, frac: number, bounds?: TimeRange): TimeRange {
  const span = r.t1 - r.t0;
  const anchor = r.t0 + span * frac;
  const next = Math.min(MAX_SPAN_MS, Math.max(MIN_SPAN_MS, span / factor));
  const t0 = anchor - next * frac;
  return clampRange({ t0, t1: t0 + next }, bounds);
}

export function panRange(r: TimeRange, dxPx: number, widthPx: number, bounds?: TimeRange): TimeRange {
  const dt = (-dxPx / Math.max(1, widthPx)) * (r.t1 - r.t0);
  return clampRange({ t0: r.t0 + dt, t1: r.t1 + dt }, bounds);
}

// ---------- ticks and idle gaps ----------

export interface TickBucket {
  /** time of the first call in the bucket */
  t: number;
  /** calls in the bucket */
  n: number;
  /** at least one call failed */
  fail: boolean;
}

/**
 * Merge tool-call timestamps that would land within `minPx` of each other, so a zoomed-out bar draws at most
 * width/minPx ticks. `failed` timestamps colour their bucket red. Input need not be sorted.
 */
export function bucketTicks(times: readonly number[], failed: ReadonlySet<number>, range: TimeRange, widthPx: number, minPx = 4): TickBucket[] {
  const span = range.t1 - range.t0;
  if (!(span > 0) || widthPx <= 0) return [];
  const cell = (span / widthPx) * minPx;
  const sorted = [...times].filter((t) => t >= range.t0 - cell && t <= range.t1 + cell).sort((a, b) => a - b);
  const out: TickBucket[] = [];
  let cur: TickBucket | null = null;
  let curStart = 0;
  for (const t of sorted) {
    const bad = failed.has(t);
    if (cur && t - curStart < cell) {
      cur.n++;
      cur.fail ||= bad;
    } else {
      cur = { t, n: 1, fail: bad };
      curStart = t;
      out.push(cur);
    }
  }
  return out;
}

/** Spans between consecutive tool calls (and the bar's ends) longer than `threshold`, as [from, to] pairs. */
export function idleGaps(times: readonly number[], start: number, end: number, threshold = IDLE_GAP_MS): [number, number][] {
  if (end <= start) return [];
  const pts = [start, ...[...times].filter((t) => t > start && t < end).sort((a, b) => a - b), end];
  const gaps: [number, number][] = [];
  for (let i = 1; i < pts.length; i++) if (pts[i] - pts[i - 1] > threshold) gaps.push([pts[i - 1], pts[i]]);
  return gaps;
}

/** Tool-call timestamps of an agent: the sparkline activity plus recent calls, de-duplicated, ascending. */
export function toolTimes(a: Pick<AgentNode, 'activity' | 'recent'>): number[] {
  const set = new Set<number>(a.activity);
  for (const r of a.recent) set.add(r.ts);
  return [...set].sort((x, y) => x - y);
}

// ---------- virtual rows ----------

export function visibleRows(scrollTop: number, viewportH: number, rowH: number, total: number, overscan = 4): { from: number; to: number } {
  const from = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const to = Math.min(total, Math.ceil((scrollTop + viewportH) / rowH) + overscan);
  return { from, to };
}

/** Index of the first replay event strictly after time `t` (the `goto` index that shows the session as of `t`). */
export function eventIndexAt(eventTimes: readonly number[], t: number): number {
  let lo = 0;
  let hi = eventTimes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (eventTimes[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
