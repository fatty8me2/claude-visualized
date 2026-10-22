import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { PeersView } from '@core/api';
import { groupRecent, matchSession, type ProjectGroup } from '@core/sessionGroups';
import type { SessionSummary } from '@core/state';
import { openInClaude, showToast } from '../state/toast';
import { useSidebarPrefs } from '../state/sidebarPrefs';
import { ago, clock } from '../util';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { Icon } from './Icon';
import { localMachineName, MachineChip } from './MachineChip';
import { PAGES, type PageId } from '../views/pages';
import '../sidebar.css';

/** FLIP: rows that moved (a session went live, was pinned, the order changed) glide from where they were. Transform only, no state. */
function useFlip(listRef: React.RefObject<HTMLDivElement | null>) {
  const prev = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const next = new Map<string, number>();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const origin = list.getBoundingClientRect().top - list.scrollTop;
    list.querySelectorAll<HTMLElement>('.session-row[data-session]').forEach((el) => {
      const id = el.dataset.session!;
      const top = el.getBoundingClientRect().top - origin;
      next.set(id, top);
      const was = prev.current.get(id);
      if (!reduce && was !== undefined && Math.abs(was - top) > 2 && Math.abs(was - top) < 600 && el.animate) {
        el.animate([{ transform: `translateY(${was - top}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      }
    });
    prev.current = next;
  });
}

type OpenMenu = (s: SessionSummary, x: number, y: number) => void;

function Row({
  s,
  sel,
  now,
  onSelect,
  onMenu,
  inGroup = false,
  pinned = false,
  hidden = false,
}: {
  s: SessionSummary;
  sel: boolean;
  now: number;
  onSelect: (id: string) => void;
  onMenu: OpenMenu;
  /** inside its project group: the project name would repeat, so show the branch instead */
  inGroup?: boolean;
  pinned?: boolean;
  hidden?: boolean;
}) {
  const active = now - s.mtime < 60_000;
  const dot = s.waiting ? 'waiting' : active ? 'active' : s.live ? 'live' : '';
  const state = s.waiting ? 'needs you' : active ? 'working' : s.live ? 'live' : 'idle';
  const where = s.machine ? `running on ${s.machine}` : (s.cwd ?? s.file);
  const client = s.entrypoint === 'claude-desktop' ? 'desktop app' : s.entrypoint === 'cli' ? 'claude CLI' : s.entrypoint;
  return (
    <div
      data-state={dot || 'idle'}
      className={`session-row ${sel ? 'sel' : ''} ${s.machine ? 'remote' : ''} ${hidden ? 'is-hidden' : ''}`}
      onClick={() => onSelect(s.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(s, e.clientX, e.clientY);
      }}
      title={[s.title ?? '(untitled)', `${state} · ${where}`, s.gitBranch ? `branch ${s.gitBranch}` : null, client ? `via ${client}` : null]
        .filter(Boolean)
        .join('\n')}
      data-session={s.id}
    >
      <span className="edge" aria-hidden />
      <span className={`dot ${dot}`} aria-label={state} />
      <span className="t">
        {pinned && <Icon name="pin" size="xs" className="pin-mark" />}
        {s.title ?? '(untitled)'}
      </span>
      <span className="row-badges">
        {s.archived && (
          <span className="badge" title="Archived in the Claude desktop app (hidden from its sidebar)">
            archived
          </span>
        )}
        {s.mode === 'plan' && s.live && <span className="badge plan">plan</span>}
        {dot === 'active' && (
          <span className="eq" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        )}
        {!!s.running && (
          <span className="badge run" title={`${s.running} subagent${s.running === 1 ? '' : 's'} running`}>
            <span className="pips" aria-hidden>
              {Array.from({ length: Math.min(s.running, 4) }, (_, i) => (
                <i key={i} style={{ animationDelay: `${i * 140}ms` }} />
              ))}
            </span>
            {s.running}
          </span>
        )}
      </span>
      <span className="row-acts">
        <button
          className="row-claude btn-icon ghost"
          aria-label="open in Claude"
          title={s.machine ? `This session is running on ${s.machine}` : 'Open in the Claude desktop app'}
          onClick={(e) => {
            e.stopPropagation();
            void openInClaude(s.id);
          }}
        >
          <Icon name="openExternal" size="xs" />
        </button>
        <button
          className="row-more btn-icon ghost"
          aria-label="more actions"
          title="Pin, hide, copy…"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            onMenu(s, r.left, r.bottom + 2);
          }}
        >
          <Icon name="more" size="xs" />
        </button>
      </span>
      {sel && <span className="brk" aria-hidden />}
      <span className="sub">
        {s.machine && !s.live && <MachineChip machine={s.machine} offline={s.offlineSince != null} />}
        <span className="proj">
          {inGroup ? (
            s.gitBranch ? (
              <>
                <Icon name="branch" size="xs" /> {s.gitBranch}
              </>
            ) : (
              s.project
            )
          ) : (
            s.project
          )}
        </span>
        {s.entrypoint === 'cli' && (
          <span className="client" title="claude CLI">
            <Icon name="cli" size="xs" />
          </span>
        )}
        <span className="when">{ago(s.mtime, now)}</span>
      </span>
    </div>
  );
}

function sharingWith(p: PeersView): string {
  const n = p.devices.filter((d) => d.role === 'viewer' && d.online).length;
  return n ? `${n} computer${n === 1 ? '' : 's'} watching` : 'your other computers';
}

function ProjectGroupView({
  g,
  now,
  selected,
  onSelect,
  onMenu,
  onToggle,
}: {
  g: ProjectGroup;
  now: number;
  selected: string | null;
  onSelect: (id: string) => void;
  onMenu: OpenMenu;
  onToggle: () => void;
}) {
  const hasSel = g.sessions.some((s) => s.id === selected);
  return (
    <div className="proj-group" data-project={g.project}>
      <button
        className={`proj-head ${hasSel ? 'has-sel' : ''}`}
        onClick={onToggle}
        aria-expanded={!g.collapsed}
        title={g.collapsed ? 'Show sessions' : 'Hide sessions'}
      >
        <Icon name={g.collapsed ? 'chevronRight' : 'chevronDown'} size="xs" />
        <span className="pn">{g.project}</span>
        {g.machine && <MachineChip machine={g.machine} />}
        <span className="pc">{g.sessions.length}</span>
        <span className="when">{ago(g.newest, now)}</span>
      </button>
      {!g.collapsed && g.sessions.map((s) => <Row key={s.id} s={s} sel={s.id === selected} now={now} onSelect={onSelect} onMenu={onMenu} inGroup />)}
    </div>
  );
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
  /** null until the first list arrives */
  sessions: SessionSummary[] | null;
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
  const listRef = useRef<HTMLDivElement>(null);
  useFlip(listRef);
  const [showHidden, setShowHidden] = useState(false);
  const [menu, setMenu] = useState<{ s: SessionSummary; x: number; y: number } | null>(null);
  const { prefs, togglePin, toggleHidden, toggleGroup } = useSidebarPrefs();
  const openMenu = useCallback<OpenMenu>((s, x, y) => setMenu({ s, x, y }), []);
  const closeMenu = useCallback(() => setMenu(null), []);

  if (collapsed) {
    return (
      <div className="sidebar collapsed">
        <div className="sidebar-col">
          <button className="btn-icon ghost" onClick={onCollapse} title="Show sessions" aria-label="show sessions">
            <Icon name="expand" />
          </button>
          <span className="col-sep" />
          {PAGES.map((p) => (
            <button
              key={p.id}
              className={`btn-icon ghost nav-icon ${page === p.id ? 'on' : ''}`}
              onClick={() => onPage(p.id)}
              title={p.collapsedTitle}
              aria-label={p.label}
            >
              <Icon name={p.icon} />
              {!!badges[p.id] && <span className="nav-badge">{badges[p.id]}</span>}
            </button>
          ))}
          <span className="col-spacer" />
          <button className="btn-icon ghost" onClick={onHelp} title="Welcome guide and tour" aria-label="help">
            <Icon name="help" />
          </button>
        </div>
      </div>
    );
  }

  const all = sessions ?? [];
  const isPinned = new Set(prefs.pinned);
  const isHidden = new Set(prefs.hidden);
  const live = all.filter((s) => s.live && matchSession(s, q));
  const localLive = live.filter((s) => !s.machine);
  const hosts = peers?.devices.filter((d) => d.role === 'host') ?? [];
  const grouped = groupRecent(
    all.filter((s) => !s.live && matchSession(s, q)),
    prefs,
  );
  const rowProps = { now, onSelect, onMenu: openMenu };

  const menuItems = (s: SessionSummary): MenuItem[] => [
    { label: isPinned.has(s.id) ? 'Unpin' : 'Pin to the top', icon: 'pin', onClick: () => togglePin(s.id) },
    { label: isHidden.has(s.id) ? 'Unhide' : 'Hide from the list', icon: isHidden.has(s.id) ? 'unhide' : 'hide', onClick: () => toggleHidden(s.id) },
    { label: 'Open in Claude', icon: 'openExternal', onClick: () => void openInClaude(s.id) },
    {
      label: 'Copy session id',
      icon: 'copy',
      onClick: () => void navigator.clipboard.writeText(s.id).then(() => showToast('Session id copied')),
    },
    ...(s.cwd
      ? [
          {
            label: 'Copy folder path',
            icon: 'copy' as const,
            onClick: () => void navigator.clipboard.writeText(s.cwd!).then(() => showToast('Folder path copied')),
          },
        ]
      : []),
  ];

  return (
    <div className="sidebar" data-tour="sessions">
      <div className="sidebar-head">
        <div className="page-switch seg" data-tour="overview">
          {PAGES.filter((p) => p.group === 'switch').map((p) => (
            <button key={p.id} className={page === p.id ? 'on' : ''} data-testid={p.testId} onClick={() => onPage(p.id)} title={p.title}>
              <Icon name={p.icon} size="xs" />
              {p.label}
            </button>
          ))}
        </div>
        <button className="btn-icon ghost" onClick={onCollapse} title="Collapse the sidebar" aria-label="collapse sidebar">
          <Icon name="collapse" />
        </button>
      </div>
      <nav className="nav-list">
        {PAGES.filter((p) => p.group === 'nav').map((p) => (
          <button key={p.id} className={`nav-item ${page === p.id ? 'on' : ''}`} data-testid={p.testId} onClick={() => onPage(p.id)} title={p.title}>
            <Icon name={p.icon} />
            <span className="nl">{p.label}</span>
            {!!badges[p.id] && (
              <span className="nav-badge" data-testid={`badge-${p.id}`}>
                {badges[p.id]}
              </span>
            )}
          </button>
        ))}
        {peers?.sharing && (
          <button
            className="nav-item sharing-banner"
            data-testid="sidebar-sharing"
            onClick={() => onPage('devices')}
            title="This computer's sessions are visible to the computers you paired with (read-only). Click to manage."
          >
            <span className="mdot on" />
            <span className="nl">sharing with {sharingWith(peers)}</span>
          </button>
        )}
      </nav>
      <div className="sidebar-tools">
        <div className="field">
          <Icon name="search" size="xs" />
          <input placeholder="search sessions…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
          {q && (
            <button className="field-clear" aria-label="Clear search" title="Clear search" onClick={() => setQ('')}>
              <Icon name="close" size="xs" />
            </button>
          )}
        </div>
        <label className="follow" data-tour="follow" title="Jump to whichever session is working right now">
          <input type="checkbox" checked={follow} onChange={(e) => onFollow(e.target.checked)} />
          follow the active session
        </label>
        <label className="follow" title="Hide recent sessions; show live ones only" data-testid="active-only">
          <input type="checkbox" checked={activeOnly} onChange={(e) => onActiveOnly?.(e.target.checked)} />
          live sessions only
        </label>
      </div>
      <div className="session-list" ref={listRef}>
        {sessions === null ? (
          <div className="list-loading">
            <span className="loading">loading sessions…</span>
          </div>
        ) : hosts.length === 0 ? (
          <>
            <div className="group-label gl-live">
              <span>live</span>
              <span className="gl-n">{live.length}</span>
              <i className="gl-rule" />
            </div>
            {live.length === 0 && <div className="empty-note list-note">{q ? 'no live session matches' : 'no session active in the last 10 min'}</div>}
            {live.map((s) => (
              <Row key={s.id} s={s} sel={s.id === selected} {...rowProps} />
            ))}
          </>
        ) : (
          <>
            <div className="machine-group" data-testid="machine-group" data-machine="local">
              <div className="group-label machine-label">
                <span className="mdot on" />
                <span className="ml-name">{localMachineName()}</span>
                <span className="gl-n">{localLive.length} live</span>
                <i className="gl-rule" />
              </div>
              {localLive.length === 0 && <div className="empty-note list-note">no session active in the last 10 min</div>}
              {localLive.map((s) => (
                <Row key={s.id} s={s} sel={s.id === selected} {...rowProps} />
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
                    <span className="ml-name">{h.name}</span>
                    <span className="gl-n">{state}</span>
                    <i className="gl-rule" />
                  </div>
                  {rows.map((s) => (
                    <Row key={s.id} s={s} sel={s.id === selected} {...rowProps} />
                  ))}
                </div>
              );
            })}
          </>
        )}
        {sessions !== null && !activeOnly && (
          <>
            {grouped.pinned.length > 0 && (
              <>
                <div className="group-label pinned">
                  <Icon name="pin" size="xs" />
                  <span>pinned</span>
                  <span className="gl-n">{grouped.pinned.length}</span>
                  <i className="gl-rule" />
                </div>
                {grouped.pinned.map((s) => (
                  <Row key={s.id} s={s} sel={s.id === selected} {...rowProps} pinned />
                ))}
              </>
            )}
            <div className="group-label">
              <span>recent</span>
              <span className="gl-n">{grouped.groups.reduce((n, g) => n + g.sessions.length, 0)}</span>
              <i className="gl-rule" />
            </div>
            {grouped.groups.length === 0 && <div className="empty-note list-note">{q ? 'no recent session matches' : 'nothing yet'}</div>}
            {grouped.groups.map((g) => (
              <ProjectGroupView key={g.key} g={g} now={now} selected={selected} onSelect={onSelect} onMenu={openMenu} onToggle={() => toggleGroup(g.key)} />
            ))}
            {grouped.overflow > 0 && <div className="empty-note list-note">+{grouped.overflow} older · search to find them</div>}
            {grouped.hidden.length > 0 && (
              <>
                <button className="hidden-toggle ghost" onClick={() => setShowHidden(!showHidden)} data-testid="hidden-toggle">
                  <Icon name={showHidden ? 'chevronDown' : 'chevronRight'} size="xs" />
                  {grouped.hidden.length} hidden
                </button>
                {showHidden && grouped.hidden.map((s) => <Row key={s.id} s={s} sel={s.id === selected} {...rowProps} hidden />)}
              </>
            )}
          </>
        )}
        {activeOnly && <div className="empty-note list-note">recent sessions hidden · untick “live sessions only” to see them</div>}
      </div>
      <div className="sidebar-foot">
        <button className="ghost" data-tour="help" onClick={onHelp} title="Welcome guide and tour">
          <Icon name="help" size="xs" />
          help & tour
        </button>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.s)} onClose={closeMenu} />}
    </div>
  );
}
