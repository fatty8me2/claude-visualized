// Pure maths for the graph backdrop (grid parallax, ripples, dust). The canvas painter in renderer/backdrop.ts only draws what this computes.

/** more running agents than this: the backdrop drops to its cheap mode (no dust, no breathing, fewer glows, lower frame rate) */
export const BACKDROP_HEAVY = 16;

export interface GridLayer {
  /** screen distance between dots */
  step: number;
  /** screen position of the first dot column / row, in [0, step) */
  ox: number;
  oy: number;
  /** how many times the spacing was doubled to keep dots apart when zoomed out */
  doublings: number;
  /** world coordinate of the dot at index 0 of the first column / row (for stable per-dot variation while panning) */
  i0: number;
  j0: number;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/**
 * A dot grid that pans and zooms with the graph. `origin` is where world (0,0) is on screen, `scale` the graph's zoom.
 * `depth` in (0,1] is the parallax factor: 1 moves exactly with the cards, smaller values lag behind (a layer further away) and
 * zoom less. Zooming out never packs dots closer than `minStep` screen pixels: the spacing doubles instead.
 */
export function gridLayer(origin: { x: number; y: number }, scale: number, spacing: number, depth: number, minStep = 14): GridLayer {
  const s = Math.pow(Math.max(scale, 0.01), depth);
  let step = spacing * s;
  let doublings = 0;
  while (step < minStep && doublings < 8) {
    step *= 2;
    doublings++;
  }
  const ox = origin.x * depth;
  const oy = origin.y * depth;
  return { step, ox: mod(ox, step), oy: mod(oy, step), doublings, i0: -Math.floor(ox / step), j0: -Math.floor(oy / step) };
}

export type RippleKind = 'spawn' | 'done' | 'error';

export interface Ripple {
  kind: RippleKind;
  /** world position */
  x: number;
  y: number;
  /** start time, ms */
  t0: number;
  /** model family or 'ok' / 'err': picks the colour in the painter */
  tone: string;
}

export const RIPPLE = {
  spawn: { life: 2200, speed: 430, width: 90, reach: 900 },
  done: { life: 1900, speed: 280, width: 85, reach: 340 },
  error: { life: 1500, speed: 620, width: 100, reach: 800 },
} as const;
export const MAX_RIPPLES = 10;

export function addRipple(list: Ripple[], r: Ripple): Ripple[] {
  const next = [...list, r];
  return next.length > MAX_RIPPLES ? next.slice(next.length - MAX_RIPPLES) : next;
}

export function pruneRipples(list: Ripple[], now: number): Ripple[] {
  const next = list.filter((r) => now - r.t0 < RIPPLE[r.kind].life);
  return next.length === list.length ? list : next;
}

/** current wavefront radius and overall strength (0..1) of a ripple, in world units */
export function rippleFront(r: Ripple, now: number): { radius: number; strength: number } {
  const p = RIPPLE[r.kind];
  const age = Math.max(0, now - r.t0);
  const k = Math.min(1, age / p.life);
  const radius = Math.min(p.reach, (p.speed * age) / 1000);
  // quick rise, long fade
  const strength = (1 - k) * (1 - k) * Math.min(1, age / 90);
  return { radius, strength };
}

/**
 * How strongly a point at world distance `dist` from the ripple's centre is lit: a soft band around the wavefront.
 * Returns 0..1 (before applying the ripple's strength).
 */
export function bandAt(dist: number, radius: number, width: number): number {
  const d = Math.abs(dist - radius) / width;
  if (d >= 1) return 0;
  const c = 1 - d * d;
  return c * c;
}

/** radial push (world px) of the grid at distance `dist` from an error shock: brief, damped sine around the wavefront */
export function shockPush(dist: number, radius: number, strength: number): number {
  const d = (dist - radius) / RIPPLE.error.width;
  if (Math.abs(d) >= 1) return 0;
  return Math.sin(d * Math.PI * 2) * (1 - Math.abs(d)) * 9 * strength;
}

export interface Dust {
  x: number;
  y: number;
  /** index into the running targets */
  target: number;
  /** 0..1 life along its path */
  born: number;
  /** per-particle constants */
  speed: number;
  swirl: number;
}

/** deterministic-friendly random source so tests can drive dust */
export type Rng = () => number;

export function spawnDust(d: Dust, targets: { x: number; y: number }[], rng: Rng, now: number): void {
  if (!targets.length) return;
  d.target = Math.floor(rng() * targets.length) % targets.length;
  const t = targets[d.target];
  const ang = rng() * Math.PI * 2;
  const dist = 200 + rng() * 280;
  d.x = t.x + Math.cos(ang) * dist;
  d.y = t.y + Math.sin(ang) * dist * 0.7;
  d.speed = 38 + rng() * 40;
  d.swirl = (rng() - 0.5) * 0.9;
  d.born = now;
}

/** advance one particle by `dt` seconds toward its target; returns false when it arrived (respawn it) */
export function stepDust(d: Dust, targets: { x: number; y: number }[], dt: number): boolean {
  const t = targets[d.target];
  if (!t) return false;
  const dx = t.x - d.x;
  const dy = t.y - d.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 36) return false;
  const nx = dx / dist;
  const ny = dy / dist;
  // accelerate on the way in, with a sideways curl that dies out near the target
  const v = d.speed * (0.6 + Math.min(1, 160 / dist));
  const curl = d.swirl * Math.min(1, dist / 200);
  d.x += (nx - ny * curl) * v * dt;
  d.y += (ny + nx * curl) * v * dt;
  return true;
}

/** dust opacity: fades in after birth and out near the target */
export function dustAlpha(d: Dust, targets: { x: number; y: number }[], now: number): number {
  const t = targets[d.target];
  if (!t) return 0;
  const fadeIn = Math.min(1, (now - d.born) / 700);
  const fadeOut = Math.min(1, Math.hypot(t.x - d.x, t.y - d.y) / 120);
  return fadeIn * fadeOut;
}

/** frame interval in ms for the current load */
export function frameInterval(running: number, busy: boolean): number {
  // cheap mode is a still image unless a ripple plays: it only checks for pan / zoom a few times a second
  if (running > BACKDROP_HEAVY) return busy ? 1000 / 20 : 1000 / 8;
  return busy ? 1000 / 40 : 1000 / 24;
}

/** the radar sweep: x position (0..1 of the width) at time `t`, or -1 while resting between sweeps */
export function sweepPos(t: number, period = 26000, duration = 7000): number {
  const ph = t % period;
  return ph < duration ? ph / duration : -1;
}

/** which transitions play ripples: reuse the connectors' detection, mapped to ripple kinds at the agents' world positions */
export function planRipples(
  plan: { spawn: string[]; ret: { id: string; err: boolean }[] },
  pos: ReadonlyMap<string, { x: number; y: number }>,
  fam: ReadonlyMap<string, string>,
  now: number,
): Ripple[] {
  const out: Ripple[] = [];
  for (const id of plan.spawn) {
    const p = pos.get(id);
    if (p) out.push({ kind: 'spawn', x: p.x, y: p.y, t0: now, tone: fam.get(id) ?? 'other' });
  }
  for (const r of plan.ret) {
    const p = pos.get(r.id);
    if (p) out.push({ kind: r.err ? 'error' : 'done', x: p.x, y: p.y, t0: now, tone: r.err ? 'err' : 'ok' });
  }
  return out;
}
