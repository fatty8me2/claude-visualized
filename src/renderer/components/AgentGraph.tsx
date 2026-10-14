import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { describeActivity, firstLine } from '@core/activity';
import { agentGoal } from '@core/insight';
import { GoalBadge } from './GoalBadge';
import { DEFAULT_LAYOUT, layoutAgents, type Layout } from '@core/layout';
import { MAIN, type AgentNode, type SessionView } from '@core/state';
import { formatDuration, formatTokens, modeLabel, modelLabel } from '@core/summarize';
import { CtxChip } from './ContextMeter';
import { isLocalModel, LocalLinkLine } from './LocalBits';
import { createClock, useClockKey, type Clock } from '../clockStore';
import { agentName, displayStatus, famClass, STATUS_GLYPH, type DisplayStatus } from '../util';

const LOCAL_ROWS_H = 30;

const SPARK_BUCKETS = 24;
const SPARK_SPAN = 12 * 60_000;

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

/** No fake percentages: full when finished, animated stripes while working, empty when idle. */
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

/** everything on a card that depends on the clock */
function cardTime(a: AgentNode, now: number, kids: KidStats) {
  const st = displayStatus(a, now);
  const elapsed = (a.endedAt ?? (st === 'running' || st === 'waiting' ? now : a.lastActivity)) - a.startedAt;
  const elapsedText = formatDuration(elapsed);
  const act = describeActivity(a, { now, runningChildren: kids.running, totalChildren: kids.total });
  const dur = act.since != null && now - act.since >= 1000 ? formatDuration(now - act.since) : '';
  const spark = sparkCounts(a.activity, now);
  return { st, elapsedText, act, dur, spark, key: `${st}|${elapsedText}|${act.kind}|${act.line}|${dur}|${spark.join(',')}` };
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
  x,
  y,
  w,
  h,
  selected,
  hl,
  onSelect,
}: {
  a: AgentNode;
  mode: string;
  kidsTotal: number;
  kidsRunning: number;
  clock: Clock;
  x: number;
  y: number;
  w: number;
  h: number;
  selected: boolean;
  hl?: boolean;
  onSelect: (id: string) => void;
}) {
  const kids = { total: kidsTotal, running: kidsRunning };
  const now = useClockKey(clock, (n) => cardTime(a, n, kids).key);
  const { st, elapsedText, act, dur, spark } = cardTime(a, now, kids);
  const isMain = a.kind === 'main';
  const model = a.model ? modelLabel(a.model) : a.kind === 'workflow' ? 'workflow' : '—';
  const plan = mode === 'plan';
  const goal = useMemo(() => agentGoal(a, plan), [a.toolCount, a.description, a.prompt, a.phase, a.agentType, a.kind, plan]); // eslint-disable-line react-hooks/exhaustive-deps
  // a finished card already says what it ended with; otherwise show the agent's own last sentence
  const says = act.kind === 'finished' || act.kind === 'idle' ? '' : firstLine(a.lastText, 120);
  return (
    <div
      className={`node ${famClass(a.model)} ${st === 'idle' && !isMain ? 'idle-agent' : st} ${isMain ? 'main' : ''} ${selected ? 'sel' : ''}${hl ? ' hl' : ''}`}
      style={{ left: x, top: y, width: w, height: h }}
      onClick={() => onSelect(a.id)}
      data-agent={a.id}
    >
      <div className="row1">
        <span className="name">{isMain ? `${model} · main` : agentName(a)}</span>
        <GoalBadge goal={goal} />
      </div>
      {isMain ? (
        <>
          <div className="model">{modeLabel(mode).short === 'PLAN' ? 'plan mode · reads, designs' : `building · ${modeLabel(mode).detail}`}</div>
          <div className={`status ${st}`}>
            {STATUS_GLYPH[st]}
            {a.effort ? ` · effort ${a.effort}` : ''}
          </div>
        </>
      ) : (
        <div className="model2">
          <span className="model">
            {model}
            {a.phase ? ` · ${a.phase}` : ''}
            {a.background ? ' · bg' : ''}
          </span>
          <span className={`status ${st}`}>{STATUS_GLYPH[st]}</span>
        </div>
      )}
      {isLocalModel(a.model) && <LocalLinkLine agent={a} />}
      <Bar status={st} />
      {!isMain && <div className="desc">{a.description || a.lastText || ''}</div>}
      <div className={`now ${act.kind}`} title={act.line} data-testid="now">
        <span className="lbl">now:</span> {act.phrase}
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

/** The edges layer only changes with the layout, not with every card update. */
const MANY_ACTIVE_EDGES = 16;

const Edges = memo(function Edges({ layout }: { layout: Layout }) {
  // the dash and dot animations repaint continuously: with many running agents, step the dashes and only travel dots on the first few edges
  const active = layout.edges.reduce((n, e) => n + (e.active ? 1 : 0), 0);
  let dots = 0;
  return (
    <svg className={`edges${active > MANY_ACTIVE_EDGES ? ' calm' : ''}`} width={layout.width} height={layout.height}>
      {layout.edges.map((e) => (
        <g key={`${e.from}>${e.to}`}>
          <path className={`edge ${e.active ? 'active' : ''}`} d={e.d} id={`p-${e.to}`} />
          {e.active && dots++ < MANY_ACTIVE_EDGES && (
            <circle r={3.2} className="edge-dot">
              <animateMotion dur="1.8s" repeatCount="indefinite" path={e.d} />
            </circle>
          )}
        </g>
      ))}
    </svg>
  );
});

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
  compact = false,
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
  /** overview panels: no toolbar, scale to fit both width and height */
  compact?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapW, setWrapW] = useState(1000);
  const [wrapH, setWrapH] = useState(600);
  const [fit, setFit] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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

  // reset per-session UI state
  useEffect(() => setExpanded(new Set()), [view.id]);

  // local-model cards carry two extra rows (model id, where it is loaded)
  const extra = useMemo(() => (Object.values(view.agents).some((a) => isLocalModel(a.model)) ? LOCAL_ROWS_H : 0), [view.agents]);
  // the layout depends only on the tree's structure: recompute it when that changes, not on every push
  const structureKey = useMemo(() => {
    let k = '';
    for (const a of Object.values(view.agents)) k += `${a.id}|${a.parentId}|${a.status}|${a.startedAt}\n`;
    return k;
  }, [view.agents]);
  const layout = useMemo(
    () =>
      layoutAgents(view.agents, {
        ...DEFAULT_LAYOUT,
        nodeH: DEFAULT_LAYOUT.nodeH + extra,
        mainH: DEFAULT_LAYOUT.mainH + extra,
        showFinished,
        expanded,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structureKey, extra, showFinished, expanded],
  );
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

  const pad = compact ? 14 : 36;
  const scale = compact
    ? Math.max(0.28, Math.min(1, (wrapW - pad * 2) / Math.max(1, layout.width), (wrapH - pad * 2) / Math.max(1, layout.height)))
    : fit
      ? Math.max(0.45, Math.min(1, (wrapW - pad * 2) / Math.max(1, layout.width)))
      : 1;
  const running = Object.values(view.agents).filter((a) => a.id !== MAIN && a.status === 'running').length;
  const total = Object.keys(view.agents).length - 1;

  return (
    <div className={`graph-wrap ${compact ? 'compact' : ''}`} data-tour="graph" ref={wrapRef} onClick={(e) => e.target === e.currentTarget && onSelect(null)}>
      {!compact && (
        <div className="graph-tools">
          <button className={fit ? 'on' : ''} onClick={() => setFit(!fit)} title="Fit graph to width">
            {fit ? '⤢ fit' : '1:1'}
          </button>
          <button className={showFinished ? '' : 'on'} onClick={onToggleFinished} title="Hide or show finished subagents">
            {showFinished ? 'hide finished' : 'show finished'}
          </button>
          <span className="badge" style={{ alignSelf: 'center' }}>
            subagents {running}/{total}
          </span>
          {extraTools}
        </div>
      )}
      <div
        className="graph-canvas"
        onMouseOver={onHoverAgent ? (e) => onHoverAgent((e.target as HTMLElement).closest<HTMLElement>('[data-agent]')?.dataset.agent ?? null) : undefined}
        onMouseLeave={onHoverAgent ? () => onHoverAgent(null) : undefined}
        style={{ width: layout.width * scale + pad * 2, height: layout.height * scale + pad * 2 }}
      >
        <div
          style={{
            position: 'absolute',
            left: pad,
            top: pad,
            width: layout.width,
            height: layout.height,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        >
          <Edges layout={layout} />
          {layout.nodes.map((n) => {
            if (n.collapsed) {
              return (
                <div
                  key={n.id}
                  className="node collapsed"
                  style={{ left: n.x, top: n.y, width: n.w, height: n.h }}
                  onClick={() => {
                    if (!showFinished) onToggleFinished();
                    setExpanded(new Set([...expanded, n.collapsed!.parentId]));
                  }}
                >
                  ✓ {n.collapsed.count} finished · click to expand
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
                x={n.x}
                y={n.y}
                w={n.w}
                h={n.h}
                selected={selectedAgent === n.id}
                hl={highlight?.has(n.id)}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
