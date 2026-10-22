import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { describeActivity, firstLine } from '@core/activity';
import { agentGoal } from '@core/insight';
import { GoalBadge } from './GoalBadge';
import { GraphBackdrop } from './GraphBackdrop';
import { COMPACT_LAYOUT, DEFAULT_LAYOUT, layoutAgents, type LayoutOptions } from '@core/layout';
import { clampZoom, fitScale, nextCardMode, revealDelta, zoomAnchor, ZOOM, type CardMode } from '@core/graphZoom';
import { MAIN, type AgentNode, type SessionView } from '@core/state';
import { formatDuration, formatTokens, modeLabel, modelFamily, modelLabel } from '@core/summarize';
import { CtxChip } from './ContextMeter';
import { GraphEdges, type EdgeMeta } from './GraphEdges';
import { isLocalModel, LocalLinkLine } from './LocalBits';
import { createClock, useClockKey, type Clock } from '../clockStore';
import { agentName, displayStatus, famClass, type DisplayStatus } from '../util';
import { MotionTracker, playMoves, trackTilt } from '../cardFx';
import { Fade, FxLayers, StatusLabel, seedOf } from './cardParts';
import { Icon } from './Icon';
import { useGraphPrefs, useGroupFolds } from '../state/graphPrefs';

const LOCAL_ROWS_H = 30;

const SPARK_BUCKETS = 24;
const SPARK_SPAN = 12 * 60_000;

/** the drawer's width plus its margin: cards under it are scrolled clear when selected */
const DRAWER_W = 400;

function sparkCounts(activity: number[], now: number): number[] {
  const size = SPARK_SPAN / SPARK_BUCKETS;
  const counts = new Array<number>(SPARK_BUCKETS).fill(0);
  for (const t of activity) {
    const age = now - t;
    if (age < 0 || age >= SPARK_SPAN) continue;
    counts[SPARK_BUCKETS - 1 - Math.floor(age / size)]++;
  }
  return counts;
}

function Spark({ counts }: { counts: number[] }) {
  const max = Math.max(1, ...counts);
  return (
    <svg className="spark" width={40} height={14} viewBox="0 0 96 14" preserveAspectRatio="none" aria-hidden>
      {counts.map((c, i) => (c ? <rect key={i} x={i * 4} y={14 - Math.max(2, (c / max) * 14)} width={3} height={Math.max(2, (c / max) * 14)} /> : null))}
    </svg>
  );
}

/** No fake percentages: full when finished, a soft shimmer while working, empty when idle. */
function Bar({ status }: { status: DisplayStatus }) {
  if (status === 'done')
    return (
      <div className="bar full">
        <i />
      </div>
    );
  if (status === 'error')
    return (
      <div className="bar full" style={{ ['--fam' as string]: 'var(--err)' }}>
        <i />
      </div>
    );
  if (status === 'running' || status === 'quiet')
    return (
      <div className={`bar indet ${status === 'quiet' ? 'quiet' : ''}`}>
        <i />
      </div>
    );
  return <div className="bar" />;
}

function totalTokens(a: AgentNode) {
  return a.tokens.in + a.tokens.out + a.tokens.cacheRead + a.tokens.cacheWrite;
}

interface KidStats {
  total: number;
  running: number;
}

/** everything on a card that depends on the clock; compact cards show less, so they re-render less */
function cardTime(a: AgentNode, now: number, kids: KidStats, compact: boolean) {
  const st = displayStatus(a, now);
  const act = describeActivity(a, { now, runningChildren: kids.running, totalChildren: kids.total });
  const dur = act.since != null && now - act.since >= 1000 ? formatDuration(now - act.since) : '';
  if (compact) return { st, elapsedText: '', act, dur, spark: [] as number[], key: `${st}|${act.kind}|${act.phrase}|${dur}` };
  const elapsed = (a.endedAt ?? (st === 'running' || st === 'waiting' ? now : a.lastActivity)) - a.startedAt;
  const elapsedText = formatDuration(elapsed);
  const spark = sparkCounts(a.activity, now);
  return { st, elapsedText, act, dur, spark, key: `${st}|${elapsedText}|${act.kind}|${act.line}|${dur}|${spark.join(',')}` };
}

/** A subagent's headline is its task; seventeen cards all titled "general-purpose" say nothing. */
function headline(a: AgentNode, model: string): string {
  if (a.kind === 'main') return `${model} · main`;
  return a.description ? firstLine(a.description, 90) : agentName(a);
}

/**
 * One agent card. Memoized: it re-renders when its agent object (replaced only when that agent changed), its geometry or its
 * selection changes, or when the text it shows because of time changes (see useClockKey), not on every clock tick.
 */
const NodeCard = memo(function NodeCard({
  a,
  mode,
  kidsTotal,
  kidsRunning,
  clock,
  motion,
  x,
  y,
  w,
  h,
  selected,
  hl,
  compact,
  foldable,
  onSelect,
  onFold,
}: {
  a: AgentNode;
  mode: string;
  kidsTotal: number;
  kidsRunning: number;
  clock: Clock;
  motion: MotionTracker;
  x: number;
  y: number;
  w: number;
  h: number;
  selected: boolean;
  hl?: boolean;
  compact: boolean;
  /** this card's finished children were expanded: offer to fold them back */
  foldable: boolean;
  onSelect: (id: string) => void;
  onFold: (id: string) => void;
}) {
  const kids = { total: kidsTotal, running: kidsRunning };
  const now = useClockKey(clock, (n) => cardTime(a, n, kids, compact).key);
  const { st, elapsedText, act, dur, spark } = cardTime(a, now, kids, compact);
  const isMain = a.kind === 'main';
  const model = a.model ? modelLabel(a.model) : a.kind === 'workflow' ? 'workflow' : '—';
  const plan = mode === 'plan';
  const goal = useMemo(() => agentGoal(a, plan), [a.toolCount, a.description, a.prompt, a.phase, a.agentType, a.kind, plan]); // eslint-disable-line react-hooks/exhaustive-deps
  const fxOn = motion.calm;
  // a finished card already says what it ended with; otherwise show the agent's own last sentence
  const says = act.kind === 'finished' || act.kind === 'idle' ? '' : firstLine(a.lastText, 120);
  const title = headline(a, model);
  const kind = isMain ? null : `${agentName(a)}${a.phase ? ` · ${a.phase}` : ''}${a.background ? ' · bg' : ''}`;
  const fold = foldable ? (
    <button
      className="fold btn-icon ghost"
      aria-label="Fold finished children"
      title="Fold the finished agents under this one back into a chip"
      onClick={(e) => {
        e.stopPropagation();
        onFold(a.id);
      }}
    >
      <Icon name="fold" size="xs" />
    </button>
  ) : null;
  const cls = `node ${famClass(a.model)} ${st === 'idle' && !isMain ? 'idle-agent' : st} ${isMain ? 'main' : ''} ${selected ? 'sel' : ''}${hl ? ' hl' : ''}${compact ? ' compact' : ''}${st === 'running' && a.currentTool ? ' tool' : ''}`;
  const style = { left: x, top: y, width: w, height: h, ['--seed' as string]: seedOf(a.id) };

  if (compact) {
    return (
      <div className={cls} style={style} onClick={() => onSelect(a.id)} data-agent={a.id} title={a.description || undefined}>
        <FxLayers st={st} selected={selected} main={isMain} />
        <div className="row1">
          <GoalBadge goal={goal} glyphOnly />
          <span className="name">{title}</span>
          {fold}
          <StatusLabel st={st} enabled={fxOn} />
        </div>
        <div className={`now ${act.kind}`} title={act.line} data-testid="now">
          <span className="lbl">{isMain ? model : (kind ?? '')}</span>
          <span className="sep"> · </span>
          <Fade k={`${act.kind}|${act.phrase}`} enabled={fxOn}>
            {act.phrase}
          </Fade>
          {dur && <span className="dur"> · {dur}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className={cls} style={style} onClick={() => onSelect(a.id)} data-agent={a.id}>
      <FxLayers st={st} selected={selected} main={isMain} />
      <div className="row1">
        <span className="name" title={a.description || undefined}>
          {title}
        </span>
        {fold}
        <GoalBadge goal={goal} />
      </div>
      {isMain ? (
        <>
          <div className="model">{modeLabel(mode).short === 'PLAN' ? 'plan mode · reads, designs' : `building · ${modeLabel(mode).detail}`}</div>
          <div>
            <StatusLabel st={st} extra={a.effort ? ` · effort ${a.effort}` : ''} enabled={fxOn} />
          </div>
        </>
      ) : (
        <div className="model2">
          <span className="model">
            {model}
            <span className="kind"> · {kind}</span>
          </span>
          <StatusLabel st={st} enabled={fxOn} />
        </div>
      )}
      {isLocalModel(a.model) && <LocalLinkLine agent={a} />}
      <Bar status={st} />
      {!isMain && <div className="desc">{(a.prompt && a.prompt !== a.description ? a.prompt : a.lastText) || ''}</div>}
      <div className={`now ${act.kind}`} title={act.line} data-testid="now">
        <span className="lbl">now:</span>{' '}
        <Fade k={`${act.kind}|${act.phrase}`} enabled={fxOn}>
          {act.phrase}
        </Fade>
        {dur && <span className="dur"> · {dur}</span>}
      </div>
      {!isMain && (
        <div className="says" title={a.lastText ?? ''}>
          {says ? <>says: {says}</> : null}
        </div>
      )}
      <div className="meta">
        <span>
          {a.toolCount} tools · {elapsedText} · {formatTokens(totalTokens(a))} tok
        </span>
        <CtxChip agent={a} />
        <Spark counts={spark} />
      </div>
    </div>
  );
});

/** above this many running agents the cards' running effects stand still */
const MANY_RUNNING = 16;
const NO_GROUPS: ReadonlySet<string> = new Set();

export function AgentGraph({
  view,
  now,
  selectedAgent,
  onSelect,
  showFinished,
  onToggleFinished,
  highlight,
  onHoverAgent,
  extraTools,
  embedded = false,
  replaying = false,
}: {
  view: SessionView;
  now: number;
  selectedAgent: string | null;
  onSelect: (id: string | null) => void;
  showFinished: boolean;
  onToggleFinished: () => void;
  /** agents to light up (hovering a plan step) */
  highlight?: Set<string>;
  /** pointer entered/left an agent card (null = left) */
  onHoverAgent?: (id: string | null) => void;
  /** extra buttons for the toolbar */
  extraTools?: ReactNode;
  /** overview panels: no toolbar, compact cards, scaled to fit both width and height */
  embedded?: boolean;
  /** replaying: the backdrop stands still */
  replaying?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [motion] = useState(() => new MotionTracker());
  const [wrapW, setWrapW] = useState(0);
  const [wrapH, setWrapH] = useState(600);
  const [prefs, setPrefs] = useGraphPrefs();
  const groups = useGroupFolds(view.id);
  const expanded = embedded ? NO_GROUPS : groups.expanded;
  const folded = embedded ? NO_GROUPS : groups.folded;
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [cardMode, setCardMode] = useState<CardMode>(embedded ? 'compact' : 'full');

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      setWrapW(el.clientWidth);
      setWrapH(el.clientHeight);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // local-model cards carry two extra rows (model id, where it is loaded)
  const extra = useMemo(() => (Object.values(view.agents).some((a) => isLocalModel(a.model)) ? LOCAL_ROWS_H : 0), [view.agents]);
  // the layout depends only on the tree's structure: recompute it when that changes, not on every push
  const structureKey = useMemo(() => {
    let k = '';
    for (const a of Object.values(view.agents)) k += `${a.id}|${a.parentId}|${a.status}|${a.startedAt}\n`;
    return k;
  }, [view.agents]);
  const build = (base: LayoutOptions, rows: number) =>
    layoutAgents(view.agents, { ...base, nodeH: base.nodeH + rows, mainH: base.mainH + (rows ? rows + 22 : 0), showFinished, expanded, folded });
  const layoutFull = useMemo(
    () => build(DEFAULT_LAYOUT, extra),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structureKey, extra, showFinished, expanded, folded],
  );
  const wantCompact = embedded || cardMode === 'compact';
  const layoutCompact = useMemo(
    () => (wantCompact ? build(COMPACT_LAYOUT, 0) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wantCompact, structureKey, showFinished, expanded, folded],
  );

  // scale and card variant: full cards never shrink below the readable floor; past it the graph switches to compact cards
  const pad = embedded ? 14 : 36;
  const viewport = { w: wrapW || 1000, h: wrapH };
  const fitFull = fitScale({ w: layoutFull.width, h: layoutFull.height }, viewport, pad, false, 0);
  let nextMode: CardMode;
  let scale: number;
  if (embedded) {
    nextMode = 'compact';
    const l = layoutCompact ?? layoutFull;
    scale = fitScale({ w: l.width, h: l.height }, viewport, pad, true, 0.6);
  } else if (prefs.zoom === 'fit') {
    nextMode = nextCardMode(cardMode, fitFull, prefs.compact);
    scale =
      nextMode === 'full' || !layoutCompact
        ? Math.max(ZOOM.fullFloor, fitFull)
        : fitScale({ w: layoutCompact.width, h: layoutCompact.height }, viewport, pad, false, ZOOM.compactFloor);
    if (nextMode === 'full' && prefs.compact === 'on') scale = fitFull;
  } else {
    scale = clampZoom(prefs.zoom);
    nextMode = nextCardMode(cardMode, scale, prefs.compact);
  }
  // adjusting state while rendering (React re-runs this render right away): the hysteresis needs the previous mode
  if (nextMode !== cardMode) setCardMode(nextMode);
  const compact = cardMode === 'compact' && !!layoutCompact;
  const layout = compact ? layoutCompact! : layoutFull;

  const kidStats = useMemo(() => {
    const m = new Map<string, KidStats>();
    for (const c of Object.values(view.agents)) {
      if (!c.parentId || c.parentId === c.id) continue;
      const k = m.get(c.parentId) ?? { total: 0, running: 0 };
      k.total++;
      if (c.status === 'running') k.running++;
      m.set(c.parentId, k);
    }
    return m;
  }, [view.agents]);
  // the clock is pushed to the cards through a store so a per-second tick does not re-render every card
  const [clock] = useState(() => createClock(now));
  useLayoutEffect(() => {
    clock.set(now);
    clock.notify();
  }, [clock, now]);

  // what the edge layer shows per agent; the same Map object is reused until something it draws changes
  const metaRef = useRef<{ key: string; map: Map<string, EdgeMeta> }>({ key: '', map: new Map() });
  const edgeMeta = useMemo(() => {
    let key = '';
    const map = new Map<string, EdgeMeta>();
    const all = Object.values(view.agents);
    const stat = all.map((a) => displayStatus(a, now));
    // a tool call in flight makes the packets burn brighter; reported only while the edge layer is not calm (few running agents)
    const showTool = stat.filter((s) => s === 'running').length <= MANY_RUNNING;
    all.forEach((a, i) => {
      const st = stat[i];
      const fam = modelFamily(a.model);
      const tool = showTool && st === 'running' && !!a.currentTool;
      map.set(a.id, { st, fam, started: a.startedAt, tool });
      key += `${a.id}|${st}|${fam}|${a.startedAt}|${tool ? 1 : 0}\n`;
    });
    if (metaRef.current.key === key) return metaRef.current.map;
    metaRef.current = { key, map };
    return map;
  }, [view.agents, now]);
  const focus = useMemo(() => {
    if (!hoverId) return highlight;
    const s = new Set(highlight);
    s.add(hoverId);
    return s;
  }, [highlight, hoverId]);

  // what changed since the last commit, seen from here: new cards, moved cards, status changes. Bulk changes (a session switch, a
  // card-variant switch, loading hundreds of agents, replay scrubbing) plan nothing.
  const motionKey = `${view.id}|${compact ? 'c' : 'f'}`;
  motion.plan(motionKey, view.agents, layout);
  useLayoutEffect(() => {
    const moves = motion.take();
    if (!embedded && canvasRef.current) playMoves(canvasRef.current, moves);
  }, [motion, view.id, view.agents, layout, embedded]);

  // hover tilt and specular highlight: written straight to the hovered card's CSS variables, never through React
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || embedded) return;
    return trackTilt(el);
  }, [embedded]);

  // ---- zoom around the cursor (ctrl+wheel / pinch), drag to pan ----
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const anchor = useRef<{ x: number; y: number; scale: number; left: number; top: number } | null>(null);
  const zoomTo = useCallback(
    (next: number, cursor?: { x: number; y: number }) => {
      const el = wrapRef.current;
      if (!el) return;
      const z = clampZoom(next);
      const c = cursor ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 };
      anchor.current = { x: c.x, y: c.y, scale: scaleRef.current, left: el.scrollLeft, top: el.scrollTop };
      setPrefs({ zoom: Math.round(z * 100) / 100 });
    },
    [setPrefs],
  );
  useLayoutEffect(() => {
    const el = wrapRef.current;
    const a = anchor.current;
    if (!el || !a || a.scale === scale) return;
    anchor.current = null;
    const next = zoomAnchor({ scale: a.scale, scrollLeft: a.left, scrollTop: a.top }, scale, a, pad);
    el.scrollLeft = next.scrollLeft;
    el.scrollTop = next.scrollTop;
  }, [scale, pad]);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || embedded) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : 1;
      zoomTo(scaleRef.current * Math.exp(-e.deltaY * unit * ZOOM.wheelK), { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [embedded, zoomTo]);

  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (embedded || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.node, .graph-tools, button, input')) return;
    const el = wrapRef.current!;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false };
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) wrapRef.current!.classList.add('panning');
    d.moved = true;
    wrapRef.current!.scrollLeft = d.left - dx;
    wrapRef.current!.scrollTop = d.top - dy;
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    wrapRef.current?.classList.remove('panning');
    if (wrapRef.current?.hasPointerCapture(e.pointerId)) wrapRef.current.releasePointerCapture(e.pointerId);
    suppressClick.current = !!d?.moved;
  };

  // a selected card hidden under the drawer or off-screen scrolls into view (only when the selection changes)
  useEffect(() => {
    if (embedded || !selectedAgent) return;
    const el = wrapRef.current;
    const card = el?.querySelector<HTMLElement>(`[data-agent="${CSS.escape(selectedAgent)}"]`);
    if (!el || !card) return;
    const d = revealDelta(card.getBoundingClientRect(), el.getBoundingClientRect(), Math.min(DRAWER_W, el.clientWidth / 2));
    if (d) el.scrollBy({ left: d.dx, top: d.dy, behavior: 'smooth' });
  }, [selectedAgent, embedded]);

  const onFold = groups.fold;

  const running = Object.values(view.agents).filter((a) => a.id !== MAIN && a.status === 'running').length;
  const total = Object.keys(view.agents).length - 1;
  const fit = prefs.zoom === 'fit';

  return (
    <div
      className={`graph-wrap ${embedded ? 'embedded' : 'has-backdrop'}`}
      data-tour="graph"
      ref={wrapRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={(e) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        if (!(e.target as HTMLElement).closest('.node, .graph-tools, button')) onSelect(null);
      }}
    >
      {!embedded && <GraphBackdrop layout={layout} meta={edgeMeta} resetKey={motionKey} paused={!!replaying} />}
      {!embedded && (
        <div className="graph-tools">
          <div className="seg zoom-seg">
            <button
              className={fit ? 'on' : ''}
              onClick={() => setPrefs({ zoom: fit ? 1 : 'fit' })}
              title="Fit the graph to the panel (never smaller than readable)"
            >
              <Icon name="fit" size="xs" />
              fit
            </button>
            <button onClick={() => zoomTo(scale / ZOOM.step)} aria-label="zoom out" title="Zoom out (ctrl+wheel)">
              <Icon name="zoomOut" size="xs" />
            </button>
            <button className="zoom-pct" onClick={() => zoomTo(1)} title="Actual size (100%)" data-testid="zoom-pct">
              {Math.round(scale * 100)}%
            </button>
            <button onClick={() => zoomTo(scale * ZOOM.step)} aria-label="zoom in" title="Zoom in (ctrl+wheel)">
              <Icon name="zoomIn" size="xs" />
            </button>
          </div>
          <button className={showFinished ? '' : 'on'} onClick={onToggleFinished} title="Hide or show finished subagents">
            {showFinished ? 'hide finished' : 'show finished'}
          </button>
          {expanded.size > 0 && (
            <button onClick={groups.foldAll} title="Fold every opened group of finished agents back into its chip">
              <Icon name="fold" size="xs" />
              fold all
            </button>
          )}
          <span className="badge graph-count" title={`${running} running of ${total} subagents`}>
            subagents {running}/{total}
          </span>
          {extraTools}
        </div>
      )}
      <div
        ref={canvasRef}
        className={`graph-canvas${running > MANY_RUNNING || embedded ? ' calm' : ''}`}
        onMouseOver={(e) => {
          const id = (e.target as HTMLElement).closest<HTMLElement>('[data-agent]')?.dataset.agent ?? null;
          setHoverId(id);
          onHoverAgent?.(id);
        }}
        onMouseLeave={() => {
          setHoverId(null);
          onHoverAgent?.(null);
        }}
        style={{ width: layout.width * scale + pad * 2, height: layout.height * scale + pad * 2 }}
      >
        <div
          className="graph-scaled"
          style={{
            position: 'absolute',
            left: pad,
            top: pad,
            width: layout.width,
            height: layout.height,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            ['--gf-s' as string]: scale,
          }}
        >
          <GraphEdges layout={layout} meta={edgeMeta} focus={focus} resetKey={motionKey} />
          {layout.nodes.map((n) => {
            if (n.collapsed) {
              return (
                <div
                  key={n.id}
                  className="node collapsed"
                  data-chip={n.id}
                  style={{ left: n.x, top: n.y, width: n.w, height: n.h }}
                  title={embedded ? undefined : 'Show the finished agents in this group'}
                  onClick={(e) => {
                    if (embedded) return;
                    e.stopPropagation();
                    if (!showFinished) onToggleFinished();
                    groups.open(n.collapsed!.parentId);
                  }}
                >
                  <Icon name="done" size="xs" /> {n.collapsed.count} finished{embedded ? '' : ' · show'}
                </div>
              );
            }
            const a = view.agents[n.id];
            if (!a) return null;
            return (
              <NodeCard
                key={n.id}
                a={a}
                mode={view.mode}
                kidsTotal={kidStats.get(a.id)?.total ?? 0}
                kidsRunning={kidStats.get(a.id)?.running ?? 0}
                clock={clock}
                motion={motion}
                x={n.x}
                y={n.y}
                w={n.w}
                h={n.h}
                selected={selectedAgent === n.id}
                hl={highlight?.has(n.id)}
                compact={compact}
                foldable={expanded.has(n.id)}
                onSelect={onSelect}
                onFold={onFold}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
