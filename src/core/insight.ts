// Glue for the UI: the goal and the "doing right now" phrase for one agent of a session.

import { describeActivity, type Activity } from './activity';
import { classifyGoal, type GoalResult } from './goal';
import type { AgentNode } from './state';

export interface AgentInsight {
  goal: GoalResult;
  activity: Activity;
}

export function childCounts(agents: Record<string, AgentNode>, id: string): { running: number; total: number } {
  let running = 0;
  let total = 0;
  for (const c of Object.values(agents)) {
    if (c.parentId !== id || c.id === id) continue;
    total++;
    if (c.status === 'running') running++;
  }
  return { running, total };
}

export function agentGoal(a: AgentNode, planMode = false): GoalResult {
  return classifyGoal({
    kind: a.kind,
    agentType: a.agentType,
    description: a.description,
    phase: a.phase,
    prompt: a.prompt,
    toolMix: a.toolMix,
    planMode: a.kind === 'main' && planMode,
  });
}

export function agentInsight(agents: Record<string, AgentNode>, a: AgentNode, now: number, planMode = false): AgentInsight {
  const { running, total } = childCounts(agents, a.id);
  return {
    goal: agentGoal(a, planMode),
    activity: describeActivity(a, { now, runningChildren: running, totalChildren: total }),
  };
}
