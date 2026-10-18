import type { UsageView, UsageWindow } from '@core/usage';
import { useNow, useUsage } from '../hooks';
import { ago } from '../util';

const WINDOW_MS = { fiveHour: 5 * 3600_000, sevenDay: 7 * 24 * 3600_000 };
const STALE_MS = 30 * 60_000;

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

function Meter({
  label,
  w,
  span,
  now,
  compact,
  problem,
  extra,
}: {
  label: string;
  w: UsageWindow | null;
  span: number;
  now: number;
  compact?: boolean;
  problem?: string | null;
  extra?: string[];
}) {
  if (!w) {
    return (
      <div className="meter empty" title={problem ?? 'No reading yet. Click to refresh.'}>
        <span className="m-label">{label}</span>
        <span className="m-bar">
          <i style={{ width: 0 }} />
        </span>
        <span className="m-pct">{problem ? 'login needed' : 'no data'}</span>
      </div>
    );
  }
  const pct = Math.round(w.pct);
  // how far through the window we are: usage ahead of this marker means burning faster than the window refills
  const elapsed = w.resetsAt ? Math.max(0, Math.min(100, 100 - ((w.resetsAt - now) / span) * 100)) : null;
  const stale = now - w.at > STALE_MS || !!problem;
  const tip = [
    `${label}: ${pct}% used`,
    w.resetsAt ? `resets ${new Date(w.resetsAt).toLocaleString()}` : null,
    elapsed !== null ? `${Math.round(elapsed)}% of the window has elapsed` : null,
    `reading ${ago(w.at, now)}${w.source === 'transcript' ? ' (limit hit, from transcript)' : ''}`,
    ...(extra ?? []),
    problem ? `Problem: ${problem}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div className={`meter ${level(pct)} ${stale ? 'stale' : ''}`} title={tip}>
      <span className="m-label">{label}</span>
      <span className="m-bar">
        <i style={{ width: `${pct}%` }} />
        {elapsed !== null && <b style={{ left: `${elapsed}%` }} />}
      </span>
      <span className="m-pct">{pct}%</span>
      {!compact && w.resetsAt && <span className="m-reset">resets {untilText(w.resetsAt, now)}</span>}
      {!compact && stale && <span className="m-reset">· {ago(w.at, now)}</span>}
    </div>
  );
}

export function UsageMeters({ compact = false, usage: given }: { compact?: boolean; usage?: UsageView }) {
  const live = useUsage();
  const now = useNow(compact ? 30_000 : 15_000);
  const u = given ?? live;
  const problem = u?.api && u.api.state !== 'ok' ? u.api.message : null;
  const perModel = (u?.models ?? []).map((m) => `weekly ${m.label}: ${Math.round(m.window.pct)}%`);
  return (
    <div className={`usage ${compact ? 'compact' : ''}`} data-tour="usage" onClick={() => void window.api.refreshUsage()} title="Click to refresh">
      <Meter label={compact ? '5h' : '5-HOUR'} w={u?.fiveHour ?? null} span={WINDOW_MS.fiveHour} now={now} compact={compact} problem={problem} />
      <Meter
        label={compact ? 'wk' : 'WEEKLY'}
        w={u?.sevenDay ?? null}
        span={WINDOW_MS.sevenDay}
        now={now}
        compact={compact}
        problem={problem}
        extra={perModel}
      />
    </div>
  );
}
