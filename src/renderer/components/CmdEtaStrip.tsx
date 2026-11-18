// The running-command countdown (src/core/cmdEta.ts): on a card, a capsule that fills toward the command's expected end
// ("npm run test:e2e  ~2 min left · 4:12 PM", amber "running long" once overdue); in the drawer, a block with the range and
// what it is based on.
import type { CmdEta } from '@core/cmdEta';
import { fmtClock, fmtSpan } from '../eta';
import { cmdBasis, cmdLeft, type CmdStripModel } from '../cmdEta';
import '../cmdEta.css';

/**
 * The card strip, a capsule that is its own progress bar. 'tall' (subagent cards): the command and its end time on top, the
 * time left large below. 'line' (the main card) and 'compact' (small cards): one line.
 */
export function CmdEtaStrip({ m, variant }: { m: CmdStripModel; variant: 'tall' | 'line' | 'compact' }) {
  const short = m.overdue ? m.left : m.left.replace(/ left$/, '');
  return (
    <div
      className={`cmd-eta cmd-eta-${variant}${m.overdue ? ' cmd-eta-over' : ''}`}
      title={m.title}
      data-testid="cmd-eta"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(m.fraction * 100)}
      aria-valuetext={`${m.label}: ${m.left}${m.overdue ? '' : `, around ${m.when}`} (estimate)`}
    >
      <b className="cmd-eta-fill" style={{ width: `${Math.round(m.fraction * 100)}%` }} aria-hidden />
      {variant === 'tall' ? (
        <>
          <span className="cmd-eta-top">
            <span className="cmd-eta-glyph" aria-hidden>
              ›_
            </span>
            <span className="cmd-eta-cmd">{m.label}</span>
            <span className="cmd-eta-when">{m.overdue ? m.when : `≈ ${m.when}`}</span>
          </span>
          <span className="cmd-eta-left">{m.left}</span>
        </>
      ) : (
        <>
          <span className="cmd-eta-glyph" aria-hidden>
            ›_
          </span>
          <span className="cmd-eta-cmd">{m.label}</span>
          <span className="cmd-eta-left">
            {short}
            {variant === 'line' && <span className="cmd-eta-when"> · {m.when}</span>}
          </span>
        </>
      )}
    </div>
  );
}

/** The drawer block: the countdown large, the range, the timeout and what it is based on. */
export function CmdEtaBlock({ e }: { e: CmdEta }) {
  const pct = Math.round(e.fraction * 100);
  return (
    <div className={`cmd-eta-d${e.overdue ? ' cmd-eta-over' : ''}`} data-testid="drawer-cmd-eta">
      <div className="cmd-eta-d-head">
        <span className="cmd-eta-d-k">running</span>
        <code className="cmd-eta-d-cmd" title={e.key}>
          {e.key}
        </code>
        <span className="cmd-eta-d-tag" title="A guess from past runs of the same command on this computer">
          est.
        </span>
      </div>
      <div className="cmd-eta-d-big">
        {e.overdue ? 'running long' : `${cmdLeft(e.remaining)} left`}
        <span className="cmd-eta-d-in"> · {fmtSpan(e.elapsed)} so far</span>
      </div>
      <div className="cmd-eta-d-bar" aria-hidden>
        <b style={{ width: `${pct}%` }} />
      </div>
      {e.overdue ? (
        <div className="cmd-eta-d-row">Longer than nearly every past run, so the end is a rough guess.</div>
      ) : (
        <div className="cmd-eta-d-row">
          done ≈ <span className="mono">{fmtClock(e.at)}</span>
          <span className="cmd-eta-d-sep"> · </span>likely{' '}
          <span className="mono">
            {fmtClock(e.low)} – {fmtClock(e.high)}
          </span>
        </div>
      )}
      {e.timeoutAt && (
        <div className="cmd-eta-d-row">
          its timeout ends it (or moves it to the background) at <span className="mono">{fmtClock(e.timeoutAt)}</span>
        </div>
      )}
      <div className="cmd-eta-d-basis">{cmdBasis(e)}</div>
    </div>
  );
}
