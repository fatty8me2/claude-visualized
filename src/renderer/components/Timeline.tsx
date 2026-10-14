import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GOAL_INFO } from '@core/goal';
import { agentGoal } from '@core/insight';
import type { AgentNode, SessionView } from '@core/state';
import { formatDuration, modeLabel } from '@core/summarize';
import {
  axisTicks,
  barEnd,
  bucketTicks,
  fitRange,
  idleGaps,
  makeScale,
  orderLanes,
  panRange,
  toolTimes,
  visibleRows,
  zoomRange,
  type TimeRange,
} from '@core/timeline';
import { agentName, clock, famClass } from '../util';
import { GoalBadge } from './GoalBadge';
import '../timeline.css';

const ROW = 26;
const LABEL_W = 210;
const MIN_BAR_PX = 3;

export interface TimelineProps {
  view: SessionView;
  now: number;
  selectedAgent: string | null;
  onSelect: (id: string | null) => void;
  highlight?: Set<string>;
  onHoverAgent?: (id: string | null) => void;
  /** true while replaying: "now" is the replay clock and clicking empty space seeks */
  replaying?: boolean;
  /** seek the replay to a time (only given while replaying) */
  onSeekTime?: (ts: number) => void;
}

interface Tip {
  x: number;
  y: number;
  text: string;
}

const planMode = (view: SessionView) => modeLabel(view.mode).short === 'PLAN';

export function Timeline({ view, now, selectedAgent, onSelect, highlight, onHoverAgent, replaying, onSeekTime }: TimelineProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [manual, setManual] = useState<TimeRange | null>(null);
  const [follow, setFollow] = useState(false);
  const [span, setSpan] = useState(0);
  const [plotW, setPlotW] = useState(800);
  const [bodyH, setBodyH] = useState(400);
  const [scrollTop, setScrollTop] = useState(0);
  const [gutter, setGutter] = useState(0);
  const [tip, setTip] = useState<Tip | null>(null);
  const axisRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragged = useRef(false);

  // lane order only depends on the tree shape: recompute on agent count or a coarse time bucket, not on every event
  const agentCount = Object.keys(view.agents).length;
  const bucket = Math.floor(now / 3000);
  const lanes = useMemo(() => orderLanes(view.agents, collapsed), [agentCount, bucket, collapsed]); // eslint-disable-line react-hooks/exhaustive-deps
  const laneIndex = useMemo(() => new Map(lanes.map((l, i) => [l.id, i])), [lanes]);

  const fit = fitRange(view.agents, now) ?? { t0: now - 60_000, t1: now };
  const margin = span * 0.03;
  const range: TimeRange = follow && span > 0 ? { t0: now + margin - span, t1: now + margin } : (manual ?? fit);
  const scale = makeScale(range, plotW);

  // latest values for the native event handlers
  const st = useRef({ range, plotW, fit, follow });
  st.current = { range, plotW, fit, follow };

  useEffect(() => {
    const ax = axisRef.current;
    const body = bodyRef.current;
    if (!ax || !body) return;
    const ro = new ResizeObserver(() => {
      setPlotW(Math.max(100, ax.clientWidth));
      setBodyH(body.clientHeight);
      setGutter(body.offsetWidth - body.clientWidth);
    });
    ro.observe(ax);
    ro.observe(body);
    return () => ro.disconnect();
  }, []);

  const commit = useCallback((r: TimeRange, keepFollow: boolean) => {
    if (keepFollow && st.current.follow) setSpan(r.t1 - r.t0);
    else {
      setFollow(false);
      setManual(r);
    }
  }, []);

  // ctrl+wheel / pinch zooms around the cursor, shift+wheel pans; plain wheel scrolls the lanes
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.shiftKey) return;
      const ax = axisRef.current;
      if (!ax) return;
      e.preventDefault();
      const rect = ax.getBoundingClientRect();
      const { range: r, plotW: w, fit: f } = st.current;
      const unit = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey) {
        const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width)));
        commit(zoomRange(r, Math.exp(-e.deltaY * unit * 0.0025), st.current.follow ? 1 : frac, f), true);
      } else {
        const d = (e.deltaY || e.deltaX) * unit;
        commit(panRange(r, -d, w, f), false);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [commit]);

  // drag to pan; a click without a drag on empty space seeks the replay
  const onPointerDown = (e: React.PointerEvent) => {
    const t = e.target as HTMLElement;
    if (e.button !== 0 || t.closest('.tl-label, .tl-tools, button')) return;
    const ax = axisRef.current;
    if (!ax || !t.closest('.tl-head, .tl-body')) return;
    dragged.current = false;
    const startX = e.clientX;
    let lastX = e.clientX;
    const onBar = !!t.closest('[data-bar]');
    const move = (ev: PointerEvent) => {
      if (!dragged.current && Math.abs(ev.clientX - startX) < 4) return;
      dragged.current = true;
      rootRef.current?.classList.add('dragging');
      const { range: r, plotW: w, fit: f } = st.current;
      commit(panRange(r, ev.clientX - lastX, w, f), false);
      lastX = ev.clientX;
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      rootRef.current?.classList.remove('dragging');
      if (!dragged.current && !onBar && onSeekTime) {
        const rect = ax.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        if (x >= 0 && x <= rect.width) onSeekTime(makeScale(st.current.range, st.current.plotW).t(x));
      }
      if (!dragged.current) return;
      // swallow the click that follows a drag
      setTimeout(() => (dragged.current = false), 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const zoomBy = (factor: number) => commit(zoomRange(range, factor, follow ? 1 : 0.5, fit), true);
  const doFit = () => {
    setFollow(false);
    setManual(null);
  };
  const toggleFollow = () => {
    if (follow) {
      setFollow(false);
      setManual(range);
    } else {
      setSpan(Math.max(10_000, range.t1 - range.t0));
      setFollow(true);
    }
  };
  const toggleCollapsed = (id: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (!n.delete(id)) n.add(id);
      return n;
    });

  const { from, to } = visibleRows(scrollTop, bodyH, ROW, lanes.length);
  const { ticks } = axisTicks(range, plotW);
  const totalH = lanes.length * ROW;
  const pm = planMode(view);

  // spawn links: parent lane -> child lane at the child's start time, for the ones touching the visible rows
  const links: { x: number; y1: number; y2: number; id: string }[] = [];
  for (const l of lanes) {
    if (!l.parentId) continue;
    const a = view.agents[l.id];
    const pi = laneIndex.get(l.parentId);
    const ci = laneIndex.get(l.id);
    if (!a || pi === undefined || ci === undefined) continue;
    if (Math.max(pi, ci) < from || Math.min(pi, ci) >= to) continue;
    const x = scale.x(a.startedAt);
    if (x < 0 || x > plotW) continue;
    links.push({ x, y1: pi * ROW + ROW / 2, y2: ci * ROW + ROW / 2, id: l.id });
  }

  const nowX = scale.x(now);

  const tipFor = (el: HTMLElement): string | null => {
    const bar = el.closest<HTMLElement>('[data-bar]');
    const tick = el.closest<HTMLElement>('[data-tick-agent]');
    if (tick) {
      const a = view.agents[tick.dataset.tickAgent!];
      const t = Number(tick.dataset.tickT);
      const n = Number(tick.dataset.tickN);
      if (!a) return null;
      if (n > 1) return `${n} tool calls from ${clock(t)}${tick.dataset.tickFail === '1' ? '\nincluding failures' : ''}`;
      const r = a.recent.reduce<AgentNode['recent'][number] | null>(
        (best, x) => (Math.abs(x.ts - t) < 1500 && (!best || Math.abs(x.ts - t) < Math.abs(best.ts - t)) ? x : best),
        null,
      );
      if (!r) return `tool call at ${clock(t)}`;
      return `${r.name}${r.summary ? ` ${r.summary}` : ''}\n${clock(r.ts)} · ${r.ok === false ? 'failed' : r.ok === null ? 'running' : 'ok'}`;
    }
    if (bar) {
      const a = view.agents[bar.dataset.bar!];
      if (!a) return null;
      const g = agentGoal(a, a.kind === 'main' && pm);
      const last = a.currentTool ?? a.recent[a.recent.length - 1];
      const lines = [agentName(a), `${GOAL_INFO[g.goal].glyph} ${GOAL_INFO[g.goal].word}${a.description ? `: ${a.description.slice(0, 120)}` : ''}`];
      lines.push(
        `${formatDuration(barEnd(a, now) - a.startedAt)} · ${a.toolCount} tool call${a.toolCount === 1 ? '' : 's'}${a.errorCount ? ` · ${a.errorCount} failed` : ''}`,
      );
      if (last) lines.push(`${a.currentTool ? 'now' : 'last'}: ${last.name}${last.summary ? ` ${last.summary.slice(0, 80)}` : ''}`);
      return lines.join('\n');
    }
    return null;
  };
  const onMove = (e: React.MouseEvent) => {
    if (dragged.current) return setTip(null);
    const text = tipFor(e.target as HTMLElement);
    if (!text) return setTip((t) => (t ? null : t));
    const root = rootRef.current!.getBoundingClientRect();
    setTip({ x: Math.min(e.clientX - root.left + 14, Math.max(0, root.width - 300)), y: e.clientY - root.top + 16, text });
  };
  const hoverAgent = (e: React.MouseEvent) => {
    if (!onHoverAgent) return;
    onHoverAgent((e.target as HTMLElement).closest<HTMLElement>('[data-lane]')?.dataset.lane ?? null);
  };

  return (
    <div
      className={`tl ${replaying ? 'replaying' : ''} ${onSeekTime ? 'seekable' : ''}`}
      ref={rootRef}
      data-testid="timeline"
      onPointerDown={onPointerDown}
      onMouseMove={onMove}
      onMouseLeave={() => {
        setTip(null);
        onHoverAgent?.(null);
      }}
    >
      <div className="tl-tools">
        <button onClick={doFit} className={!follow && !manual ? 'on' : ''} title="Fit the whole session" data-testid="tl-fit">
          ⤢ fit
        </button>
        <button onClick={toggleFollow} className={follow ? 'on' : ''} title="Keep the right edge at now" data-testid="tl-follow">
          {replaying ? '▶ follow replay' : '▶ follow now'}
        </button>
        <button onClick={() => zoomBy(1.6)} title="Zoom in (ctrl+wheel)">
          +
        </button>
        <button onClick={() => zoomBy(1 / 1.6)} title="Zoom out (ctrl+wheel)">
          −
        </button>
        <span className="tl-hint">
          {formatDuration(range.t1 - range.t0)} visible · {lanes.length} lane{lanes.length === 1 ? '' : 's'} · ctrl+wheel zoom, drag or shift+wheel pan
          {onSeekTime ? ', click to seek' : ''}
        </span>
      </div>
      <div className="tl-head" style={{ paddingRight: gutter }}>
        <div className="tl-corner">agent</div>
        <div className="tl-axis" ref={axisRef} data-testid="tl-axis">
          {ticks.map((t) => (
            <span key={t.t} className={`tl-ax ${t.major ? 'major' : ''}`} style={{ left: scale.x(t.t) }}>
              {t.label}
            </span>
          ))}
          {nowX >= 0 && nowX <= plotW && (
            <span className="tl-nowtag" style={{ left: nowX, transform: nowX > plotW - 40 ? 'translateX(-100%)' : undefined }}>
              {replaying ? 'replay' : 'now'}
            </span>
          )}
        </div>
      </div>
      <div className="tl-body" ref={bodyRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        {lanes.length === 0 && <div className="tl-empty">no agents yet</div>}
        <div className="tl-content" style={{ height: totalH }} onMouseOver={hoverAgent}>
          <svg className="tl-grid" style={{ left: LABEL_W, width: plotW, height: totalH }} aria-hidden>
            {ticks.map((t) => (
              <line key={t.t} x1={scale.x(t.t)} x2={scale.x(t.t)} y1={0} y2={totalH} className={t.major ? 'major' : ''} />
            ))}
          </svg>
          {lanes.slice(from, to).map((lane, k) => {
            const a = view.agents[lane.id];
            if (!a) return null;
            const i = from + k;
            const start = a.startedAt;
            const end = barEnd(a, now);
            const x0 = scale.x(start);
            const x1 = scale.x(end);
            const visible = start > 0 && x1 >= 0 && x0 <= plotW;
            const left = Math.max(x0, -2);
            const width = Math.max(MIN_BAR_PX, Math.min(x1, plotW + 2) - left);
            const times = visible ? toolTimes(a) : [];
            const failed = new Set(a.recent.filter((r) => r.ok === false).map((r) => r.ts));
            const buckets = visible ? bucketTicks(times, failed, range, plotW) : [];
            const gaps = visible ? idleGaps(times, start, end) : [];
            const goal = agentGoal(a, a.kind === 'main' && pm);
            const sel = selectedAgent === a.id;
            return (
              <div
                key={lane.id}
                className={`tl-row ${sel ? 'sel' : ''} ${highlight?.has(lane.id) ? 'hl' : ''}`}
                style={{ top: i * ROW, height: ROW }}
                data-testid="tl-row"
              >
                <div
                  className="tl-label"
                  data-lane={lane.id}
                  style={{ width: LABEL_W, paddingLeft: 6 + lane.depth * 14 }}
                  onClick={() => onSelect(sel ? null : lane.id)}
                >
                  {lane.depth > 0 && <span className={`tl-conn ${lane.last ? 'last' : ''}`} />}
                  {lane.kind === 'workflow' && lane.hasChildren ? (
                    <button
                      className="tl-fold"
                      title={collapsed.has(lane.id) ? 'Expand the workflow' : 'Collapse the workflow'}
                      data-testid="tl-fold"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCollapsed(lane.id);
                      }}
                    >
                      {collapsed.has(lane.id) ? '▸' : '▾'}
                    </button>
                  ) : null}
                  <GoalBadge goal={goal} glyphOnly />
                  <span className="tl-name">{agentName(a)}</span>
                  {a.description && lane.kind !== 'main' && <span className="tl-desc">{a.description}</span>}
                </div>
                <div className="tl-lp" style={{ left: LABEL_W, width: plotW }}>
                  {visible && (
                    <div
                      className={`tl-bar ${famClass(a.model)} st-${a.status} ${a.endedAt == null && a.status === 'running' ? 'live' : ''}`}
                      style={{ left, width }}
                      data-bar={a.id}
                      data-testid="tl-bar"
                      onClick={() => {
                        if (!dragged.current) onSelect(sel ? null : a.id);
                      }}
                    >
                      {x0 >= -2 && width > 18 && <GoalBadge goal={goal} glyphOnly />}
                    </div>
                  )}
                  {gaps.map(([g0, g1], gi) => {
                    const gl = Math.max(scale.x(g0), 0);
                    const gr = Math.min(scale.x(g1), plotW);
                    return gr > gl ? <i key={gi} className="tl-gap" style={{ left: gl, width: gr - gl }} /> : null;
                  })}
                  {buckets.map((b) => (
                    <i
                      key={b.t}
                      className={`tl-tick ${b.fail ? 'fail' : ''} ${b.n > 1 ? 'multi' : ''}`}
                      style={{ left: scale.x(b.t) }}
                      data-tick-agent={a.id}
                      data-tick-t={b.t}
                      data-tick-n={b.n}
                      data-tick-fail={b.fail ? 1 : 0}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          <svg className="tl-over" style={{ left: LABEL_W, width: plotW, height: totalH }} aria-hidden>
            {links.map((l) => (
              <line key={l.id} x1={l.x} x2={l.x} y1={l.y1} y2={l.y2} className="tl-spawn" />
            ))}
            {nowX >= 0 && nowX <= plotW && <line x1={nowX} x2={nowX} y1={0} y2={totalH} className="tl-now" data-testid="tl-now" />}
          </svg>
        </div>
      </div>
      {tip && (
        <div className="tl-tip" style={{ left: tip.x, top: tip.y }} data-testid="tl-tip">
          {tip.text}
        </div>
      )}
    </div>
  );
}
