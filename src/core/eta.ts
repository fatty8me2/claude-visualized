// Time estimates: when each running agent should finish, and when the current prompt (the turn) should wrap up: its work
// done, then committed, pushed and released so that update checks can see it.
//
// Claude Code reports no progress, so every number here is an estimate from evidence, and the UI labels it as one:
// - An agent: how long similar past agents ran on this computer (the history index: same agent type and model family,
//   falling back to broader groups), given how long this one has run so far, blended with the same reasoning over
//   tool-call counts at this agent's own pace. Run times are active time (pauses over 5 minutes left out), so an agent
//   resumed hours later does not count as one that ran for hours. One that has outlasted nearly every similar run is
//   "running long": its finish is only a guess.
// - The prompt: the pace of the turn's task list (time per finished step, pulled toward a prior while few are done),
//   never before the slowest running agent is due, then the shipping steps the turn still has to do (commit, push,
//   release), each with a typical duration. With no task list, past prompts of the same project stand in.
// Pure: a function of (input, now, priors). Every field of the input is treated as optional (older peers send less).

import { classifyGoal, type Confidence, type ToolMix } from './goal';
import type { ShipKind } from './events';
import type { ShipEvent, TodoItem } from './state';
import { modelFamily } from './summarize';

export type { Confidence };

// ---------- priors (built from the history index, src/main/historyDb.ts) ----------

export interface AgentSamples {
  /** active run times in ms, ascending */
  dur: number[];
  /** tool calls per run, ascending */
  tools: number[];
}

export interface EtaPriors {
  /** when they were computed; 0 = none yet */
  at: number;
  /** finished subagent runs grouped by priorKeys(); only groups with enough runs */
  agents: Record<string, AgentSamples>;
  /** past prompts: time from the prompt to the main agent's last message, ascending */
  turns: number[];
  turnsByProject: Record<string, number[]>;
}

export const NO_PRIORS: EtaPriors = { at: 0, agents: {}, turns: [], turnsByProject: {} };

/** a group needs this many past runs to be used */
export const MIN_RUNS = 6;
/** and this many of them must have run longer than the agent has so far */
export const MIN_LEFT = 3;
const GROUP_CAP = 400;
const RUN_MIN_MS = 3_000;
const RUN_MAX_MS = 4 * 3_600_000;
const MIN_TURNS = 8;
const TURN_MIN_MS = 10_000;
const TURN_MAX_MS = 8 * 3_600_000;
const TURN_CAP = 1500;

export interface PriorKey {
  key: string;
  /** what the agent is compared with, for the UI ("Explore · opus agents") */
  label: string;
  /** type and model family both match */
  specific: boolean;
}

/** Groups a run belongs to, most specific first. */
export function priorKeys(type: string, family: string | null, goal: string): PriorKey[] {
  const t = type || 'agent';
  const keys: PriorKey[] = [];
  if (family) {
    keys.push({ key: `tfg:${t}|${family}|${goal}`, label: `${t} · ${family} · ${goal}`, specific: true });
    keys.push({ key: `tf:${t}|${family}`, label: `${t} · ${family}`, specific: true });
  }
  keys.push({ key: `tg:${t}|${goal}`, label: `${t} · ${goal}`, specific: false });
  keys.push({ key: `t:${t}`, label: t, specific: false });
  keys.push({ key: `g:${goal}`, label: `${goal} agents`, specific: false });
  keys.push({ key: '*', label: 'all agents', specific: false });
  return keys;
}

export interface PriorRun {
  type: string;
  family: string | null;
  goal: string;
  activeMs: number;
  tools: number;
}

export interface PriorTurn {
  project: string;
  ms: number;
}

const asc = (a: number, b: number) => a - b;

/** Group past runs and turns (newest first: each group keeps its newest runs). */
export function buildEtaPriors(runs: PriorRun[], turns: PriorTurn[], at: number): EtaPriors {
  const groups = new Map<string, AgentSamples>();
  for (const r of runs) {
    if (!(r.activeMs >= RUN_MIN_MS && r.activeMs <= RUN_MAX_MS)) continue;
    for (const k of priorKeys(r.type, r.family, r.goal || 'general')) {
      let g = groups.get(k.key);
      if (!g) groups.set(k.key, (g = { dur: [], tools: [] }));
      if (g.dur.length >= GROUP_CAP) continue;
      g.dur.push(Math.round(r.activeMs));
      g.tools.push(Math.max(0, Math.round(r.tools) || 0));
    }
  }
  const agents: Record<string, AgentSamples> = {};
  for (const [k, g] of groups) if (g.dur.length >= MIN_RUNS) agents[k] = { dur: g.dur.sort(asc), tools: g.tools.sort(asc) };

  const all: number[] = [];
  const byProject = new Map<string, number[]>();
  for (const t of turns) {
    if (!(t.ms >= TURN_MIN_MS && t.ms <= TURN_MAX_MS) || all.length >= TURN_CAP) continue;
    all.push(Math.round(t.ms));
    if (!t.project) continue;
    let p = byProject.get(t.project);
    if (!p) byProject.set(t.project, (p = []));
    p.push(Math.round(t.ms));
  }
  const turnsByProject: Record<string, number[]> = {};
  for (const [k, v] of byProject) if (v.length >= MIN_TURNS) turnsByProject[k] = v.sort(asc);
  return { at, agents, turns: all.length >= MIN_TURNS ? all.sort(asc) : [], turnsByProject };
}

/** gaps longer than this between an agent's messages are pauses (waiting, resumed later), not work */
export const ACTIVE_GAP_MS = 5 * 60_000;

/** Active time per `${session}\t${agent}` from message times sorted by session, agent, time. */
export function activeTimes(msgs: readonly { s: string; a: string; ts: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  let key = '';
  let last = 0;
  let sum = 0;
  for (const m of msgs) {
    const k = `${m.s}\t${m.a}`;
    if (k !== key) {
      if (key) out.set(key, sum);
      key = k;
      sum = 0;
    } else sum += Math.min(Math.max(0, m.ts - last), ACTIVE_GAP_MS);
    last = m.ts;
  }
  if (key) out.set(key, sum);
  return out;
}

/**
 * Past turns: from each main-agent prompt to the main agent's last message before the next prompt, for turns with at
 * least `minMsgs` messages (a quick answer says nothing about a long task). Inputs sorted by session, time; newest first out.
 */
export function turnTimes(
  prompts: readonly { s: string; ts: number }[],
  msgs: readonly { s: string; ts: number }[],
  projectOf: (session: string) => string,
  minMsgs = 3,
): (PriorTurn & { at: number })[] {
  const bySession = new Map<string, number[]>();
  for (const m of msgs) {
    let l = bySession.get(m.s);
    if (!l) bySession.set(m.s, (l = []));
    l.push(m.ts);
  }
  const out: (PriorTurn & { at: number })[] = [];
  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    const next = prompts[i + 1]?.s === p.s ? prompts[i + 1].ts : Infinity;
    const times = bySession.get(p.s);
    if (!times) continue;
    let k = upperBound(times, p.ts - 1);
    let n = 0;
    let last = 0;
    for (; k < times.length && times[k] < next; k++, n++) last = times[k];
    if (n >= minMsgs) out.push({ project: projectOf(p.s), ms: last - p.ts, at: p.ts });
  }
  return out.sort((x, y) => y.at - x.at);
}

// ---------- order statistics ----------

/** p-quantile of an ascending list (linear between neighbours), counting from index `from`. NaN when empty. */
export function quantile(sorted: readonly number[], p: number, from = 0): number {
  const n = sorted.length - from;
  if (n <= 0) return NaN;
  const x = Math.min(Math.max(p, 0), 1) * (n - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = sorted[from + i];
  return i + 1 < n ? a + f * (sorted[from + i + 1] - a) : a;
}

/** index of the first element greater than v */
function upperBound(sorted: readonly number[], v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * How much longer the runs that outlasted `elapsed` went on: quantiles of (d - elapsed) over d > elapsed, and how many
 * such runs there were. Null when fewer than `min` outlasted it.
 */
export function remainingAfter(sorted: readonly number[], elapsed: number, ps: number[], min = MIN_LEFT): { q: number[]; left: number } | null {
  const i = upperBound(sorted, elapsed);
  const left = sorted.length - i;
  if (left < min) return null;
  return { q: ps.map((p) => quantile(sorted, p, i) - elapsed), left };
}

// ---------- one agent ----------

export interface EtaAgentInput {
  id: string;
  kind: string;
  agentType: string;
  model: string | null;
  status: string;
  startedAt: number;
  endedAt: number | null;
  toolCount: number;
  description: string;
  phase: string | null;
  prompt: string | null;
  toolMix: ToolMix;
  parentId?: string | null;
}

export interface AgentEta {
  /** expected finish (epoch ms) and a plausible range around it */
  at: number;
  low: number;
  high: number;
  remaining: number;
  /** time-based share done, for a bar: elapsed / (elapsed + remaining) */
  fraction: number;
  confidence: Confidence;
  /** has outlasted nearly every similar run: the finish is a guess */
  overdue: boolean;
  /** waiting for the user (a permission prompt or a question) */
  paused: boolean;
  /** what it was compared with ("Explore · opus") and how many past runs that is */
  group: string;
  runs: number;
  /** middle half of those runs' active times (25th to 75th percentile), ms */
  typical: [number, number];
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * What the agent is for (goal.ts), cached: the estimates run for every running agent on every clock tick, in the strip and on
 * each card, and the classifier's keyword scan over the prompt dominates that cost. The key is everything the answer depends on.
 */
const goalCache = new Map<string, string>();
function goalOf(a: EtaAgentInput): string {
  let mix = '';
  for (const k in a.toolMix ?? {}) mix += `${k}${a.toolMix[k as keyof ToolMix]},`;
  const key = `${a.agentType}${a.phase ?? ''}${mix}${a.description}${a.prompt ?? ''}`;
  let g = goalCache.get(key);
  if (g === undefined) {
    g = classifyGoal({ kind: 'agent', agentType: a.agentType, description: a.description, phase: a.phase, prompt: a.prompt, toolMix: a.toolMix }).goal;
    if (goalCache.size >= 4000) goalCache.clear();
    goalCache.set(key, g);
  }
  return g;
}

/** what the history says: similar past runs, given how long this one has run */
function historyGuess(a: EtaAgentInput, elapsed: number, priors: EtaPriors) {
  const goal = goalOf(a);
  const family = a.model ? modelFamily(a.model) : null;
  const pick = priorKeys(a.agentType, family, goal).find((k) => priors.agents[k.key]);
  if (!pick) return null;
  const g = priors.agents[pick.key];
  const typical: [number, number] = [quantile(g.dur, 0.25), quantile(g.dur, 0.75)];
  const byTime = remainingAfter(g.dur, elapsed, [0.25, 0.5, 0.75]);
  if (!byTime) {
    // longer than (nearly) every similar run: it is probably well along, but that is a guess
    const remaining = Math.max(60_000, elapsed * 0.25);
    return {
      pick,
      runs: g.dur.length,
      typical,
      overdue: true,
      confidence: 'low' as Confidence,
      remaining,
      low: Math.min(remaining, 30_000),
      high: Math.max(remaining * 2, elapsed * 0.6),
    };
  }
  // (blending in tool-call counts at the agent's own pace, or capping the wait by the time spent, both did worse on real sessions)
  const mid = Math.max(byTime.q[1], 1000);
  const overdue = byTime.left / g.dur.length < 0.05;
  const confidence: Confidence = overdue ? 'low' : g.dur.length >= 25 && byTime.left >= 8 && pick.specific ? 'high' : 'medium';
  return { pick, runs: g.dur.length, typical, overdue, confidence, remaining: mid, low: Math.min(mid, byTime.q[0]), high: Math.max(mid, byTime.q[2]) };
}

/** Expected finish of a running subagent, or null (not running, not a subagent, or nothing similar in the history yet). */
export function agentEta(a: EtaAgentInput, now: number, priors: EtaPriors): AgentEta | null {
  if (a.kind !== 'agent' || (a.status !== 'running' && a.status !== 'waiting') || !(a.startedAt > 0)) return null;
  const elapsed = Math.max(0, now - a.startedAt);
  const h = historyGuess(a, elapsed, priors);
  if (!h) return null;
  return {
    at: now + h.remaining,
    low: now + Math.min(h.low, h.remaining),
    high: now + Math.max(h.high, h.remaining),
    remaining: h.remaining,
    fraction: clamp(elapsed / (elapsed + h.remaining), 0.02, 0.97),
    confidence: h.confidence,
    overdue: h.overdue,
    paused: a.status === 'waiting',
    group: h.pick.label,
    runs: h.runs,
    typical: h.typical,
  };
}

/** Estimates for every running subagent of a session (computed once per clock tick and shared by the bar and the cards). */
export function agentEtas(agents: Record<string, EtaAgentInput> | undefined, now: number, priors: EtaPriors): Map<string, AgentEta> {
  const out = new Map<string, AgentEta>();
  for (const a of Object.values(agents ?? {})) {
    if (a.kind !== 'agent' || (a.status !== 'running' && a.status !== 'waiting')) continue;
    const e = agentEta(a, now, priors);
    if (e) out.set(a.id, e);
  }
  return out;
}

// ---------- the prompt (turn) ----------

export type StageKey = 'work' | 'commit' | 'push' | 'release';
/** skipped: a later stage happened in this turn without it; failed: tried and every attempt failed */
export type StageState = 'done' | 'active' | 'pending' | 'failed' | 'skipped';

export interface StageEta {
  key: StageKey;
  state: StageState;
  /**
   * 'turn': part of this prompt (on its task list, or already started); 'later': only asked for in the prompt, and on real
   * sessions that mostly happens in a later turn, after the user's go-ahead, so it is not counted in the prompt's end
   */
  plan: 'turn' | 'later';
  /** done: when it happened; otherwise when it is expected (later stages: as if the go-ahead came right at the end) */
  at: number | null;
  /** a few words: "4 of 7 steps", "draft uploaded", "published" */
  note: string;
}

export interface AgentMark {
  id: string;
  state: 'running' | 'waiting' | 'done' | 'error';
  /** finished: when; running: expected finish (null: no estimate) */
  at: number | null;
  eta: AgentEta | null;
}

/** how far the prompt is meant to go: published (update checks see it), pushed, committed, or just the turn over */
export type FinishLine = 'release' | 'push' | 'commit' | 'turn';

export interface PromptEta {
  startedAt: number;
  state: 'running' | 'waiting' | 'done';
  /** expected end of the prompt (the actual end once done); null = no estimate yet */
  finishAt: number | null;
  low: number | null;
  high: number | null;
  /** end of the work before any shipping */
  workAt: number | null;
  /** time-based share of the prompt done, 0..1; null without an estimate */
  fraction: number | null;
  confidence: Confidence;
  finishLine: FinishLine;
  /** when the finish line is expected (after finishAt when it needs a later go-ahead); null for 'turn' or no estimate */
  shipAt: number | null;
  stages: StageEta[];
  /** subagents of this turn (and older ones still running), oldest first */
  agents: AgentMark[];
  steps: { done: number; active: number; total: number; perStep: number } | null;
  /** short reasons, for a tooltip */
  basis: string[];
}

export interface EtaStep {
  text: string;
  status: 'done' | 'in_progress' | 'pending';
}

export interface PromptEtaInput {
  agents?: Record<string, EtaAgentInput & { lastActivity?: number }>;
  todos?: TodoItem[];
  turnStartedAt?: number | null;
  ship?: ShipEvent[];
  startedAt?: number | null;
  ended?: boolean;
  /** when the plan text was submitted (plan steps below count for this turn when it is during the turn or unfinished) */
  planSince?: number | null;
  /** steps of the session's plan text with their status (plan.ts), when it has plan text; the todo list is read from `todos` */
  planSteps?: EtaStep[] | null;
  /** project name, for past prompts of the same project */
  project?: string | null;
  /** agent estimates already worked out for this `now` (agentEtas), to share them with the cards */
  etas?: Map<string, AgentEta>;
}

/**
 * typical time per task-list step before any is done, pulled toward what this turn shows as steps finish
 * (3 to 8 minutes, a weight of 0.5 to 3 and pacing by the last few steps only all backtested the same on real sessions)
 */
export const STEP_PRIOR_MS = 5 * 60_000;
const STEP_PRIOR_WEIGHT = 1.5;
/** the main agent reading the results after its last agent finishes */
const COLLECT_MS = 90_000;
/** typical shipping times; a release that already happened in this session is used instead when there was one */
export const STAGE_MS: Record<Exclude<StageKey, 'work'>, number> = { commit: 90_000, push: 45_000, release: 5 * 60_000 };

const RELEASE_RE =
  /\b(releas(?:e|es|ed|ing)|publish(?:es|ed|ing)?|ship(?:s|ped|ping)?|deploy(?:s|ed|ing)?|check(?:s|ing)? for updates|update checks?|auto-?updat\w*)\b/i;
const PUSH_RE = /\b(push(?:es|ed|ing)?|github|pull request|open (?:a )?pr)\b/i;
const COMMIT_RE = /\bcommit(?:s|ted|ting)?\b/i;
const VERSION_RE = /\b(version|v\d+\.\d+(?:\.\d+)?|\d+\.\d+\.\d+)\b/i;
const SHIP_FIRST = /^\W*(?:(?:then|and|finally)\s+)?(commit|push|release|publish|ship|deploy|tag|bump|cut|open (?:a )?(?:pr|pull request))\b/i;

/** a task-list step that is shipping rather than work ("Commit and release", "Push to GitHub") */
export function isShipStep(text: string): boolean {
  return SHIP_FIRST.test(text) || (COMMIT_RE.test(text) && (PUSH_RE.test(text) || RELEASE_RE.test(text)));
}

const DONE_RE = /^(completed?|done)$/i;
const ACTIVE_RE = /^(in[_-]progress|active)$/i;
const todoStatus = (s: string): EtaStep['status'] => (DONE_RE.test(s) ? 'done' : ACTIVE_RE.test(s) ? 'in_progress' : 'pending');

type ShipStage = Exclude<StageKey, 'work'>;
const SHIP_STAGES: ShipStage[] = ['commit', 'push', 'release'];
const SHIP_STAGE: Record<ShipKind, ShipStage> = { commit: 'commit', push: 'push', pr: 'push', release: 'release', publish: 'release' };

interface StepRow extends EtaStep {
  startedAt?: number;
  doneAt?: number;
}

/** The task list this turn is working through: todos touched during the turn, else a plan made or unfinished during it, else unfinished todos. */
function turnSteps(input: PromptEtaInput, t0: number): { rows: StepRow[]; timed: boolean } | null {
  const todos = (input.todos ?? []).filter((t) => t.text?.trim());
  const fromTodos = (): StepRow[] => todos.map((t) => ({ text: t.text, status: todoStatus(t.status), startedAt: t.startedAt, doneAt: t.doneAt }));
  const touched = todos.some((t) => (t.startedAt ?? 0) >= t0 - 5000 || (t.doneAt ?? 0) >= t0 - 5000);
  if (touched) return { rows: fromTodos(), timed: true };
  const plan = input.planSteps ?? null;
  if (plan?.length && ((input.planSince ?? 0) >= t0 - 5000 || plan.some((s) => s.status !== 'done')))
    return { rows: plan.map((s) => ({ ...s })), timed: false };
  if (todos.some((t) => todoStatus(t.status) !== 'done')) return { rows: fromTodos(), timed: true };
  return null;
}

/** time per step: what the finished steps took, pulled toward the prior while there are few */
function stepPace(rows: StepRow[], t0: number, now: number): { perStep: number; lastDone: number | null } {
  const done = rows.filter((r) => r.status === 'done');
  const times = done.map((r) => r.doneAt).filter((t): t is number => typeof t === 'number' && t >= t0 - 60_000);
  const lastDone = times.length ? Math.max(...times) : null;
  if (!done.length) return { perStep: STEP_PRIOR_MS, lastDone };
  const active = rows.filter((r) => r.status === 'in_progress').length;
  // with times: the span up to the last finish over the steps finished; without: elapsed so far over the steps done or half done
  const observed = lastDone !== null ? Math.max(0, lastDone - t0) / times.length : Math.max(0, now - t0) / (done.length + 0.5 * active);
  const n = lastDone !== null ? times.length : done.length;
  return { perStep: Math.max(20_000, (n * observed + STEP_PRIOR_WEIGHT * STEP_PRIOR_MS) / (n + STEP_PRIOR_WEIGHT)), lastDone };
}

const okEvent = (e: ShipEvent) => e.ok === true || (e.ok === null && e.endAt !== null);

function shipStatus(events: ShipEvent[], stage: ShipStage) {
  const ev = events.filter((e) => SHIP_STAGE[e.kind] === stage);
  const ok = ev.filter(okEvent);
  const running = ev.filter((e) => e.endAt === null);
  // a release is done only once published; a draft upload is a release under way
  const done = stage === 'release' ? ok.filter((e) => e.kind === 'publish') : ok;
  return { ev, ok, done, running, failed: ev.length > 0 && !ok.length && !running.length };
}

/** how long a release took earlier in this session (release start to publish end), else null */
function learnedReleaseMs(all: ShipEvent[]): number | null {
  for (let i = all.length - 1; i >= 0; i--) {
    const p = all[i];
    if (p.kind !== 'publish' || !okEvent(p)) continue;
    const start = all
      .slice(0, i)
      .reverse()
      .find((e) => e.kind === 'release' && p.at - e.at < 3 * 3_600_000);
    if (start) return clamp((p.endAt ?? p.at) - start.at, 30_000, 45 * 60_000);
  }
  return null;
}

/** what the turn ships: [in this turn, only asked for in the prompt], each cascading down (a release needs a push needs a commit) */
function shipPlan(prompt: string, shipText: string, started: Record<ShipStage, boolean>) {
  const inTurn = { release: started.release || RELEASE_RE.test(shipText), push: false, commit: false };
  inTurn.push = inTurn.release || started.push || PUSH_RE.test(shipText);
  inTurn.commit = inTurn.push || started.commit || COMMIT_RE.test(shipText);
  const promptShips = COMMIT_RE.test(prompt) || PUSH_RE.test(prompt) || VERSION_RE.test(prompt);
  const asked = { release: RELEASE_RE.test(prompt) && promptShips, push: false, commit: false };
  asked.push = asked.release || (PUSH_RE.test(prompt) && (COMMIT_RE.test(prompt) || /github/i.test(prompt)));
  asked.commit = asked.push || COMMIT_RE.test(prompt);
  return { inTurn, asked };
}

/**
 * Range around the prompt's expected end, as multiples of the time left. Backtested on real sessions the estimate lands
 * within a factor of about 2.5 half the time, so a range that is honest is wide; the UI shows it on hover only.
 */
const SPREAD: Record<Confidence, [number, number]> = { high: [0.6, 1.8], medium: [0.45, 2.4], low: [0.3, 3.5] };
const lower = (c: Confidence): Confidence => (c === 'high' ? 'medium' : 'low');

/** Estimate for the session's current prompt, or null when there is no turn to speak of. */
export function promptEta(input: PromptEtaInput, now: number, priors: EtaPriors): PromptEta | null {
  const agents = input.agents ?? {};
  const main = agents['main'];
  const t0 = input.turnStartedAt ?? (main?.startedAt || input.startedAt || 0);
  if (!t0) return null;
  const basis: string[] = [];

  // subagents of this turn, plus older ones still running
  const marks: AgentMark[] = [];
  let unknownAgents = 0;
  const etas = input.etas ?? agentEtas(agents, now, priors);
  for (const a of Object.values(agents)) {
    if (a.kind !== 'agent') continue;
    const live = a.status === 'running' || a.status === 'waiting';
    if (!live && !(a.startedAt >= t0 - 1000)) continue;
    const eta = live ? (etas.get(a.id) ?? null) : null;
    if (live && !eta) unknownAgents++;
    const state: AgentMark['state'] = live ? (a.status as 'running' | 'waiting') : a.status === 'error' ? 'error' : 'done';
    marks.push({ id: a.id, state, at: live ? (eta?.at ?? null) : (a.endedAt ?? a.lastActivity ?? null), eta });
  }
  marks.sort((x, y) => (agents[x.id]?.startedAt ?? 0) - (agents[y.id]?.startedAt ?? 0));
  const live = marks.filter((m) => m.state === 'running' || m.state === 'waiting');
  const workflowBusy = Object.values(agents).some((a) => a.kind === 'workflow' && a.status === 'running');
  const mainBusy = main?.status === 'running';
  const mainWaiting = main?.status === 'waiting';
  const over = !!input.ended || (!mainBusy && !mainWaiting && !live.length && !workflowBusy);
  const state: PromptEta['state'] = over
    ? 'done'
    : mainWaiting || (!mainBusy && live.length > 0 && live.every((m) => m.state === 'waiting'))
      ? 'waiting'
      : 'running';

  // the task list and the shipping this turn has done, and is expected to do
  const steps = turnSteps(input, t0);
  const shipAll = input.ship ?? [];
  const ship = shipAll.filter((e) => e.at >= t0 - 1000);
  const st: Record<ShipStage, ReturnType<typeof shipStatus>> = {
    commit: shipStatus(ship, 'commit'),
    push: shipStatus(ship, 'push'),
    release: shipStatus(ship, 'release'),
  };
  const shipText = (steps?.rows ?? [])
    .filter((r) => isShipStep(r.text))
    .map((r) => r.text)
    .join('\n');
  const plan = shipPlan(main?.prompt ?? '', shipText, { commit: st.commit.ev.length > 0, push: st.push.ev.length > 0, release: st.release.ev.length > 0 });
  const wanted = (k: ShipStage) => plan.inTurn[k] || plan.asked[k];
  const finishLine: FinishLine = wanted('release') ? 'release' : wanted('push') ? 'push' : wanted('commit') ? 'commit' : 'turn';

  // the work: the task list's pace, never before the last running agent is due
  const work = steps ? steps.rows.filter((r) => !isShipStep(r.text)) : [];
  let stepsInfo: PromptEta['steps'] = null;
  let workAt: number | null = null;
  let confidence: Confidence = 'low';
  if (steps && work.length) {
    const done = work.filter((r) => r.status === 'done').length;
    const active = work.filter((r) => r.status === 'in_progress');
    const pending = work.length - done - active.length;
    const { perStep, lastDone } = stepPace(work, t0, now);
    let current = 0;
    for (const r of active) {
      const spent = Math.max(0, now - Math.max(t0, r.startedAt ?? lastDone ?? t0));
      current = Math.max(current, spent < perStep * 0.8 ? perStep - spent : Math.max(perStep * 0.2, spent * 0.15));
    }
    workAt = now + current + pending * perStep;
    stepsInfo = { done, active: active.length, total: work.length, perStep };
    confidence = done >= 3 && steps.timed ? 'high' : done >= 1 ? 'medium' : 'low';
    basis.push(
      done
        ? `${done} of ${work.length} steps done, about ${minutes(perStep)} each`
        : `no step done yet: about ${minutes(perStep)} a step assumed for ${work.length} step${work.length === 1 ? '' : 's'}`,
    );
  } else if (steps) {
    // only shipping steps on the list: the work is behind it
    workAt = now;
    confidence = 'medium';
  } else if (!over) {
    const project = input.project ? priors.turnsByProject[input.project] : undefined;
    const past = project?.length ? project : priors.turns;
    if (past.length) {
      const r = remainingAfter(past, now - t0, [0.5]);
      workAt = now + (r ? Math.max(r.q[0], 30_000) : Math.max(5 * 60_000, (now - t0) * 0.25));
      basis.push(`no task list: compared with ${past.length} past prompts${project?.length ? ' in this project' : ''}`);
    }
  }
  if (live.length) {
    let agentsAt = 0;
    for (const m of live) agentsAt = Math.max(agentsAt, m.at ?? now + Math.max(120_000, (now - (agents[m.id]?.startedAt ?? now)) * 0.5));
    workAt = Math.max(workAt ?? 0, agentsAt + COLLECT_MS);
    basis.push(
      `${live.length} agent${live.length === 1 ? '' : 's'} running${unknownAgents ? ` (${unknownAgents} with nothing similar in the history yet)` : ''}`,
    );
    if (unknownAgents) confidence = lower(confidence);
  }
  if (workAt !== null) workAt = Math.max(workAt, now);

  // shipping: stages of this turn add their typical time to its end; stages only asked for come after it
  const releaseMs = learnedReleaseMs(shipAll) ?? STAGE_MS.release;
  const stageMs = (k: ShipStage) => (k === 'release' ? releaseMs : STAGE_MS[k]);
  const stages: StageEta[] = [];
  const endOf = (ev: ShipEvent[]) => Math.max(...ev.map((e) => e.endAt ?? e.at));
  const workDone = over || (!!steps && work.length > 0 && work.every((r) => r.status === 'done'));
  stages.push({
    key: 'work',
    state: workDone ? 'done' : 'active',
    plan: 'turn',
    at: over ? null : workAt,
    note: stepsInfo ? `${stepsInfo.done} of ${stepsInfo.total} steps` : live.length ? `${live.length} agent${live.length === 1 ? '' : 's'}` : '',
  });
  const laterDone = (k: ShipStage) => SHIP_STAGES.slice(SHIP_STAGES.indexOf(k) + 1).some((x) => st[x].done.length > 0);
  let t = workAt;
  for (const key of SHIP_STAGES) {
    const s = st[key];
    if (!plan.inTurn[key]) continue;
    if (s.done.length) {
      stages.push({ key, state: 'done', plan: 'turn', at: endOf(s.done), note: stageNote(key, 'done', s.ev) });
    } else if (laterDone(key)) {
      stages.push({ key, state: 'skipped', plan: 'turn', at: null, note: '' });
    } else if (over) {
      stages.push({ key, state: s.failed ? 'failed' : s.ev.length ? 'active' : 'pending', plan: 'turn', at: null, note: stageNote(key, 'over', s.ev) });
    } else if (s.running.length || s.ok.length) {
      // under way (a release build, or a draft waiting to be published): counts down from when it started
      const since = Math.min(...(s.running.length ? s.running : s.ok).map((e) => e.at));
      t = Math.max(t ?? now, now + Math.max(key === 'release' ? 30_000 : 10_000, stageMs(key) - (now - since)));
      stages.push({ key, state: 'active', plan: 'turn', at: t, note: stageNote(key, 'active', s.ev) });
    } else {
      t = t === null ? null : t + stageMs(key);
      stages.push({ key, state: s.failed ? 'failed' : 'pending', plan: 'turn', at: t, note: stageNote(key, 'pending', s.ev) });
    }
  }
  const finishAt = over ? Math.max(t0, main?.endedAt ?? 0, ...marks.map((m) => m.at ?? 0), ...ship.map((e) => e.endAt ?? e.at)) : t;
  // asked for but not part of this turn: after its end, once the user says go
  let tl = over ? now : finishAt;
  for (const key of SHIP_STAGES) {
    if (plan.inTurn[key] || !plan.asked[key]) continue;
    tl = tl === null ? null : tl + stageMs(key);
    stages.push({ key, state: 'pending', plan: 'later', at: tl, note: 'after your go-ahead' });
  }
  if (finishLine !== 'turn') {
    const left = stages.filter((s) => s.key !== 'work' && (s.state === 'pending' || s.state === 'active'));
    const inTurn = left.filter((s) => s.plan === 'turn').map((s) => s.key);
    const later = left.filter((s) => s.plan === 'later').map((s) => s.key);
    if (inTurn.length && !over) basis.push(`then ${inTurn.join(' → ')}${inTurn.includes('release') ? ` (a release takes about ${minutes(releaseMs)})` : ''}`);
    if (later.length) basis.push(`${later.join(' → ')} asked for but not on the task list: usually a later turn, after your go-ahead`);
  }
  const lineStage = stages.find((s) => s.key === finishLine);
  const shipAt = finishLine === 'turn' ? null : (lineStage?.at ?? null);

  let low: number | null = null;
  let high: number | null = null;
  let fraction: number | null = null;
  if (over) {
    confidence = 'high';
    low = high = finishAt;
    fraction = 1;
  } else if (finishAt !== null) {
    const rem = Math.max(0, finishAt - now);
    const [lo, hi] = SPREAD[confidence];
    low = now + rem * lo;
    high = now + rem * hi;
    fraction = clamp((now - t0) / Math.max(1, finishAt - t0), 0.01, 0.98);
  }
  return {
    startedAt: t0,
    state,
    finishAt,
    low,
    high,
    workAt: over ? null : workAt,
    fraction,
    confidence,
    finishLine,
    shipAt,
    stages,
    agents: marks,
    steps: stepsInfo,
    basis,
  };
}

function stageNote(key: ShipStage, phase: 'done' | 'active' | 'pending' | 'over', ev: ShipEvent[]): string {
  if (key === 'release') {
    if (phase === 'done') return 'published';
    if (ev.some((e) => e.kind === 'publish' && e.endAt === null)) return 'publishing';
    if (ev.some((e) => e.kind === 'release' && e.endAt === null)) return 'building';
    if (ev.some((e) => e.kind === 'release' && okEvent(e))) return phase === 'over' ? 'draft, not published' : 'draft uploaded';
    return '';
  }
  if (key === 'push' && ev.some((e) => e.kind === 'pr')) return phase === 'done' ? 'PR opened' : 'PR';
  if (phase === 'done') return key === 'push' ? 'on GitHub' : 'committed';
  return '';
}

function minutes(ms: number): string {
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const m = Math.round(ms / 60_000);
  return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
