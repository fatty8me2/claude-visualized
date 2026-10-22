// Connectors must never run through or under a card. Property test over random trees plus the owner's screenshot case.
import { describe, expect, it } from 'vitest';
import { COMPACT_LAYOUT, DEFAULT_LAYOUT, layoutAgents, type Layout, type LayoutOptions } from '@core/layout';
import { MAIN, newAgent, type AgentNode, type AgentStatus } from '@core/state';

const CLEAR = 6;
const EPS = 0.02;

/** mulberry32 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTree(seed: number): Record<string, AgentNode> {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const agents: Record<string, AgentNode> = { [MAIN]: newAgent(MAIN, 'main', 0, null) };
  agents[MAIN].status = 'running';
  let n = 0;
  const statuses: AgentStatus[] = ['running', 'done', 'done', 'done', 'error', 'waiting', 'idle'];
  const grow = (parent: string, depth: number) => {
    // mostly leaf-heavy groups (grids), sometimes a handful of nested subtrees
    const count = depth === 0 ? Math.floor(r() * 61) : r() < 0.35 ? Math.floor(r() * 61) : Math.floor(r() * 5);
    for (let i = 0; i < count; i++) {
      n++;
      const workflow = r() < 0.08;
      const id = workflow ? `wf:${n}` : `a${n}`;
      const a = newAgent(id, workflow ? 'workflow' : 'agent', n, parent);
      a.status = pick(statuses);
      agents[id] = a;
      if (depth < 3 && r() < (depth === 0 ? 0.25 : 0.2)) grow(id, depth + 1);
    }
  };
  grow(MAIN, 0);
  return agents;
}

type Rect = { x: number; y: number; w: number; h: number };

function gap(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
  return Math.hypot(dx, dy);
}

function check(lay: Layout, label: string) {
  const byId = new Map(lay.nodes.map((n) => [n.id, n]));
  // cards never overlap each other
  const nodes = lay.nodes;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[i].x < nodes[j].x + nodes[j].w && nodes[j].x < nodes[i].x + nodes[i].w && nodes[i].y < nodes[j].y + nodes[j].h && nodes[j].y < nodes[i].y + nodes[i].h)
        throw new Error(`${label}: cards ${nodes[i].id} and ${nodes[j].id} overlap`);
    }
  }
  for (const e of lay.edges) {
    const p = byId.get(e.from)!;
    const c = byId.get(e.to)!;
    const pts = e.geom.pts;
    const where = `${label}: edge ${e.from}->${e.to}`;
    expect(pts[0][0], where).toBeCloseTo(p.x + p.w / 2, 1);
    expect(pts[0][1], where).toBeCloseTo(p.y + p.h, 1);
    const last = pts[pts.length - 1];
    expect(last[0], where).toBeCloseTo(c.x + c.w / 2, 1);
    expect(last[1], where).toBeCloseTo(c.y, 1);
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1];
      const [bx, by] = pts[i];
      if (!(Math.abs(ax - bx) < EPS || Math.abs(ay - by) < EPS)) throw new Error(`${where}: segment ${i} is not axis-aligned`);
      const seg: Rect = { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(ax - bx), h: Math.abs(ay - by) };
      for (const n of nodes) {
        if (n.x > seg.x + seg.w + CLEAR || n.x + n.w < seg.x - CLEAR || n.y > seg.y + seg.h + CLEAR || n.y + n.h < seg.y - CLEAR) continue;
        // the stub leaving the parent and the stub entering the child touch their own card by design
        if (i === 1 && n.id === e.from) continue;
        if (i === pts.length - 1 && n.id === e.to) continue;
        const d = gap(seg, n);
        if (d < CLEAR) throw new Error(`${where}: segment ${i} (${ax},${ay})->(${bx},${by}) is ${d.toFixed(1)}px from card ${n.id}`);
      }
    }
  }
  // every non-main card has exactly one incoming edge
  const incoming = new Map<string, number>();
  for (const e of lay.edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  for (const n of nodes) if (n.id !== MAIN) expect(incoming.get(n.id), `${label}: ${n.id}`).toBe(1);
}

const optionSets: Array<[string, LayoutOptions]> = [
  ['default', DEFAULT_LAYOUT],
  ['compact', COMPACT_LAYOUT],
  ['default+expanded', { ...DEFAULT_LAYOUT, expanded: new Set([MAIN]) }],
  ['compact+hidden-finished', { ...COMPACT_LAYOUT, showFinished: false }],
  ['default+folded', { ...DEFAULT_LAYOUT, folded: new Set([MAIN]), collapseAbove: 100 }],
  ['default+extra', { ...DEFAULT_LAYOUT, maxCols: 4, gapX: 8 }],
  ['compact+3cols', { ...COMPACT_LAYOUT, maxCols: 3 }],
  ['wide-cols', { ...DEFAULT_LAYOUT, maxCols: 10 }],
];

describe('connector routing', () => {
  it('never runs a segment through or under a card (random trees)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const agents = randomTree(seed);
      for (const [name, opt] of optionSets) {
        const o = opt.expanded ? { ...opt, expanded: new Set(Object.keys(agents)) } : opt;
        check(layoutAgents(agents, o), `seed ${seed} ${name}`);
      }
    }
  }, 120_000);

  it('keeps the owner screenshot case readable: 9 running and 39 finished under main', () => {
    const agents: Record<string, AgentNode> = { [MAIN]: newAgent(MAIN, 'main', 0, null) };
    agents[MAIN].status = 'running';
    for (let i = 0; i < 48; i++) {
      const a = newAgent(`a${i}`, 'agent', i + 1, MAIN);
      a.status = i < 9 ? 'running' : 'done';
      agents[a.id] = a;
    }
    for (const [name, opt] of optionSets.slice(0, 2)) {
      const lay = layoutAgents(agents, opt);
      check(lay, name);
      // 9 running + the chip: two rows
      expect(lay.nodes.filter((n) => n.id !== MAIN)).toHaveLength(10);
      const topY = Math.min(...lay.edges.map((e) => e.geom.y2));
      const second = lay.edges.filter((e) => e.geom.y2 > topY + 1);
      expect(second).toHaveLength(10 - opt.maxCols);
      // second-row edges share one trunk gutter and one lane
      expect(new Set(second.map((e) => e.geom.pts[e.geom.pts.length - 3][1])).size).toBe(1);
    }
    // expanded: all 48 cards, 10 rows of grid
    const open = layoutAgents(agents, { ...DEFAULT_LAYOUT, expanded: new Set([MAIN]) });
    check(open, 'expanded');
    expect(open.nodes).toHaveLength(49);
  });
});
