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

describe('with finished agents hidden (the default)', () => {
  // a running reviewer with two finished auditors and one on standby under it, like an audit round
  const tree = (): Record<string, AgentNode> => {
    const a = agents();
    const sub = (id: string, status: AgentNode['status']) => ({ ...agent(id, status, status === 'done' ? T - MIN : null), parentId: 'live' });
    return { ...a, d1: sub('d1', 'done'), d2: sub('d2', 'done'), idle: sub('idle', 'idle') };
  };
  const hidden = { ...DEFAULT_LAYOUT, showFinished: false };

  it('folds agents the moment they finish, at every level; running and standby agents stay', () => {
    const l = layoutAgents(tree(), hidden);
    expect(cards(l).sort()).toEqual(['idle', 'live', MAIN].sort());
    const chips = l.nodes.filter((n) => n.collapsed).map((n) => n.collapsed!);
    expect(chips.find((c) => c.parentId === 'live')!.ids.sort()).toEqual(['d1', 'd2']);
    expect(chips.find((c) => c.parentId === MAIN)!.ids.sort()).toEqual(['fresh', 'old1', 'old2']);
  });

  it('a chip the user opened stays open', () => {
    const l = layoutAgents(tree(), { ...hidden, expanded: new Set(['live']) });
    expect(cards(l)).toEqual(expect.arrayContaining(['d1', 'd2', 'idle']));
    expect(l.nodes.some((n) => n.collapsed?.parentId === 'live')).toBe(false);
  });
});
