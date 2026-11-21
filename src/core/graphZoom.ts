// Zoom math for the agent graph (pure; tests/unit/graphZoom.test.ts). The graph pans by scrolling its wrapper and zooms by scaling
// the canvas, so these functions work in scroll offsets and scales.

export const ZOOM = {
  min: 0.5,
  max: 1.5,
  /** full cards are never shown smaller than this: below it the text stops being readable */
  fullFloor: 0.8,
  /** compact cards' floor in fit mode: they exist to stay readable, so a tree wider than this scrolls instead of shrinking */
  compactFloor: 0.85,
  /** fit switches to compact cards below this scale, and back to full ones above leaveCompactAbove (hysteresis) */
  enterCompactBelow: 0.8,
  leaveCompactAbove: 0.9,
  /** ctrl+wheel sensitivity and the +/- button step */
  wheelK: 0.0025,
  step: 1.25,
} as const;

export type CardMode = 'full' | 'compact';
export type CompactPref = 'auto' | 'on' | 'off';

export interface Size {
  w: number;
  h: number;
}

/** The scale that fits `content` (plus `pad` on each side) into `viewport`: width only unless fitHeight, clamped to [floor, max]. */
export function fitScale(content: Size, viewport: Size, pad: number, fitHeight: boolean, floor: number, max = 1): number {
  const sx = (viewport.w - pad * 2) / Math.max(1, content.w);
  const sy = fitHeight ? (viewport.h - pad * 2) / Math.max(1, content.h) : Infinity;
  const s = Math.min(max, sx, sy);
  return Number.isFinite(s) ? Math.max(floor, s) : max;
}

/** How many columns of cards of `nodeW` (with `gutter` between them) fit in `width` with `pad` on each side, at scale 1. */
export function columnsForWidth(width: number, nodeW: number, gutter: number, pad: number, min = 2, max = 12): number {
  if (!(width > 0)) return max;
  const n = Math.floor((width - pad * 2 + gutter) / (nodeW + gutter));
  return Math.max(min, Math.min(max, n));
}

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM.max, Math.max(ZOOM.min, z));
}

/**
 * Which card variant to draw at `scale`: the user's preference wins; 'auto' goes compact below enterCompactBelow and back to full
 * above leaveCompactAbove, so a sidebar drag across the threshold doesn't flip it back and forth.
 */
export function nextCardMode(prev: CardMode, scale: number, pref: CompactPref): CardMode {
  if (pref === 'on') return 'compact';
  if (pref === 'off') return 'full';
  if (prev === 'full') return scale < ZOOM.enterCompactBelow ? 'compact' : 'full';
  return scale > ZOOM.leaveCompactAbove ? 'full' : 'compact';
}

/**
 * Scroll offsets that keep the content point under `cursor` (relative to the viewport) in place when the scale changes from
 * prev.scale to nextScale. `pad` is the unscaled margin around the scaled content.
 */
export function zoomAnchor(
  prev: { scale: number; scrollLeft: number; scrollTop: number },
  nextScale: number,
  cursor: { x: number; y: number },
  pad: number,
): { scrollLeft: number; scrollTop: number } {
  const cx = (prev.scrollLeft + cursor.x - pad) / prev.scale;
  const cy = (prev.scrollTop + cursor.y - pad) / prev.scale;
  return {
    scrollLeft: Math.max(0, cx * nextScale + pad - cursor.x),
    scrollTop: Math.max(0, cy * nextScale + pad - cursor.y),
  };
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * How far to scroll so `card` is fully visible in `viewport`, leaving `obscuredRight` px on the right free (the drawer covers
 * them). Null when it already is.
 */
export function revealDelta(card: Rect, viewport: Rect, obscuredRight: number, margin = 16): { dx: number; dy: number } | null {
  const right = viewport.right - obscuredRight;
  let dx = 0;
  let dy = 0;
  if (card.right + margin > right) dx = card.right + margin - right;
  if (card.left - dx - margin < viewport.left) dx = card.left - margin - viewport.left;
  if (card.bottom + margin > viewport.bottom) dy = card.bottom + margin - viewport.bottom;
  if (card.top - dy - margin < viewport.top) dy = card.top - margin - viewport.top;
  return dx || dy ? { dx, dy } : null;
}

/** A panel's zoom that does not bounce (see stickyScale). */
export interface StickyZoom {
  scale: number;
  /** the panel size it was fitted to: a resize re-fits at once */
  vw?: number;
  vh?: number;
  /** since when a larger fit has been possible (null: none pending) */
  upSince: number | null;
}

/**
 * The overview's zoom without bouncing: a bigger tree zooms out at once, but zooming back in waits until the larger fit has
 * held for `holdMs`. Agents spawning, finishing and folding away one after another would otherwise zoom every card in and out.
 * Differences under 2% are ignored.
 */
export function stickyScale(prev: StickyZoom | null, fit: number, now: number, holdMs = 20_000, viewport?: { w: number; h: number }): StickyZoom {
  const vw = viewport?.w;
  const vh = viewport?.h;
  // first fit, or the panel itself was resized: fit at once (the user is resizing, not watching agents come and go)
  if (!prev || !(prev.scale > 0) || prev.vw !== vw || prev.vh !== vh) return { scale: fit, upSince: null, vw, vh };
  if (fit <= prev.scale * 1.02) return fit < prev.scale * 0.98 ? { scale: fit, upSince: null, vw, vh } : { scale: prev.scale, upSince: null, vw, vh };
  if (prev.upSince === null) return { scale: prev.scale, upSince: now, vw, vh };
  return now - prev.upSince >= holdMs ? { scale: fit, upSince: null, vw, vh } : prev;
}

/** A measured size that ignores changes under `step` px, so sub-pixel or scrollbar flicker does not re-flow the graph. */
export function steadySize(prev: number, next: number, step = 2): number {
  return Math.abs(next - prev) < step ? prev : next;
}
