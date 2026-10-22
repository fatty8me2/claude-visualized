import type { SessionView } from './state';
// PLACEHOLDER: replaced at merge by the real implementation (same interface).
export interface SessionInsights {
  toolsPerMin: number[];
  topTools: { name: string; count: number }[];
  recentFiles: { path: string; agentId: string; ts: number | null }[];
  recentErrors: { ts: number; agentId: string; text: string }[];
  burn: { tokensPerMin: number; toolsPerMin: number; costPerHour: number | null };
  context: { pct: number | null; growthPerMin: number | null; minutesToCompact: number | null };
  goalMix: { goal: string; running: number; done: number; error: number }[];
  agents: { running: number; waiting: number; done: number; error: number; total: number };
  uptimeMs: number;
  busyShare: number | null;
}
export function sessionInsights(view: SessionView, now: number): SessionInsights {
  const toolsPerMin = new Array<number>(30).fill(0);
  const agents = { running: 0, waiting: 0, done: 0, error: 0, total: 0 };
  const tools = new Map<string, number>();
  const files: SessionInsights['recentFiles'] = [];
  for (const a of Object.values(view.agents)) {
    agents.total++;
    if (a.status === 'running') agents.running++;
    else if (a.status === 'waiting') agents.waiting++;
    else if (a.status === 'error') agents.error++;
    else if (a.status === 'done') agents.done++;
    for (const ts of a.activity) {
      const i = 29 - Math.floor((now - ts) / 60_000);
      if (i >= 0 && i < 30) toolsPerMin[i]++;
    }
    for (const r of a.recent) tools.set(r.name, (tools.get(r.name) ?? 0) + 1);
    for (const f of a.files) files.push({ path: f, agentId: a.id, ts: null });
  }
  return {
    toolsPerMin,
    topTools: [...tools]
      .map(([name, count]) => ({ name, count }))
      .sort((x, y) => y.count - x.count)
      .slice(0, 6),
    recentFiles: files.reverse().slice(0, 8),
    recentErrors: [],
    burn: { tokensPerMin: 0, toolsPerMin: toolsPerMin.slice(-5).reduce((x, y) => x + y, 0) / 5, costPerHour: null },
    context: { pct: null, growthPerMin: null, minutesToCompact: null },
    goalMix: [],
    agents,
    uptimeMs: view.startedAt ? now - view.startedAt : 0,
    busyShare: null,
  };
}
