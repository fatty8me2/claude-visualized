import { useState } from 'react';
import type { PeersView } from '@core/api';
import type { SessionSummary } from '@core/state';
import { openInClaude } from '../state/toast';
import { ago, clock } from '../util';
import { localMachineName, MachineChip } from './MachineChip';
import { PAGES, type PageId } from '../views/pages';

function Row({ s, sel, now, onSelect }: { s: SessionSummary; sel: boolean; now: number; onSelect: (id: string) => void }) {
  const active = now - s.mtime < 60_000;
  const dot = s.waiting ? 'waiting' : active ? 'active' : s.live ? 'live' : '';
  return (
    <div
      className={`session-row ${sel ? 'sel' : ''} ${s.machine ? 'remote' : ''}`}
      onClick={() => onSelect(s.id)}
      title={s.machine ? `${s.cwd ?? s.project} · running on ${s.machine}` : (s.cwd ?? s.file)}
      data-session={s.id}
    >
      <span className={`dot ${dot}`} />
      <span className="t">{s.title ?? '(untitled)'}</span>
      <span style={{ display: 'flex', gap: 4 }}>
        {s.archived && (
          <span className="badge" title="Archived in the Claude desktop app (hidden from its sidebar)">
            archived
          </span>
        )}
        {s.mode === 'plan' && s.live && <span className="badge plan">plan</span>}
        {!!s.running && <span className="badge run">{s.running}▸</span>}
      </span>
      <button
        className="row-claude"
        title={s.machine ? `This session is running on ${s.machine}` : 'Open in the Claude desktop app'}
        onClick={(e) => {
          e.stopPropagation();
          void openInClaude(s.id);
        }}
      >
        ↗
      </button>
      <span className="sub">
        {s.machine && !s.live && (
          <>
            <MachineChip machine={s.machine} offline={s.offlineSince != null} />{' '}
          </>
        )}
        {s.project} · {ago(s.mtime, now)}
        {s.entrypoint === 'claude-desktop' ? ' · desktop' : s.entrypoint === 'cli' ? ' · cli' : ''}
      </span>
    </div>
  );
}

function sharingWith(p: PeersView): string {
  const n = p.devices.filter((d) => d.role === 'viewer' && d.online).length;
  return n ? `${n} computer${n === 1 ? '' : 's'} watching` : 'your other computers';
}

export function SessionList({
  sessions,
  selected,
  now,
  follow,
  onSelect,
  onFollow,
  collapsed,
  onCollapse,
  page,
  onPage,
  onHelp,
  activeOnly = false,
  onActiveOnly,
  badges = {},
  peers = null,
}: {
  /** paired computers: live sessions are grouped by machine once there is one */
  peers?: PeersView | null;
  /** unread counts per page id (e.g. the inbox) */
  badges?: Record<string, number>;
  activeOnly?: boolean;
  onActiveOnly?: (on: boolean) => void;
  sessions: SessionSummary[];
  selected: string | null;
  now: number;
  follow: boolean;
  onSelect: (id: string) => void;
  onFollow: (on: boolean) => void;
  collapsed: boolean;
  onCollapse: () => void;
  page: PageId;
  onPage: (p: PageId) => void;
  onHelp: () => void;
}) {
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
          <button onClick={onHelp} title="Welcome guide and tour">
            ?
          </button>
          {PAGES.map((p) => (
            <button key={p.id} className={page === p.id ? 'on' : ''} onClick={() => onPage(p.id)} title={p.collapsedTitle}>
              {p.icon}
              {!!badges[p.id] && <span className="nav-badge">{badges[p.id]}</span>}
            </button>
          ))}
        </div>
      </div>
    );
  }
  const query = q.trim().toLowerCase();
  const match = (s: SessionSummary) => !query || (s.title ?? '').toLowerCase().includes(query) || s.project.toLowerCase().includes(query);
  const live = sessions.filter((s) => s.live && match(s));
  const localLive = live.filter((s) => !s.machine);
  const hosts = peers?.devices.filter((d) => d.role === 'host') ?? [];
  const recentAll = sessions.filter((s) => !s.live && match(s));
  // other computers' sessions come after ours in the list: interleave them by time
  if (sessions.some((s) => s.machine)) recentAll.sort((a, b) => b.mtime - a.mtime);
  const recent = recentAll.slice(0, 120);
  return (
    <div className="sidebar" data-tour="sessions">
      <div className="sidebar-head">
        <span className="brand">
          <b>◆</b> CLAUDE VISUALIZED
        </span>
        <span style={{ display: 'flex', gap: 4 }}>
          <button data-tour="help" onClick={onHelp} title="Welcome guide and tour">
            ? help
          </button>
          <button onClick={onCollapse} title="Collapse">
            «
          </button>
        </span>
      </div>
      <div className="sidebar-tools">
        <div className="page-switch" data-tour="overview">
          {PAGES.filter((p) => p.group === 'switch').map((p) => (
            <button key={p.id} className={page === p.id ? 'on' : ''} data-testid={p.testId} onClick={() => onPage(p.id)} title={p.title}>
              {p.icon} {p.label}
            </button>
          ))}
        </div>
        {PAGES.filter((p) => p.group === 'nav').map((p) => (
          <button key={p.id} className={`local-nav ${page === p.id ? 'on' : ''}`} data-testid={p.testId} onClick={() => onPage(p.id)} title={p.title}>
            {p.icon} {p.label}
            {!!badges[p.id] && (
              <span className="nav-badge" data-testid={`badge-${p.id}`}>
                {badges[p.id]}
              </span>
            )}
          </button>
        ))}
        {peers?.sharing && (
          <button
            className="sharing-banner"
            data-testid="sidebar-sharing"
            onClick={() => onPage('devices')}
            title="This computer's sessions are visible to the computers you paired with (read-only). Click to manage."
          >
            ● sharing with {sharingWith(peers)}
          </button>
        )}
        <input placeholder="search sessions…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="follow" data-tour="follow">
          <input type="checkbox" checked={follow} onChange={(e) => onFollow(e.target.checked)} />
          follow the active session
        </label>
        <label className="follow" title="Hide recent sessions and finished agents" data-testid="active-only">
          <input type="checkbox" checked={activeOnly} onChange={(e) => onActiveOnly?.(e.target.checked)} />
          active only
        </label>
      </div>
      <div className="session-list">
        {hosts.length === 0 ? (
          <>
            <div className="group-label">live · {live.length}</div>
            {live.length === 0 && (
              <div className="empty-note" style={{ padding: '2px 12px' }}>
                no session active in the last 10 min
              </div>
            )}
            {live.map((s) => (
              <Row key={s.id} s={s} sel={s.id === selected} now={now} onSelect={onSelect} />
            ))}
          </>
        ) : (
          <>
            <div className="machine-group" data-testid="machine-group" data-machine="local">
              <div className="group-label machine-label">
                <span className="mdot on" />
                {localMachineName()} · {localLive.length} live
              </div>
              {localLive.length === 0 && (
                <div className="empty-note" style={{ padding: '2px 12px' }}>
                  no session active in the last 10 min
                </div>
              )}
              {localLive.map((s) => (
                <Row key={s.id} s={s} sel={s.id === selected} now={now} onSelect={onSelect} />
              ))}
            </div>
            {hosts.map((h) => {
              const rows = live.filter((s) => s.deviceId === h.deviceId);
              const state = h.online
                ? `${rows.length} live`
                : h.state === 'connecting'
                  ? 'connecting…'
                  : h.state === 'revoked'
                    ? 'un-paired there'
                    : h.offlineSince
                      ? `offline since ${clock(h.offlineSince)}`
                      : 'offline';
              return (
                <div className="machine-group" key={h.key} data-testid="machine-group" data-machine={h.name} data-online={h.online}>
                  <div className="group-label machine-label" title={h.error ?? `${h.host}:${h.port}`}>
                    <span className={`mdot ${h.online ? 'on' : 'off'}`} />
                    {h.name} · {state}
                  </div>
                  {rows.map((s) => (
                    <Row key={s.id} s={s} sel={s.id === selected} now={now} onSelect={onSelect} />
                  ))}
                </div>
              );
            })}
          </>
        )}
        {!activeOnly && <div className="group-label">recent</div>}
        {!activeOnly && recent.map((s) => <Row key={s.id} s={s} sel={s.id === selected} now={now} onSelect={onSelect} />)}
        {activeOnly && (
          <div className="empty-note" style={{ padding: '10px 12px' }}>
            recent sessions hidden · untick “active only” to see them
          </div>
        )}
      </div>
    </div>
  );
}
