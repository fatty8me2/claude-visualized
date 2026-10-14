import { describeActivity } from '@core/activity';
import { toolCategory, type ToolCategory } from '@core/goal';
import { childCounts, agentGoal } from '@core/insight';
import type { AgentNode, SessionView } from '@core/state';
import { formatDuration, formatTokens, modelLabel, toolLabel } from '@core/summarize';
import { agentName, clock, displayStatus, famClass, STATUS_GLYPH } from '../util';
import { GoalBadge } from './GoalBadge';

const TOOL_ICON: Record<ToolCategory, string> = {
  search: '⌕',
  read: '▤',
  edit: '✎',
  test: '⚗',
  run: '❯',
  web: '◈',
  agent: '⧉',
  plan: '☰',
  other: '·',
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
      <h4>TOOL MIX</h4>
      <div className="mix">
        {MIX_ORDER.filter((c) => a.toolMix[c]).map((c) => (
          <div key={c} className="mixrow" data-cat={c}>
            <span className="mn">
              {TOOL_ICON[c]} {MIX_NAME[c]}
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

export function AgentDrawer({ view, id, now, onClose, onFilterLog }: { view: SessionView; id: string; now: number; onClose: () => void; onFilterLog: (id: string) => void }) {
  const a = view.agents[id];
  if (!a) return null;
  const st = displayStatus(a, now);
  const parent = a.parentId ? view.agents[a.parentId] : null;
  const goal = agentGoal(a, view.mode === 'plan');
  const kids = childCounts(view.agents, a.id);
  const act = describeActivity(a, { now, runningChildren: kids.running, totalChildren: kids.total });
  const task = a.prompt || a.description;
  const timeline = [...a.recent].reverse();
  return (
    <div className={`drawer ${famClass(a.model)}`} data-testid="drawer">
      <div className="hd">
        <b>{agentName(a)}</b>
        <GoalBadge goal={goal} />
        <button onClick={onClose}>×</button>
      </div>
      <div className="because" data-testid="because">
        {goal.because} <span className="conf">· {goal.confidence} confidence</span>
      </div>
      <div className="nowbox" data-testid="drawer-now">
        <span className="lbl">now:</span> {act.phrase}
        {act.since != null && <span className="dur"> · {formatDuration(now - act.since)}</span>}
      </div>
      <div className="kv">
        <span className="k">status</span>
        <span className={`v status ${st}`}>{STATUS_GLYPH[st]}</span>
        <span className="k">model</span>
        <span className="v">{modelLabel(a.model)}</span>
        {a.kind !== 'main' && (
          <>
            <span className="k">id</span>
            <span className="v">{a.id}</span>
            <span className="k">parent</span>
            <span className="v">{agentName(parent ?? undefined)}</span>
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
      </div>
      {task && (
        <section>
          <h4>{a.kind === 'main' ? 'LATEST PROMPT' : 'TASK'}</h4>
          <div className="task" data-testid="task">
            {task}
          </div>
        </section>
      )}
      {timeline.length > 0 && (
        <section>
          <h4>RECENT ACTIVITY</h4>
          <div className="timeline" data-testid="timeline">
            {timeline.map((r) => (
              <div key={r.id} className={`tl ${r.ok === false ? 'bad' : r.ok === null ? 'run' : ''}`} title={`${toolLabel(r.name)} ${r.summary}`}>
                <span className="t">{clock(r.ts)}</span>
                <span className="ic">{TOOL_ICON[toolCategory(r.name)]}</span>
                <span className="tx">
                  <b>{toolLabel(r.name)}</b> {r.summary}
                </span>
                <span className="ok">{r.ok === null ? '◐' : r.ok ? '✓' : '✗'}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      {a.files.length > 0 && (
        <section>
          <h4>FILES ({a.files.length})</h4>
          <div className="chips" data-testid="files">
            {[...a.files].reverse().map((f) => (
              <span key={f} className="chip" title={f}>
                {base(f)}
              </span>
            ))}
          </div>
        </section>
      )}
      {a.commands.length > 0 && (
        <section>
          <h4>COMMANDS</h4>
          <div className="cmds" data-testid="commands">
            {[...a.commands].reverse().map((c, i) => (
              <div key={i} title={c}>
                <span className="pr">❯</span> {c.split('\n')[0]}
              </div>
            ))}
          </div>
        </section>
      )}
      <MixBars a={a} />
      {a.lastText && (
        <section>
          <h4>LAST MESSAGE</h4>
          <div className="last">{a.lastText}</div>
        </section>
      )}
      <button onClick={() => onFilterLog(a.id)}>filter log to this agent</button>
    </div>
  );
}
