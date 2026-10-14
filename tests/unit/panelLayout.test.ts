import { describe, expect, it } from 'vitest';
import {
  ARRANGEMENTS,
  DEFAULT_LAYOUT,
  gridStyle,
  resizeDelta,
  sanitizeLayout,
  shuffled,
  slotOf,
  swapPanels,
  visibleAreas,
  type PanelLayout,
} from '@core/panelLayout';

function rectangular(grid: string[][]): boolean {
  for (const n of new Set(grid.flat())) {
    const cells = grid.flatMap((row, r) => row.flatMap((v, c) => (v === n ? [[r, c]] : [])));
    const rs = cells.map(([r]) => r),
      cs = cells.map(([, c]) => c);
    const area = (Math.max(...rs) - Math.min(...rs) + 1) * (Math.max(...cs) - Math.min(...cs) + 1);
    if (area !== cells.length) return false;
  }
  return true;
}

describe('panel layout', () => {
  it('every arrangement x hidden combination yields valid rectangular grid areas', () => {
    for (const a of ARRANGEMENTS)
      for (const mode of [false, true])
        for (const log of [false, true])
          for (const slots of [DEFAULT_LAYOUT.slots, { A: 'graph', B: 'log', C: 'mode' } as const, { A: 'log', B: 'mode', C: 'graph' } as const]) {
            const l: PanelLayout = { ...DEFAULT_LAYOUT, arrangement: a.id, slots: { ...slots }, hidden: { ...DEFAULT_LAYOUT.hidden, mode, log } };
            const g = visibleAreas(l);
            expect(rectangular(g), `${a.id} mode=${mode} log=${log} ${JSON.stringify(slots)}: ${JSON.stringify(g)}`).toBe(true);
            // hidden panels' slots are gone, the graph is always there
            const names = new Set(g.flat());
            expect(names.has(slotOf(l, 'graph'))).toBe(true);
            if (mode) expect(names.has(slotOf(l, 'mode'))).toBe(false);
            if (log) expect(names.has(slotOf(l, 'log'))).toBe(false);
            expect(gridStyle(l).gridTemplateAreas).toMatch(/^"/);
          }
  });

  it('swaps panels between slots', () => {
    const l = swapPanels(DEFAULT_LAYOUT, 'mode', 'log');
    expect(l.slots).toEqual({ A: 'log', B: 'graph', C: 'mode' });
    expect(swapPanels(l, 'log', 'log')).toBe(l);
  });

  it('repairs garbage from storage', () => {
    expect(sanitizeLayout(null)).toEqual(DEFAULT_LAYOUT);
    const s = sanitizeLayout({ arrangement: 'nope', slots: { A: 'mode', B: 'mode', C: 'log' }, side: 9999, dock: -5, sidebar: { side: 'right', width: 10 } });
    expect(s.arrangement).toBe('classic');
    expect(s.slots).toEqual(DEFAULT_LAYOUT.slots);
    expect(s.side).toBe(640);
    expect(s.dock).toBe(110);
    expect(s.sidebar).toEqual({ side: 'right', width: 200 });
  });

  it('resizes away from the panel', () => {
    expect(resizeDelta('right', 10, 0)).toBe(10);
    expect(resizeDelta('left', 10, 0)).toBe(-10);
    expect(resizeDelta('top', 0, -20)).toBe(20);
  });

  it('shuffle picks a different arrangement and a valid permutation', () => {
    let seed = 1;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 20; i++) {
      const s = shuffled(DEFAULT_LAYOUT, rand);
      expect(s.arrangement).not.toBe('classic');
      expect(Object.values(s.slots).sort()).toEqual(['graph', 'log', 'mode']);
    }
  });
});
