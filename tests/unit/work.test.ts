import { describe, expect, it } from 'vitest';
import { isWorking, quietAfterMs, workCounts, workingIds, workText, type WorkAgent } from '../../src/core/work';

const NOW = 1_800_000_000_000;
const SEC = 1000;

function agent(id: string, over: Partial<WorkAgent> = {}): WorkAgent {
  return {
    id,
    parentId: id === 'main' ? null : 'main',
    kind: id === 'main' ? 'main' : 'agent',
    status: 'running',
    currentTool: null,
    lastActivity: NOW - 5 * SEC,
    ...over,
  };
}
const rec = (list: WorkAgent[]): Record<string, WorkAgent> => Object.fromEntries(list.map((a) => [a.id, a]));

describe('is an agent working', () => {
  it('yes with a tool call in flight, however long it has been', () => {
    expect(isWorking(agent('a', { currentTool: { name: 'Bash' }, lastActivity: NOW - 40 * 60 * SEC }), NOW)).toBe(true);
  });
  it('yes shortly after its last output, no once it has gone quiet', () => {
    expect(isWorking(agent('a', { lastActivity: NOW - 30 * SEC }), NOW)).toBe(true);
    expect(isWorking(agent('a', { lastActivity: NOW - quietAfterMs('agent') - SEC }), NOW)).toBe(false);
    expect(isWorking(agent('main', { lastActivity: NOW - quietAfterMs('main') - SEC }), NOW)).toBe(false);
  });
  it('no while it only waits on the subagents it started', () => {
    expect(isWorking(agent('a', { currentTool: { name: 'Agent' } }), NOW, 2)).toBe(false);
    expect(isWorking(agent('a', { currentTool: { name: 'Workflow' } }), NOW, 1)).toBe(false);
    // the spawning call itself, before any child runs, is work
    expect(isWorking(agent('a', { currentTool: { name: 'Agent' } }), NOW, 0)).toBe(true);
    // no tool in flight and children running: between steps for a moment, then waiting
    expect(isWorking(agent('a', { lastActivity: NOW - 5 * SEC }), NOW, 1)).toBe(true);
    expect(isWorking(agent('a', { lastActivity: NOW - 60 * SEC }), NOW, 1)).toBe(false);
  });
  it('no while it waits on you, is idle or finished, or is a workflow group', () => {
    expect(isWorking(agent('a', { currentTool: { name: 'AskUserQuestion' } }), NOW)).toBe(false);
    expect(isWorking(agent('a', { currentTool: { name: 'ExitPlanMode' } }), NOW)).toBe(false);
    for (const status of ['waiting', 'idle', 'done', 'error'] as const)
      expect(isWorking(agent('a', { status, currentTool: { name: 'Bash' } }), NOW)).toBe(false);
    expect(isWorking(agent('wf:1', { kind: 'workflow', currentTool: { name: 'Bash' } }), NOW)).toBe(false);
  });
});

describe('work counts', () => {
  const agents = rec([
    agent('main', { currentTool: { name: 'Agent' } }), // waiting on its subagents
    agent('busy', { currentTool: { name: 'Read' } }),
    agent('thinking', { lastActivity: NOW - 10 * SEC }),
    agent('quiet', { lastActivity: NOW - 10 * 60 * SEC }),
    agent('asks', { status: 'waiting' }),
    agent('parked', { status: 'idle' }),
    agent('done', { status: 'done' }),
    agent('failed', { status: 'error' }),
    agent('wf:1', { kind: 'workflow' }),
  ]);
  it('separates agents doing something from ones that are merely still open', () => {
    expect(workCounts(agents, NOW)).toEqual({ working: 2, idle: 4, finished: 2, total: 8 });
    expect([...workingIds(agents, NOW)].sort()).toEqual(['busy', 'thinking']);
  });
  it('time alone turns a working agent idle', () => {
    expect(workCounts(agents, NOW + 10 * 60 * SEC)).toMatchObject({ working: 1, idle: 5 });
  });
  it('a main agent waiting for the next prompt is a finished turn, not an idle agent', () => {
    expect(workCounts(rec([agent('main', { status: 'idle' })]), NOW)).toEqual({ working: 0, idle: 0, finished: 1, total: 1 });
  });
  it('reads as a short phrase', () => {
    expect(workText({ working: 3, idle: 2, finished: 0, total: 5 })).toBe('3 working · 2 idle');
    expect(workText({ working: 0, idle: 2, finished: 0, total: 2 })).toBe('none working · 2 idle');
    expect(workText({ working: 1, idle: 0, finished: 4, total: 5 })).toBe('1 working');
  });
});
