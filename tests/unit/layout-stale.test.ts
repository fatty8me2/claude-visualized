import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, layoutAgents } from '@core/layout';
import { MAIN, newAgent, type AgentNode } from '@core/state';

const T = Date.parse('2026-11-17T12:00:00Z');
const MIN = 60_000;

function agent(id: string, status: AgentNode['status'], endedAt: number | null): AgentNode {
  const a = newAgent(id, 'agent', T - 60 * MIN, MAIN);
  a.status = status;
  a.endedAt = endedAt;
  a.lastActivity = endedAt ?? T;
  return a;
}

const agents = (): Record<string, AgentNode> => {
  const main = newAgent(MAIN, 'main', T - 60 * MIN, null);
  return {
    [MAIN]: main,
    old1: agent('old1', 'done', T - 40 * MIN),
    old2: agent('old2', 'done', T - 30 * MIN),
    fresh: agent('fresh', 'done', T - MIN),
    live: agent('live', 'running', null),
  };
};
const cards = (l: ReturnType<typeof layoutAgents>) => l.nodes.filter((n) => !n.collapsed).map((n) => n.id);
const chip = (l: ReturnType<typeof layoutAgents>) => l.nodes.find((n) => n.collapsed)?.collapsed;

describe('finished agents from earlier work fold away', () => {
  it('agents that ended before the cutoff go into the chip, recent and running ones stay', () => {
    const l = layoutAgents(agents(), { ...DEFAULT_LAYOUT, staleBefore: T - 10 * MIN });
    expect(cards(l).sort()).toEqual(['fresh', 'live', MAIN].sort());
    expect(chip(l)).toMatchObject({ count: 2, parentId: MAIN });
    expect(chip(l)!.ids.sort()).toEqual(['old1', 'old2']);
  });

  it('opening the chip shows them again', () => {
    const l = layoutAgents(agents(), { ...DEFAULT_LAYOUT, staleBefore: T - 10 * MIN, expanded: new Set([MAIN]) });
    expect(cards(l)).toHaveLength(5);
    expect(chip(l)).toBeUndefined();
  });

  it('without a cutoff nothing changes for a small group', () => {
    expect(cards(layoutAgents(agents(), DEFAULT_LAYOUT))).toHaveLength(5);
  });
});
