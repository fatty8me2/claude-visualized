// Plays the card motion planned by cardMotion.ts with the Web Animations API (transform / opacity only, run on the compositor).
// Nothing here touches React state: it runs once from a layout effect, right after the new cards are in the DOM and before they paint.

import { planMotion, makeSnap, type Move, type MotionSnap, type Plan } from './cardMotion';
import type { Layout } from '@core/layout';

export const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const GLIDE = 'cubic-bezier(0.22, 0.9, 0.25, 1)';
/** overshoots a little and settles: the spawn "pop" */
const SPRING = 'cubic-bezier(0.2, 1.28, 0.35, 1)';

/** Remembers the last committed layout and says what changed since. One per graph. */
export class MotionTracker {
  private prev: MotionSnap | null = null;
  private cur: { agents: unknown; layout: Layout; sid: string; snap: MotionSnap; plan: Plan; taken: boolean } | null = null;

  /** Pure given the same inputs (cached), so it is safe to call from render. */
  plan(sid: string, agents: Record<string, { status: string; parentId?: string | null }>, layout: Layout): Plan {
    const c = this.cur;
    if (c && c.agents === agents && c.layout === layout && c.sid === sid) return c.plan;
    const snap = makeSnap(sid, agents, layout);
    const plan = planMotion(this.prev, snap);
    this.cur = { agents, layout, sid, snap, plan, taken: false };
    return plan;
  }

  /** Called once per committed plan: moves to play (empty when already taken), and the snapshot becomes the baseline. */
  take(): Move[] {
    const c = this.cur;
    if (!c || c.taken) return [];
    c.taken = true;
    this.prev = c.snap;
    return c.plan.moves;
  }

  /** Should small text changes (status, the "now" line) animate right now? */
  calm = (): boolean => {
    return !!this.cur && !this.cur.plan.bulk;
  };
}


/** the lines of content inside a card, in reading order (they fade in one by one when it materializes, and slice apart in a glitch) */
const CONTENT = ':scope > .row1, :scope > .model, :scope > .model2, :scope > .bar, :scope > .desc, :scope > .now, :scope > .says, :scope > .meta, :scope > .local-link';

function flash(card: Element, color: string | null, peak = 0.9, ms = 900) {
  const fx = card.querySelector<HTMLElement>(':scope > .fx');
  if (!fx) return;
  if (color) fx.style.setProperty('--fxc', color);
  else fx.style.removeProperty('--fxc');
  fx.animate([{ opacity: 0 }, { opacity: peak, offset: 0.22 }, { opacity: 0 }], { duration: ms, easing: 'ease-out' });
}

const num = (v: string, fallback: number) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * A short-lived layer at a card's rectangle inside the scaled canvas. The card clips its own contents, so wireframes, shockwaves and
 * sparks live here, where they can spill past its edge. Removed when every animation made for it has finished.
 */
function overlayFor(root: HTMLElement, el: HTMLElement, id: string): HTMLElement | null {
  const host = root.querySelector<HTMLElement>('.graph-scaled');
  if (!host) return null;
  const o = document.createElement('div');
  o.className = 'fx-overlay';
  o.dataset.fxFor = id;
  o.style.left = `${num(el.style.left, el.offsetLeft)}px`;
  o.style.top = `${num(el.style.top, el.offsetTop)}px`;
  o.style.width = `${num(el.style.width, el.offsetWidth)}px`;
  o.style.height = `${num(el.style.height, el.offsetHeight)}px`;
  o.style.setProperty('--fam', getComputedStyle(el).getPropertyValue('--fam'));
  host.appendChild(o);
  return o;
}
const part = (o: HTMLElement, cls: string, tag = 'i') => {
  const e = document.createElement(tag);
  e.className = cls;
  o.appendChild(e);
  return e;
};
const removeWhenDone = (o: HTMLElement, anims: Animation[]) => {
  if (!anims.length) return o.remove();
  void Promise.allSettled(anims.map((a) => a.finished)).then(() => o.remove());
};

/**
 * Materialize (~520 ms, so the card is complete as the edge's spawn arc arrives): a wireframe outline draws in while the card flies out of
 * its parent, the glass body is revealed by a scan line sweeping left to right, the content lines fade up one by one, and a brief
 * chromatic-aberration flash lands at the end. `stag` fans cards out of a chip one after another.
 */
function materialize(root: HTMLElement, el: HTMLElement, m: { id: string; dx: number; dy: number; glow: boolean }, stag: number) {
  const fly = [{ transform: `translate(${m.dx}px, ${m.dy}px) scale(0.94)` }, { transform: 'translate(0, 0) scale(1)' }];
  const flyOpts: KeyframeAnimationOptions = { duration: 520, delay: stag, easing: GLIDE, fill: 'backwards' };
  el.animate(fly, flyOpts);
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: stag + 110, easing: 'ease-out', fill: 'backwards' });
  const reveal: KeyframeAnimationOptions = { duration: 300, delay: stag + 130, easing: 'cubic-bezier(0.5, 0, 0.2, 1)', fill: 'backwards' };
  el.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], reveal);
  el.querySelectorAll<HTMLElement>(CONTENT).forEach((line, i) =>
    line.animate(
      [
        { opacity: 0, transform: 'translateY(4px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 170, delay: stag + 190 + i * 26, easing: 'ease-out', fill: 'backwards' },
    ),
  );
  // chromatic aberration: the text splits into red and cyan for ~150 ms, then snaps together
  el.animate(
    [
      { textShadow: '-2.5px 0 rgba(255, 50, 90, 0.9), 2.5px 0 rgba(40, 220, 255, 0.9)' },
      { textShadow: '1.5px 0 rgba(255, 50, 90, 0.5), -1.5px 0 rgba(40, 220, 255, 0.5)', offset: 0.5 },
      { textShadow: '0 0 0 rgba(255, 50, 90, 0), 0 0 0 rgba(40, 220, 255, 0)' },
    ],
    { duration: 150, delay: stag + 385, easing: 'ease-out' },
  );
  const o = overlayFor(root, el, m.id);
  if (o) {
    const w = num(o.style.width, 200);
    o.innerHTML =
      '<svg class="fx-wire" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><rect x="0.5" y="0.5" width="99" height="99" pathLength="1" stroke-dasharray="1"/></svg><i class="fx-wipe"></i>';
    const own = [
      o.animate(fly, flyOpts),
      o.querySelector('rect')!.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 240, delay: stag, easing: 'ease-out', fill: 'backwards' }),
      o.querySelector('.fx-wire')!.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, delay: stag + 300, easing: 'ease-in', fill: 'both' }),
      o.querySelector('.fx-wipe')!.animate(
        [
          { transform: 'translateX(0)', opacity: 0 },
          { transform: 'translateX(0)', opacity: 1, offset: 0.08 },
          { transform: `translateX(${w}px)`, opacity: 1, offset: 0.9 },
          { transform: `translateX(${w}px)`, opacity: 0 },
        ],
        { ...reveal, fill: 'both' },
      ),
    ];
    removeWhenDone(o, own);
  }
  if (m.glow) flash(el, null, 0.95, 1100);
}

/** Done: the bar floods, the check strokes in, a shockwave ring leaves the check with a burst of sparks, then the card cools */
function celebrate(root: HTMLElement, el: HTMLElement, id: string) {
  el.querySelector('.bar > i')?.animate(
    [
      { transform: 'scaleX(0.3)', opacity: 0.45, transformOrigin: 'left center' },
      { transform: 'scaleX(1)', opacity: 0.85, transformOrigin: 'left center' },
    ],
    { duration: 620, easing: GLIDE, fill: 'backwards' },
  );
  el.querySelector('.bar')?.animate([{ filter: 'brightness(2.4) saturate(1.4)' }, { filter: 'none' }], { duration: 760, delay: 420, easing: 'ease-out' });
  const tick = el.querySelector<SVGPathElement>('.tick path');
  if (tick) {
    const len = tick.getTotalLength?.() ?? 10;
    tick.animate(
      [
        { strokeDasharray: len, strokeDashoffset: len },
        { strokeDasharray: len, strokeDashoffset: 0 },
      ],
      { duration: 420, delay: 300, easing: 'ease-out', fill: 'backwards' },
    );
  }
  el.querySelector('.tick')?.animate([{ transform: 'scale(0.5)' }, { transform: 'scale(1.3)', offset: 0.6 }, { transform: 'scale(1)' }], {
    duration: 420,
    delay: 300,
    easing: 'ease-out',
    fill: 'backwards',
  });
  // hot, then cool: the card briefly overexposes and settles to its dim state (the dim itself is a CSS transition)
  el.animate([{ filter: 'brightness(1.55) saturate(1.3)' }, { filter: 'brightness(1) saturate(1)' }], { duration: 1100, delay: 320, easing: 'ease-out' });
  flash(el, 'var(--ok)', 0.55, 1000);

  const o = overlayFor(root, el, id);
  if (!o) return;
  const cr = el.getBoundingClientRect();
  const w = num(o.style.width, cr.width);
  const s = cr.width / w || 1;
  const t = el.querySelector('.tick')?.getBoundingClientRect();
  const cx = t ? (t.left + t.width / 2 - cr.left) / s : w - 24;
  const cy = t ? (t.top + t.height / 2 - cr.top) / s : 16;
  const place = (e: HTMLElement) => {
    e.style.left = `${cx}px`;
    e.style.top = `${cy}px`;
  };
  const anims: Animation[] = [];
  const at = 330;
  const ring = (delay: number, to: number, ms: number, peak: number) => {
    const r = part(o, 'fx-ring');
    place(r);
    anims.push(
      r.animate(
        [
          { transform: 'scale(0.2)', opacity: peak },
          { transform: `scale(${to})`, opacity: 0 },
        ],
        { duration: ms, delay, easing: 'cubic-bezier(0.1, 0.6, 0.25, 1)', fill: 'both' },
      ),
    );
  };
  ring(at, 8, 760, 0.95);
  ring(at + 110, 5, 620, 0.5);
  const n = 8 + Math.floor(Math.random() * 5);
  for (let i = 0; i < n; i++) {
    const sp = part(o, 'fx-spark');
    place(sp);
    const ang = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    const dist = 34 + Math.random() * 56;
    const dx = Math.cos(ang) * dist;
    const dy = Math.sin(ang) * dist + 16;
    anims.push(
      sp.animate(
        [
          { transform: 'translate(0, 0) scale(1.1)', opacity: 1 },
          { transform: `translate(${dx * 0.7}px, ${dy * 0.6}px) scale(0.8)`, opacity: 1, offset: 0.45 },
          { transform: `translate(${dx}px, ${dy}px) scale(0.2)`, opacity: 0 },
        ],
        { duration: 520 + Math.random() * 380, delay: at + Math.random() * 60, easing: 'cubic-bezier(0.1, 0.7, 0.3, 1)', fill: 'both' },
      ),
    );
  }
  removeWhenDone(o, anims);
}

/** Error: a few frames of slice offset and colour split, a red scanline, a short shake, then the settled red state */
function glitch(el: HTMLElement) {
  const step = 'steps(1, end)';
  el.querySelectorAll<HTMLElement>(CONTENT).forEach((line, i) => {
    const a = i % 2 ? 1 : -1;
    line.animate(
      [
        { transform: 'translateX(0)', easing: step },
        { transform: `translateX(${a * 7}px) skewX(${a * -8}deg)`, offset: 0.08, easing: step },
        { transform: `translateX(${-a * 5}px)`, offset: 0.17, easing: step },
        { transform: 'translateX(0)', offset: 0.27, easing: step },
        { transform: `translateX(${a * 3}px)`, offset: 0.5, easing: step },
        { transform: `translateX(${-a * 9}px) skewX(${a * 6}deg)`, offset: 0.57, easing: step },
        { transform: 'translateX(0)', offset: 0.7 },
      ],
      { duration: 480, delay: i * 22 },
    );
  });
  const split = (k: number) => `${-3 * k}px 0 rgba(255, 40, 80, 0.95), ${3 * k}px 0 rgba(40, 230, 255, 0.95)`;
  el.animate(
    [
      { textShadow: split(1), easing: step },
      { textShadow: split(-1.4), offset: 0.12, easing: step },
      { textShadow: split(0.6), offset: 0.24, easing: step },
      { textShadow: split(0), offset: 0.34, easing: step },
      { textShadow: split(1.6), offset: 0.52, easing: step },
      { textShadow: split(0), offset: 0.64 },
    ],
    { duration: 520 },
  );
  el.animate([{ opacity: 1, easing: step }, { opacity: 0.55, offset: 0.09, easing: step }, { opacity: 1, offset: 0.16, easing: step }, { opacity: 0.7, offset: 0.52, easing: step }, { opacity: 1, offset: 0.58 }], { duration: 520 });
  el.animate([{ translate: '0 0' }, { translate: '-6px 0' }, { translate: '5px 0' }, { translate: '-3px 0' }, { translate: '2px 0' }, { translate: '0 0' }], {
    duration: 380,
    easing: 'ease-in-out',
  });
  const line = document.createElement('i');
  line.className = 'fx-errline';
  el.appendChild(line);
  const h = num(el.style.height, el.offsetHeight);
  line
    .animate(
      [
        { transform: 'translateY(-4px)', opacity: 1 },
        { transform: `translateY(${h * 0.5}px)`, opacity: 0.6, offset: 0.5 },
        { transform: `translateY(${h}px)`, opacity: 1 },
      ],
      { duration: 520, delay: 40, easing: 'cubic-bezier(0.6, 0, 0.8, 0.6)', fill: 'both' },
    )
    .finished.then(() => line.remove(), () => line.remove());
  flash(el, 'var(--err)', 0.9, 1000);
}

/** Waiting: the card pings the user, a warm ring leaves its edge twice */
function ping(root: HTMLElement, el: HTMLElement, id: string) {
  flash(el, 'var(--warn)', 0.8, 900);
  const o = overlayFor(root, el, id);
  if (!o) return;
  const anims: Animation[] = [];
  for (const delay of [0, 260]) {
    const p = part(o, 'fx-ping');
    anims.push(
      p.animate(
        [
          { transform: 'scale(1)', opacity: 0.9 },
          { transform: 'scale(1.1, 1.18)', opacity: 0 },
        ],
        { duration: 760, delay, easing: 'cubic-bezier(0.1, 0.6, 0.25, 1)', fill: 'both' },
      ),
    );
  }
  removeWhenDone(o, anims);
}

export function playMoves(root: HTMLElement, moves: Move[]) {
  if (!moves.length || reducedMotion() || document.hidden) return;
  const els = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>('[data-agent],[data-chip]').forEach((el) => els.set((el.dataset.agent ?? el.dataset.chip)!, el));

  let spawned = 0;
  for (const m of moves) {
    const el = els.get(m.id);
    if (!el || !el.animate) continue;
    switch (m.kind) {
      case 'spawn':
        // a card revealed from a chip fans out with a stagger; a brand-new one starts at once
        materialize(root, el, m, m.glow ? 0 : Math.min(spawned, 10) * 50);
        spawned++;
        break;
      case 'glide':
        el.animate([{ transform: `translate(${m.dx}px, ${m.dy}px)` }, { transform: 'translate(0, 0)' }], { duration: 520, easing: GLIDE });
        break;
      case 'pop':
        el.animate(
          [
            { transform: 'scale(0.92)', opacity: 0 },
            { transform: 'scale(1)', opacity: 1 },
          ],
          { duration: 420, easing: SPRING, fill: 'backwards' },
        );
        break;
      case 'status':
        if (m.to === 'done') celebrate(root, el, m.id);
        else if (m.to === 'error') glitch(el);
        else ping(root, el, m.id);
        break;
    }
  }
}

/**
 * Hover tilt and specular highlight. Writes --mx/--my (highlight position) and --rx/--ry (at most 4 degrees) on the card under the
 * pointer, once per frame; the CSS applies them only while the card is hovered. No React state is involved.
 */
export function trackTilt(canvas: HTMLElement): () => void {
  let raf = 0;
  let ev: MouseEvent | null = null;
  const apply = () => {
    raf = 0;
    const e = ev;
    if (!e || reducedMotion()) return;
    const node = (e.target as Element | null)?.closest?.<HTMLElement>('.node:not(.collapsed)');
    if (!node) return;
    const r = node.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const py = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    node.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
    node.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);
    node.style.setProperty('--rx', `${((0.5 - py) * 8).toFixed(2)}deg`);
    node.style.setProperty('--ry', `${((px - 0.5) * 8).toFixed(2)}deg`);
  };
  const onMove = (e: MouseEvent) => {
    ev = e;
    if (!raf) raf = requestAnimationFrame(apply);
  };
  canvas.addEventListener('mousemove', onMove, { passive: true });
  return () => {
    canvas.removeEventListener('mousemove', onMove);
    if (raf) cancelAnimationFrame(raf);
  };
}
