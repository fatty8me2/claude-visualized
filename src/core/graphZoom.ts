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
