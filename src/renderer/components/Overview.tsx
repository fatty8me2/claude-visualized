import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { MAIN, type SessionView } from '@core/state';
import { contextInfo } from '@core/context';
import { CtxChip } from './ContextMeter';
import { GOAL_INFO } from '@core/goal';
import { coarseNow, panelPlan, panelTier, type PanelTier } from '@core/panelContent';
import { resolvePlan } from '@core/plan';
import { agentGoal, agentInsight } from '@core/insight';
import { formatTokens, modelLabel } from '@core/summarize';
import {
  DEFAULT_OVERVIEW,
  DENSITIES,
  MIN_COL_PX,
  MIN_ROW_PX,
  SIZE_STEPS,
  defaultColumns,
  fitFr,
  mergeOrder,
  placeItems,
  resizeTracks,
  sizeLabel,
  swapOrder,
  toggleIn,
  trackTemplate,
  type Density,
  type Span,
} from '@core/overviewGrid';
import { GoalBadge } from './GoalBadge';
import { seedOf, StatusText } from './cardParts';
import { useNow, useOverview } from '../hooks';
import { agentName, ago, clock, displayStatus, famClass } from '../util';
import { AgentGraph } from './AgentGraph';
import { AgentTable, InsightRail, LiveFeed, PlanStrip, Roll, SideRail } from './PanelExtras';
import { isLocalModel, LocalChip, LocalTag } from './LocalBits';
import { estimateAgents, estimateTooltip, formatUSD } from '@core/pricing';
import { Icon } from './Icon';
import { MachineChip } from './MachineChip';
import { openInClaude } from '../state/toast';
import { markFlip, useFlipPlayer, useOverviewLayout, type OverviewApi } from '../overviewLayout';

const DENSITY_HINT: Record<Density, string> = {
  compact: 'Compact: more columns, a slim header, just the graph and a short log',
  comfortable: 'Comfortable: balanced columns; panels add insights as they grow',
  spacious: 'Spacious: fewer, larger panels that show more sooner',
};

/** a tiny picture of a span, used on the size buttons */
function SpanGlyph({ s }: { s: Span }) {
  return (
    <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden>
      <rect x={1} y={1} width={s.c === 2 ? 10 : 4.6} height={s.r === 2 ? 10 : 4.6} rx={1} fill="currentColor" opacity={0.9} />
      <rect x={1} y={1} width={10} height={10} rx={1.4} fill="none" stroke="currentColor" opacity={0.35} />
    </svg>
  );
}

/** a short, wide small-tier panel has room beside the graph: from this body width it gets a slim side rail */
const SIDE_RAIL_W = 980;

interface PanelProps {
  v: SessionView;
  index: number;
  now: number;
  activeOnly: boolean;
  density: Density;
  span: Span;
  cellStyle: CSSProperties;
  pinned: boolean;
  hidden: boolean;
  maximized: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onOpen: (id: string) => void;
  onSize: (id: string, s: Span) => void;
  onPin: (id: string) => void;
  onHide: (id: string) => void;
  onMaximize: (id: string) => void;
  onHeadDown: (id: string, e: ReactPointerEvent) => void;
  suppressClick: () => boolean;
}

function Panel(p: PanelProps) {
  const { v, index, now, activeOnly, density, span, pinned, hidden, maximized } = p;
  const main = v.agents[MAIN];
  const st = main ? displayStatus(main, now) : 'idle';
  const subs = Object.values(v.agents).filter((a) => a.kind === 'agent');
  const running = subs.filter((a) => a.status === 'running').length;
  const plan = v.mode === 'plan';
  const localAgents = Object.values(v.agents).filter((a) => isLocalModel(a.model)).length;
  const tokens = v.totals.in + v.totals.out + v.totals.cacheRead + v.totals.cacheWrite;
  // what the panel shows follows the size of its body (below the header) and the density
  const bodyRef = useRef<HTMLDivElement>(null);
  const [body, setBody] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setBody((o) => (o.w === el.clientWidth && o.h === el.clientHeight ? o : { w: el.clientWidth, h: el.clientHeight }));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  const prevTier = useRef<PanelTier | undefined>(undefined);
  const tier = panelTier(body.w, body.h, density, prevTier.current);
  prevTier.current = tier;
  const hasPlan = useMemo(() => tier === 'large' && !!resolvePlan(v.plan, v.todos), [tier, v.plan, v.todos]);
  const pp = panelPlan(tier, density, body.w, body.h, hasPlan);
  const tick = coarseNow(now);
  const side = tier === 'small' && density !== 'compact' && body.w >= SIDE_RAIL_W;
  const logLines = side ? 0 : pp.logLines;
  const recent = logLines > 0 ? v.log.filter((l) => l.kind !== 'text').slice(-logLines) : [];
  const project = v.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const ctx = main ? contextInfo(main) : null;
  const live = st === 'running' || running > 0;
  const tone = st === 'waiting' ? 'waiting' : live ? 'live' : 'idle';
  const est = v.costUSD == null ? estimateAgents(v.agents) : null;
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (openTimer.current && clearTimeout(openTimer.current)), []);
  const cls = [
    'ov-panel',
    plan ? 'plan' : 'build',
    st === 'waiting' ? 'waiting' : '',
    tone,
    famClass(main?.model),
    `d-${density}`,
    pinned ? 'pinned' : '',
    hidden ? 'ghosted' : '',
    maximized ? 'maximized' : '',
    p.dragging ? 'dragging' : '',
    p.dropTarget ? 'drop-target' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <section
      className={cls}
      style={{ ...p.cellStyle, '--seed': seedOf(v.id) } as CSSProperties}
      data-session={v.id}
      data-flip={v.id}
      data-size={sizeLabel(span)}
      data-tier={tier}
    >
      <i className="ov-edge" aria-hidden />
      <i className="ov-sheen" aria-hidden />
      <i className="ov-flash" aria-hidden />
      <i className="ov-ring" aria-hidden />
      <header
        className="ov-head"
        onPointerDown={(e) => p.onHeadDown(v.id, e)}
        onClick={(e) => {
          if (p.suppressClick()) return;
          // a double-click maximizes instead of opening, so a single click waits a beat
          if (e.detail >= 2) {
            if (openTimer.current) clearTimeout(openTimer.current);
            return;
          }
          if (openTimer.current) clearTimeout(openTimer.current);
          openTimer.current = setTimeout(() => p.onOpen(v.id), 230);
        }}
        onDoubleClick={() => p.onMaximize(v.id)}
        title="Click to open, double-click to maximize, drag onto another panel to swap"
      >
        <span className="ov-light" data-tone={tone} aria-hidden>
          <i />
        </span>
        <span className="ov-num">{index + 1}</span>
        <span className={`modebadge chip ${plan ? 'plan' : ''}`} data-tone={plan ? 'plan' : 'build'}>
          {plan ? 'PLAN' : 'BUILD'}
        </span>
        <div className="ov-titles">
          <div className="ov-title">
            {v.machine && (
              <>
                <MachineChip machine={v.machine} />{' '}
              </>
            )}
            {v.title ?? 'untitled session'}
          </div>
          <div className="ov-sub">
            {project}
            {v.entrypoint === 'claude-desktop' ? ' · desktop' : v.entrypoint === 'opencode' ? ' · OpenCode' : v.entrypoint ? ` · ${v.entrypoint}` : ''}
            {v.lastActivity ? ` · ${ago(v.lastActivity, now)}` : ''}
          </div>
        </div>
        <div className="ov-stats">
          <span className={`status ${st} ${famClass(main?.model)}`}>
            <b style={{ color: 'var(--fam)' }}>{modelLabel(main?.model)}</b> {isLocalModel(main?.model) && <LocalTag />} <StatusText st={st} />
          </span>
          <span className="ov-sub ov-meta">
            {ctx?.windowKnown && (
              <span className={`ov-gauge ${ctx.level}`} style={{ '--p': Math.min(1, ctx.fraction) } as CSSProperties} aria-hidden>
                <i />
              </span>
            )}
            <CtxChip agent={main} />
            {main && main.contextTokens > 0 ? ' · ' : ''}
            agents {running}/{subs.length}
            {localAgents > 0 && !isLocalModel(main?.model) ? ` · ${localAgents} local` : ''} · <Roll text={formatTokens(tokens)} /> tok
            {v.costUSD != null ? (
              ` · $${v.costUSD.toFixed(2)}`
            ) : est && est.usd > 0 ? (
              <span title={estimateTooltip(est)}> · est. ~{formatUSD(est.usd)}</span>
            ) : (
              ''
            )}
          </span>
        </div>
        <div className="ov-ctl" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <span className="ov-sizes" role="group" aria-label="Panel size">
            {SIZE_STEPS.map((s) => {
              const on = s.c === span.c && s.r === span.r;
              return (
                <button
                  key={sizeLabel(s)}
                  className={`ov-ibtn ${on ? 'on' : ''}`}
                  aria-pressed={on}
                  title={`Panel size ${sizeLabel(s)}`}
                  data-testid={`size-${sizeLabel(s)}`}
                  onClick={() => p.onSize(v.id, s)}
                >
                  <SpanGlyph s={s} />
                </button>
              );
            })}
          </span>
          <button
            className={`ov-ibtn ${pinned ? 'on' : ''}`}
            aria-pressed={pinned}
            title={pinned ? 'Unpin' : 'Pin to the top-left'}
            data-testid="ov-pin"
            onClick={() => p.onPin(v.id)}
          >
            <Icon name="pin" size="xs" />
          </button>
          <button
            className={`ov-ibtn ${maximized ? 'on' : ''}`}
            aria-pressed={maximized}
            title={maximized ? 'Restore (Esc)' : 'Maximize'}
            data-testid="ov-max"
            onClick={() => p.onMaximize(v.id)}
          >
            <Icon name={maximized ? 'collapse' : 'fit'} size="xs" />
          </button>
          <button className="ov-ibtn" title={hidden ? 'Show this panel again' : 'Hide from the overview'} data-testid="ov-hide" onClick={() => p.onHide(v.id)}>
            <Icon name={hidden ? 'unhide' : 'hide'} size="xs" />
          </button>
          <button
            className="ov-claude"
            title={v.machine ? `This session is running on ${v.machine}` : 'Open in the Claude desktop app'}
            onClick={() => void openInClaude(v.id)}
          >
            <Icon name="openExternal" size="xs" />
            Claude
          </button>
        </div>
      </header>
      {main && density !== 'compact' && (
        <div className={`ov-tool ${famClass(main.model)}`}>
          <GoalBadge goal={agentGoal(main, plan)} glyphOnly /> <span className="lbl">now:</span> {agentInsight(v.agents, main, now, plan).activity.line}
          {running > 0 && (
            <span className="ov-subs">
              {' '}
              ·{' '}
              {subs
                .filter((a) => a.status === 'running')
                .slice(0, 3)
                .map((a) => `${GOAL_INFO[agentGoal(a).goal].word} ${agentName(a)}: ${agentInsight(v.agents, a, now).activity.phrase}`)
                .join('  ·  ')}
            </span>
          )}
        </div>
      )}
      <div
        className={`ov-body ${side ? 'side' : ''}`}
        ref={bodyRef}
        data-tier={tier}
        data-wide={pp.wide ? 1 : 0}
        data-side={side ? 1 : 0}
        data-testid="ov-body"
      >
        <div className="ov-graph">
          <AgentGraph
            view={v}
            now={now}
            selectedAgent={null}
            onSelect={() => p.onOpen(v.id)}
            showFinished={!activeOnly}
            onToggleFinished={() => {}}
            embedded
            fill
          />
        </div>
        {side && <SideRail v={v} tick={tick} feed={body.h >= 350} />}
        {pp.rail && <InsightRail v={v} tick={tick} />}
        {pp.plan && !pp.wide && <PlanStrip v={v} />}
        {pp.feed && (
          <div className="px-lower">
            <LiveFeed v={v} />
            {pp.wide ? (
              <div className="stack">
                {pp.plan && <PlanStrip v={v} />}
                {pp.table && <AgentTable v={v} now={now} rows={pp.tableRows} />}
              </div>
            ) : (
              pp.table && <AgentTable v={v} now={now} rows={pp.tableRows} />
            )}
          </div>
        )}
        {logLines > 0 && (
          <footer className="ov-log">
            {recent.length === 0 && <div className="empty-note">no activity yet</div>}
            {recent.map((l) => (
              <div key={l.seq}>
                <span style={{ color: 'var(--faint)' }}>{clock(l.ts)}</span>{' '}
                <span className={famClass(v.agents[l.agentId]?.model)} style={{ color: 'var(--fam)' }}>
                  {agentName(v.agents[l.agentId])}
                </span>{' '}
                {l.text}
              </div>
            ))}
          </footer>
        )}
      </div>
    </section>
  );
}

// ---------- resize handles ----------

interface Tracks {
  cols: number[];
  rows: number[];
  gapX: number;
  gapY: number;
  padL: number;
  padT: number;
  w: number;
  h: number;
}

const px = (s: string) => (s && s !== 'none' ? s.split(/\s+/).map(parseFloat).filter(Number.isFinite) : []);

function measureTracks(grid: HTMLElement): Tracks {
  const cs = getComputedStyle(grid);
  const cols = px(cs.gridTemplateColumns);
  const rows = px(cs.gridTemplateRows);
  const gapX = parseFloat(cs.columnGap) || 0;
  const gapY = parseFloat(cs.rowGap) || 0;
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padT = parseFloat(cs.paddingTop) || 0;
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  return {
    cols,
    rows,
    gapX,
    gapY,
    padL,
    padT,
    w: padL + sum(cols) + gapX * Math.max(0, cols.length - 1) + (parseFloat(cs.paddingRight) || 0),
    h: Math.max(grid.clientHeight, padT + sum(rows) + gapY * Math.max(0, rows.length - 1) + (parseFloat(cs.paddingBottom) || 0)),
  };
}

const sameTracks = (a: Tracks | null, b: Tracks) => !!a && JSON.stringify(a) === JSON.stringify(b);

function Handle({
  axis,
  index,
  style,
  onResize,
  onReset,
  getPx,
}: {
  axis: 'col' | 'row';
  index: number;
  style: CSSProperties;
  onResize: (i: number, d: number, startPx: number[]) => void;
  onReset: () => void;
  getPx: () => number[];
}) {
  const down = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const start = axis === 'col' ? e.clientX : e.clientY;
    const startPx = getPx();
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => onResize(index, (axis === 'col' ? ev.clientX : ev.clientY) - start, startPx);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const key = (e: ReactKeyboardEvent) => {
    const dir: Record<string, number> = axis === 'col' ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
    const d = dir[e.key];
    if (!d) return;
    e.preventDefault();
    onResize(index, d * (e.shiftKey ? 80 : 24), getPx());
  };
  return (
    <div
      className={`ov-rz ov-rz-${axis}`}
      style={style}
      role="separator"
      aria-orientation={axis === 'col' ? 'vertical' : 'horizontal'}
      tabIndex={0}
      title="Drag to resize, double-click to even out, arrow keys nudge"
      data-testid={`ov-rz-${axis}-${index}`}
      onPointerDown={down}
      onKeyDown={key}
      onDoubleClick={onReset}
    />
  );
}

// ---------- the page ----------

export function Overview({ onOpen, onLocal, activeOnly = false }: { onOpen: (id: string) => void; onLocal: () => void; activeOnly?: boolean }) {
  const views = useOverview();
  const now = useNow(1000);
  const api: OverviewApi = useOverviewLayout();
  const { layout, change, changeQuiet } = api;
  const [showHidden, setShowHidden] = useState(false);
  const [maxId, setMaxId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; over: string | null } | null>(null);
  const [tracks, setTracks] = useState<Tracks | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const justDragged = useRef(false);
  useFlipPlayer();

  const byId = useMemo(() => new Map((views ?? []).map((v) => [v.id, v])), [views]);
  const liveIds = useMemo(() => (views ?? []).map((v) => v.id), [views]);
  /** every live session in display order (pinned first, saved order, newcomers last) */
  const ordered = useMemo(() => mergeOrder(layout.order, liveIds, layout.pinned), [layout.order, liveIds, layout.pinned]);
  const hiddenLive = ordered.filter((id) => layout.hidden.includes(id));
  const shown = ordered.filter((id) => showHidden || !layout.hidden.includes(id));
  const maxActive = maxId && shown.includes(maxId) ? maxId : null;

  const n = shown.length;
  const cols = maxActive ? 1 : defaultColumns(n, layout.density);
  const placed = useMemo(
    () =>
      maxActive
        ? { cells: [{ id: maxActive, c: 1, r: 1, col: 0, row: 0 }], rows: 1 }
        : placeItems(
            shown.map((id) => ({ id, c: layout.sizes[id]?.c ?? 1, r: layout.sizes[id]?.r ?? 1 })),
            cols,
          ),
    [shown, layout.sizes, cols, maxActive],
  );
  const colFr = fitFr(layout.colFr[String(cols)], cols);
  const rowFr = fitFr(layout.rowFr, placed.rows, true);
  const colKey = colFr.join();
  const rowKey = rowFr.join();
  const loaded = views !== null;
  const cellOf = useMemo(() => new Map(placed.cells.map((c) => [c.id, c])), [placed]);

  // Esc restores a maximized panel
  useEffect(() => {
    if (!maxActive) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && toggleMax(maxActive);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // measure the tracks so the resize handles sit on the borders (and follow the window / panel changes)
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      const t = measureTracks(grid);
      setTracks((old) => (sameTracks(old, t) ? old : t));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(grid);
    return () => ro.disconnect();
  }, [colKey, rowKey, cols, placed.rows, maxActive, loaded]);

  const toggleMax = (id: string) => {
    markFlip();
    setMaxId((cur) => (cur === id ? null : id));
  };
  const setSize = (id: string, s: Span) =>
    change((l) => {
      const sizes = { ...l.sizes };
      if (s.c === 1 && s.r === 1) delete sizes[id];
      else sizes[id] = s;
      return { ...l, sizes };
    });
  const pin = (id: string) => change((l) => ({ ...l, pinned: toggleIn(l.pinned, id), order: mergeOrder(l.order, liveIds, []) }));
  const hide = (id: string) => {
    if (maxId === id) setMaxId(null);
    change((l) => ({ ...l, hidden: toggleIn(l.hidden, id) }));
  };
  const setDensity = (d: Density) => change((l) => ({ ...l, density: d }));
  const reset = () => {
    setShowHidden(false);
    setMaxId(null);
    change(() => DEFAULT_OVERVIEW);
  };

  const resizeCol = (i: number, d: number, startPx: number[]) =>
    changeQuiet((l) => ({ ...l, colFr: { ...l.colFr, [String(cols)]: resizeTracks(fitFr(l.colFr[String(cols)], cols), i, d, startPx, MIN_COL_PX) } }));
  const resizeRow = (i: number, d: number, startPx: number[]) =>
    changeQuiet((l) => ({ ...l, rowFr: resizeTracks(fitFr(l.rowFr, placed.rows, true), i, d, startPx, MIN_ROW_PX) }));

  // drag a header onto another panel to swap them
  const headDown = (id: string, e: ReactPointerEvent) => {
    if (e.button !== 0 || maxActive || (e.target as HTMLElement).closest('button, a, input')) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let active = false;
    const overAt = (x: number, y: number): string | null => {
      const el = document.elementsFromPoint(x, y).find((nd) => (nd as HTMLElement).dataset?.session && (nd as HTMLElement).dataset.session !== id) as
        HTMLElement | undefined;
      return el?.dataset.session ?? null;
    };
    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      active = true;
      document.body.classList.add('resizing');
      setDrag({ id, x: ev.clientX, y: ev.clientY, over: overAt(ev.clientX, ev.clientY) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      if (!active) return;
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
      const over = ev.type === 'pointerup' ? overAt(ev.clientX, ev.clientY) : null;
      setDrag(null);
      // pinned panels stay on top, so a swap only makes sense within the same group
      if (over && layout.pinned.includes(id) === layout.pinned.includes(over)) change((l) => ({ ...l, order: swapOrder(ordered, id, over) }));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  if (!views)
    return (
      <div className="empty-state">
        <span className="loading">loading sessions…</span>
      </div>
    );
  const total = views.length;
  const running = views.reduce((k, v) => k + Object.values(v.agents).filter((a) => a.kind === 'agent' && a.status === 'running').length, 0);
  const customized = JSON.stringify(layout) !== JSON.stringify(DEFAULT_OVERVIEW) || showHidden || !!maxActive;
  const sumPx = (a: number[]) => a.reduce((x, y) => x + y, 0);
  return (
    <div className={`overview d-${layout.density} ${n > 8 ? 'calm' : ''}`}>
      <div className="page-head">
        <h2>
          <Icon name="overview" size="md" />
          All sessions
        </h2>
        <span className="sub">
          {total} live · {running} subagent{running === 1 ? '' : 's'} running · click a panel to open it
        </span>
        <div className="actions">
          <div className="ov-density" role="group" aria-label="Density">
            {DENSITIES.map((d) => (
              <button
                key={d}
                className={layout.density === d ? 'on' : ''}
                aria-pressed={layout.density === d}
                title={DENSITY_HINT[d]}
                data-testid={`density-${d}`}
                onClick={() => setDensity(d)}
              >
                {d}
              </button>
            ))}
          </div>
          {hiddenLive.length > 0 && (
            <button
              className={`ov-tbtn ${showHidden ? 'on' : ''}`}
              aria-pressed={showHidden}
              data-testid="ov-show-hidden"
              onClick={() => {
                markFlip();
                setShowHidden((s) => !s);
              }}
            >
              <Icon name={showHidden ? 'hide' : 'unhide'} size="xs" />
              {showHidden ? 'hide hidden' : 'show hidden'} ({hiddenLive.length})
            </button>
          )}
          <button className="ov-tbtn" disabled={!customized} data-testid="ov-reset" title="Back to the automatic layout" onClick={reset}>
            <Icon name="reset" size="xs" />
            reset layout
          </button>
          <LocalChip onOpen={onLocal} />
        </div>
      </div>
      {total === 0 ? (
        <div className="empty-state">
          <div className="empty-card">
            <Icon name="overview" size="lg" />
            <div className="empty-title">No live sessions right now</div>
            <div>Sessions show up here side by side as soon as Claude Code starts working in them.</div>
          </div>
        </div>
      ) : n === 0 ? (
        <div className="empty-state">
          <div className="empty-card">
            <Icon name="hide" size="lg" />
            <div className="empty-title">All {total} sessions are hidden</div>
            <button className="ov-tbtn" onClick={() => setShowHidden(true)}>
              show hidden ({hiddenLive.length})
            </button>
          </div>
        </div>
      ) : (
        <div className="ov-scroll">
          <div
            ref={gridRef}
            className={`ov-grid ${maxActive ? 'has-max' : ''}`}
            data-cols={cols}
            data-rows={placed.rows}
            style={{
              gridTemplateColumns: maxActive ? 'minmax(0, 1fr)' : trackTemplate(colFr, MIN_COL_PX),
              gridTemplateRows: maxActive ? 'minmax(0, 1fr)' : trackTemplate(rowFr, MIN_ROW_PX),
            }}
          >
            {shown.map((id, i) => {
              const v = byId.get(id);
              const cell = cellOf.get(id);
              if (!v || !cell) return null;
              const span: Span = layout.sizes[id] ?? { c: 1, r: 1 };
              return (
                <Panel
                  key={id}
                  v={v}
                  index={i}
                  now={now}
                  activeOnly={activeOnly}
                  density={layout.density}
                  span={span}
                  cellStyle={{ gridColumn: `${cell.col + 1} / span ${cell.c}`, gridRow: `${cell.row + 1} / span ${cell.r}` }}
                  pinned={layout.pinned.includes(id)}
                  hidden={layout.hidden.includes(id)}
                  maximized={maxActive === id}
                  dragging={drag?.id === id}
                  dropTarget={drag?.over === id}
                  onOpen={onOpen}
                  onSize={setSize}
                  onPin={pin}
                  onHide={hide}
                  onMaximize={toggleMax}
                  onHeadDown={headDown}
                  suppressClick={() => justDragged.current}
                />
              );
            })}
            {tracks &&
              !maxActive &&
              tracks.cols
                .slice(0, -1)
                .map((_, i) => (
                  <Handle
                    key={`c${i}`}
                    axis="col"
                    index={i}
                    getPx={() => (gridRef.current ? measureTracks(gridRef.current).cols : tracks.cols)}
                    onResize={resizeCol}
                    onReset={() => changeQuiet((l) => ({ ...l, colFr: { ...l.colFr, [String(cols)]: fitFr(undefined, cols) } }))}
                    style={{ left: tracks.padL + sumPx(tracks.cols.slice(0, i + 1)) + tracks.gapX * i + tracks.gapX / 2 - 4, top: 0, height: tracks.h }}
                  />
                ))}
            {tracks &&
              !maxActive &&
              tracks.rows
                .slice(0, -1)
                .map((_, i) => (
                  <Handle
                    key={`r${i}`}
                    axis="row"
                    index={i}
                    getPx={() => (gridRef.current ? measureTracks(gridRef.current).rows : tracks.rows)}
                    onResize={resizeRow}
                    onReset={() => changeQuiet((l) => ({ ...l, rowFr: [] }))}
                    style={{ top: tracks.padT + sumPx(tracks.rows.slice(0, i + 1)) + tracks.gapY * i + tracks.gapY / 2 - 4, left: 0, width: tracks.w }}
                  />
                ))}
          </div>
        </div>
      )}
      {drag && (
        <div className="ov-ghost" style={{ left: drag.x, top: drag.y }}>
          <Icon name="swap" size="xs" /> {byId.get(drag.id)?.title ?? 'session'}
          {drag.over ? <span> ⇄ {byId.get(drag.over)?.title ?? 'session'}</span> : null}
        </div>
      )}
    </div>
  );
}
