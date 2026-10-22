// Camera math for the agent graph (pure; tests/unit/graphCamera.test.ts). Everything is in scroll space: the graph pans by scrolling
// its wrapper, so "where the camera is" is {left, top} and the visible window is {w, h} (minus whatever the drawer covers).

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Pt {
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}

export const CAMERA = {
  /** a camera move lasts this long at least / at most (ms); it grows with the distance travelled */
  minMs: 260,
  maxMs: 760,
  /** after the user touches the graph, automatic moves (follow a new agent) keep still for this long */
  idleBeforeFollowMs: 6000,
  /** most edge chips shown at once */
  maxChips: 4,
  /** minimap box (the longer side) */
  mapW: 192,
  mapH: 150,
} as const;

export function easeInOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function clampScroll(p: { left: number; top: number }, content: Size, view: Size): { left: number; top: number } {
  return {
    left: Math.min(Math.max(0, content.w - view.w), Math.max(0, p.left)),
    top: Math.min(Math.max(0, content.h - view.h), Math.max(0, p.top)),
  };
}

/** The scroll position that puts `card` in the middle of the free part of the view (the drawer covers `obscuredRight` px). */
export function centerOn(card: Box, content: Size, view: Size, obscuredRight = 0): { left: number; top: number } {
  const freeW = Math.max(1, view.w - obscuredRight);
  return clampScroll({ left: card.x + card.w / 2 - freeW / 2, top: card.y + card.h / 2 - view.h / 2 }, content, view);
}

/** How long a move of `dist` px takes. */
export function moveDuration(dist: number): number {
  return Math.round(CAMERA.minMs + Math.min(CAMERA.maxMs - CAMERA.minMs, dist * 0.35));
}

export function intersects(card: Box, scroll: { left: number; top: number }, view: Size, obscuredRight = 0, margin = 0): boolean {
  const l = scroll.left + margin;
  const t = scroll.top + margin;
  const r = scroll.left + view.w - obscuredRight - margin;
  const b = scroll.top + view.h - margin;
  return card.x < r && card.x + card.w > l && card.y < b && card.y + card.h > t;
}

/** Scale and size of the minimap of a canvas `content` px big. */
export function minimapSize(content: Size, maxW: number = CAMERA.mapW, maxH: number = CAMERA.mapH): { scale: number; w: number; h: number } {
  const scale = Math.min(maxW / Math.max(1, content.w), maxH / Math.max(1, content.h));
  return { scale, w: Math.max(1, Math.round(content.w * scale)), h: Math.max(1, Math.round(content.h * scale)) };
}

/** The scroll position that centres the view on the minimap point `p` (minimap px, origin at its top-left). */
export function mapToScroll(p: Pt, mapScale: number, content: Size, view: Size, canvasOffset: Pt = { x: 0, y: 0 }): { left: number; top: number } {
  return clampScroll({ left: p.x / mapScale + canvasOffset.x - view.w / 2, top: p.y / mapScale + canvasOffset.y - view.h / 2 }, content, view);
}

/** Whether the content is bigger than the view enough to need a map at all. */
export function needsMap(content: Size, view: Size, slack = 4): boolean {
  return content.w > view.w + slack || content.h > view.h + slack;
}

export interface Chip {
  x: number;
  y: number;
  /** radians, 0 = pointing right */
  angle: number;
}

/** The rectangle chips sit on: the view inset from its edges, clear of the toolbar on top and the drawer on the right. */
export function chipBounds(view: Size, obscuredRight: number, inset = 14, topInset = 52): { l: number; t: number; r: number; b: number } {
  const l = inset;
  const r = Math.max(l + 1, view.w - obscuredRight - inset);
  const t = Math.min(topInset, view.h / 3);
  const b = Math.max(t + 1, view.h - inset);
  return { l, t, r, b };
}

/**
 * Where an edge chip for something at `target` (view px) sits: on the line from the middle of the free view towards the target,
 * where it crosses the rectangle inset from the view's edges. `topInset` keeps it clear of the toolbar.
 */
export function edgeChip(target: Pt, view: Size, obscuredRight: number, inset = 14, topInset = 52): Chip {
  const { l, t, r, b } = chipBounds(view, obscuredRight, inset, topInset);
  const cx = (l + r) / 2;
  const cy = (t + b) / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy, angle: 0 };
  const angle = Math.atan2(dy, dx);
  const sx = dx === 0 ? Infinity : ((dx > 0 ? r : l) - cx) / dx;
  const sy = dy === 0 ? Infinity : ((dy > 0 ? b : t) - cy) / dy;
  const s = Math.min(sx, sy, 1);
  return { x: cx + dx * s, y: cy + dy * s, angle };
}

/** The `max` boxes nearest the middle of the view, among those out of it. */
export function pickOffscreen<T extends { id: string; box: Box }>(items: T[], scroll: { left: number; top: number }, view: Size, obscuredRight: number, max: number = CAMERA.maxChips): T[] {
  const cx = scroll.left + (view.w - obscuredRight) / 2;
  const cy = scroll.top + view.h / 2;
  return items
    .filter((i) => !intersects(i.box, scroll, view, obscuredRight))
    .map((i) => ({ i, d: Math.hypot(i.box.x + i.box.w / 2 - cx, i.box.y + i.box.h / 2 - cy) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((e) => e.i);
}

/**
 * Chips that point the same way land on the same spot: spread them along their shared edge (a run of chips on the top or bottom
 * edge spreads horizontally, on the left or right edge vertically) so none hides another. `sizes[i]` is chip i's width and height.
 * Returns new centres; the input is not changed.
 */
export function spreadChips(chips: Pt[], sizes: Size[], bounds: { l: number; t: number; r: number; b: number }, gap = 6): Pt[] {
  const out = chips.map((c) => ({ ...c }));
  const eps = 1.5;
  const groups = new Map<string, number[]>();
  chips.forEach((c, i) => {
    const edge = Math.abs(c.y - bounds.t) < eps ? 't' : Math.abs(c.y - bounds.b) < eps ? 'b' : Math.abs(c.x - bounds.l) < eps ? 'l' : Math.abs(c.x - bounds.r) < eps ? 'r' : '';
    if (edge) groups.set(edge, [...(groups.get(edge) ?? []), i]);
  });
  for (const [edge, idx] of groups) {
    const horiz = edge === 't' || edge === 'b';
    const key = horiz ? 'x' : 'y';
    const len = (i: number) => (horiz ? sizes[i].w : sizes[i].h);
    const lo = horiz ? bounds.l : bounds.t;
    const hi = horiz ? bounds.r : bounds.b;
    const order = [...idx].sort((a, b) => chips[a][key] - chips[b][key]);
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      let v = Math.max(out[i][key], lo + len(i) / 2);
      if (k > 0) {
        const p = order[k - 1];
        v = Math.max(v, out[p][key] + (len(p) + len(i)) / 2 + gap);
      }
      out[i][key] = v;
    }
    // push back from the far end if the run overflowed
    for (let k = order.length - 1; k >= 0; k--) {
      const i = order[k];
      let v = Math.min(out[i][key], hi - len(i) / 2);
      if (k < order.length - 1) {
        const n = order[k + 1];
        v = Math.min(v, out[n][key] - (len(n) + len(i)) / 2 - gap);
      }
      out[i][key] = v;
    }
  }
  return out;
}
