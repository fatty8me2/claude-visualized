import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { reducedMotion } from '../cardFx';
import { STATUS_WORD, type DisplayStatus } from '../util';
import { Icon } from './Icon';

/**
 * Text that fades (and settles 3px) when `k` changes, instead of snapping. The first render and changes that `enabled()` rejects
 * (a session switch, bulk updates) stay instant.
 */
export function Fade({ k, enabled, className, children }: { k: string; enabled: () => boolean; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(k);
  useLayoutEffect(() => {
    if (prev.current === k) return;
    prev.current = k;
    if (!enabled() || reducedMotion() || document.hidden) return;
    ref.current?.animate(
      [
        { opacity: 0, transform: 'translateY(3px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 240, easing: 'ease-out' },
    );
  }, [k, enabled]);
  return (
    <span ref={ref} className={`fade${className ? ` ${className}` : ''}`}>
      {children}
    </span>
  );
}

/** The status word. Done gets a stroke-drawn check (animated by cardFx when the agent finishes in front of you). */
export function StatusLabel({ st, extra, enabled }: { st: DisplayStatus; extra?: string; enabled: () => boolean }) {
  return (
    <span className={`status ${st}`}>
      <Fade k={st} enabled={enabled}>
        <StatusText st={st} />
        {extra}
      </Fade>
    </span>
  );
}

/** a stable 0..1 number per agent, so a hundred running cards do not sweep and orbit in lockstep */
export function seedOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 997;
  return h / 997;
}

/**
 * The effect layers inside a card. Empty `<i>` elements, all behind the text (graphCards.css): the one-shot glow (.fx), the orbiting
 * energy border and scan sweep while running, the breathing ring and corner brackets while waiting, the targeting reticle when
 * selected, and the mesh and stripe on the main card. Only the layers a state needs are mounted.
 */
export function FxLayers({ st, selected, main }: { st: DisplayStatus; selected: boolean; main: boolean }) {
  return (
    <>
      <i className="fx" aria-hidden />
      {main && <i className="mesh" aria-hidden />}
      {main && <i className="stripe" aria-hidden />}
      {st === 'running' && <i className="orbit" aria-hidden />}
      {st === 'running' && <i className="scan" aria-hidden />}
      {st === 'waiting' && <i className="ring" aria-hidden />}
      {(selected || st === 'waiting') && <i className="brackets" aria-hidden />}
    </>
  );
}

/** Icon + word for a display status. "done" draws its check as a stroked path so cardFx can animate it. */
export function StatusText({ st }: { st: DisplayStatus }) {
  return (
    <>
      {st === 'done' ? (
        <svg className="tick" viewBox="0 0 12 12" aria-hidden>
          <path d="M2.2 6.4 4.9 9 9.8 3.2" />
        </svg>
      ) : (
        <Icon name={st} size="xs" className={`st-icon st-${st}`} />
      )}{' '}
      {STATUS_WORD[st]}
    </>
  );
}
