import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DEFAULT_LAYOUT, layoutAgents } from '@core/layout';
import { MAIN, type AgentNode, type SessionView } from '@core/state';
import { formatDuration, formatTokens, modeLabel, modelLabel, toolLabel } from '@core/summarize';
import { agentName, displayStatus, famClass, STATUS_GLYPH, type DisplayStatus } from '../util';

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
  if (status === 'done') return <div className="bar full"><i /></div>;
  if (status === 'error') return <div className="bar full" style={{ ['--fam' as string]: 'var(--err)' }}><i /></div>;
  if (status === 'running' || status === 'quiet') return <div className={`bar indet ${status === 'quiet' ? 'quiet' : ''}`}><i /></div>;
  return <div className="bar" />;
}

function totalTokens(a: AgentNode) {
  return a.tokens.in + a.tokens.out + a.tokens.cacheRead + a.tokens.cacheWrite;
}

function NodeCard({ a, view, now, x, y, w, h, selected, onSelect }: { a: AgentNode; view: SessionView; now: number; x: number; y: number; w: number; h: number; selected: boolean; onSelect: (id: string) => void }) {
  const st = displayStatus(a, now);
  const elapsed = (a.endedAt ?? (st === 'running' || st === 'waiting' ? now : a.lastActivity)) - a.startedAt;
  const isMain = a.kind === 'main';
  const model = a.model ? modelLabel(a.model) : a.kind === 'workflow' ? 'workflow' : '—';
  const children = Object.values(view.agents).filter((c) => c.parentId === a.id && c.id !== a.id);
  return (
    <div
      className={`node ${famClass(a.model)} ${st === 'idle' && !isMain ? 'idle-agent' : st} ${isMain ? 'main' : ''} ${selected ? 'sel' : ''}`}
      style={{ left: x, top: y, width: w, height: h }}
      onClick={() => onSelect(a.id)}
      data-agent={a.id}
    >
      <div className="row1">
        <span className="name">{isMain ? `${model} · main` : agentName(a)}</span>
        {!isMain && <span className={`status ${st}`}>{STATUS_GLYPH[st]}</span>}
      </div>
      {isMain ? (
        <>
          <div className="model">
            {modeLabel(view.mode).short === 'PLAN' ? 'plan mode · reads, designs' : `building · ${modeLabel(view.mode).detail}`}
          </div>
          <div className={`status ${st}`}>
            {STATUS_GLYPH[st]}
            {a.effort ? ` · effort ${a.effort}` : ''}
          </div>
        </>
      ) : (
        <div className="model">
          {model}
          {a.phase ? ` · ${a.phase}` : ''}
          {a.background ? ' · bg' : ''}
        </div>
      )}
      <Bar status={st} />
      {!isMain && <div className="desc">{a.description || a.lastText || ''}</div>}
      <div className="tool">
        {a.currentTool ? (
          <>
            ⚙ <span className="tn">{toolLabel(a.currentTool.name)}</span> {a.currentTool.summary}
          </>
        ) : a.kind === 'workflow' ? (
          <span style={{ color: 'var(--muted)' }}>
            {children.filter((c) => c.status === 'running').length}/{children.length} agents running
          </span>
        ) : (
          <span style={{ color: 'var(--muted)' }}>
            {st === 'done' ? 'returned to parent' : st === 'error' ? 'stopped' : st === 'idle' ? (isMain ? 'waiting for your next prompt' : 'idle') : st === 'waiting' ? 'waiting on you' : st === 'quiet' ? 'no recent activity' : 'thinking…'}
          </span>
        )}
      </div>
      <div className="meta">
        <span>
          {a.toolCount} tools · {formatDuration(elapsed)} · {formatTokens(totalTokens(a))} tok
        </span>
        <Spark activity={a.activity} now={now} />
      </div>
    </div>
  );
}

export function AgentGraph({ view, now, selectedAgent, onSelect, showFinished, onToggleFinished }: { view: SessionView; now: number; selectedAgent: string | null; onSelect: (id: string | null) => void; showFinished: boolean; onToggleFinished: () => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapW, setWrapW] = useState(1000);
  const [fit, setFit] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWrapW(el.clientWidth));
    ro.observe(el);
    setWrapW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // reset per-session UI state
  useEffect(() => setExpanded(new Set()), [view.id]);

  const layout = layoutAgents(view.agents, { ...DEFAULT_LAYOUT, showFinished, expanded });
  const pad = 36;
  const scale = fit ? Math.max(0.45, Math.min(1, (wrapW - pad * 2) / Math.max(1, layout.width))) : 1;
  const running = Object.values(view.agents).filter((a) => a.id !== MAIN && a.status === 'running').length;
  const total = Object.keys(view.agents).length - 1;

  return (
    <div className="graph-wrap" ref={wrapRef} onClick={(e) => e.target === e.currentTarget && onSelect(null)}>
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
      </div>
      <div className="graph-canvas" style={{ width: layout.width * scale + pad * 2, height: layout.height * scale + pad * 2 }}>
        <div style={{ position: 'absolute', left: pad, top: pad, width: layout.width, height: layout.height, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
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
            return <NodeCard key={n.id} a={a} view={view} now={now} x={n.x} y={n.y} w={n.w} h={n.h} selected={selectedAgent === n.id} onSelect={onSelect} />;
          })}
        </div>
      </div>
    </div>
  );
}
