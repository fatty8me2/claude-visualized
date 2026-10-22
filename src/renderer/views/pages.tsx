import { useEffect, useState, type ReactNode } from 'react';
import { DevicesPage } from '../components/DevicesPage';
import { InboxPage } from '../components/InboxPage';
import { HistoryPage } from '../components/HistoryPage';
import { LocalModelsPage } from '../components/LocalModelsPage';
import { Overview } from '../components/Overview';
import { SessionView, type SessionViewProps } from './SessionView';
import { Icon, type IconName } from '../components/Icon';
import '../emptyStates.css';

/**
 * Page registry: the pages that fill the area next to the sidebar.
 *
 * To add a page, append ONE entry to PAGES below. The sidebar button (expanded and collapsed) and the routing in App.tsx are generated from it:
 *   { id: 'inbox', icon: '!', label: 'inbox', title: 'Needs your attention', collapsedTitle: 'Attention inbox', group: 'nav', render: (ctx) => <InboxPage onOpen={ctx.openSession} /> },
 * `group: 'switch'` puts the button in the "all sessions / one session" pair; `'nav'` gives it its own full-width button under that pair.
 * Entries are shown in array order. The chosen page id is remembered in localStorage (see state/page.ts); unknown ids fall back to DEFAULT_PAGE.
 */
export type PageId = string;

/** What App hands to every page. Add fields here when a new page needs app-level state. */
export interface PageContext {
  selected: string | null;
  openSession: (id: string) => void;
  /** select a session and, if given, open one of its agents */
  showAgent: (sessionId: string, agentId: string | null) => void;
  setPage: (id: PageId) => void;
  openSettings: () => void;
  openSetup: () => void;
  activeOnly: boolean;
  /** props for the one-session view; null while no session is loaded */
  session: SessionViewProps | null;
  /** whether any session exists; undefined until the first list arrives */
  haveSessions: boolean | undefined;
}

export interface PageDef {
  id: PageId;
  /** icon shown alone in the collapsed sidebar and before the label in the expanded one */
  icon: IconName;
  label: string;
  /** tooltip in the expanded sidebar */
  title: string;
  /** tooltip in the collapsed sidebar */
  collapsedTitle: string;
  group: 'switch' | 'nav';
  testId?: string;
  render: (ctx: PageContext) => ReactNode;
}

function EmptySession({ selected, known, onSetup }: { selected: string | null; known: boolean | undefined; onSetup: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!selected) return;
    const t = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(t);
  }, [selected]);
  // the first answers have not arrived yet: don't flash "no sessions" at someone who has hundreds
  if (known === undefined || (!selected && known)) {
    return (
      <div className="empty-state">
        <span className="loading">loading…</span>
      </div>
    );
  }
  if (selected) {
    return (
      <div className="empty-state">
        {slow ? (
          <div className="empty-card">
            <Icon name="warn" size="lg" />
            <div className="empty-title">This session could not be loaded</div>
            <div>Its transcript may have been moved or deleted. Pick another session from the list.</div>
          </div>
        ) : (
          <span className="loading">loading session…</span>
        )}
      </div>
    );
  }
  return (
    <div className="empty-state">
      <div className="glass-empty" data-testid="empty-state">
        <Icon name="session" size="lg" />
        <div className="ge-title">No Claude Code sessions yet</div>
        <p>
          Start one in the Claude desktop app (the Code tab), or run <code>claude</code> in a terminal and ask it something. It shows up here within a second or
          two, and this page fills in by itself.
        </p>
        <p className="ge-note">
          Optional: run <code>claude /login</code> once so the usage meters work.
        </p>
        <button className="primary ge-action" data-testid="empty-run-setup" onClick={onSetup}>
          run setup
        </button>
      </div>
    </div>
  );
}

export const PAGES: readonly PageDef[] = [
  {
    id: 'overview',
    icon: 'overview',
    label: 'all sessions',
    title: 'Every live session side by side',
    collapsedTitle: 'All sessions',
    group: 'switch',
    render: (ctx) => <Overview onOpen={ctx.openSession} onLocal={() => ctx.setPage('local')} activeOnly={ctx.activeOnly} />,
  },
  {
    id: 'session',
    icon: 'session',
    label: 'one session',
    title: 'One session in detail',
    collapsedTitle: 'One session',
    group: 'switch',
    render: (ctx) =>
      ctx.session ? <SessionView {...ctx.session} /> : <EmptySession selected={ctx.selected} known={ctx.haveSessions} onSetup={ctx.openSetup} />,
  },
  {
    id: 'inbox',
    icon: 'inbox',
    label: 'inbox',
    title: 'Everything that needs you, across all sessions',
    collapsedTitle: 'Attention inbox',
    group: 'nav',
    testId: 'nav-inbox',
    render: (ctx) => <InboxPage onShow={ctx.showAgent} />,
  },
  {
    id: 'local',
    icon: 'local',
    label: 'local models',
    title: 'Ollama, LM Studio and other local model servers',
    collapsedTitle: 'Local models (Ollama, LM Studio, ...)',
    group: 'nav',
    testId: 'nav-local',
    render: (ctx) => <LocalModelsPage onOpenSession={ctx.openSession} onSettings={ctx.openSettings} />,
  },
  {
    id: 'history',
    icon: 'history',
    label: 'history',
    title: 'Usage, cost and search across every past session',
    collapsedTitle: 'History and search',
    group: 'nav',
    testId: 'nav-history',
    render: (ctx) => <HistoryPage onOpenSession={ctx.openSession} />,
  },
  {
    id: 'devices',
    icon: 'devices',
    label: 'devices',
    title: 'Share with your other computers, or watch theirs',
    collapsedTitle: 'Devices (share / pair)',
    group: 'nav',
    testId: 'nav-devices',
    render: () => <DevicesPage />,
  },
];

export const DEFAULT_PAGE: PageId = 'session';

export const isPageId = (id: string): boolean => PAGES.some((p) => p.id === id);
