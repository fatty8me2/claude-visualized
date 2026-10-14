import { useEffect, useRef, useState } from 'react';
import { niceTicks, type GroupRow } from '@core/history';
import { formatTokens } from '@core/summarize';

/** Stack order bottom to top. Local models sit on top in their own colour so they never blend into Claude's. */
export const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'other', 'local'] as const;
export const FAMILY_LABEL: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', other: 'other', local: 'local models' };
export const familyColor = (f: string) => `var(--${FAMILIES.includes(f as (typeof FAMILIES)[number]) ? f : 'other'})`;

/** Width of an element, tracked with a ResizeObserver, so SVG text stays crisp instead of being scaled. */
export function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const H = 230;
const M = { top: 12, right: 12, bottom: 38, left: 52 };

function labelOf(g: GroupRow): string {
  const d = new Date(g.key + 'T00:00:00');
  return `${d.toLocaleString([], { month: 'short' })} ${d.getDate()}`;
}

/** Stacked bars: tokens per day (or week) by model family. Zero-based axis, gridlines, labelled axes. */
export function TokenBars({ groups, by, all }: { groups: GroupRow[]; by: 'day' | 'week'; all: boolean }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const series = (g: GroupRow) => (all ? g.byFamilyAll : g.byFamily);
  const totals = groups.map((g) => FAMILIES.reduce((n, f) => n + (series(g)[f] ?? 0), 0));
  const max = Math.max(0, ...totals);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const w = Math.max(320, width);
  const iw = w - M.left - M.right;
  const ih = H - M.top - M.bottom;
  const step = groups.length ? iw / groups.length : iw;
  const bw = Math.max(1, Math.min(34, step * 0.72));
  const y = (v: number) => M.top + ih - (v / top) * ih;
  const every = Math.max(1, Math.ceil(46 / step));
  const h = hover != null ? groups[hover] : null;

  return (
    <div ref={ref} className="hist-chart" data-testid="history-chart">
      <svg width={w} height={H} role="img" aria-label={`Tokens per ${by} by model family`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.left} x2={w - M.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'hist-axis' : 'hist-grid'} />
            <text x={M.left - 8} y={y(t) + 4} textAnchor="end" className="hist-tick">
              {formatTokens(t)}
            </text>
          </g>
        ))}
        {groups.map((g, i) => {
          let acc = 0;
          const x = M.left + i * step + (step - bw) / 2;
          return (
            <g key={g.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} data-day={g.key}>
              <rect x={M.left + i * step} y={M.top} width={step} height={ih} fill="transparent" />
              {FAMILIES.map((f) => {
                const v = series(g)[f] ?? 0;
                if (v <= 0) return null;
                const y1 = y(acc + v);
                const hgt = Math.max(1, y(acc) - y1);
                acc += v;
                return (
                  <rect key={f} x={x} y={y1} width={bw} height={hgt} fill={familyColor(f)} opacity={hover == null || hover === i ? 1 : 0.55} data-family={f} />
                );
              })}
              {i % every === 0 && (
                <text x={x + bw / 2} y={H - M.bottom + 15} textAnchor="middle" className="hist-tick">
                  {labelOf(g)}
                </text>
              )}
            </g>
          );
        })}
        <text x={M.left + iw / 2} y={H - 6} textAnchor="middle" className="hist-axis-title">
          {by === 'day' ? 'day (local time)' : 'week starting Monday'}
        </text>
        <text transform={`translate(12 ${M.top + ih / 2}) rotate(-90)`} textAnchor="middle" className="hist-axis-title">
          {all ? 'tokens incl. cache' : 'tokens in + out'}
        </text>
      </svg>
      {h && hover != null && (
        <div className="hist-tip" style={{ left: Math.min(Math.max(M.left + hover * step, 8), w - 190) }}>
          <b>{by === 'week' ? h.label : h.key}</b>
          {FAMILIES.filter((f) => (series(h)[f] ?? 0) > 0).map((f) => (
            <div key={f}>
              <i style={{ background: familyColor(f) }} /> {FAMILY_LABEL[f]} <b>{formatTokens(series(h)[f] ?? 0)}</b>
            </div>
          ))}
          <div className="hist-tip-sub">{h.messages > 0 ? `${h.messages} messages` : 'no activity'}</div>
        </div>
      )}
    </div>
  );
}

export function FamilyLegend({ present }: { present: Set<string> }) {
  return (
    <div className="hist-legend" data-testid="history-legend">
      {FAMILIES.filter((f) => present.has(f)).map((f) => (
        <span key={f} data-family={f}>
          <i style={{ background: familyColor(f) }} />
          {f === 'local' ? <span className="local-tag">⌂ local models</span> : FAMILY_LABEL[f]}
        </span>
      ))}
    </div>
  );
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Weekday x hour grid, one hue, cell opacity proportional to messages. */
export function Heatmap({ grid }: { grid: number[][] }) {
  const [ref, width] = useWidth();
  const max = Math.max(1, ...grid.flat());
  const L = 36;
  const T = 18;
  const w = Math.max(300, width);
  const cw = (w - L - 4) / 24;
  const ch = 17;
  return (
    <div ref={ref} className="hist-heat" data-testid="history-heatmap">
      <svg width={w} height={T + 7 * ch + 18} role="img" aria-label="Messages by weekday and hour of day">
        {Array.from({ length: 24 }, (_, hr) =>
          hr % 3 === 0 ? (
            <text key={hr} x={L + hr * cw + cw / 2} y={11} textAnchor="middle" className="hist-tick">
              {hr}
            </text>
          ) : null,
        )}
        {grid.map((row, d) => (
          <g key={d}>
            <text x={L - 6} y={T + d * ch + 12} textAnchor="end" className="hist-tick">
              {DAYS[d]}
            </text>
            {row.map((v, hr) => (
              <rect
                key={hr}
                x={L + hr * cw + 1}
                y={T + d * ch + 1}
                width={cw - 2}
                height={ch - 2}
                rx={2}
                className="hist-cell"
                style={v > 0 ? { fill: `color-mix(in srgb, var(--opus) ${Math.round(12 + 88 * (v / max))}%, var(--panel-2))` } : undefined}
                data-v={v}
              >
                <title>{`${DAYS[d]} ${String(hr).padStart(2, '0')}:00 - ${v} message${v === 1 ? '' : 's'}`}</title>
              </rect>
            ))}
          </g>
        ))}
        <text x={L + (24 * cw) / 2} y={T + 7 * ch + 14} textAnchor="middle" className="hist-axis-title">
          hour of day (local time) · darker = more messages, busiest cell {max}
        </text>
      </svg>
    </div>
  );
}

/** Horizontal bars with a zero baseline, value at the end. */
export function BarList({
  rows,
  color,
  testId,
  fmt = (n: number) => formatTokens(n),
}: {
  rows: { key: string; label: React.ReactNode; value: number; color?: string; title?: string }[];
  color?: string;
  testId: string;
  fmt?: (n: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="hist-bars" data-testid={testId}>
      {rows.map((r) => (
        <div key={r.key} className="hist-bar-row" title={r.title}>
          <span className="hist-bar-label">{r.label}</span>
          <span className="hist-bar-track">
            <i style={{ width: `${Math.max(1.5, (r.value / max) * 100)}%`, background: r.color ?? color ?? 'var(--opus)' }} />
          </span>
          <span className="hist-bar-val">{fmt(r.value)}</span>
        </div>
      ))}
      {rows.length === 0 && <div className="hist-empty-line">nothing in this range</div>}
    </div>
  );
}
