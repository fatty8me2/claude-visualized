import { MAIN, type SessionView } from '@core/state';
import { CtxChip } from './ContextMeter';
import { GOAL_INFO } from '@core/goal';
import { agentGoal, agentInsight } from '@core/insight';
import { formatTokens, modelLabel } from '@core/summarize';
import { GoalBadge } from './GoalBadge';
import { StatusText } from './cardParts';
import { useNow, useOverview } from '../hooks';
import { agentName, ago, clock, displayStatus, famClass } from '../util';
import { AgentGraph } from './AgentGraph';
import { isLocalModel, LocalChip, LocalTag } from './LocalBits';
import { UsageMeters } from './UsageMeters';
import { MachineChip } from './MachineChip';
import { openInClaude } from '../state/toast';

/** columns that keep panels roughly landscape on a typical monitor */
function columnsFor(n: number): number {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

function Panel({ v, index, now, onOpen, activeOnly }: { v: SessionView; index: number; now: number; onOpen: (id: string) => void; activeOnly: boolean }) {
  const main = v.agents[MAIN];
  const st = main ? displayStatus(main, now) : 'idle';
  const subs = Object.values(v.agents).filter((a) => a.kind === 'agent');
  const running = subs.filter((a) => a.status === 'running').length;
  const plan = v.mode === 'plan';
  const localAgents = Object.values(v.agents).filter((a) => isLocalModel(a.model)).length;
  const tokens = v.totals.in + v.totals.out + v.totals.cacheRead + v.totals.cacheWrite;
  const recent = v.log.filter((l) => l.kind !== 'text').slice(-2);
  const project = v.cwd?.split(/[\\/]/).filter(Boolean).pop() ?? '';
  return (
    <section className={`ov-panel ${plan ? 'plan' : 'build'} ${st === 'waiting' ? 'waiting' : ''}`} data-session={v.id}>
      <header className="ov-head" onClick={() => onOpen(v.id)} title="Open this session">
        <span className="ov-num">{index + 1}</span>
        <span className={`modebadge ${plan ? 'plan' : ''}`}>{plan ? 'PLAN' : 'BUILD'}</span>
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
            {v.entrypoint === 'claude-desktop' ? ' · desktop' : v.entrypoint ? ` · ${v.entrypoint}` : ''}
            {v.lastActivity ? ` · ${ago(v.lastActivity, now)}` : ''}
          </div>
        </div>
        <div className="ov-stats">
          <span className={`status ${st} ${famClass(main?.model)}`}>
            <b style={{ color: 'var(--fam)' }}>{modelLabel(main?.model)}</b> {isLocalModel(main?.model) && <LocalTag />} <StatusText st={st} />
          </span>
          <span className="ov-sub">
            <CtxChip agent={main} />
            {main && main.contextTokens > 0 ? ' · ' : ''}
            agents {running}/{subs.length}
            {localAgents > 0 && !isLocalModel(main?.model) ? ` · ⌂ ${localAgents} local` : ''} · {formatTokens(tokens)} tok
            {v.costUSD != null ? ` · $${v.costUSD.toFixed(2)}` : ''}
          </span>
        </div>
        <button
          className="ov-claude"
          title={v.machine ? `This session is running on ${v.machine}` : 'Open in the Claude desktop app'}
          onClick={(e) => {
            e.stopPropagation();
            void openInClaude(v.id);
          }}
        >
          ↗ Claude
        </button>
      </header>
      {main && (
        <div className={`ov-tool ${famClass(main.model)}`}>
          <GoalBadge goal={agentGoal(main, plan)} glyphOnly /> <span className="lbl">now:</span> {agentInsight(v.agents, main, now, plan).activity.line}
          {running > 0 && (
            <span className="ov-subs">
              {' '}
              ·{' '}
              {subs
                .filter((a) => a.status === 'running')
                .slice(0, 3)
                .map((a) => `${GOAL_INFO[agentGoal(a).goal].glyph} ${agentName(a)}: ${agentInsight(v.agents, a, now).activity.phrase}`)
                .join('  ·  ')}
            </span>
          )}
        </div>
      )}
      <div className="ov-graph">
        <AgentGraph view={v} now={now} selectedAgent={null} onSelect={() => onOpen(v.id)} showFinished={!activeOnly} onToggleFinished={() => {}} embedded />
      </div>
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
    </section>
  );
}

export function Overview({ onOpen, onLocal, activeOnly = false }: { onOpen: (id: string) => void; onLocal: () => void; activeOnly?: boolean }) {
  const views = useOverview();
  const now = useNow(1000);
  if (!views)
    return (
      <div className="empty-state">
        <span className="loading">loading sessions…</span>
      </div>
    );
  const n = views.length;
  const cols = columnsFor(n);
  const rows = Math.max(1, Math.ceil(n / cols));
  const running = views.reduce((k, v) => k + Object.values(v.agents).filter((a) => a.kind === 'agent' && a.status === 'running').length, 0);
  return (
    <div className="overview">
      <div className="topbar">
        <div className="title">
          ALL SESSIONS{' '}
          <span className="proj">
            · {n} live · {running} subagents running · click a panel to open it
          </span>
        </div>
        <UsageMeters />
        <LocalChip onOpen={onLocal} />
      </div>
      {n === 0 ? (
        <div className="empty-state">
          <div>
            <div style={{ fontSize: 15, color: 'var(--text)', marginBottom: 8 }}>No live sessions right now</div>
            <div>Sessions show up here as soon as Claude Code starts working in them.</div>
          </div>
        </div>
      ) : (
        <div className="ov-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(300px, 1fr))` }}>
          {views.map((v, i) => (
            <Panel key={v.id} v={v} index={i} now={now} onOpen={onOpen} activeOnly={activeOnly} />
          ))}
        </div>
      )}
    </div>
  );
}
