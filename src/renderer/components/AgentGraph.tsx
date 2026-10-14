import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { describeActivity, firstLine } from '@core/activity';
import { agentGoal } from '@core/insight';
import { GoalBadge } from './GoalBadge';
import { DEFAULT_LAYOUT, layoutAgents } from '@core/layout';
import { MAIN, type AgentNode, type SessionView } from '@core/state';
import { formatDuration, formatTokens, modeLabel, modelLabel } from '@core/summarize';
import { CtxChip } from './ContextMeter';
import { isLocalModel, LocalLinkLine } from './LocalBits';
import { agentName, displayStatus, famClass, STATUS_GLYPH, type DisplayStatus } from '../util';

const LOCAL_ROWS_H = 30;

function Spark({ activity, now }: { activity: number[]; now: number }) {
  const buckets = 24;
  const span = 12 * 60_000;
  const size = span / buckets;
  const counts = new Array(buckets).fill(0);
  for (const t of activity) {
    const age = now - t;
    if (age < 0 || age >= span) continue;
    counts[buckets - 1 - Math.floor(age / size)]++;
  }
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

function NodeCard({
  a,
  view,
  now,
  x,
  y,
  w,
  h,
  selected,
  hl,
  onSelect,
}: {
  a: AgentNode;
  view: SessionView;
  now: number;
  x: number;
  y: number;
  w: number;
  h: number;
  selected: boolean;
  hl?: boolean;
  onSelect: (id: string) => void;
}) {
  const st = displayStatus(a, now);
  const elapsed = (a.endedAt ?? (st === 'running' || st === 'waiting' ? now : a.lastActivity)) - a.startedAt;
  const isMain = a.kind === 'main';
  const model = a.model ? modelLabel(a.model) : a.kind === 'workflow' ? 'workflow' : '—';
  const children = Object.values(view.agents).filter((c) => c.parentId === a.id && c.id !== a.id);
  const plan = view.mode === 'plan';
  const goal = useMemo(() => agentGoal(a, plan), [a.toolCount, a.description, a.prompt, a.phase, a.agentType, a.kind, plan]); // eslint-disable-line react-hooks/exhaustive-deps
  const runningKids = children.filter((c) => c.status === 'running').length;
  const act = describeActivity(a, { now, runningChildren: runningKids, totalChildren: children.length });
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
          <div className="model">{modeLabel(view.mode).short === 'PLAN' ? 'plan mode · reads, designs' : `building · ${modeLabel(view.mode).detail}`}</div>
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
        {act.since != null && now - act.since >= 1000 && <span className="dur"> · {formatDuration(now - act.since)}</span>}
      </div>
      {!isMain && (
        <div className="says" title={a.lastText ?? ''}>
          {says ? <>says: {says}</> : null}
        </div>
      )}
      <div className="meta">
        <span>
          {a.toolCount} tools · {formatDuration(elapsed)} · {formatTokens(totalTokens(a))} tok
        </span>
        <CtxChip agent={a} />
        <Spark activity={a.activity} now={now} />
      </div>
    </div>
  );
}

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
  const extra = Object.values(view.agents).some((a) => isLocalModel(a.model)) ? LOCAL_ROWS_H : 0;
  const layout = layoutAgents(view.agents, {
    ...DEFAULT_LAYOUT,
    nodeH: DEFAULT_LAYOUT.nodeH + extra,
    mainH: DEFAULT_LAYOUT.mainH + extra,
    showFinished,
    expanded,
  });
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
          <svg className="edges" width={layout.width} height={layout.height}>
            {layout.edges.map((e) => (
              <g key={`${e.from}>${e.to}`}>
                <path className={`edge ${e.active ? 'active' : ''}`} d={e.d} id={`p-${e.to}`} />
                {e.active && (
                  <circle r={3.2} className="edge-dot">
                    <animateMotion dur="1.8s" repeatCount="indefinite" path={e.d} />
                  </circle>
                )}
              </g>
            ))}
          </svg>
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
                view={view}
                now={now}
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
