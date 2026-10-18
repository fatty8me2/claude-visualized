import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { reducedMotion } from '../cardFx';
import { STATUS_GLYPH, type DisplayStatus } from '../util';

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
        {st === 'done' ? (
          <>
            <svg className="tick" viewBox="0 0 12 12" aria-hidden>
              <path d="M2.2 6.4 4.9 9 9.8 3.2" />
            </svg>{' '}
            done
          </>
        ) : (
          STATUS_GLYPH[st]
        )}
        {extra}
      </Fade>
    </span>
  );
}
