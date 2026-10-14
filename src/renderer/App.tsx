import { useEffect, useState } from 'react';
import { Tour, Welcome } from './components/Onboarding';
import { SessionList } from './components/SessionList';
import { SettingsDialog } from './components/SettingsDialog';
import { useConfig, useHookServer, useInbox, useLiveState, useNow, useSelected, useSessions } from './hooks';
import { SidebarResizeHandle, usePanelLayout } from './layout';
import { useReplay } from './replay';
import { useActiveOnly } from './state/activeOnly';
import { useOnboarding } from './state/onboarding';
import { useOpenSettings } from './state/openSettings';
import { usePage } from './state/page';
import { useSessionUi } from './state/sessionUi';
import { PAGES } from './views/pages';

/** App shell: owns the app-level state, draws the sidebar and routes to the current page (see views/pages.tsx). */
export function App() {
  const sessions = useSessions();
  const selected = useSelected();
  const live = useLiveState();
  const config = useConfig();
  const hookSrv = useHookServer();
  const wallNow = useNow(1000);
  const replayApi = useReplay();
  const { replay, stop } = replayApi;
  const [showSettings, setShowSettings] = useOpenSettings();
  const [collapsed, setCollapsed] = useState(false);
  const [activeOnly, setActiveOnly] = useActiveOnly();
  const [page, setPage] = usePage();
  const ui = useSessionUi(selected);
  const inbox = useInbox();
  /** an agent to open once its session is the selected one (inbox "show") */
  const [pendingAgent, setPendingAgent] = useState<{ sessionId: string; agentId: string } | null>(null);
  const layoutApi = usePanelLayout();
  const { layout } = layoutApi;
  const {
    onboarding,
    setOnboarding,
    openWelcome,
    finish: finishOnboarding,
    startTour,
  } = useOnboarding(config, () => {
    // the tour points at the sidebar and the one-session page
    setCollapsed(false);
    setPage('session');
  });
  const openSession = (id: string) => {
    void window.api.select(id);
    setPage('session');
  };

  const showAgent = (id: string, agentId: string | null) => {
    openSession(id);
    setPendingAgent(agentId && agentId !== 'main' ? { sessionId: id, agentId } : null);
  };
  useEffect(() => {
    if (pendingAgent && selected === pendingAgent.sessionId && live?.id === selected) {
      if (live.agents[pendingAgent.agentId]) ui.setAgentSel(pendingAgent.agentId);
      setPendingAgent(null);
    }
  }, [selected, live, pendingAgent]);
  // the tray menu / notifications ask for a page
  useEffect(() => window.api.onNavigate((p) => PAGES.some((x) => x.id === p) && setPage(p)), []);

  // leaving the session ends replay
  useEffect(() => {
    if (replay && replay.sessionId !== selected) stop();
  }, [selected]);

  const view = replay ? replay.view : live && live.id === selected ? live : null;
  const now = replay ? replay.now : wallNow;
  const current = PAGES.find((p) => p.id === page) ?? PAGES[0];

  return (
    <div className={`app sidebar-${layout.sidebar.side}`}>
      <div className="sidebar-wrap" data-flip="sidebar" style={collapsed ? undefined : { width: layout.sidebar.width }}>
        <SessionList
          sessions={sessions}
          selected={selected}
          now={wallNow}
          follow={config?.followActive ?? true}
          onSelect={openSession}
          onFollow={(on) => void window.api.setFollow(on)}
          collapsed={collapsed}
          onCollapse={() => setCollapsed(!collapsed)}
          page={page}
          onPage={setPage}
          onHelp={openWelcome}
          activeOnly={activeOnly}
          onActiveOnly={setActiveOnly}
          badges={{ inbox: inbox?.count ?? 0 }}
        />
        {!collapsed && <SidebarResizeHandle api={layoutApi} />}
      </div>
      {current.render({
        selected,
        openSession,
        showAgent,
        setPage,
        openSettings: () => setShowSettings(true),
        openWelcome,
        activeOnly,
        session: view
          ? {
              view,
              summary: sessions.find((s) => s.id === selected),
              now,
              replay: replayApi,
              hookSrv,
              activeOnly,
              onActiveOnly: setActiveOnly,
              onSettings: () => setShowSettings(true),
              onLocal: () => setPage('local'),
              layoutApi,
              ui,
            }
          : null,
      })}
      {showSettings && config && (
        <SettingsDialog
          config={config}
          hookSrv={hookSrv}
          onClose={() => setShowSettings(false)}
          onWelcome={() => {
            setShowSettings(false);
            setOnboarding('welcome');
          }}
        />
      )}
      {onboarding === 'welcome' && (
        <Welcome
          onTour={startTour}
          onSkip={finishOnboarding}
          onOpenSettings={() => {
            setOnboarding('none');
            setShowSettings(true);
          }}
        />
      )}
      {onboarding === 'tour' && <Tour onDone={finishOnboarding} />}
    </div>
  );
}
