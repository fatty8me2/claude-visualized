// The sections an overview panel adds as it grows (see core/panelContent.ts): the insight rail, the live feed, the plan strip and
// the agent table. Each is memoized on the session view (and a coarse clock for rates), so a panel only re-renders them when its
// own session changed.
import { memo, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { agentGoal, agentInsight } from '@core/insight';
import { computeStepStatus, planProgress, resolvePlan } from '@core/plan';
import { compactForecast, ctxTone } from '@core/panelContent';
import { formatUSD } from '@core/pricing';
import { sessionInsights } from '@core/sessionInsights';
import { MAIN, type AgentNode, type SessionView } from '@core/state';
import { formatDuration, formatTokens } from '@core/summarize';
import { GoalBadge } from './GoalBadge';
import { agentName, clock, displayStatus, famClass } from '../util';

/** does the session have a plan or todo list to show? (cheap: the parse is only done when the strip renders) */
export const hasPlanSource = (v: SessionView) => !!v.plan || v.todos.length > 0;

/** text whose characters roll in when they change (a changed digit re-mounts and slides up; unchanged ones hold still) */
export const Roll = memo(function Roll({ text }: { text: string }) {
  return (
    <span className="roll" aria-label={text}>
      {[...text].map((ch, i) => (
        <span key={`${i}:${ch}`} aria-hidden style={{ '--i': i } as CSSProperties}>
          {ch}
        </span>
      ))}
    </span>
  );
});

function Spark30({ counts }: { counts: number[] }) {
  const max = Math.max(1, ...counts);
  const H = 34;
  // a line through the bar tops draws itself in; the bars grow from the baseline one after another
  const pts = counts.map((c, i) => `${i * 6 + 3},${(H - (c ? Math.max(2, (c / max) * (H - 2)) : 1)).toFixed(1)}`);
  return (
    <svg className="px-spark" viewBox={`0 0 ${counts.length * 6} ${H}`} preserveAspectRatio="none" aria-label="tool calls per minute, last 30 minutes">
      {counts.map((c, i) => {
        const h = c ? Math.max(2, (c / max) * (H - 2)) : 1;
        return (
          <rect
            key={i}
            x={i * 6 + 0.5}
            y={H - h}
            width={5}
            height={h}
            rx={1}
            style={{ '--i': i } as CSSProperties}
            className={c ? (i === counts.length - 1 ? 'now' : 'on') : ''}
          />
        );
      })}
      <polyline className="line" points={pts.join(' ')} pathLength={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const rate = (n: number) => `${formatTokens(Math.round(n))}/min`;

/** B: activity sparkline, burn rate, context forecast and agent counts */
export const InsightRail = memo(function InsightRail({ v, tick, side = false }: { v: SessionView; tick: number; side?: boolean }) {
  const ins = useMemo(() => sessionInsights(v, tick), [v, tick]);
  const { pct, minutesToCompact } = ins.context;
  const tone = ctxTone(pct);
  const fc = compactForecast(minutesToCompact);
  const c = ins.agents;
  const calls = ins.toolsPerMin.reduce((n, x) => n + x, 0);
  return (
    <div className={`px-rail ${side ? 'side' : ''}`} data-testid={side ? 'px-side-rail' : 'px-rail'}>
      <div className="cell wide">
        <div className="k">activity · 30 min</div>
        <Spark30 counts={ins.toolsPerMin} />
        <div className="axis">
          <span>-30m</span>
          <span>-15m</span>
          <span>now</span>
        </div>
        <span className="sr-only">{calls} tool calls</span>
      </div>
      <div className="cell">
        <div className="k">burn rate</div>
        <div className="big">
          <Roll text={ins.burn.tokensPerMin > 0 ? rate(ins.burn.tokensPerMin) : '–'} />
        </div>
        <div className="sub">
          {ins.burn.costPerHour != null ? `est. ~${formatUSD(ins.burn.costPerHour)}/h` : 'cost unknown'} · {ins.burn.toolsPerMin.toFixed(1)} tools/min
        </div>
      </div>
      <div className="cell">
        <div className="k">main context</div>
        <div className={`big ${tone}`}>
          <Roll text={pct == null ? '–' : `${Math.round(pct)}%`} />
        </div>
        <div className="track">
          <i className={tone} style={{ '--p': Math.min(1, (pct ?? 0) / 100) } as CSSProperties} />
        </div>
        <div className={`sub ${fc.tone === 'warn' ? 'warn' : ''}`} data-testid="px-compact">
          {fc.text}
        </div>
      </div>
      <div className="cell">
        <div className="k">subagents</div>
        <div className="counts">
          <span className="run">
            <b>
              <Roll text={String(c.running)} />
            </b>{' '}
            running
          </span>
          <span className={c.waiting ? 'warn' : 'faint'}>
            <b>
              <Roll text={String(c.waiting)} />
            </b>{' '}
            waiting
          </span>
          <span className="ok">
            <b>
              <Roll text={String(c.done)} />
            </b>{' '}
            done
          </span>
          <span className={c.error ? 'err' : 'faint'}>
            <b>
              <Roll text={String(c.error)} />
            </b>{' '}
            failed
          </span>
        </div>
      </div>
    </div>
  );
});

/** C: colour-coded ticker of the newest log lines, filling the height it is given (older lines are clipped at the top) */
export const LiveFeed = memo(function LiveFeed({ v, count = 40, testId = 'px-feed' }: { v: SessionView; count?: number; testId?: string }) {
  const lines = useMemo(() => v.log.filter((l) => l.kind !== 'text').slice(-count), [v.log, count]);
  // the first paint cascades the newest lines in; lines that arrive later just slide in
  const first = useRef(true);
  useEffect(() => void (first.current = false), []);
  return (
    <div className="px-feed" data-testid={testId}>
      <div className="px-title">
        <i className="live-dot" aria-hidden />
        live feed
      </div>
      <div className="lines">
        {lines.length === 0 && <div className="empty-note">no activity yet</div>}
        {lines.map((l, i) => (
          <div key={l.seq} className={`ln k-${l.kind}`} style={{ '--d': first.current ? Math.max(0, 9 - (lines.length - 1 - i)) : 0 } as CSSProperties}>
            <span className="t">{clock(l.ts)}</span>
            <span className={`who ${famClass(v.agents[l.agentId]?.model)}`}>{agentName(v.agents[l.agentId])}</span>
            <span className="tx">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
});

/** E: the plan's steps as a strip of done / in progress / pending (only rendered when the session has a plan) */
export const PlanStrip = memo(function PlanStrip({ v }: { v: SessionView }) {
  const m = useMemo(() => {
    const r = resolvePlan(v.plan, v.todos);
    if (!r) return null;
    const agents = Object.values(v.agents).map((a) => ({
      id: a.id,
      kind: a.kind,
      agentType: a.agentType,
      description: a.description,
      status: a.status,
      lastText: a.lastText,
      prompt: a.prompt,
      startedAt: a.startedAt,
    }));
    const st = computeStepStatus(r.parsed.steps, v.todos, agents, { since: r.origin === 'todos' ? undefined : v.plan?.since });
    return { steps: r.parsed.steps, st, ...planProgress(st) };
  }, [v.plan, v.todos, v.agents]);
  if (!m || m.total === 0) return null;
  return (
    <div className="px-plan" data-testid="px-plan">
      <div className="px-title">
        plan{' '}
        <b>
          {m.done}/{m.total}
        </b>
        <span className="pbar">
          <i style={{ '--p': m.done / Math.max(1, m.total) } as CSSProperties} />
        </span>
      </div>
      <div className="steps">
        {m.steps.map((s, i) => {
          const st = m.st[i].status;
          return (
            <div key={s.id} className={`step ${st}`} title={m.st[i].reasons.join('\n')}>
              <span className="g" aria-hidden>
                {st === 'done' ? '✓' : st === 'in_progress' ? '▸' : '○'}
              </span>
              <span className="tx">{s.title || s.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
});

const rank = (a: AgentNode) => (a.status === 'running' ? 0 : a.status === 'waiting' ? 1 : a.status === 'error' ? 2 : 3);

/** F: running agents first, then waiting, failed and finished: goal glyph, name, what it is doing, elapsed time, tokens */
export const AgentTable = memo(function AgentTable({ v, now, rows }: { v: SessionView; now: number; rows: number }) {
  const list = useMemo(
    () =>
      Object.values(v.agents)
        .filter((a) => a.kind !== 'workflow')
        .sort((x, y) => rank(x) - rank(y) || (x.id === MAIN ? -1 : y.id === MAIN ? 1 : 0) || y.lastActivity - x.lastActivity),
    [v.agents],
  );
  const shown = list.slice(0, rows);
  const tok = (a: AgentNode) => a.tokens.in + a.tokens.out + a.tokens.cacheRead + a.tokens.cacheWrite;
  const maxTok = Math.max(1, ...list.map(tok));
  const plan = v.mode === 'plan';
  return (
    <div className="px-table" data-testid="px-table">
      <div className="px-title">
        agents <b>{list.length}</b>
      </div>
      <div className="trow th">
        <span />
        <span>agent</span>
        <span>doing</span>
        <span className="r">time</span>
        <span className="r">tokens</span>
      </div>
      {shown.map((a) => {
        const st = displayStatus(a, now);
        const end = a.endedAt ?? (a.status === 'running' ? now : a.lastActivity);
        return (
          <div key={a.id} className={`trow ${st} ${famClass(a.model)}`}>
            <GoalBadge goal={agentGoal(a, plan)} glyphOnly />
            <span className="nm" title={a.description}>
              <i className={`sd ${st}`} />
              {a.kind === 'main' ? 'main' : a.description || agentName(a)}
            </span>
            <span className="act">{agentInsight(v.agents, a, now, plan).activity.phrase}</span>
            <span className="r">{formatDuration(Math.max(0, end - a.startedAt))}</span>
            <span className="r tk" style={{ '--w': tok(a) / maxTok } as CSSProperties}>
              {formatTokens(tok(a))}
            </span>
          </div>
        );
      })}
      {list.length > shown.length && <div className="more">+{list.length - shown.length} more</div>}
    </div>
  );
});

/** the slim rail of a short, wide small-tier panel: sparkline and gauges stacked beside the graph, with the newest few log lines */
export const SideRail = memo(function SideRail({ v, tick, feed }: { v: SessionView; tick: number; feed: boolean }) {
  return (
    <aside className="ov-side" data-testid="px-side">
      <InsightRail v={v} tick={tick} side />
      {feed && <LiveFeed v={v} count={6} testId="px-side-feed" />}
    </aside>
  );
});
