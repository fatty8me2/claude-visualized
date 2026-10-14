import { describe, expect, it } from 'vitest';
import { newAgent, type AgentNode } from '../../src/core/state';
import {
  axisTicks,
  barEnd,
  bucketTicks,
  clampRange,
  eventIndexAt,
  fitRange,
  idleGaps,
  makeScale,
  orderLanes,
  panRange,
  pickStep,
  toolTimes,
  visibleRows,
  zoomRange,
} from '../../src/core/timeline';

function mk(id: string, parentId: string | null, start: number, kind: AgentNode['kind'] = 'agent', extra: Partial<AgentNode> = {}): AgentNode {
  return { ...newAgent(id, kind, start, parentId), ...extra };
}
const agents = (...l: AgentNode[]) => Object.fromEntries(l.map((a) => [a.id, a]));

describe('orderLanes', () => {
  it('puts main first, children under their parent by start time, with depth', () => {
    const a = agents(
      mk('main', null, 0, 'main'),
      mk('b', 'main', 20),
      mk('a', 'main', 10),
      mk('a1', 'a', 15),
      mk('wf:x', 'main', 30, 'workflow'),
      mk('w1', 'wf:x', 31),
    );
    const l = orderLanes(a);
    expect(l.map((x) => x.id)).toEqual(['main', 'a', 'a1', 'b', 'wf:x', 'w1']);
    expect(l.map((x) => x.depth)).toEqual([0, 1, 2, 1, 1, 2]);
    expect(l.find((x) => x.id === 'wf:x')!.hasChildren).toBe(true);
    expect(l.find((x) => x.id === 'wf:x')!.last).toBe(true);
    expect(l.find((x) => x.id === 'a')!.last).toBe(false);
  });
  it('hides the children of collapsed lanes', () => {
    const a = agents(mk('main', null, 0, 'main'), mk('wf:x', 'main', 1, 'workflow'), mk('w1', 'wf:x', 2), mk('w2', 'wf:x', 3));
    expect(orderLanes(a, new Set(['wf:x'])).map((x) => x.id)).toEqual(['main', 'wf:x']);
  });
  it('hangs orphans under main and survives cycles', () => {
    const a = agents(mk('main', null, 0, 'main'), mk('o', 'ghost', 5), mk('c1', 'c2', 6), mk('c2', 'c1', 7));
    const ids = orderLanes(a).map((x) => x.id);
    expect(ids[0]).toBe('main');
    expect(ids).toContain('o');
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('barEnd / fitRange', () => {
  it('uses endedAt, last activity for done or stale agents, now otherwise', () => {
    const now = 10_000_000;
    expect(barEnd(mk('a', null, 0, 'agent', { endedAt: 500 }), now)).toBe(500);
    expect(barEnd(mk('a', null, 0, 'agent', { status: 'done', lastActivity: 900 }), now)).toBe(900);
    expect(barEnd(mk('a', null, 0, 'agent', { status: 'running', lastActivity: now - 10 }), now)).toBe(now);
    expect(barEnd(mk('a', null, 0, 'agent', { status: 'running', lastActivity: 1000 }), now)).toBe(1000);
  });
  it('fits all agents with a little padding', () => {
    const r = fitRange(agents(mk('main', null, 1000, 'main', { endedAt: 11_000 })), 0)!;
    expect(r.t0).toBeLessThan(1000);
    expect(r.t1).toBeGreaterThan(11_000);
    expect(fitRange({}, 0)).toBeNull();
    expect(fitRange(agents(mk('main', null, 0, 'main')), 5)).toBeNull();
  });
});

describe('axis', () => {
  it('picks coarser steps for wider spans', () => {
    expect(pickStep(10_000, 900)).toBe(1000);
    expect(pickStep(3_600_000, 900)).toBe(10 * 60_000);
    expect(pickStep(86_400_000, 900)).toBeGreaterThanOrEqual(3_600_000);
  });
  it('makes ticks inside the range, ascending, aligned to the step, with wall-clock labels', () => {
    const t0 = new Date(2026, 9, 1, 10, 0, 3).getTime();
    const { step, ticks } = axisTicks({ t0, t1: t0 + 60_000 }, 900);
    expect(step).toBeLessThan(60_000);
    expect(ticks.length).toBeGreaterThan(3);
    for (const t of ticks) {
      expect(t.t).toBeGreaterThanOrEqual(t0);
      expect(t.t).toBeLessThanOrEqual(t0 + 60_000);
      expect(new Date(t.t).getSeconds() % (step / 1000)).toBe(0);
      expect(t.label).toMatch(/^\d\d:\d\d:\d\d$/);
    }
    const wide = axisTicks({ t0, t1: t0 + 3 * 3_600_000 }, 900);
    expect(wide.ticks[0].label).toMatch(/^\d\d:\d\d$/);
    expect(axisTicks({ t0, t1: t0 }, 900).ticks).toEqual([]);
  });
  it('scales both ways', () => {
    const s = makeScale({ t0: 1000, t1: 2000 }, 500);
    expect(s.x(1500)).toBe(250);
    expect(s.t(250)).toBe(1500);
  });
  it('zooms around the cursor and pans', () => {
    const r = { t0: 0, t1: 100_000 };
    const z = zoomRange(r, 2, 0.5);
    expect(z.t1 - z.t0).toBe(50_000);
    expect((z.t0 + z.t1) / 2).toBe(50_000);
    const z0 = zoomRange(r, 2, 0);
    expect(z0.t0).toBe(0);
    const deep = zoomRange(r, 1e9, 0.5);
    expect(deep.t1 - deep.t0).toBeGreaterThanOrEqual(2000);
    const p = panRange(r, -100, 1000);
    expect(p.t0).toBe(10_000);
    expect(p.t1 - p.t0).toBe(100_000);
  });
  it('keeps the view near the bounds', () => {
    const bounds = { t0: 0, t1: 1000 };
    const c = clampRange({ t0: 1e9, t1: 1e9 + 500 }, bounds);
    expect(c.t0).toBeLessThan(1e6);
    expect(c.t1 - c.t0).toBe(2000);
  });
});

describe('bucketTicks / idleGaps / toolTimes', () => {
  it('caps the tick count by merging close calls and keeps failures', () => {
    const times = Array.from({ length: 5000 }, (_, i) => i * 10);
    const b = bucketTicks(times, new Set([2500]), { t0: 0, t1: 50_000 }, 500, 4);
    expect(b.length).toBeLessThanOrEqual(500 / 4 + 2);
    expect(b.reduce((n, x) => n + x.n, 0)).toBe(5000);
    expect(b.filter((x) => x.fail).length).toBe(1);
  });
  it('keeps every call when zoomed in and drops those out of view', () => {
    const b = bucketTicks([0, 1000, 2000, 99_999_999], new Set(), { t0: 0, t1: 3000 }, 900, 4);
    expect(b.map((x) => x.t)).toEqual([0, 1000, 2000]);
  });
  it('finds idle gaps longer than 60 s, including at the ends', () => {
    expect(idleGaps([10_000, 20_000], 0, 30_000)).toEqual([]);
    expect(idleGaps([10_000, 200_000], 0, 205_000)).toEqual([[10_000, 200_000]]);
    expect(idleGaps([], 0, 120_000)).toEqual([[0, 120_000]]);
    expect(idleGaps([5], 10, 10)).toEqual([]);
  });
  it('merges activity and recent timestamps', () => {
    const recent = [
      { id: 'x', name: 'n', summary: '', ts: 3, ok: true },
      { id: 'y', name: 'n', summary: '', ts: 9, ok: false },
    ];
    expect(toolTimes({ activity: [5, 1, 3], recent })).toEqual([1, 3, 5, 9]);
  });
});

describe('visibleRows / eventIndexAt', () => {
  it('windows rows with overscan', () => {
    expect(visibleRows(0, 100, 20, 300, 2)).toEqual({ from: 0, to: 7 });
    expect(visibleRows(2000, 100, 20, 300, 2)).toEqual({ from: 98, to: 107 });
    expect(visibleRows(5900, 400, 20, 300, 2).to).toBe(300);
  });
  it('maps a time to a replay index', () => {
    const ts = [10, 20, 20, 30];
    expect(eventIndexAt(ts, 5)).toBe(0);
    expect(eventIndexAt(ts, 20)).toBe(3);
    expect(eventIndexAt(ts, 99)).toBe(4);
  });
});
