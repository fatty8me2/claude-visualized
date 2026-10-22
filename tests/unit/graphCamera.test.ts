import { describe, expect, it } from 'vitest';
import { CAMERA, centerOn, clampScroll, easeInOutCubic, edgeChip, intersects, mapToScroll, minimapSize, moveDuration, needsMap, pickOffscreen, spreadChips } from '@core/graphCamera';

const view = { w: 800, h: 600 };
const content = { w: 2000, h: 1500 };

describe('graph camera math', () => {
  it('eases from 0 to 1 and clamps', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
    expect(easeInOutCubic(-3)).toBe(0);
    expect(easeInOutCubic(9)).toBe(1);
  });
  it('clamps scroll into the content', () => {
    expect(clampScroll({ left: -5, top: 9999 }, content, view)).toEqual({ left: 0, top: 900 });
    expect(clampScroll({ left: 10, top: 10 }, { w: 500, h: 400 }, view)).toEqual({ left: 0, top: 0 });
  });
  it('centres a card in the free view, leaving the drawer side clear', () => {
    const card = { x: 1000, y: 700, w: 200, h: 100 };
    expect(centerOn(card, content, view)).toEqual({ left: 700, top: 450 });
    expect(centerOn(card, content, view, 400)).toEqual({ left: 900, top: 450 });
    expect(centerOn({ x: 0, y: 0, w: 10, h: 10 }, content, view)).toEqual({ left: 0, top: 0 });
  });
  it('lasts longer for longer moves, within bounds', () => {
    expect(moveDuration(0)).toBe(CAMERA.minMs);
    expect(moveDuration(100000)).toBe(CAMERA.maxMs);
    expect(moveDuration(800)).toBeGreaterThan(moveDuration(100));
  });
  it('knows what is in view', () => {
    const box = { x: 900, y: 100, w: 100, h: 50 };
    expect(intersects(box, { left: 0, top: 0 }, view)).toBe(false);
    expect(intersects(box, { left: 300, top: 0 }, view)).toBe(true);
    expect(intersects(box, { left: 300, top: 0 }, view, 400)).toBe(false);
  });
  it('sizes the minimap to the content and maps clicks back', () => {
    const m = minimapSize(content);
    expect(m.w / m.h).toBeCloseTo(content.w / content.h, 1);
    expect(m.w).toBeLessThanOrEqual(CAMERA.mapW);
    expect(m.h).toBeLessThanOrEqual(CAMERA.mapH);
    const s = mapToScroll({ x: m.w / 2, y: m.h / 2 }, m.scale, content, view);
    expect(s.left).toBeCloseTo(content.w / 2 - view.w / 2, -1);
    expect(mapToScroll({ x: 0, y: 0 }, m.scale, content, view)).toEqual({ left: 0, top: 0 });
  });
  it('shows a map only when there is something to scroll to', () => {
    expect(needsMap({ w: 700, h: 500 }, view)).toBe(false);
    expect(needsMap(content, view)).toBe(true);
    expect(needsMap({ w: 802, h: 500 }, view)).toBe(false);
  });
  it('puts edge chips on the inset border, pointing at the target', () => {
    const right = edgeChip({ x: 5000, y: 300 }, view, 0);
    expect(right.x).toBeCloseTo(view.w - 14);
    expect(right.angle).toBeCloseTo(0, 1);
    const top = edgeChip({ x: 400, y: -4000 }, view, 0);
    expect(top.y).toBeCloseTo(52);
    expect(top.angle).toBeLessThan(0);
    const drawer = edgeChip({ x: 5000, y: 300 }, view, 400);
    expect(drawer.x).toBeCloseTo(view.w - 400 - 14);
    const inside = edgeChip({ x: 300, y: 300 }, view, 0);
    expect(inside.x).toBeCloseTo(300);
  });
  it('picks the nearest off-screen boxes', () => {
    const mk = (id: string, x: number, y: number) => ({ id, box: { x, y, w: 100, h: 50 } });
    const items = [mk('in', 100, 100), mk('far', 1800, 1400), mk('near', 900, 100), mk('mid', 1200, 700)];
    expect(pickOffscreen(items, { left: 0, top: 0 }, view, 0, 2).map((i) => i.id)).toEqual(['near', 'mid']);
  });
  it('spreads chips that share an edge so they do not overlap', () => {
    const bounds = { l: 14, t: 52, r: 786, b: 586 };
    const chips = [
      { x: 700, y: 52 },
      { x: 702, y: 52 },
      { x: 705, y: 52 },
    ];
    const sizes = chips.map(() => ({ w: 120, h: 22 }));
    const out = spreadChips(chips, sizes, bounds);
    for (let i = 1; i < out.length; i++) expect(out[i].x - out[i - 1].x).toBeGreaterThanOrEqual(120);
    expect(Math.max(...out.map((o) => o.x)) + 60).toBeLessThanOrEqual(bounds.r);
    expect(out.every((o) => o.y === 52)).toBe(true);
    // chips on different edges are left alone
    const two = spreadChips([{ x: 100, y: 52 }, { x: 786, y: 300 }], [{ w: 120, h: 22 }, { w: 120, h: 22 }], bounds);
    expect(two[1]).toEqual({ x: 786, y: 300 });
  });
});
