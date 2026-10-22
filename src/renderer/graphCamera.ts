import { easeInOutCubic, moveDuration } from '@core/graphCamera';
import { reducedMotion } from './cardFx';

/**
 * Eased camera moves for a scrolling element: rAF writes scrollLeft/scrollTop (never React state). Any input from the user (wheel,
 * pointer, touch, keys) cancels a move in flight so the camera never fights the hand; reduced motion jumps straight there.
 */
export class CameraAnimator {
  private raf = 0;
  private el: HTMLElement | null = null;
  /** performance.now() of the last thing the user did to the graph */
  lastInput = -Infinity;
  private off: (() => void) | null = null;

  attach(el: HTMLElement): void {
    this.detach();
    this.el = el;
    const touch = () => {
      this.lastInput = performance.now();
      this.cancel();
    };
    const opts = { passive: true, capture: true } as const;
    const evs = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;
    for (const e of evs) el.addEventListener(e, touch, opts);
    this.off = () => {
      for (const e of evs) el.removeEventListener(e, touch, opts);
    };
  }

  detach(): void {
    this.off?.();
    this.off = null;
    this.cancel();
    this.el = null;
  }

  get moving(): boolean {
    return this.raf !== 0;
  }

  cancel(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** the user has been hands-off the graph for `ms` */
  idleFor(ms: number): boolean {
    return performance.now() - this.lastInput > ms;
  }

  moveTo(left: number, top: number, ms?: number): void {
    const el = this.el;
    this.cancel();
    if (!el) return;
    const l0 = el.scrollLeft;
    const t0 = el.scrollTop;
    const dx = left - l0;
    const dy = top - t0;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return;
    if (reducedMotion() || document.hidden) {
      el.scrollLeft = left;
      el.scrollTop = top;
      return;
    }
    const dur = ms ?? moveDuration(dist);
    const t = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t) / dur);
      const e = easeInOutCubic(k);
      el.scrollLeft = l0 + dx * e;
      el.scrollTop = t0 + dy * e;
      this.raf = k < 1 ? requestAnimationFrame(step) : 0;
    };
    this.raf = requestAnimationFrame(step);
  }
}
