import { useState } from 'react';
import type { SessionSummary } from '@core/state';
import { ago } from '../util';

function Row({ s, sel, now, onSelect }: { s: SessionSummary; sel: boolean; now: number; onSelect: (id: string) => void }) {
  const active = now - s.mtime < 60_000;
  const dot = s.waiting ? 'waiting' : active ? 'active' : s.live ? 'live' : '';
  return (
    <div className={`session-row ${sel ? 'sel' : ''}`} onClick={() => onSelect(s.id)} title={s.cwd ?? s.file}>
      <span className={`dot ${dot}`} />
      <span className="t">{s.title ?? '(untitled)'}</span>
      <span style={{ display: 'flex', gap: 4 }}>
        {s.mode === 'plan' && s.live && <span className="badge plan">plan</span>}
        {!!s.running && <span className="badge run">{s.running}▸</span>}
      </span>
      <span className="sub">
        {s.project} · {ago(s.mtime, now)}
        {s.entrypoint === 'claude-desktop' ? ' · desktop' : s.entrypoint === 'cli' ? ' · cli' : ''}
      </span>
    </div>
  );
}

export type Page = 'session' | 'overview';

export function SessionList({ sessions, selected, now, follow, onSelect, onFollow, collapsed, onCollapse, page, onPage }: { sessions: SessionSummary[]; selected: string | null; now: number; follow: boolean; onSelect: (id: string) => void; onFollow: (on: boolean) => void; collapsed: boolean; onCollapse: () => void; page: Page; onPage: (p: Page) => void }) {
  const [q, setQ] = useState('');
  if (collapsed) {
    return (
      <div className="sidebar collapsed">
        <div className="sidebar-head">
          <button onClick={onCollapse} title="Show sessions">
            »
          </button>
        </div>
        <div className="sidebar-head" style={{ flexDirection: 'column' }}>
          <button className={page === 'overview' ? 'on' : ''} onClick={() => onPage('overview')} title="All sessions">
            ▦
          </button>
          <button className={page === 'session' ? 'on' : ''} onClick={() => onPage('session')} title="One session">
            ◉
          </button>
        </div>
      </div>
    );
  }
  const query = q.trim().toLowerCase();
  const match = (s: SessionSummary) => !query || (s.title ?? '').toLowerCase().includes(query) || s.project.toLowerCase().includes(query);
  const live = sessions.filter((s) => s.live && match(s));
  const recent = sessions.filter((s) => !s.live && match(s)).slice(0, 120);
  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <span className="brand">
          <b>◆</b> CLAUDE VISUALIZED
        </span>
        <button onClick={onCollapse} title="Collapse">
          «
        </button>
      </div>
      <div className="sidebar-tools">
        <div className="page-switch">
          <button className={page === 'overview' ? 'on' : ''} onClick={() => onPage('overview')} title="Every live session side by side">
            ▦ all sessions
          </button>
          <button className={page === 'session' ? 'on' : ''} onClick={() => onPage('session')} title="One session in detail">
            ◉ one session
          </button>
        </div>
        <input placeholder="search sessions…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="follow">
          <input type="checkbox" checked={follow} onChange={(e) => onFollow(e.target.checked)} />
          follow the active session
        </label>
      </div>
      <div className="session-list">
        <div className="group-label">live · {live.length}</div>
        {live.length === 0 && <div className="empty-note" style={{ padding: '2px 12px' }}>no session active in the last 10 min</div>}
        {live.map((s) => (
          <Row key={s.id} s={s} sel={s.id === selected} now={now} onSelect={onSelect} />
        ))}
        <div className="group-label">recent</div>
        {recent.map((s) => (
          <Row key={s.id} s={s} sel={s.id === selected} now={now} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}
