// The overview must not shake: its zoom does not bounce as agents spawn and fold away, and tiny size changes (sub-pixel
// rounding, a scrollbar flickering) do not re-flow the tree.
import { describe, expect, it } from 'vitest';
import { steadySize, stickyScale } from '@core/graphZoom';

describe('stickyScale', () => {
  it('starts at the fit', () => {
    expect(stickyScale(null, 0.8, 0)).toEqual({ scale: 0.8, upSince: null });
  });
  it('zooms out at once when the tree grows', () => {
    expect(stickyScale({ scale: 1, upSince: null }, 0.7, 10)).toEqual({ scale: 0.7, upSince: null });
  });
  it('zooms back in only after the larger fit has held for 20 s', () => {
    let z = stickyScale({ scale: 0.7, upSince: null }, 1, 1000);
    expect(z).toEqual({ scale: 0.7, upSince: 1000 });
    z = stickyScale(z, 1, 15_000);
    expect(z.scale).toBe(0.7);
    z = stickyScale(z, 1, 21_000);
    expect(z).toEqual({ scale: 1, upSince: null });
  });
  it('a worker that spawns and folds away again does not zoom the panel in and out', () => {
    let z = stickyScale(null, 0.9, 0);
    z = stickyScale(z, 0.75, 1000); // a worker spawns: zoom out
    z = stickyScale(z, 0.9, 31_000); // it folds away 30 s later: a zoom-in is pending
    z = stickyScale(z, 0.75, 40_000); // the next worker spawns before it happens: no change at all
    expect(z).toEqual({ scale: 0.75, upSince: null });
  });
  it('a resized panel re-fits at once, zooming in too', () => {
    const v1 = { w: 800, h: 600 };
    let z = stickyScale(null, 0.7, 0, 20_000, v1);
    z = stickyScale(z, 0.7, 1000, 20_000, v1);
    expect(z.scale).toBe(0.7);
    z = stickyScale(z, 1, 2000, 20_000, { w: 1200, h: 900 });
    expect(z.scale).toBe(1);
  });
  it('ignores differences under 2%', () => {
    expect(stickyScale({ scale: 1, upSince: null }, 0.99, 5)).toEqual({ scale: 1, upSince: null });
    expect(stickyScale({ scale: 0.5, upSince: null }, 0.505, 5)).toEqual({ scale: 0.5, upSince: null });
  });
});

describe('steadySize', () => {
  it('keeps the old size for changes under 2 px', () => {
    expect(steadySize(800, 801)).toBe(800);
    expect(steadySize(800, 799.4)).toBe(800);
    expect(steadySize(800, 815)).toBe(815);
    expect(steadySize(0, 640)).toBe(640);
  });
});
