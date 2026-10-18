import { useEffect, useState } from 'react';
import { describeActivity } from '@core/activity';
import { toolCategory, type ToolCategory } from '@core/goal';
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
  return (
    <div className={`drawer panel-raised ${famClass(a.model)}`} data-testid="drawer" role="dialog" aria-label={`Agent ${agentName(a)}`}>
      <div className="hd">
        <b>{agentName(a)}</b>
        <GoalBadge goal={goal} />
        <button className="btn-icon ghost" onClick={onClose} aria-label="close" title="Close (Esc)">
          <Icon name="close" />
        </button>
      </div>
      {a.kind !== 'main' && a.description && <div className="dtitle">{a.description}</div>}
      <div className="because" data-testid="because">
        {goal.because} <span className="conf">· {goal.confidence} confidence</span>
      </div>
      <div className="nowbox" data-testid="drawer-now">
        <span className="lbl">now:</span> {act.phrase}
        {act.since != null && <span className="dur"> · {formatDuration(now - act.since)}</span>}
      </div>
      <div className="kv">
        <span className="k">status</span>
        <span className={`v status ${st}`}>
          <StatusText st={st} />
        </span>
        <span className="k">model</span>
        <span className="v">{modelLabel(a.model)}</span>
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
        <span className="k">elapsed</span>
        <span className="v">{formatDuration((a.endedAt ?? now) - a.startedAt)}</span>
        <span className="k">tools</span>
        <span className="v">
          {a.toolCount}
          {a.errorCount ? ` (${a.errorCount} failed)` : ''}
        </span>
        <span className="k">tokens in/out</span>
        <span className="v">
          {formatTokens(a.tokens.in + a.tokens.cacheRead + a.tokens.cacheWrite)} / {formatTokens(a.tokens.out)}
        </span>
        {cost !== null && (
          <>
            <span className="k">cost est.</span>
            <span className="v" title={estimateTooltip()} data-testid="drawer-cost">
              ~{formatUSD(cost)}
            </span>
          </>
        )}
      </div>
      {task && (
        <section>
          <h4>
            {a.kind === 'main' ? 'latest prompt' : 'task'}
            <CopyButton text={task} title="Copy the task" />
          </h4>
          <div className="task" data-testid="task">
            {task}
          </div>
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
            {timeline.map((r) => {
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
  );
}
