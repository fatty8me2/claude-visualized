import { describe, expect, it } from 'vitest';
import {
  MAX_RIPPLES,
  RIPPLE,
  addRipple,
  bandAt,
  dustAlpha,
  frameInterval,
  gridLayer,
  planRipples,
  pruneRipples,
  rippleFront,
  shockPush,
  spawnDust,
  stepDust,
  sweepPos,
  type Dust,
  type Ripple,
} from '../../src/core/backdrop';

const rip = (t0: number, kind: Ripple['kind'] = 'spawn'): Ripple => ({ kind, x: 0, y: 0, t0, tone: 'opus' });

describe('gridLayer', () => {
  it('sticks to the cards at depth 1 and zooms with them', () => {
    const a = gridLayer({ x: 100, y: 50 }, 1, 22, 1);
    expect(a.step).toBe(22);
    expect(a.ox).toBeCloseTo(100 % 22);
    const z = gridLayer({ x: 100, y: 50 }, 2, 22, 1);
    expect(z.step).toBe(44);
  });
  it('lags behind when panning at lower depth', () => {
    const near = gridLayer({ x: 10, y: 0 }, 1, 40, 1);
    const far = gridLayer({ x: 10, y: 0 }, 1, 40, 0.5);
    const near2 = gridLayer({ x: 30, y: 0 }, 1, 40, 1);
    const far2 = gridLayer({ x: 30, y: 0 }, 1, 40, 0.5);
    expect(near2.ox - near.ox).toBeCloseTo(20);
    expect(far2.ox - far.ox).toBeCloseTo(10);
  });
  it('zooms less at lower depth and never packs dots below the minimum', () => {
    expect(gridLayer({ x: 0, y: 0 }, 4, 20, 0.5).step).toBeCloseTo(40);
    const tiny = gridLayer({ x: 0, y: 0 }, 0.25, 22, 1, 14);
    expect(tiny.step).toBeGreaterThanOrEqual(14);
    expect(tiny.doublings).toBe(2);
    expect(tiny.step).toBeCloseTo(22);
  });
  it('keeps the offset inside one step for negative origins', () => {
    const l = gridLayer({ x: -105, y: -3 }, 1, 22, 1);
    expect(l.ox).toBeGreaterThanOrEqual(0);
    expect(l.ox).toBeLessThan(22);
    expect(l.ox).toBeCloseTo(-105 + 5 * 22);
    expect(l.i0).toBe(5);
  });
});

describe('ripples', () => {
  it('expands, then fades out and is pruned', () => {
    const r = rip(1000);
    const a = rippleFront(r, 1100);
    const b = rippleFront(r, 1800);
    expect(b.radius).toBeGreaterThan(a.radius);
    expect(b.strength).toBeLessThan(a.strength);
    expect(rippleFront(r, 1000 + RIPPLE.spawn.life).strength).toBe(0);
    expect(pruneRipples([r], 1500)).toHaveLength(1);
    expect(pruneRipples([r], 1000 + RIPPLE.spawn.life + 1)).toHaveLength(0);
  });
  it('stops growing at its reach and caps the list', () => {
    expect(rippleFront(rip(0, 'done'), RIPPLE.done.life - 1).radius).toBeLessThanOrEqual(RIPPLE.done.reach);
    let l: Ripple[] = [];
    for (let i = 0; i < MAX_RIPPLES + 5; i++) l = addRipple(l, rip(i));
    expect(l).toHaveLength(MAX_RIPPLES);
    expect(l[l.length - 1].t0).toBe(MAX_RIPPLES + 4);
  });
  it('lights a band around the front only', () => {
    expect(bandAt(200, 200, 60)).toBe(1);
    expect(bandAt(100, 200, 60)).toBe(0);
    expect(bandAt(230, 200, 60)).toBeGreaterThan(0);
    expect(bandAt(230, 200, 60)).toBeLessThan(1);
  });
  it('pushes the grid out and in around an error front, nowhere else', () => {
    const w = RIPPLE.error.width;
    expect(shockPush(1000, 100, 1)).toBe(0);
    expect(shockPush(100 + w * 0.25, 100, 1)).toBeGreaterThan(0);
    expect(shockPush(100 - w * 0.25, 100, 1)).toBeLessThan(0);
  });
  it('maps a transition plan to ripples at the agents, skipping unknown ones', () => {
    const pos = new Map([
      ['a', { x: 1, y: 2 }],
      ['b', { x: 3, y: 4 }],
    ]);
    const fam = new Map([['a', 'sonnet']]);
    const out = planRipples({ spawn: ['a', 'zz'], ret: [{ id: 'b', err: true }] }, pos, fam, 5);
    expect(out).toEqual([
      { kind: 'spawn', x: 1, y: 2, t0: 5, tone: 'sonnet' },
      { kind: 'error', x: 3, y: 4, t0: 5, tone: 'err' },
    ]);
  });
});

describe('dust and pacing', () => {
  const targets = [{ x: 500, y: 300 }];
  const seq = (...v: number[]) => {
    let i = 0;
    return () => v[i++ % v.length];
  };
  it('spawns away from a running agent and drifts in until it arrives', () => {
    const d: Dust = { x: 0, y: 0, target: 0, born: 0, speed: 0, swirl: 0 };
    spawnDust(d, targets, seq(0, 0, 0.5, 0.5, 0.5), 0);
    expect(Math.hypot(d.x - 500, d.y - 300)).toBeGreaterThan(150);
    let steps = 0;
    while (stepDust(d, targets, 0.05) && steps < 2000) steps++;
    expect(steps).toBeGreaterThan(5);
    expect(steps).toBeLessThan(2000);
    expect(Math.hypot(d.x - 500, d.y - 300)).toBeLessThan(40);
  });
  it('fades in after birth and out near the target', () => {
    const d: Dust = { x: 900, y: 300, target: 0, born: 0, speed: 50, swirl: 0 };
    expect(dustAlpha(d, targets, 0)).toBe(0);
    expect(dustAlpha(d, targets, 800)).toBe(1);
    d.x = 520;
    expect(dustAlpha(d, targets, 800)).toBeLessThan(0.3);
  });
  it('drops the frame rate under load and sweeps rarely', () => {
    expect(frameInterval(3, false)).toBeGreaterThan(frameInterval(3, true));
    expect(frameInterval(20, true)).toBeGreaterThan(frameInterval(3, true));
    expect(sweepPos(0)).toBe(0);
    expect(sweepPos(3500)).toBeCloseTo(0.5);
    expect(sweepPos(15000)).toBe(-1);
  });
});
