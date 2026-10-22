import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OVERVIEW,
  defaultColumns,
  fitFr,
  mergeOrder,
  placeItems,
  resizeTracks,
  sanitizeOverview,
  swapOrder,
  toggleIn,
  trackTemplate,
} from '@core/overviewGrid';

describe('overview grid math', () => {
  it('resizes a border and keeps the fraction sum', () => {
    const out = resizeTracks([1, 1, 1], 0, 100, [300, 300, 300], 200);
    expect(out[0] + out[1]).toBeCloseTo(2);
    expect(out[2]).toBe(1);
    expect(out[0]).toBeCloseTo((400 / 600) * 2);
  });
  it('never shrinks a neighbour below the minimum', () => {
    const out = resizeTracks([1, 1], 0, 5000, [300, 300], 200);
    expect(out[1]).toBeCloseTo((200 / 600) * 2);
    const left = resizeTracks([1, 1], 0, -5000, [300, 300], 200);
    expect(left[0]).toBeCloseTo((200 / 600) * 2);
  });
  it('splits evenly when both tracks are already under the minimum', () => {
    const out = resizeTracks([1, 1], 0, 50, [100, 100], 200);
    expect(out[0]).toBeCloseTo(1);
  });
  it('ignores a border that does not exist', () => {
    expect(resizeTracks([1, 1], 1, 10, [100, 100], 50)).toEqual([1, 1]);
  });
  it('fits fractions to a track count', () => {
    expect(fitFr([2, 1], 2)).toEqual([2, 1]);
    expect(fitFr([2, 1], 3)).toEqual([1, 1, 1]);
    expect(fitFr([2, 1], 3, true)).toEqual([2, 1, 1]);
    expect(fitFr([2, 1, 5], 2, true)).toEqual([2, 1]);
    expect(fitFr([2, -1], 2)).toEqual([1, 1]);
  });
  it('builds a track template with a pixel floor', () => {
    expect(trackTemplate([1, 2], 100)).toBe('minmax(100px, 1fr) minmax(100px, 2fr)');
  });
  it('picks more columns for compact and fewer for spacious', () => {
    expect(defaultColumns(1, 'compact')).toBe(1);
    expect(defaultColumns(4, 'comfortable')).toBe(2);
    expect(defaultColumns(4, 'compact')).toBe(3);
    expect(defaultColumns(4, 'spacious')).toBe(2);
    expect(defaultColumns(12, 'spacious')).toBe(3);
    expect(defaultColumns(12, 'compact')).toBe(4);
  });
});

describe('span placement', () => {
  it('places 1x1 items row by row', () => {
    const { cells, rows } = placeItems(
      [1, 2, 3].map((n) => ({ id: `s${n}`, c: 1, r: 1 })),
      2,
    );
    expect(cells.map((c) => [c.col, c.row])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
    ]);
    expect(rows).toBe(2);
  });
  it('lets later small items fill holes left by a large one (dense)', () => {
    const { cells, rows } = placeItems(
      [
        { id: 'a', c: 1, r: 1 },
        { id: 'b', c: 2, r: 1 },
        { id: 'c', c: 1, r: 1 },
      ],
      2,
    );
    expect(cells.find((c) => c.id === 'b')).toMatchObject({ col: 0, row: 1 });
    expect(cells.find((c) => c.id === 'c')).toMatchObject({ col: 1, row: 0 });
    expect(rows).toBe(2);
  });
  it('clamps spans to the column count and handles tall items', () => {
    const { cells, rows } = placeItems(
      [
        { id: 'a', c: 2, r: 2 },
        { id: 'b', c: 1, r: 1 },
      ],
      1,
    );
    expect(cells[0].c).toBe(1);
    expect(cells[1]).toMatchObject({ col: 0, row: 2 });
    expect(rows).toBe(3);
  });
  it('never overlaps', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, c: i % 3 === 0 ? 2 : 1, r: i % 4 === 0 ? 2 : 1 }));
    const { cells } = placeItems(items, 3);
    const used = new Set<string>();
    for (const c of cells)
      for (let y = c.row; y < c.row + c.r; y++)
        for (let x = c.col; x < c.col + c.c; x++) {
          expect(used.has(`${x},${y}`)).toBe(false);
          used.add(`${x},${y}`);
        }
  });
});

describe('order merging', () => {
  it('keeps the saved order, drops ended sessions and appends new ones', () => {
    expect(mergeOrder(['b', 'x', 'a'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
  });
  it('puts pinned sessions first', () => {
    expect(mergeOrder(['a', 'b', 'c'], ['a', 'b', 'c'], ['c'])).toEqual(['c', 'a', 'b']);
  });
  it('ignores duplicates', () => {
    expect(mergeOrder(['a', 'a'], ['a', 'b'])).toEqual(['a', 'b']);
  });
  it('swaps two ids and toggles list membership', () => {
    expect(swapOrder(['a', 'b', 'c'], 'a', 'c')).toEqual(['c', 'b', 'a']);
    expect(swapOrder(['a', 'b'], 'a', 'zzz')).toEqual(['a', 'b']);
    expect(toggleIn(['a'], 'a')).toEqual([]);
    expect(toggleIn(['a'], 'b')).toEqual(['a', 'b']);
  });
});

describe('persistence sanitizer', () => {
  it('turns junk into the defaults', () => {
    expect(sanitizeOverview(null)).toEqual(DEFAULT_OVERVIEW);
    expect(sanitizeOverview('x')).toEqual(DEFAULT_OVERVIEW);
    expect(sanitizeOverview({ density: 'huge', colFr: 5, rowFr: 'a', sizes: [], order: 3 })).toEqual(DEFAULT_OVERVIEW);
  });
  it('keeps valid pieces and drops invalid ones', () => {
    const out = sanitizeOverview({
      density: 'compact',
      colFr: { '2': [1.5, 0.5], '3': [1, 1], '9': [1], x: [1, 1] },
      rowFr: [1, 2],
      sizes: { a: { c: 2, r: 2 }, b: { c: 3, r: 1 }, c: { c: 1, r: 1 }, d: { c: 1, r: 2 } },
      order: ['a', 'a', 7, 'b'],
      pinned: ['a'],
      hidden: ['q', ''],
    });
    expect(out.density).toBe('compact');
    expect(out.colFr).toEqual({ '2': [1.5, 0.5] });
    expect(out.rowFr).toEqual([1, 2]);
    expect(out.sizes).toEqual({ a: { c: 2, r: 2 }, d: { c: 1, r: 2 } });
    expect(out.order).toEqual(['a', 'b']);
    expect(out.pinned).toEqual(['a']);
    expect(out.hidden).toEqual(['q']);
  });
  it('rejects non-positive fractions', () => {
    expect(sanitizeOverview({ rowFr: [1, 0] }).rowFr).toEqual([]);
    expect(sanitizeOverview({ rowFr: [1, NaN] }).rowFr).toEqual([]);
  });
});
