import { useEffect, useState } from 'react';
import { describeActivity } from '@core/activity';
import { toolCategory, type ToolCategory } from '@core/goal';
import { contextInfo } from '@core/context';
import { childCounts, agentGoal } from '@core/insight';
import { estimateCostUSD, estimateTooltip, formatUSD } from '@core/pricing';
import type { AgentNode, SessionView } from '@core/state';
import { formatDuration, formatTokens, modelLabel, toolLabel } from '@core/summarize';
import { agentName, clock, displayStatus, famClass } from '../util';
import { GoalBadge } from './GoalBadge';
import { StatusText } from './cardParts';
import { CopyButton } from './CopyButton';
import { Icon, type IconName } from './Icon';
import { isLocalModel, LocalLinkLine } from './LocalBits';

const TOOL_ICON: Record<ToolCategory, IconName> = {
  search: 'search',
  read: 'read',
  edit: 'edit',
  test: 'test',
  run: 'run',
  web: 'web',
  agent: 'agent',
  plan: 'plan',
  other: 'other',
};

const MIX_ORDER: ToolCategory[] = ['search', 'read', 'edit', 'test', 'run', 'web', 'agent', 'plan', 'other'];
const MIX_NAME: Record<ToolCategory, string> = {
  search: 'search',
  read: 'read',
  edit: 'edit',
  test: 'test',
  run: 'shell',
  web: 'web',
  agent: 'agents',
  plan: 'checklist',
  other: 'other',
};
const MAX_CHILDREN = 12;
const SPARK_BINS = 32;

/** a number that slides in when it changes (keyed remount, CSS animation only) */
function Roll({ text }: { text: string }) {
  return (
    <span className="tv" key={text}>
      {text}
    </span>
  );
}

/** the task text, clamped to a few lines with a "show more" toggle (the full text stays in the DOM) */
function Task({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 260 || text.split('\n').length > 4;
  return (
    <div className={`task-wrap ${open || !long ? 'open' : ''}`}>
      <div className="task" data-testid="task">
        {text}
      </div>
      {long && (
        <button className="task-more" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'show less' : 'show more'}
        </button>
      )}
    </div>
  );
}

/** tool starts over the agent's life as a bar sparkline (heights are scaleY, so it stays on the compositor) */
function Spark({ a, end }: { a: AgentNode; end: number }) {
  if (a.activity.length < 2) return null;
  const span = Math.min(10 * 60_000, Math.max(60_000, end - a.startedAt));
  const t0 = end - span;
  const bins = new Array<number>(SPARK_BINS).fill(0);
  for (const t of a.activity) {
    if (t < t0 || t > end) continue;
    bins[Math.min(SPARK_BINS - 1, Math.floor(((t - t0) / span) * SPARK_BINS))]++;
  }
  const max = Math.max(1, ...bins);
  return (
    <div className="d-spark" data-testid="drawer-spark" title={`tool starts, last ${formatDuration(span)}`}>
      <div className="bars">
        {bins.map((n, i) => (
          <i key={i} className={n ? 'on' : ''} style={{ transform: `scaleY(${n ? 0.18 + (0.82 * n) / max : 0.08})` }} />
        ))}
      </div>
      <div className="cap">
        <span>{formatDuration(span)} ago</span>
        <span>tool activity</span>
        <span>now</span>
      </div>
    </div>
  );
}

function base(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function MixBars({ a }: { a: AgentNode }) {
  const total = MIX_ORDER.reduce((n, c) => n + (a.toolMix[c] ?? 0), 0);
  if (!total) return null;
  const max = Math.max(...MIX_ORDER.map((c) => a.toolMix[c] ?? 0));
  return (
    <section>
      <h4>tool mix</h4>
      <div className="mix">
        {MIX_ORDER.filter((c) => a.toolMix[c]).map((c) => (
          <div key={c} className="mixrow" data-cat={c}>
            <span className="mn">
              <Icon name={TOOL_ICON[c]} size="xs" /> {MIX_NAME[c]}
            </span>
            <span className="mb">
              <i style={{ width: `${((a.toolMix[c] ?? 0) / max) * 100}%` }} />
            </span>
            <span className="mc">{a.toolMix[c]}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function AgentDrawer({
  view,
  id,
  now,
  onClose,
  onFilterLog,
  onSelect,
  onShowInTimeline,
}: {
  view: SessionView;
  id: string;
  now: number;
  onClose: () => void;
  onFilterLog: (id: string) => void;
  /** select another agent (parent, children) */
  onSelect: (id: string) => void;
  /** switch the panel to the timeline (the agent stays selected); undefined when it is already showing */
  onShowInTimeline?: () => void;
}) {
  // error details the user toggled (the newest failure starts open)
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  // Escape closes the drawer, unless the key was meant for a text field
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const a = view.agents[id];
  if (!a) return null;
  const st = displayStatus(a, now);
  const parent = a.parentId ? view.agents[a.parentId] : null;
  const goal = agentGoal(a, view.mode === 'plan');
  const kids = childCounts(view.agents, a.id);
  const act = describeActivity(a, { now, runningChildren: kids.running, totalChildren: kids.total });
  const task = a.prompt || a.description;
  const timeline = [...a.recent].reverse();
  // time until the next call started (or until now for the newest): a rough "how long it held the agent"
  const gaps = timeline.map((r, i) => (i === 0 ? now : timeline[i - 1].ts) - r.ts);
  const maxGap = Math.max(1, ...gaps);
  const newestErr = timeline.find((r) => r.error)?.id;
  const children = Object.values(view.agents)
    .filter((c) => c.parentId === a.id && c.id !== a.id)
    .sort((x, y) => x.startedAt - y.startedAt);
  const cost = estimateCostUSD(a.tokens, a.model);
  const toggle = (rid: string) =>
    setToggled((cur) => {
      const n = new Set(cur);
      if (n.has(rid)) n.delete(rid);
      else n.add(rid);
      return n;
    });
  const ctx = contextInfo(a);
  const end = a.endedAt ?? now;
  const live = st === 'running' || st === 'waiting';
  const tokIn = a.tokens.in + a.tokens.cacheRead + a.tokens.cacheWrite;
  return (
    <div className={`drawer panel-raised ${famClass(a.model)} d-${st} ${live ? 'live' : ''}`} data-testid="drawer" role="dialog" aria-label={`Agent ${agentName(a)}`}>
      <span className="d-orbit" aria-hidden />
      <div className="d-scroll">
        <div className="d-body" key={a.id}>
          <header className="d-hero">
            <div className="hd">
              <b>{agentName(a)}</b>
              <GoalBadge goal={goal} />
              <button className="btn-icon ghost" onClick={onClose} aria-label="close" title="Close (Esc)">
                <Icon name="close" />
              </button>
            </div>
            {a.kind !== 'main' && a.description && <div className="dtitle">{a.description}</div>}
            <div className="d-chips">
              <span className="d-model" title={a.model ?? undefined}>
                <i className="d-dot" />
                {modelLabel(a.model)}
              </span>
              <span className={`v status d-status ${st}`}>
                <StatusText st={st} />
                <span className="d-elapsed" title={`started ${clock(a.startedAt)}`}>
                  {formatDuration(end - a.startedAt)}
                </span>
              </span>
            </div>
          </header>
          <div className="because" data-testid="because">
            {goal.because} <span className="conf">· {goal.confidence} confidence</span>
          </div>
          <div className="nowbox" data-testid="drawer-now">
            <span className="lbl">now:</span> {act.phrase}
            {act.since != null && <span className="dur"> · {formatDuration(now - act.since)}</span>}
          </div>
          <div className="d-tiles">
            <div className="d-tile" data-k="tools">
              <span className="tk">tools</span>
              <Roll text={String(a.toolCount)} />
              <span className={`ts ${a.errorCount ? 'bad' : ''}`}>{a.errorCount ? `${a.errorCount} failed` : 'all ok'}</span>
            </div>
            <div className="d-tile" data-k="tokens" title={`in ${formatTokens(tokIn)} / out ${formatTokens(a.tokens.out)}`}>
              <span className="tk">tokens</span>
              <Roll text={formatTokens(tokIn + a.tokens.out)} />
              <span className="ts">
                {formatTokens(tokIn)} in · {formatTokens(a.tokens.out)} out
              </span>
            </div>
            {ctx && (
              <div className={`d-tile lv-${ctx.level}`} data-k="ctx" title={ctx.windowKnown ? `${formatTokens(ctx.tokens)} of ${formatTokens(ctx.size)} context` : `${formatTokens(ctx.tokens)} context`}>
                <span className="tk">context</span>
                <Roll text={ctx.windowKnown ? `${ctx.pct}%` : formatTokens(ctx.tokens)} />
                <span className="ts d-meter">
                  <i style={{ transform: `scaleX(${ctx.windowKnown ? Math.min(1, ctx.fraction) : 0})` }} />
                </span>
              </div>
            )}
            {cost !== null && (
              <div className="d-tile" data-k="cost" title={estimateTooltip()} data-testid="drawer-cost">
                <span className="tk">cost est.</span>
                <Roll text={`~${formatUSD(cost)}`} />
                <span className="ts">estimate</span>
              </div>
            )}
          </div>
          <Spark a={a} end={end} />
          <div className="kv">
            {isLocalModel(a.model) && (
              <>
                <span className="k">runs on</span>
                <span className="v">
                  <LocalLinkLine agent={a} />
                </span>
              </>
            )}
            {a.kind !== 'main' && (
              <>
                <span className="k">id</span>
                <span className="v" title={a.id}>
                  {a.id}
                </span>
                <span className="k">parent</span>
                <span className="v">
                  {parent ? (
                    <button className="link" onClick={() => onSelect(parent.id)} data-testid="drawer-parent" title="Show the parent agent">
                      {agentName(parent)}
                    </button>
                  ) : (
                    '—'
                  )}
                </span>
              </>
            )}
            <span className="k">started</span>
            <span className="v">{clock(a.startedAt)}</span>
          </div>
      {task && (
        <section>
          <h4>
            {a.kind === 'main' ? 'latest prompt' : 'task'}
            <CopyButton text={task} title="Copy the task" />
          </h4>
          <Task text={task} />
        </section>
      )}
      {children.length > 0 && (
        <section>
          <h4>
            subagents · {kids.running ? `${kids.running} running of ` : ''}
            {children.length}
          </h4>
          <div className="kids" data-testid="drawer-children">
            {children.slice(0, MAX_CHILDREN).map((c) => {
              const cs = displayStatus(c, now);
              return (
                <button key={c.id} className={`kid ${famClass(c.model)} st-${cs}`} onClick={() => onSelect(c.id)} title={c.description || agentName(c)}>
                  <span className={`status ${cs}`}>
                    <StatusText st={cs} />
                  </span>
                  <span className="kn">{c.description || agentName(c)}</span>
                </button>
              );
            })}
            {children.length > MAX_CHILDREN && <span className="more">+{children.length - MAX_CHILDREN} more</span>}
          </div>
        </section>
      )}
      {timeline.length > 0 && (
        <section>
          <h4>recent activity</h4>
          <div className="dtl" data-testid="timeline">
            {timeline.map((r, ri) => {
              const open = !!r.error && toggled.has(r.id) !== (r.id === newestErr);
              return (
                <div key={r.id} className="tl-wrap">
                  <div
                    className={`tl ${r.ok === false ? 'bad' : r.ok === null ? 'run' : ''} ${r.error ? 'has-err' : ''}`}
                    title={r.error ? 'Click to show or hide what it said' : `${toolLabel(r.name)} ${r.summary}`}
                    onClick={r.error ? () => toggle(r.id) : undefined}
                  >
                    <span className="t">{clock(r.ts)}</span>
                    <span className="ic">
                      <Icon name={TOOL_ICON[toolCategory(r.name)]} size="xs" />
                    </span>
                    <span className="tx">
                      <b>{toolLabel(r.name)}</b> {r.summary}
                    </span>
                    <span className="gap" title={`about ${formatDuration(gaps[ri])} until the next call`}>
                      <i style={{ transform: `scaleX(${Math.max(0.04, gaps[ri] / maxGap)})` }} />
                    </span>
                    <span className="ok">
                      <Icon name={r.ok === null ? 'running' : r.ok ? 'done' : 'error'} size="xs" />
                    </span>
                  </div>
                  {open && (
                    <pre className="tl-err" data-testid="tool-error">
                      {r.error}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
      {a.files.length > 0 && (
        <section>
          <h4>files · {a.files.length}</h4>
          <div className="chips" data-testid="files">
            {[...a.files].reverse().map((f) => (
              <span key={f} className="chip" data-tone="text" title={f}>
                {base(f)}
              </span>
            ))}
          </div>
        </section>
      )}
      {a.commands.length > 0 && (
        <section>
          <h4>commands</h4>
          <div className="cmds" data-testid="commands">
            {[...a.commands].reverse().map((c, i) => (
              <div key={i} title={c}>
                <span className="pr">❯</span>
                <span className="cx">{c.split('\n')[0]}</span>
                <CopyButton text={c} title="Copy the command" />
              </div>
            ))}
          </div>
        </section>
      )}
      <MixBars a={a} />
      {a.lastText && (
        <section>
          <h4>
            last message
            <CopyButton text={a.lastText} title="Copy the message" />
          </h4>
          <div className="last">{a.lastText}</div>
        </section>
      )}
      <div className="drawer-acts">
        <button onClick={() => onFilterLog(a.id)} title="Show only this agent's lines in the session log">
          show in log
        </button>
        {onShowInTimeline && (
          <button onClick={onShowInTimeline} title="Switch to the timeline with this agent selected">
            show in timeline
          </button>
        )}
      </div>
        </div>
      </div>
    </div>
  );
}
