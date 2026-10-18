// Which motion should the agent cards play after a graph update? Pure (no DOM), so it is unit-tested.
//
// The graph keeps a snapshot of the last committed layout. Comparing the next one against it tells us what happened WHILE WATCHING:
// a card appeared, cards moved because siblings came or went, an agent changed status. A first snapshot, a different session or a
// bulk change (loading 300 finished agents, scrubbing a replay, expanding a big group) produces no motion at all.

import type { Layout } from '@core/layout';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MotionSnap {
  sid: string;
  status: Map<string, string>;
  parent: Map<string, string>;
  /** every visible node (cards and "N finished" chips) */
  boxes: Map<string, Box>;
  /** agent id -> id of the chip it is folded into */
  chipOf: Map<string, string>;
}

export type FxStatus = 'done' | 'error' | 'waiting';

export type Move =
  /** a card appears: scale/fade in, gliding from `dx,dy` (the parent, or the chip it was folded into) */
  | { kind: 'spawn'; id: string; dx: number; dy: number; glow: boolean }
  /** an existing card or chip moved by `-dx,-dy` since the last layout */
  | { kind: 'glide'; id: string; dx: number; dy: number }
  /** a chip appeared */
  | { kind: 'pop'; id: string }
  | { kind: 'status'; id: string; to: FxStatus };

export interface Plan {
  moves: Move[];
  /** the change was too big to animate (or not ours to animate): the caller just takes the new snapshot */
  bulk: boolean;
}

export const LIMITS = {
  /** new or revealed cards in one update */
  appear: 12,
  /** status transitions in one update */
  status: 8,
  /** cards that moved in one update */
  glide: 80,
  /** how far a card flies in from, so a far-away parent doesn't whip across the canvas */
  fly: 360,
};

export function makeSnap(sid: string, agents: Record<string, { status: string; parentId?: string | null }>, layout: Layout): MotionSnap {
  const status = new Map<string, string>();
  const parent = new Map<string, string>();
  for (const [id, a] of Object.entries(agents)) {
    status.set(id, a.status);
    if (a.parentId && a.parentId !== id) parent.set(id, a.parentId);
  }
  const boxes = new Map<string, Box>();
  const chipOf = new Map<string, string>();
  for (const n of layout.nodes) {
    boxes.set(n.id, { x: n.x, y: n.y, w: n.w, h: n.h });
    if (n.collapsed) for (const id of n.collapsed.ids) chipOf.set(id, n.id);
  }
  return { sid, status, parent, boxes, chipOf };
}

const cx = (b: Box) => b.x + b.w / 2;
const cy = (b: Box) => b.y + b.h / 2;
const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));

export function planMotion(prev: MotionSnap | null, next: MotionSnap): Plan {
  if (!prev || prev.sid !== next.sid) return { moves: [], bulk: true };

  const appear: Move[] = [];
  const glide: Move[] = [];
  const status: Move[] = [];
  const pop: Move[] = [];

  for (const [id, b] of next.boxes) {
    const was = prev.boxes.get(id);
    const isChip = id.startsWith('collapsed:');
    if (was) {
      const dx = was.x - b.x;
      const dy = was.y - b.y;
      if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) glide.push({ kind: 'glide', id, dx, dy });
      continue;
    }
    if (isChip) {
      pop.push({ kind: 'pop', id });
      continue;
    }
    const brandNew = !prev.status.has(id);
    // origin: a revealed card fans out of the chip it was folded into, a new one grows out of its parent
    const parentId = next.parent.get(id) ?? 'main';
    const origin = (!brandNew && prev.boxes.get(prev.chipOf.get(id) ?? '')) || prev.boxes.get(parentId) || next.boxes.get(parentId);
    const dx = origin ? clamp(cx(origin) - cx(b), LIMITS.fly) : 0;
    const dy = origin ? clamp(cy(origin) - cy(b), LIMITS.fly) : -24;
    appear.push({ kind: 'spawn', id, dx, dy, glow: brandNew });
  }

  for (const [id, st] of next.status) {
    const was = prev.status.get(id);
    if (was === undefined || was === st) continue;
    if (st === 'done' || st === 'error' || st === 'waiting') {
      // only cards on screen can show it
      if (next.boxes.has(id) && prev.boxes.has(id)) status.push({ kind: 'status', id, to: st });
    }
  }

  if (appear.length > LIMITS.appear || status.length > LIMITS.status) return { moves: [], bulk: true };
  const moves: Move[] = [...appear, ...pop, ...status];
  if (glide.length <= LIMITS.glide) moves.push(...glide);
  return { moves, bulk: false };
}
