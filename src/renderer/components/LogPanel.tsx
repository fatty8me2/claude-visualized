import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogKind, SessionView } from '@core/state';
import { agentName, clock, famClass } from '../util';

const GROUPS: { key: string; label: string; kinds: LogKind[] }[] = [
  { key: 'prompts', label: 'prompts', kinds: ['prompt'] },
  { key: 'tools', label: 'tools', kinds: ['tool', 'tool-error'] },
  { key: 'agents', label: 'agents', kinds: ['agent', 'done'] },
  { key: 'text', label: 'replies', kinds: ['text'] },
  { key: 'other', label: 'events', kinds: ['mode', 'model', 'notice', 'attention'] },
];

const KIND_TAG: Partial<Record<LogKind, string>> = {
  prompt: '›',
  tool: '⚙',
  'tool-error': '✗',
  agent: '⇣',
  done: '✓',
  mode: '◆',
  model: '◇',
  text: '“',
  notice: '·',
  attention: '⚠',
};

export function LogPanel({ view, agentFilter, onAgentFilter }: { view: SessionView; agentFilter: string | null; onAgentFilter: (id: string | null) => void }) {
  const [enabled, setEnabled] = useState<Record<string, boolean>>({ prompts: true, tools: true, agents: true, text: false, other: true });
  const [q, setQ] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const kinds = useMemo(() => new Set(GROUPS.filter((g) => enabled[g.key]).flatMap((g) => g.kinds)), [enabled]);
  const query = q.trim().toLowerCase();
  const rows = view.log
    .filter((l) => kinds.has(l.kind) && (!agentFilter || l.agentId === agentFilter) && (!query || l.text.toLowerCase().includes(query)))
    .sort((a, b) => a.ts - b.ts || a.seq - b.seq)
    .slice(-600);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const agents = Object.values(view.agents);
  return (
    <div className="log" data-tour="log">
      <div className="log-head">
        <span className="lbl">session log</span>
        {GROUPS.map((g) => (
          <button key={g.key} className={`chip ${enabled[g.key] ? 'on' : ''}`} onClick={() => setEnabled({ ...enabled, [g.key]: !enabled[g.key] })}>
            {g.label}
          </button>
        ))}
        <select value={agentFilter ?? ''} onChange={(e) => onAgentFilter(e.target.value || null)}>
          <option value="">all agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {agentName(a)} {a.kind === 'agent' ? `· ${a.id.slice(0, 7)}` : ''}
            </option>
          ))}
        </select>
        <input placeholder="filter…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div
        className="log-body"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {rows.map((l) => {
          const a = view.agents[l.agentId];
          return (
            <div key={l.seq} className={`log-row k-${l.kind} ${famClass(a?.model)}`} onClick={() => onAgentFilter(agentFilter ? null : l.agentId)}>
              <span className="ts">{clock(l.ts)}</span>
              <span className="who" title={l.agentId}>
                {agentName(a)}
              </span>
              <span className="msg" title={l.text}>
                <span className="kind">{KIND_TAG[l.kind] ?? '·'}</span>
                {l.text}
              </span>
            </div>
          );
        })}
        {rows.length === 0 && (
          <div className="empty-note" style={{ padding: '8px 14px' }}>
            nothing yet
          </div>
        )}
      </div>
    </div>
  );
}
