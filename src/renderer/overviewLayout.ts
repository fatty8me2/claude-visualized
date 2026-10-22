import { useCallback, useLayoutEffect, useState } from 'react';
import { DEFAULT_OVERVIEW, sanitizeOverview, type OverviewLayout } from '@core/overviewGrid';

const STORE = 'cvis.overview.v1';

function load(): OverviewLayout {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? sanitizeOverview(JSON.parse(raw)) : DEFAULT_OVERVIEW;
  } catch {
    return DEFAULT_OVERVIEW;
  }
}

function save(l: OverviewLayout) {
  try {
    localStorage.setItem(STORE, JSON.stringify(l));
  } catch {
    /* storage unavailable: the layout lasts for this run */
  }
}

// ---------- FLIP: snapshot panel rects before a change, spring from there after it (same feel as layout.tsx) ----------

const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
let pending: Map<string, DOMRect> | null = null;

/** call right before a state change that moves panels */
export function markFlip() {
  pending = new Map();
  document.querySelectorAll<HTMLElement>('.ov-grid [data-flip]').forEach((el) => pending!.set(el.dataset.flip!, el.getBoundingClientRect()));
}

function playFlip() {
  const first = pending;
  pending = null;
  if (!first || reducedMotion()) return;
  let i = 0;
  document.querySelectorAll<HTMLElement>('.ov-grid [data-flip]').forEach((el) => {
    const a = first.get(el.dataset.flip!);
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) return;
    if (!a || !a.width || !a.height) {
      el.animate(
        [
          { opacity: 0, transform: 'scale(0.94)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 380, easing: 'cubic-bezier(.2,1.2,.3,1)' },
      );
      return;
    }
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    const sx = a.width / b.width;
    const sy = a.height / b.height;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
    const delay = Math.min(i++, 6) * 35;
    // transform only: the panel springs from its old rect to the new one
    el.animate(
      [
        { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { transformOrigin: 'top left', transform: 'translate(0, 0) scale(1, 1)' },
      ],
      { duration: 620, delay, easing: 'cubic-bezier(.18,1.28,.32,1)', fill: 'backwards' },
    );
    // a flash of the model's colour over the glass (opacity only)...
    el.querySelector<HTMLElement>(':scope > .ov-flash')?.animate([{ opacity: 0.9 }, { opacity: 0 }], {
      duration: 760,
      delay,
      easing: 'ease-out',
      fill: 'backwards',
    });
    // ...and when the size changed, the content (laid out at its final size, so squashed mid-flight) fades in as the panel settles
    if (Math.abs(sx - 1) > 0.02 || Math.abs(sy - 1) > 0.02) {
      el.querySelectorAll<HTMLElement>(':scope > .ov-body, :scope > .ov-tool').forEach((c) =>
        c.animate([{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1 }], { duration: 560, delay, easing: 'ease-out', fill: 'backwards' }),
      );
    }
  });
}

/** put in the component that owns the grid: plays a pending FLIP after every render that followed markFlip() */
export function useFlipPlayer() {
  useLayoutEffect(() => {
    if (pending) playFlip();
  });
}

// ---------- state ----------

export function useOverviewLayout() {
  const [layout, setRaw] = useState<OverviewLayout>(load);

  /** change with the spring animation (anything that moves or resizes panels) */
  const change = useCallback((fn: (l: OverviewLayout) => OverviewLayout) => {
    markFlip();
    setRaw((l) => {
      const next = fn(l);
      save(next);
      return next;
    });
  }, []);

  /** change without animating (live resizing) */
  const changeQuiet = useCallback((fn: (l: OverviewLayout) => OverviewLayout) => {
    setRaw((l) => {
      const next = fn(l);
      save(next);
      return next;
    });
  }, []);

  return { layout, change, changeQuiet };
}

export type OverviewApi = ReturnType<typeof useOverviewLayout>;
