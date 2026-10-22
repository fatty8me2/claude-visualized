// Pure logic for the all-sessions grid: resizable tracks, span placement, panel order and the persisted layout.

export type Density = 'compact' | 'comfortable' | 'spacious';
export const DENSITIES: Density[] = ['compact', 'comfortable', 'spacious'];

export interface Span {
  c: 1 | 2;
  r: 1 | 2;
}
export const SIZE_STEPS: Span[] = [
  { c: 1, r: 1 },
  { c: 2, r: 1 },
  { c: 1, r: 2 },
  { c: 2, r: 2 },
];
export const sizeLabel = (s: Span) => `${s.c}×${s.r}`;

export interface OverviewLayout {
  density: Density;
  /** column fractions, keyed by column count (so each shape of grid remembers its own widths) */
  colFr: Record<string, number[]>;
  /** row fractions (extra rows are padded with 1) */
  rowFr: number[];
  /** panel spans per session id */
  sizes: Record<string, Span>;
  /** custom order of session ids (new sessions are appended when merged) */
  order: string[];
  pinned: string[];
  hidden: string[];
}

export const MIN_COL_PX = 260;
export const MIN_ROW_PX = 230;
export const MAX_COLS = 6;
const MAX_IDS = 300;
const MAX_ROWS = 40;

export const DEFAULT_OVERVIEW: OverviewLayout = { density: 'comfortable', colFr: {}, rowFr: [], sizes: {}, order: [], pinned: [], hidden: [] };

/** how many columns a density asks for with n panels (never more columns than panels) */
export function defaultColumns(n: number, density: Density): number {
  if (n <= 1) return 1;
  switch (density) {
    case 'compact':
      return n <= 2 ? 2 : n <= 6 ? 3 : 4;
    case 'spacious':
      return n <= 6 ? 2 : 3;
    default:
      return n <= 4 ? 2 : n <= 9 ? 3 : 4;
  }
}

export const equalFr = (n: number): number[] => Array.from({ length: Math.max(1, n) }, () => 1);

/** fractions for exactly n tracks: invalid input or a wrong length falls back to equal tracks, extra rows are padded */
export function fitFr(fr: number[] | undefined, n: number, pad = false): number[] {
  const ok = Array.isArray(fr) && fr.every((x) => Number.isFinite(x) && x > 0);
  if (!ok || !fr) return equalFr(n);
  if (fr.length === n) return fr;
  if (pad) return n < fr.length ? fr.slice(0, n) : [...fr, ...equalFr(n - fr.length)];
  return equalFr(n);
}

/**
 * Move the border between track i and i+1 by dx pixels. `px` are the current pixel sizes of all tracks;
 * both neighbours keep at least minPx (when they can). The fractions keep their sum, so other tracks are unchanged.
 */
export function resizeTracks(fr: number[], i: number, dx: number, px: number[], minPx: number): number[] {
  if (i < 0 || i + 1 >= fr.length || px.length !== fr.length) return fr;
  const a = px[i];
  const b = px[i + 1];
  const total = a + b;
  if (!(total > 0)) return fr;
  const lo = Math.min(minPx, total / 2);
  const na = Math.min(Math.max(a + dx, lo), total - lo);
  const frTotal = fr[i] + fr[i + 1];
  const out = fr.slice();
  out[i] = (na / total) * frTotal;
  out[i + 1] = ((total - na) / total) * frTotal;
  return out;
}

export interface Item {
  id: string;
  c: number;
  r: number;
}
export interface Cell extends Item {
  col: number; // 0-based
  row: number;
}

/** dense placement: every item takes the first free spot (row-major) where it fits, spans clamp to the column count */
export function placeItems(items: Item[], cols: number): { cells: Cell[]; rows: number } {
  const taken: boolean[][] = [];
  const free = (r: number, c: number, rs: number, cs: number) => {
    for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) if (taken[y]?.[x]) return false;
    return true;
  };
  const cells: Cell[] = [];
  let rows = 0;
  for (const it of items) {
    const cs = Math.min(Math.max(1, it.c), cols);
    const rs = Math.max(1, it.r);
    let r = 0;
    let c = 0;
    search: for (r = 0; ; r++) for (c = 0; c + cs <= cols; c++) if (free(r, c, rs, cs)) break search;
    for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) (taken[y] ??= [])[x] = true;
    cells.push({ id: it.id, c: cs, r: rs, col: c, row: r });
    rows = Math.max(rows, r + rs);
  }
  return { cells, rows };
}

/** CSS track list: fractions with a pixel floor */
export const trackTemplate = (fr: number[], minPx: number) => fr.map((f) => `minmax(${minPx}px, ${+f.toFixed(4)}fr)`).join(' ');

/** saved order restricted to live ids, new ids appended in the order given, pinned ids first */
export function mergeOrder(saved: string[], live: string[], pinned: string[] = []): string[] {
  const liveSet = new Set(live);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...saved, ...live])
    if (liveSet.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  const pin = new Set(pinned);
  return [...out.filter((id) => pin.has(id)), ...out.filter((id) => !pin.has(id))];
}

/** swap two ids inside an order list that already contains them (an unknown id leaves it unchanged) */
export function swapOrder(order: string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0 || i === j) return order;
  const out = order.slice();
  out[i] = b;
  out[j] = a;
  return out;
}

export const toggleIn = (list: string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

// ---------- persistence ----------

const strList = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) if (typeof x === 'string' && x && !out.includes(x) && out.length < MAX_IDS) out.push(x);
  return out;
};

const frList = (v: unknown, max: number): number[] | null => {
  if (!Array.isArray(v) || v.length === 0 || v.length > max) return null;
  const out = v.map(Number);
  return out.every((x) => Number.isFinite(x) && x > 0.05 && x < 50) ? out : null;
};

/** anything read from storage becomes a valid layout; bad pieces fall back to defaults */
export function sanitizeOverview(raw: unknown): OverviewLayout {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const density = DENSITIES.includes(o.density as Density) ? (o.density as Density) : DEFAULT_OVERVIEW.density;
  const colFr: Record<string, number[]> = {};
  if (o.colFr && typeof o.colFr === 'object')
    for (const [k, v] of Object.entries(o.colFr as Record<string, unknown>)) {
      const n = Number(k);
      const fr = frList(v, MAX_COLS);
      if (Number.isInteger(n) && n >= 1 && n <= MAX_COLS && fr && fr.length === n) colFr[k] = fr;
    }
  const sizes: Record<string, Span> = {};
  if (o.sizes && typeof o.sizes === 'object')
    for (const [id, v] of Object.entries(o.sizes as Record<string, unknown>).slice(0, MAX_IDS)) {
      const s = v as Partial<Span> | null;
      const c = s?.c === 2 ? 2 : s?.c === 1 ? 1 : 0;
      const r = s?.r === 2 ? 2 : s?.r === 1 ? 1 : 0;
      if (c && r && (c > 1 || r > 1)) sizes[id] = { c, r };
    }
  return {
    density,
    colFr,
    rowFr: frList(o.rowFr, MAX_ROWS) ?? [],
    sizes,
    order: strList(o.order),
    pinned: strList(o.pinned),
    hidden: strList(o.hidden),
  };
}
