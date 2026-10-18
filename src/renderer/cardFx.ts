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

function flash(card: Element, color: string | null, peak = 0.9, ms = 900) {
  const fx = card.querySelector<HTMLElement>(':scope > .fx');
  if (!fx) return;
  if (color) fx.style.setProperty('--fxc', color);
  else fx.style.removeProperty('--fxc');
  fx.animate([{ opacity: 0 }, { opacity: peak, offset: 0.22 }, { opacity: 0 }], { duration: ms, easing: 'ease-out' });
}

export function playMoves(root: HTMLElement, moves: Move[]) {
  if (!moves.length || reducedMotion() || document.hidden) return;
  const els = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>('[data-agent],[data-chip]').forEach((el) => els.set((el.dataset.agent ?? el.dataset.chip)!, el));

  for (const m of moves) {
    const el = els.get(m.id);
    if (!el || !el.animate) continue;
    switch (m.kind) {
      case 'spawn':
        el.animate([{ transform: `translate(${m.dx}px, ${m.dy}px) scale(0.9)` }, { transform: 'translate(0, 0) scale(1)' }], {
          duration: 640,
          easing: SPRING,
          fill: 'backwards',
        });
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out', fill: 'backwards' });
        if (m.glow) flash(el, null, 0.95, 1100);
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
        if (m.to === 'done') {
          // the bar fills to solid, then the check strokes in; the dim is a CSS transition with a delay
          el.querySelector('.bar > i')?.animate(
            [
              { transform: 'scaleX(0.3)', opacity: 0.45, transformOrigin: 'left center' },
              { transform: 'scaleX(1)', opacity: 0.85, transformOrigin: 'left center' },
            ],
            { duration: 620, easing: GLIDE, fill: 'backwards' },
          );
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
          el.querySelector('.tick')?.animate([{ transform: 'scale(0.5)' }, { transform: 'scale(1.15)', offset: 0.7 }, { transform: 'scale(1)' }], {
            duration: 420,
            delay: 300,
            easing: 'ease-out',
            fill: 'backwards',
          });
          flash(el, 'var(--ok)', 0.55, 1000);
        } else if (m.to === 'error') {
          // a single short shake (the `translate` property, so it composes with a glide), then the red state
          el.animate(
            [{ translate: '0 0' }, { translate: '-6px 0' }, { translate: '5px 0' }, { translate: '-3px 0' }, { translate: '2px 0' }, { translate: '0 0' }],
            { duration: 380, easing: 'ease-in-out' },
          );
          flash(el, 'var(--err)', 0.85, 900);
        } else {
          flash(el, 'var(--warn)', 0.8, 900);
        }
        break;
    }
  }
}
