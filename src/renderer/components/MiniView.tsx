import { MAIN } from '@core/state';
import { agentGoal, agentInsight } from '@core/insight';
import { modelLabel } from '@core/summarize';
import { GoalBadge } from './GoalBadge';
import { StatusText } from './cardParts';
import { useInbox, useLiveState, useNow } from '../hooks';
import { CtxChip } from './ContextMeter';
import { UsageMeters } from './UsageMeters';
import { isLocalModel, LocalChip, LocalTag } from './LocalBits';
import { agentName, clock, displayStatus, famClass } from '../util';
import { Icon } from './Icon';

export function MiniView() {
  const view = useLiveState();
  const now = useNow();
  const inbox = useInbox();
  const main = view?.agents[MAIN];
  const subs = view ? Object.values(view.agents).filter((a) => a.kind !== 'main') : [];
  const running = subs.filter((a) => a.status === 'running' || a.status === 'waiting');
  const recentDone = subs.filter((a) => (a.status === 'done' || a.status === 'error') && a.endedAt && now - a.endedAt < 5 * 60_000).slice(-3);
  const log = view
    ? [...view.log]
        .filter((l) => l.kind !== 'text')
        .sort((a, b) => a.ts - b.ts || a.seq - b.seq)
        .slice(-4)
    : [];
  const plan = view?.mode === 'plan';
  const st = main ? displayStatus(main, now) : 'idle';
  return (
    <div className="mini">
      <div className="mini-head">
        {view && <span className={`modebadge ${plan ? 'plan' : ''}`}>{plan ? 'PLAN' : 'BUILD'}</span>}
        <span className="t">{view?.title ?? 'waiting for a session…'}</span>
        <button className="btn-icon ghost" onClick={() => window.api.showMain()} title="Open the main window" aria-label="open the main window">
          <Icon name="openExternal" size="xs" />
        </button>
        <button className="btn-icon ghost" onClick={() => window.close()} title="Close the mini view" aria-label="close">
          <Icon name="close" size="xs" />
        </button>
      </div>
      {!!inbox?.count && (
        <div className="mini-need" data-testid="mini-need" title="Open the inbox" onClick={() => void window.api.showInbox()}>
          <Icon name="waiting" size="xs" /> {inbox.count} need you
        </div>
      )}
      <div className="mini-usage">
        <UsageMeters compact />
        <LocalChip onOpen={() => window.api.showMain()} />
      </div>
      {view && main && (
        <div className="mini-body">
          <div className={`mini-main ${famClass(main.model)}`}>
            <b style={{ color: 'var(--fam)' }}>{modelLabel(main.model)}</b>
            {isLocalModel(main.model) && <LocalTag />}
            <span className={`status ${st}`}>
              <StatusText st={st} />
            </span>
            <CtxChip agent={main} />
            <GoalBadge goal={agentGoal(main, plan)} glyphOnly />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} data-testid="mini-now">
              {agentInsight(view.agents, main, now, plan).activity.line}
            </span>
          </div>
          {(running.length > 0 || recentDone.length > 0) && (
            <div className="mini-chips">
              {running.map((a) => {
                const ins = agentInsight(view.agents, a, now);
                return (
                  <span key={a.id} className={`mini-chip ${famClass(a.model)}`} title={`${a.description}\n${ins.goal.because}`}>
                    <GoalBadge goal={ins.goal} glyphOnly /> {isLocalModel(a.model) && <LocalTag title="local model" />} {agentName(a)} · {ins.activity.line}
                  </span>
                );
              })}
              {recentDone.map((a) => (
                <span key={a.id} className={`mini-chip done ${famClass(a.model)}`} title={a.description}>
                  <GoalBadge goal={agentGoal(a)} glyphOnly /> {isLocalModel(a.model) && <LocalTag title="local model" />} <Icon name="done" size="xs" />{' '}
                  {agentName(a)}
                  {a.description ? ` · ${a.description}` : ''}
                </span>
              ))}
            </div>
          )}
          <div className="mini-log">
            {log.map((l) => (
              <div key={l.seq}>
                <span style={{ color: 'var(--faint)' }}>{clock(l.ts)}</span>{' '}
                <span className={famClass(view.agents[l.agentId]?.model)} style={{ color: 'var(--fam)' }}>
                  {agentName(view.agents[l.agentId])}
                </span>{' '}
                {l.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
