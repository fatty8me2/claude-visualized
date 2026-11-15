import { describe, expect, it } from 'vitest';
import { apply } from '@core/reducer';
import { MAIN, newSession } from '@core/state';
import { normalizeLine } from '@core/normalize';
import { workCounts } from '@core/work';
import type { AgentEvent } from '@core/events';

const T = Date.parse('2026-11-15T12:00:00Z');
const SID = 's1';

/** the line Claude Code writes when a request is refused: a usage limit, a sign-in failure */
const limitLine = (ts: number) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(ts).toISOString(),
    sessionId: SID,
    isApiErrorMessage: true,
    error: 'rate_limit',
    message: {
      id: 'm1',
      model: '<synthetic>',
      role: 'assistant',
      stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: "You've hit your 5-hour limit" }],
    },
  });

function fold(events: AgentEvent[]) {
  let s = newSession(SID);
  for (const e of events) s = apply(s, e);
  return s;
}
const ref = (agentId: string | null) => ({ sessionId: SID, agentId });
const start = (ts: number, agentId: string | null, id: string): AgentEvent => ({
  k: 'tool.start',
  ts,
  src: 'transcript',
  ref: ref(agentId),
  toolUseId: id,
  name: 'Bash',
  input: {},
});

describe('an agent stopped by an API error', () => {
  it('a subagent cut off by a usage limit is over, not open and quiet', () => {
    const s = fold([start(T, 'sub', 't1'), ...normalizeLine(limitLine(T + 1000), { sessionId: SID, agentId: 'sub' })]);
    expect(s.agents.sub).toMatchObject({ status: 'error', currentTool: null });
    expect(workCounts(s.agents, T + 2000)).toMatchObject({ working: 0, idle: 0 });
  });

  it('the main agent goes back to waiting for a prompt', () => {
    const s = fold([start(T, null, 't1'), ...normalizeLine(limitLine(T + 1000), { sessionId: SID, agentId: null })]);
    expect(s.agents[MAIN]).toMatchObject({ status: 'idle', currentTool: null });
  });

  it('an agent that carries on afterwards is running again', () => {
    const s = fold([start(T, 'sub', 't1'), ...normalizeLine(limitLine(T + 1000), { sessionId: SID, agentId: 'sub' }), start(T + 60_000, 'sub', 't2')]);
    expect(s.agents.sub.status).toBe('running');
  });
});
