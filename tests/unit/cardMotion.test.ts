import { describe, expect, it } from 'vitest';
import type { Layout, LayoutNode } from '../../src/core/layout';
import { LIMITS, makeSnap, planMotion } from '../../src/renderer/cardMotion';

type A = { status: string; parentId: string | null };
const agent = (status: string, parentId: string | null = 'main'): A => ({ status, parentId });
const node = (id: string, x: number, y = 100, collapsed?: LayoutNode['collapsed']): LayoutNode => ({ id, x, y, w: 240, h: 180, collapsed });
const layout = (...nodes: LayoutNode[]): Layout => ({ nodes, edges: [], width: 1000, height: 400 });

const snap = (agents: Record<string, A>, nodes: LayoutNode[], sid = 's1') => makeSnap(sid, agents, layout(...nodes));
const MAIN = node('main', 380, 0);

describe('planMotion', () => {
  it('plays nothing for the first snapshot and after a session switch', () => {
    const a = snap({ main: agent('running', null), a1: agent('done') }, [MAIN, node('a1', 0)]);
    expect(planMotion(null, a)).toEqual({ moves: [], bulk: true });
    expect(planMotion(snap({ main: agent('running', null) }, [MAIN], 'other'), a).moves).toEqual([]);
  });

  it('spawns a new agent from its parent, with a glow', () => {
    const before = snap({ main: agent('running', null) }, [MAIN]);
    const after = snap({ main: agent('running', null), a1: agent('running') }, [MAIN, node('a1', 380)]);
    const { moves } = planMotion(before, after);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ kind: 'spawn', id: 'a1', glow: true, dx: 0 });
    expect((moves[0] as { dy: number }).dy).toBeLessThan(0);
  });

  it('glides existing cards that moved when a sibling arrives', () => {
    const before = snap({ main: agent('running', null), a1: agent('running') }, [MAIN, node('a1', 380)]);
    const after = snap({ main: agent('running', null), a1: agent('running'), a2: agent('running') }, [MAIN, node('a1', 120), node('a2', 400)]);
    const moves = planMotion(before, after).moves;
    expect(moves).toContainEqual({ kind: 'glide', id: 'a1', dx: 260, dy: 0 });
    expect(moves.find((m) => m.kind === 'spawn')).toMatchObject({ id: 'a2' });
  });

  it('flags done, failed and waiting transitions of visible cards only', () => {
    const agents = (s: string) => ({ main: agent('running', null), a1: agent(s), a2: agent('running'), a3: agent('running') });
    const nodes = [MAIN, node('a1', 0), node('a2', 250)];
    const before = snap(agents('running'), [...nodes, node('a3', 500)]);
    const after = snap({ ...agents('done'), a2: agent('error'), a3: agent('done') }, nodes);
    const moves = planMotion(before, after).moves.filter((m) => m.kind === 'status');
    expect(moves).toEqual([
      { kind: 'status', id: 'a1', to: 'done' },
      { kind: 'status', id: 'a2', to: 'error' },
    ]);
    const waiting = planMotion(before, snap({ ...agents('waiting') }, [...nodes, node('a3', 500)])).moves;
    expect(waiting).toEqual([{ kind: 'status', id: 'a1', to: 'waiting' }]);
  });

  it('fans revealed cards out of the chip they were folded into, without a glow', () => {
    const agents = { main: agent('running', null), a1: agent('done'), a2: agent('done') };
    const chip = node('collapsed:main', 380, 100, { count: 2, ids: ['a1', 'a2'], parentId: 'main' });
    const folded = snap(agents, [MAIN, chip]);
    const open = snap(agents, [MAIN, node('a1', 100), node('a2', 400)]);
    const { moves } = planMotion(folded, open);
    const spawns = moves.filter((m) => m.kind === 'spawn');
    expect(spawns).toHaveLength(2);
    expect(spawns.every((m) => m.kind === 'spawn' && !m.glow)).toBe(true);
    expect(spawns[0]).toMatchObject({ id: 'a1', dx: 380 - 100, dy: 0 });
    // and a chip appearing pops
    expect(planMotion(open, folded).moves).toEqual([{ kind: 'pop', id: 'collapsed:main' }]);
  });

  it('stays still for bulk changes: loading or scrubbing many agents at once', () => {
    const many = (n: number) => {
      const agents: Record<string, A> = { main: agent('running', null) };
      const nodes = [MAIN];
      for (let i = 0; i < n; i++) {
        agents[`k${i}`] = agent('running');
        nodes.push(node(`k${i}`, i * 10));
      }
      return snap(agents, nodes);
    };
    expect(planMotion(many(0), many(LIMITS.appear + 1))).toEqual({ moves: [], bulk: true });
    expect(planMotion(many(LIMITS.appear), many(LIMITS.appear)).bulk).toBe(false);
    // too many statuses at once
    const done = (s: string) => {
      const agents: Record<string, A> = { main: agent('running', null) };
      const nodes = [MAIN];
      for (let i = 0; i < LIMITS.status + 1; i++) {
        agents[`k${i}`] = agent(s);
        nodes.push(node(`k${i}`, i * 10));
      }
      return snap(agents, nodes);
    };
    expect(planMotion(done('running'), done('done'))).toEqual({ moves: [], bulk: true });
  });

  it('drops glides, but keeps the rest, when too many cards moved', () => {
    const n = LIMITS.glide + 5;
    const mk = (shift: number, extra: boolean) => {
      const agents: Record<string, A> = { main: agent('running', null) };
      const nodes = [MAIN];
      for (let i = 0; i < n; i++) {
        agents[`k${i}`] = agent('done');
        nodes.push(node(`k${i}`, i * 10 + shift));
      }
      if (extra) {
        agents.fresh = agent('running');
        nodes.push(node('fresh', 5000));
      }
      return snap(agents, nodes);
    };
    const moves = planMotion(mk(0, false), mk(30, true)).moves;
    expect(moves.map((m) => m.kind)).toEqual(['spawn']);
  });
});
