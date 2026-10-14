// Customizable session-view layout: three panels (mode, graph, log) placed into three slots of
// a named arrangement (CSS grid areas). Pure so it can be tested; the renderer animates changes.

export type PanelId = 'mode' | 'graph' | 'log';
export type Slot = 'A' | 'B' | 'C';
export type Edge = 'top' | 'right' | 'bottom' | 'left';
export type SizeKey = 'side' | 'dock';

export interface Arrangement {
  id: string;
  label: string;
  /** rows of slot names; every slot must form a rectangle */
  areas: Slot[][];
  cols: (side: number, dock: number) => string;
  rows: (side: number, dock: number) => string;
  /** resize handles per slot: which edge, and which size it drives */
  handles: Partial<Record<Slot, { edge: Edge; key: SizeKey }[]>>;
}

export const ARRANGEMENTS: Arrangement[] = [
  {
    id: 'classic',
    label: 'Classic',
    areas: [['A', 'B'], ['C', 'C']],
    cols: (s) => `${s}px minmax(0, 1fr)`,
    rows: (_s, d) => `minmax(0, 1fr) ${d}px`,
    handles: { A: [{ edge: 'right', key: 'side' }], C: [{ edge: 'top', key: 'dock' }] },
  },
  {
    id: 'mirror',
    label: 'Mirror',
    areas: [['B', 'A'], ['C', 'C']],
    cols: (s) => `minmax(0, 1fr) ${s}px`,
    rows: (_s, d) => `minmax(0, 1fr) ${d}px`,
    handles: { A: [{ edge: 'left', key: 'side' }], C: [{ edge: 'top', key: 'dock' }] },
  },
  {
    id: 'columns',
    label: 'Three columns',
    areas: [['A', 'B', 'C']],
    cols: (s, d) => `${s}px minmax(0, 1fr) ${Math.max(d * 2, 320)}px`,
    rows: () => 'minmax(0, 1fr)',
    handles: { A: [{ edge: 'right', key: 'side' }], C: [{ edge: 'left', key: 'dock' }] },
  },
  {
    id: 'top',
    label: 'Log on top',
    areas: [['C', 'C'], ['A', 'B']],
    cols: (s) => `${s}px minmax(0, 1fr)`,
    rows: (_s, d) => `${d}px minmax(0, 1fr)`,
    handles: { A: [{ edge: 'right', key: 'side' }], C: [{ edge: 'bottom', key: 'dock' }] },
  },
  {
    id: 'focus',
    label: 'Graph focus',
    areas: [['B', 'A'], ['B', 'C']],
    cols: (s) => `minmax(0, 1fr) ${Math.max(s, 300)}px`,
    rows: (_s, d) => `minmax(0, 1fr) ${d}px`,
    handles: { A: [{ edge: 'left', key: 'side' }], C: [{ edge: 'left', key: 'side' }, { edge: 'top', key: 'dock' }] },
  },
  {
    id: 'theater',
    label: 'Theater',
    areas: [['B', 'B'], ['A', 'C']],
    cols: (s) => `${s}px minmax(0, 1fr)`,
    rows: (_s, d) => `minmax(0, 1fr) ${d}px`,
    handles: { A: [{ edge: 'top', key: 'dock' }, { edge: 'right', key: 'side' }], C: [{ edge: 'top', key: 'dock' }] },
  },
  {
    id: 'stacked',
    label: 'Stacked',
    areas: [['A'], ['B'], ['C']],
    cols: () => 'minmax(0, 1fr)',
    rows: (s, d) => `${s}px minmax(0, 1fr) ${d}px`,
    handles: { A: [{ edge: 'bottom', key: 'side' }], C: [{ edge: 'top', key: 'dock' }] },
  },
];

export interface PanelLayout {
  v: 1;
  arrangement: string;
  slots: Record<Slot, PanelId>;
  /** px: the side panel's size along its free axis, and the dock panel's */
  side: number;
  dock: number;
  hidden: { mode: boolean; log: boolean; legend: boolean; status: boolean };
  sidebar: { side: 'left' | 'right'; width: number };
}

export const DEFAULT_LAYOUT: PanelLayout = {
  v: 1,
  arrangement: 'classic',
  slots: { A: 'mode', B: 'graph', C: 'log' },
  side: 250,
  dock: 230,
  hidden: { mode: false, log: false, legend: false, status: false },
  sidebar: { side: 'left', width: 280 },
};

export const LIMITS = { side: [160, 640], dock: [110, 640], sidebar: [200, 520] } as const;

export const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.max(lo, Math.min(hi, Math.round(v)));

export function arrangementOf(l: PanelLayout): Arrangement {
  return ARRANGEMENTS.find((a) => a.id === l.arrangement) ?? ARRANGEMENTS[0];
}

/** Repair anything loaded from storage into a valid layout. */
export function sanitizeLayout(raw: unknown): PanelLayout {
  const d = DEFAULT_LAYOUT;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<PanelLayout>;
  const panels = r.slots ? [r.slots.A, r.slots.B, r.slots.C] : [];
  const validSlots = panels.length === 3 && ['mode', 'graph', 'log'].every((p) => panels.includes(p as PanelId));
  return {
    v: 1,
    arrangement: ARRANGEMENTS.some((a) => a.id === r.arrangement) ? r.arrangement! : d.arrangement,
    slots: validSlots ? { ...r.slots! } : { ...d.slots },
    side: clamp(typeof r.side === 'number' ? r.side : d.side, LIMITS.side),
    dock: clamp(typeof r.dock === 'number' ? r.dock : d.dock, LIMITS.dock),
    hidden: { ...d.hidden, ...(r.hidden ?? {}) },
    sidebar: {
      side: r.sidebar?.side === 'right' ? 'right' : 'left',
      width: clamp(typeof r.sidebar?.width === 'number' ? r.sidebar.width : d.sidebar.width, LIMITS.sidebar),
    },
  };
}

export function slotOf(l: PanelLayout, p: PanelId): Slot {
  return (Object.keys(l.slots) as Slot[]).find((s) => l.slots[s] === p)!;
}

/** Swap two panels' slots. */
export function swapPanels(l: PanelLayout, a: PanelId, b: PanelId): PanelLayout {
  if (a === b) return l;
  const sa = slotOf(l, a);
  const sb = slotOf(l, b);
  return { ...l, slots: { ...l.slots, [sa]: b, [sb]: a } };
}

function isRectangular(grid: string[][]): boolean {
  const names = new Set(grid.flat());
  for (const n of names) {
    let r0 = Infinity, r1 = -1, c0 = Infinity, c1 = -1, count = 0;
    grid.forEach((row, r) =>
      row.forEach((v, c) => {
        if (v !== n) return;
        count++;
        r0 = Math.min(r0, r);
        r1 = Math.max(r1, r);
        c0 = Math.min(c0, c);
        c1 = Math.max(c1, c);
      }),
    );
    if (count !== (r1 - r0 + 1) * (c1 - c0 + 1)) return false;
  }
  return true;
}

const DIRS: [number, number][][] = [
  [[-1, 0]],
  [[1, 0]],
  [[0, -1]],
  [[0, 1]],
  [[-1, 0], [0, -1]],
  [[1, 0], [0, 1]],
];

/**
 * Grid areas with hidden panels removed: each hidden slot's cells are taken over by a neighbour,
 * trying fill directions until every remaining area is a rectangle (CSS grid requires it).
 */
export function visibleAreas(l: PanelLayout): string[][] {
  const arr = arrangementOf(l);
  const hiddenSlots = new Set((['A', 'B', 'C'] as Slot[]).filter((s) => l.slots[s] !== 'graph' && l.hidden[l.slots[s] as 'mode' | 'log']));
  const base = arr.areas.map((row) => [...row] as string[]);
  if (hiddenSlots.size === 0) return base;
  for (const dirs of DIRS) {
    const g = base.map((row) => [...row]);
    let ok = true;
    for (let pass = 0; pass < 3; pass++) {
      for (let r = 0; r < g.length; r++)
        for (let c = 0; c < g[r].length; c++) {
          if (!hiddenSlots.has(g[r][c] as Slot)) continue;
          for (const [dr, dc] of dirs) {
            let rr = r + dr, cc = c + dc;
            while (g[rr]?.[cc] !== undefined && hiddenSlots.has(g[rr][cc] as Slot)) {
              rr += dr;
              cc += dc;
            }
            if (g[rr]?.[cc] !== undefined) {
              g[r][c] = g[rr][cc];
              break;
            }
          }
        }
    }
    if (g.flat().some((v) => hiddenSlots.has(v as Slot))) ok = false;
    if (ok && isRectangular(g)) return g;
  }
  const graphSlot = slotOf(l, 'graph');
  return base.map((row) => row.map((v) => (hiddenSlots.has(v as Slot) ? graphSlot : v)));
}

export interface GridStyle {
  gridTemplateAreas: string;
  gridTemplateColumns: string;
  gridTemplateRows: string;
}

export function gridStyle(l: PanelLayout): GridStyle {
  const arr = arrangementOf(l);
  return {
    gridTemplateAreas: visibleAreas(l)
      .map((row) => `"${row.join(' ')}"`)
      .join(' '),
    gridTemplateColumns: arr.cols(l.side, l.dock),
    gridTemplateRows: arr.rows(l.side, l.dock),
  };
}

/** Pointer movement along an edge -> change in size (dragging away from the panel grows it). */
export function resizeDelta(edge: Edge, dx: number, dy: number): number {
  switch (edge) {
    case 'right':
      return dx;
    case 'left':
      return -dx;
    case 'bottom':
      return dy;
    case 'top':
      return -dy;
  }
}

/** A random different arrangement and panel order, for the shuffle button. */
export function shuffled(l: PanelLayout, rand: () => number = Math.random): PanelLayout {
  const others = ARRANGEMENTS.filter((a) => a.id !== l.arrangement);
  const arrangement = others[Math.floor(rand() * others.length)].id;
  const panels: PanelId[] = ['mode', 'graph', 'log'];
  for (let i = panels.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [panels[i], panels[j]] = [panels[j], panels[i]];
  }
  return { ...l, arrangement, slots: { A: panels[0], B: panels[1], C: panels[2] } };
}
