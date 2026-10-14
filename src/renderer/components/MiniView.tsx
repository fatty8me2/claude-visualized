import { MAIN } from '@core/state';
import { modelLabel, toolLabel } from '@core/summarize';
import { useLiveState, useNow } from '../hooks';
import { CtxChip } from './ContextMeter';
import { UsageMeters } from './UsageMeters';
import { agentName, clock, displayStatus, famClass, STATUS_GLYPH } from '../util';

export function MiniView() {
  const view = useLiveState();
  const now = useNow();
  const main = view?.agents[MAIN];
  const subs = view ? Object.values(view.agents).filter((a) => a.kind !== 'main') : [];
  const running = subs.filter((a) => a.status === 'running' || a.status === 'waiting');
  const recentDone = subs
    .filter((a) => (a.status === 'done' || a.status === 'error') && a.endedAt && now - a.endedAt < 5 * 60_000)
    .slice(-3);
  const log = view ? [...view.log].filter((l) => l.kind !== 'text').sort((a, b) => a.ts - b.ts || a.seq - b.seq).slice(-4) : [];
  const plan = view?.mode === 'plan';
  const st = main ? displayStatus(main, now) : 'idle';
  return (
    <div className="mini">
      <div className="mini-head">
        {view && <span className={`modebadge ${plan ? 'plan' : ''}`}>{plan ? 'PLAN' : 'BUILD'}</span>}
        <span className="t">{view?.title ?? 'waiting for a session…'}</span>
        <button onClick={() => window.api.showMain()} title="Open main window">
          ⤢
        </button>
        <button onClick={() => window.close()} title="Close mini view">
          ×
        </button>
      </div>
      <div className="mini-usage">
        <UsageMeters compact />
      </div>
      {view && main && (
        <div className="mini-body">
          <div className={`mini-main ${famClass(main.model)}`}>
            <b style={{ color: 'var(--fam)' }}>{modelLabel(main.model)}</b>
            <span className={`status ${st}`}>{STATUS_GLYPH[st]}</span>
            <CtxChip agent={main} />
            {main.currentTool && (
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                ⚙ {toolLabel(main.currentTool.name)} {main.currentTool.summary}
              </span>
            )}
          </div>
          {(running.length > 0 || recentDone.length > 0) && (
            <div className="mini-chips">
              {running.map((a) => (
                <span key={a.id} className={`mini-chip ${famClass(a.model)}`} title={a.description}>
                  ◐ {agentName(a)}
                  {a.currentTool ? ` · ${toolLabel(a.currentTool.name)}` : ''}
                </span>
              ))}
              {recentDone.map((a) => (
                <span key={a.id} className={`mini-chip done ${famClass(a.model)}`} title={a.description}>
                  ✓ {agentName(a)}
                </span>
              ))}
            </div>
          )}
          <div className="mini-log">
            {log.map((l) => (
              <div key={l.seq}>
                <span style={{ color: 'var(--faint)' }}>{clock(l.ts)}</span> <span className={famClass(view.agents[l.agentId]?.model)} style={{ color: 'var(--fam)' }}>{agentName(view.agents[l.agentId])}</span> {l.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
