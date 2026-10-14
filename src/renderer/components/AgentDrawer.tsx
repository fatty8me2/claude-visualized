import type { SessionView } from '@core/state';
import { formatDuration, formatTokens, modelLabel, toolLabel } from '@core/summarize';
import { agentName, clock, displayStatus, famClass, STATUS_GLYPH } from '../util';

export function AgentDrawer({ view, id, now, onClose, onFilterLog }: { view: SessionView; id: string; now: number; onClose: () => void; onFilterLog: (id: string) => void }) {
  const a = view.agents[id];
  if (!a) return null;
  const st = displayStatus(a, now);
  const parent = a.parentId ? view.agents[a.parentId] : null;
  const recent = view.log.filter((l) => l.agentId === id && (l.kind === 'tool' || l.kind === 'tool-error')).slice(-8);
  return (
    <div className={`drawer ${famClass(a.model)}`}>
      <div className="hd">
        <b>{agentName(a)}</b>
        <button onClick={onClose}>×</button>
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
      {a.description && <div style={{ color: 'var(--text-2)' }}>{a.description}</div>}
      {a.currentTool && (
        <div>
          ⚙ <span style={{ color: 'var(--fam)' }}>{toolLabel(a.currentTool.name)}</span> {a.currentTool.summary}{' '}
          <span style={{ color: 'var(--muted)' }}>({formatDuration(now - a.currentTool.since)})</span>
        </div>
      )}
      {recent.length > 0 && (
        <div>
          <div style={{ color: 'var(--muted)', fontSize: 11, marginBottom: 3 }}>RECENT TOOLS</div>
          {recent.map((l) => (
            <div key={l.seq} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: l.kind === 'tool-error' ? 'var(--warn)' : 'var(--text-2)' }}>
              <span style={{ color: 'var(--faint)' }}>{clock(l.ts)}</span> {l.text}
            </div>
          ))}
        </div>
      )}
      {a.lastText && (
        <div>
          <div style={{ color: 'var(--muted)', fontSize: 11, marginBottom: 3 }}>LAST MESSAGE</div>
          <div className="last">{a.lastText}</div>
        </div>
      )}
      <button onClick={() => onFilterLog(a.id)}>filter log to this agent</button>
    </div>
  );
}
