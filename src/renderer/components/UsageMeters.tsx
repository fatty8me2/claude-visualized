import { useEffect, useState, type CSSProperties } from 'react';
import type { UsageView, UsageWindow } from '@core/usage';
import type { WindowEstimate } from '@core/usageEstimate';
import { useNow, useUsage } from '../hooks';
import { ago } from '../util';
import '../chrome.css';

const WINDOW_MS = { fiveHour: 5 * 3600_000, sevenDay: 7 * 24 * 3600_000 };
/** until the poller reports its own cadence */
const DEFAULT_INTERVAL_MS = 3 * 60_000;

function level(pct: number): 'ok' | 'warn' | 'hot' {
  if (pct >= 85) return 'hot';
  if (pct >= 60) return 'warn';
  return 'ok';
}

function untilText(resetsAt: number, now: number): string {
  const ms = resetsAt - now;
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return new Date(resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** "in 45s" / "in 3m" */
function inText(at: number, now: number): string {
  const s = Math.max(0, Math.round((at - now) / 1000));
  return s < 90 ? `in ${s}s` : `in ${Math.round(s / 60)}m`;
}

const SOURCE: Record<UsageWindow['source'], string> = {
  statusline: 'live from a terminal session',
  api: 'from the usage API',
  transcript: 'limit hit, from transcript',
};

function Meter({
  label,
  w,
  span,
  now,
  compact,
  problem,
  extra,
  staleMs,
  footer,
  est,
}: {
  label: string;
  w: UsageWindow | null;
  span: number;
  now: number;
  compact?: boolean;
  problem?: string | null;
  extra?: string[];
  staleMs: number;
  footer: string[];
  est?: WindowEstimate;
}) {
  if (!w) {
    return (
      <div className="meter empty" title={[problem ?? 'No reading yet. Click to refresh.', ...footer].join('\n')}>
        <span className="m-label">{label}</span>
        <span className="m-bar">
          <i style={{ width: 0 }} />
        </span>
        <span className="m-pct">{problem ? 'login needed' : 'no data'}</span>
      </div>
    );
  }
  const confirmed = Math.round(w.pct);
  // live estimate: the confirmed reading plus what the transcripts say was spent since (snaps back to the next real reading)
  const estimating = !!est && !w.inferred && Math.round(est.pct) > confirmed;
  const pct = estimating ? Math.round(est!.pct) : confirmed;
  // how far through the window we are: usage ahead of this marker means burning faster than the window refills
  const elapsed = w.resetsAt ? Math.max(0, Math.min(100, 100 - ((w.resetsAt - now) / span) * 100)) : null;
  // a reading older than two polling intervals is not trusted; after a failed poll a reading older than one interval is marked too (the last good numbers stay)
  const stale = now - w.at > staleMs || (!!problem && now - w.at > staleMs / 2);
  const tip = [
    estimating ? `${label}: ~${pct}% used (live estimate)` : `${label}: ${pct}% used`,
    estimating
      ? `Last confirmed: ${confirmed}%, ${ago(w.at, now)} (${SOURCE[w.source]}). Since then the transcripts show about +${Math.max(1, pct - confirmed)} points${est!.calibrated ? '' : ' (rate not yet learned for this account)'}.`
      : null,
    w.inferred ? 'The window has just reset; waiting for the first reading of the new one.' : null,
    w.resetsAt ? `resets ${new Date(w.resetsAt).toLocaleString()}` : null,
    elapsed !== null ? `${Math.round(elapsed)}% of the window has elapsed` : null,
    estimating ? null : `updated ${ago(w.at, now)} (${SOURCE[w.source]})${now - w.at > staleMs ? ': stale' : ''}`,
    ...(extra ?? []),
    ...footer,
    problem ? `Problem: ${problem}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const lvl = level(pct);
  const lines = tip.split(String.fromCharCode(10));
  return (
    <div className={`meter ${lvl} ${stale ? 'stale' : ''} ${estimating ? 'est' : ''}`} title={compact ? tip : undefined} data-src={w.source} data-est={estimating ? '1' : undefined}>
      {/* a fresh reading sweeps a sheen across the pill (re-keyed on every new reading) */}
      <span className="m-tick" key={`t${w.at}`} aria-hidden />
      <span className="m-label">{label}</span>
      <span className="m-bar" style={{ '--p': pct / 100 } as CSSProperties}>
        <i style={{ width: `${pct}%` }} />
        {elapsed !== null && <b style={{ left: `${elapsed}%` }} />}
      </span>
      <span className="m-pct" data-confirmed={confirmed}>
        {estimating ? '~' : ''}
        {pct}%
      </span>
      <span className="m-dot" key={w.at} data-testid="m-dot" />
      {!compact && w.resetsAt && (
        <span className="m-reset">
          resets <em>{untilText(w.resetsAt, now)}</em>
        </span>
      )}
      {!compact && stale && !estimating && <span className="m-reset m-age">· {ago(w.at, now)}</span>}
      {!compact && (
        <span className="m-pop" role="tooltip">
          <b className="m-pop-h">
            {lines[0]}
            <em>{estimating ? 'estimate' : SOURCE[w.source]}</em>
          </b>
          {lines.slice(1).map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </span>
      )}
    </div>
  );
}

export function UsageMeters({ compact = false, usage: given }: { compact?: boolean; usage?: UsageView }) {
  const live = useUsage();
  const now = useNow(compact ? 10_000 : 5_000);
  const u = given ?? live;
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 8_000);
    return () => clearTimeout(t);
  }, [note]);
  const problem = u?.api && u.api.state !== 'ok' ? u.api.message : null;
  const perModel = (u?.models ?? []).map((m) => `weekly ${m.label}: ${Math.round(m.window.pct)}%`);
  const staleMs = 2 * Math.max(60_000, u?.api?.intervalMs ?? DEFAULT_INTERVAL_MS);
  const footer = [
    u?.api?.blockedUntil && u.api.blockedUntil > now ? `The usage API asked us to wait: next read ${inText(u.api.blockedUntil, now)}.` : null,
    u?.api?.nextAt && u.api.nextAt > now && !(u.api.blockedUntil && u.api.blockedUntil > now) ? `Next automatic read ${inText(u.api.nextAt, now)}.` : null,
    note,
    'Click to refresh.',
  ].filter((x): x is string => !!x);
  const click = () =>
    void window.api.refreshUsage().then((r) => {
      if (r && !r.ran && r.nextAllowedAt) setNote(`Too soon to ask again: next read allowed ${inText(r.nextAllowedAt, Date.now())}.`);
    });
  return (
    <div className={`usage ${compact ? 'compact' : ''}`} data-tour="usage" onClick={click}>
      <Meter label={compact ? '5h' : '5-HOUR'} w={u?.fiveHour ?? null} span={WINDOW_MS.fiveHour} now={now} compact={compact} problem={problem} staleMs={staleMs} footer={footer} est={u?.estimate?.fiveHour} />
      <Meter
        label={compact ? 'wk' : 'WEEKLY'}
        w={u?.sevenDay ?? null}
        span={WINDOW_MS.sevenDay}
        now={now}
        compact={compact}
        problem={problem}
        extra={perModel}
        staleMs={staleMs}
        footer={footer}
        est={u?.estimate?.sevenDay}
      />
      {!compact && note && <span className="m-note">{note}</span>}
    </div>
  );
}
