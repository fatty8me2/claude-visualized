// Session-wide numbers for the insights panel: tool pace, busiest tools and files, recent errors,
// throughput, main-agent context forecast, subagent goals, agent counts and uptime.
// Pure: the result is a function of (view, now) only. Never throws on partial data.
//
// Approximations (the state keeps no time series, so some figures are estimates):
// - Tool pace uses each agent's `activity` (tool-start timestamps, capped at ACTIVITY_CAP per agent),
//   so an agent with more than 120 calls inside the window is undercounted.
// - Token and cost rates have no timestamps. Each agent's lifetime tokens are spread evenly over its
//   active window (start to end, or to now while running) and the share falling in the last 10 minutes is taken.
// - tokensPerMin counts input + output tokens only; cache reads and writes would swamp the figure.
// - costPerHour scales the session's cost (reported when Claude Code gave one, else the list-price
//   estimate) by the share of estimated cost that falls in the last 10 minutes.
// - The context growth rate is the average since the main agent's first activity. It assumes the
//   context started near zero, and it is only given while the context has not been compacted.
// - topTools counts the log's 'tool' lines, so it covers only what the log still holds (LOG_CAP).
// - A file's ts is the time of its latest matching recent call (matched by basename, last 10 calls
//   per agent only), else null. Files are ordered by that ts, or by the agent's last activity when unknown.
// - busyShare treats each agent as busy from its start to its end (or to now while running), so an
//   idle main agent between turns counts as busy. Waiting agents are not busy.
// - Subagent counts and goal groups use kind 'agent' only (main and workflow nodes are excluded);
//   'waiting' is counted as running in goalMix.

import type { AgentNode, LogEntry, SessionView } from './state';
import { MAIN } from './state';
import { agentGoal } from './insight';
import { contextInfo } from './context';
import { estimateCostUSD } from './pricing';

export interface SessionInsights {
  /** tool calls per minute across ALL agents for the last 30 minutes, oldest first (length 30) */
  toolsPerMin: number[];
  /** most used tools in the session (from agents' toolMix or recent/log), top 6, by count desc */
  topTools: { name: string; count: number }[];
  /** most recently touched files, newest first, unique by path, max 8 */
  recentFiles: { path: string; agentId: string; ts: number | null }[];
  /** latest failures (log kinds 'tool-error' and error attention), newest first, max 5 */
  recentErrors: { ts: number; agentId: string; text: string }[];
  /** throughput over the last 10 minutes */
  burn: { tokensPerMin: number; toolsPerMin: number; costPerHour: number | null };
  /** main agent context forecast; null fields when not enough data */
  context: { pct: number | null; growthPerMin: number | null; minutesToCompact: number | null };
  /** subagents grouped by goal (from goal.ts), with counts by state */
  goalMix: { goal: string; running: number; done: number; error: number }[];
  /** agent counts */
  agents: { running: number; waiting: number; done: number; error: number; total: number };
  /** wall-clock since the session's first activity, and share of that time with at least one agent running (0..1) */
  uptimeMs: number;
  busyShare: number | null;
}

const MINUTE = 60_000;
const SERIES_MINUTES = 30;
const BURN_MINUTES = 10;
const TOP_TOOLS = 6;
const RECENT_FILES = 8;
const RECENT_ERRORS = 5;
/** auto-compact fires near this share of the window (the constant is not in context.ts) */
const COMPACT_AT = 0.97;
/** the context counts as compacted when it has fallen below this share of its peak */
const COMPACTED_BELOW = 0.8;
const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** whole minutes between ts and now; future timestamps (clock skew) count as age 0 */
function minuteAge(ts: number, now: number): number {
  return Math.floor(Math.max(0, now - ts) / MINUTE);
}

/** a 'tool' log line reads "Name  summary" (or just "Name") */
function toolNameOf(text: string): string {
  const cut = text.indexOf('  ');
  return (cut < 0 ? text : text.slice(0, cut)).trim();
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** timestamp of the agent's latest file-tool call whose summary (a basename) matches, else null */
function lastCallTs(a: AgentNode, path: string): number | null {
  const base = basename(path);
  let best: number | null = null;
  for (const r of a.recent ?? []) {
    if (!FILE_TOOLS.has(r.name) || r.summary !== base) continue;
    if (best === null || r.ts > best) best = r.ts;
  }
  return best;
}

export function sessionInsights(view: SessionView, now: number): SessionInsights {
  const agentMap = view.agents ?? {};
  const agents = Object.values(agentMap);
  const log: LogEntry[] = view.log ?? [];

  // tool pace: bucket i covers the minute ending (29 - i) minutes ago; index 29 is the current minute
  const toolsPerMin = new Array<number>(SERIES_MINUTES).fill(0);
  for (const a of agents) {
    for (const ts of a.activity ?? []) {
      const age = minuteAge(ts, now);
      if (age < SERIES_MINUTES) toolsPerMin[SERIES_MINUTES - 1 - age]++;
    }
  }

  // most used tools, from the log's tool lines
  const toolCounts = new Map<string, number>();
  for (const e of log) {
    if (e.kind !== 'tool') continue;
    const name = toolNameOf(e.text);
    if (name) toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
  }
  const topTools = [...toolCounts]
    .map(([name, count]) => ({ name, count }))
    .sort((x, y) => y.count - x.count || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
    .slice(0, TOP_TOOLS);

  // recent files: every agent's list, newest key first, first occurrence of each path wins
  const candidates: { path: string; agentId: string; ts: number | null; key: number }[] = [];
  for (const a of agents) {
    const files = a.files ?? [];
    for (let i = files.length - 1; i >= 0; i--) {
      const ts = lastCallTs(a, files[i]);
      candidates.push({ path: files[i], agentId: a.id, ts, key: ts ?? num(a.lastActivity) });
    }
  }
  candidates.sort((x, y) => y.key - x.key);
  const seenPaths = new Set<string>();
  const recentFiles: SessionInsights['recentFiles'] = [];
  for (const c of candidates) {
    if (recentFiles.length >= RECENT_FILES) break;
    if (seenPaths.has(c.path)) continue;
    seenPaths.add(c.path);
    recentFiles.push({ path: c.path, agentId: c.agentId, ts: c.ts });
  }

  // recent errors: failed tool calls and error attention lines, newest first
  const recentErrors = log
    .filter((e) => e.kind === 'tool-error' || (e.kind === 'attention' && e.attn === 'error'))
    .sort((x, y) => num(y.ts) - num(x.ts) || num(y.seq) - num(x.seq))
    .slice(0, RECENT_ERRORS)
    .map((e) => ({ ts: num(e.ts), agentId: e.agentId, text: e.text }));

  // burn: each agent's lifetime tokens and cost spread over its active window (see header)
  const burnFrom = now - BURN_MINUTES * MINUTE;
  let recentTokens = 0;
  let recentCost = 0;
  let totalCost = 0;
  for (const a of agents) {
    if (a.kind === 'workflow' || !a.tokens) continue;
    const start = num(a.startedAt);
    if (start <= 0) continue;
    const end = Math.max(start, a.status === 'running' ? now : num(a.endedAt) || num(a.lastActivity) || start);
    const window = Math.max(end - start, 1);
    const overlap = Math.max(0, Math.min(end, now) - Math.max(start, burnFrom));
    const frac = Math.min(1, overlap / window);
    const t = { in: num(a.tokens.in), out: num(a.tokens.out), cacheRead: num(a.tokens.cacheRead), cacheWrite: num(a.tokens.cacheWrite) };
    recentTokens += (t.in + t.out) * frac;
    const cost = estimateCostUSD(t, a.model);
    if (cost !== null) {
      totalCost += cost;
      recentCost += cost * frac;
    }
  }
  const burnTools = toolsPerMin.slice(-BURN_MINUTES).reduce((n, c) => n + c, 0) / BURN_MINUTES;
  // no priced tokens means no rate: null rather than 0
  const costPerHour = totalCost > 0 ? (view.costUSD ?? totalCost) * (recentCost / totalCost) * (60 / BURN_MINUTES) : null;

  // main-agent context forecast
  const main = agentMap[MAIN];
  let pct: number | null = null;
  let growthPerMin: number | null = null;
  let minutesToCompact: number | null = null;
  if (main) {
    const info = contextInfo({ model: main.model, contextTokens: num(main.contextTokens), contextPeak: num(main.contextPeak) });
    if (info && info.windowKnown) {
      pct = info.pct;
      const tokens = info.tokens;
      const peak = num(main.contextPeak);
      const since = num(main.startedAt) > 0 ? num(main.startedAt) : num(view.startedAt);
      const elapsedMin = (num(main.contextAt) - since) / MINUTE;
      const compacted = peak > 0 && tokens < COMPACTED_BELOW * peak;
      if (!compacted && elapsedMin >= 1) growthPerMin = tokens / elapsedMin;
      if (growthPerMin !== null && growthPerMin > 0) {
        minutesToCompact = Math.max(0, (info.size * COMPACT_AT - tokens) / growthPerMin);
      }
    }
  }

  // subagents: counts by state, and by goal
  const counts = { running: 0, waiting: 0, done: 0, error: 0, total: 0 };
  const byGoal = new Map<string, { running: number; done: number; error: number }>();
  for (const a of agents) {
    if (a.kind !== 'agent') continue;
    counts.total++;
    const g = agentGoal(a).goal;
    let row = byGoal.get(g);
    if (!row) {
      row = { running: 0, done: 0, error: 0 };
      byGoal.set(g, row);
    }
    if (a.status === 'running') counts.running++;
    else if (a.status === 'waiting') counts.waiting++;
    else if (a.status === 'done') counts.done++;
    else if (a.status === 'error') counts.error++;
    // waiting agents are still live, so goalMix folds them into running
    if (a.status === 'running' || a.status === 'waiting') row.running++;
    else if (a.status === 'done') row.done++;
    else if (a.status === 'error') row.error++;
  }
  const goalMix = [...byGoal]
    .filter(([, r]) => r.running + r.done + r.error > 0)
    .map(([goal, r]) => ({ goal, ...r }))
    .sort((x, y) => y.running + y.done + y.error - (x.running + x.done + x.error) || (x.goal < y.goal ? -1 : x.goal > y.goal ? 1 : 0));

  // uptime and busy share: merged busy spans, clipped to [start, now]
  let start = num(view.startedAt);
  if (start <= 0) {
    for (const a of agents) {
      const s = num(a.startedAt);
      if (s > 0 && (start <= 0 || s < start)) start = s;
    }
  }
  const uptimeMs = start > 0 ? Math.max(0, now - start) : 0;
  let busyShare: number | null = null;
  if (uptimeMs > 0) {
    const spans: [number, number][] = [];
    for (const a of agents) {
      const s0 = num(a.startedAt);
      if (s0 <= 0) continue;
      const end0 = a.status === 'running' ? now : (num(a.endedAt) || num(a.lastActivity) || s0);
      const s = Math.max(s0, start);
      const e = Math.min(Math.max(end0, s0), now);
      if (e > s) spans.push([s, e]);
    }
    spans.sort((x, y) => x[0] - y[0]);
    let busy = 0;
    let cs = 0;
    let ce = -1;
    let open = false;
    for (const [s, e] of spans) {
      if (!open || s > ce) {
        if (open) busy += ce - cs;
        cs = s;
        ce = e;
        open = true;
      } else if (e > ce) ce = e;
    }
    if (open) busy += ce - cs;
    busyShare = Math.min(1, busy / uptimeMs);
  }

  return {
    toolsPerMin,
    topTools,
    recentFiles,
    recentErrors,
    burn: { tokensPerMin: recentTokens / BURN_MINUTES, toolsPerMin: burnTools, costPerHour },
    context: { pct, growthPerMin, minutesToCompact },
    goalMix,
    agents: counts,
    uptimeMs,
    busyShare,
  };
}
