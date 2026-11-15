// "How many agents are actually doing something right now?" An agent whose status is still "running" may be sitting on its hands:
// waiting for its subagents, waiting for you, or simply quiet. Every count in the app goes through here so they all agree. Pure.

export interface WorkAgent {
  id: string;
  parentId: string | null;
  kind: 'main' | 'agent' | 'workflow';
  status: 'running' | 'waiting' | 'idle' | 'done' | 'error';
  currentTool: { name: string } | null;
  lastActivity: number;
}

/** A running agent with no tool in flight that has written nothing for this long is quiet, not busy. */
export const quietAfterMs = (kind: WorkAgent['kind']): number => (kind === 'main' ? 90_000 : 180_000);

/** With subagents running and no tool in flight, an agent is between steps only for a moment; after this it is waiting on them. */
const BETWEEN_STEPS_MS = 20_000;

/** tools that hand the work to someone else: the agent itself is waiting while they are in flight */
const SPAWN_TOOLS = new Set(['Agent', 'Task', 'Workflow']);
const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * True while the agent itself is doing something: a tool call in flight, or output within the quiet window.
 * Not working: finished, idle between turns, waiting on you, only waiting on its subagents, or quiet.
 */
export function isWorking(a: WorkAgent, now: number, runningChildren = 0): boolean {
  if (a.kind === 'workflow' || a.status !== 'running') return false;
  const t = a.currentTool;
  if (t) {
    if (ASK_TOOLS.has(t.name)) return false;
    return !(SPAWN_TOOLS.has(t.name) && runningChildren > 0);
  }
  const silent = now - a.lastActivity;
  if (runningChildren > 0) return silent <= BETWEEN_STEPS_MS;
  return silent <= quietAfterMs(a.kind);
}

export interface WorkCounts {
  /** agents doing something right now (the main agent included) */
  working: number;
  /** agents that are not finished but are not doing anything: waiting on subagents or on you, quiet, or between turns */
  idle: number;
  /** finished or failed */
  finished: number;
  /** all agents (workflow groups are not agents) */
  total: number;
}

/** Children still running, per parent id. */
export function runningChildren(agents: Readonly<Record<string, WorkAgent>>): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of Object.values(agents)) {
    if (!c.parentId || c.parentId === c.id || c.status !== 'running') continue;
    m.set(c.parentId, (m.get(c.parentId) ?? 0) + 1);
  }
  return m;
}

/** Ids of the agents working right now. */
export function workingIds(agents: Readonly<Record<string, WorkAgent>>, now: number): Set<string> {
  const kids = runningChildren(agents);
  const out = new Set<string>();
  for (const a of Object.values(agents)) if (isWorking(a, now, kids.get(a.id) ?? 0)) out.add(a.id);
  return out;
}

export function workCounts(agents: Readonly<Record<string, WorkAgent>>, now: number): WorkCounts {
  const kids = runningChildren(agents);
  const c: WorkCounts = { working: 0, idle: 0, finished: 0, total: 0 };
  for (const a of Object.values(agents)) {
    if (a.kind === 'workflow') continue;
    c.total++;
    if (a.status === 'done' || a.status === 'error') c.finished++;
    else if (isWorking(a, now, kids.get(a.id) ?? 0)) c.working++;
    // a main agent waiting for your next prompt is not an idle agent, it is a finished turn
    else if (a.kind === 'main' && a.status === 'idle') c.finished++;
    else c.idle++;
  }
  return c;
}

export function addCounts(a: WorkCounts, b: WorkCounts): WorkCounts {
  return { working: a.working + b.working, idle: a.idle + b.idle, finished: a.finished + b.finished, total: a.total + b.total };
}

/** "3 working · 2 idle", "none working · 2 idle", "none working" */
export function workText(c: WorkCounts): string {
  const w = c.working ? `${c.working} working` : 'none working';
  return c.idle ? `${w} · ${c.idle} idle` : w;
}

/** For tooltips: what the two numbers mean. */
export const WORK_HELP =
  'Working: an agent with a tool call in flight or output in the last minutes. Idle: still open but doing nothing itself (waiting on its subagents, waiting on you, or quiet).';
