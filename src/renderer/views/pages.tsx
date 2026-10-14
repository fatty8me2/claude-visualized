import type { ReactNode } from 'react';
import { InboxPage } from '../components/InboxPage';
import { LocalModelsPage } from '../components/LocalModelsPage';
import { Overview } from '../components/Overview';
import { SessionView, type SessionViewProps } from './SessionView';

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
  openWelcome: () => void;
  activeOnly: boolean;
  /** props for the one-session view; null while no session is loaded */
  session: SessionViewProps | null;
}

export interface PageDef {
  id: PageId;
  /** glyph shown alone in the collapsed sidebar and before the label in the expanded one */
  icon: string;
  label: string;
  /** tooltip in the expanded sidebar */
  title: string;
  /** tooltip in the collapsed sidebar */
  collapsedTitle: string;
  group: 'switch' | 'nav';
  testId?: string;
  render: (ctx: PageContext) => ReactNode;
}

function EmptySession({ selected, onWelcome }: { selected: string | null; onWelcome: () => void }) {
  return (
    <div className="empty">
      {selected ? (
        <div>loading session…</div>
      ) : (
        <div className="getting-started" data-testid="empty-state">
          <div className="gs-title">No Claude Code sessions found yet</div>
          <ol>
            <li>
              Install Claude Code: the <b>Code</b> tab in the Claude desktop app, or the <code>claude</code> command in a terminal.
            </li>
            <li>Start a session and ask Claude something. It will show up here within a second or two, and this page fills in by itself.</li>
            <li>
              Optional: run <code>claude /login</code> once so the usage meters work.
            </li>
          </ol>
          <button className="primary" onClick={onWelcome}>
            open the welcome guide
          </button>
        </div>
      )}
    </div>
  );
}

export const PAGES: readonly PageDef[] = [
  {
    id: 'overview',
    icon: '▦',
    label: 'all sessions',
    title: 'Every live session side by side',
    collapsedTitle: 'All sessions',
    group: 'switch',
    render: (ctx) => <Overview onOpen={ctx.openSession} onLocal={() => ctx.setPage('local')} activeOnly={ctx.activeOnly} />,
  },
  {
    id: 'session',
    icon: '◉',
    label: 'one session',
    title: 'One session in detail',
    collapsedTitle: 'One session',
    group: 'switch',
    render: (ctx) => (ctx.session ? <SessionView {...ctx.session} /> : <EmptySession selected={ctx.selected} onWelcome={ctx.openWelcome} />),
  },
  {
    id: 'inbox',
    icon: '!',
    label: 'inbox',
    title: 'Everything that needs you, across all sessions',
    collapsedTitle: 'Attention inbox',
    group: 'nav',
    testId: 'nav-inbox',
    render: (ctx) => <InboxPage onShow={ctx.showAgent} />,
  },
  {
    id: 'local',
    icon: '⌂',
    label: 'local models',
    title: 'Ollama, LM Studio and other local model servers',
    collapsedTitle: 'Local models (Ollama, LM Studio, ...)',
    group: 'nav',
    testId: 'nav-local',
    render: (ctx) => <LocalModelsPage onOpenSession={ctx.openSession} onSettings={ctx.openSettings} />,
  },
];

export const DEFAULT_PAGE: PageId = 'session';

export const isPageId = (id: string): boolean => PAGES.some((p) => p.id === id);
