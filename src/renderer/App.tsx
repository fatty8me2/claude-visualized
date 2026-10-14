import { useEffect, useRef, useState } from 'react';
import { ONBOARDING_VERSION, shouldShowOnboarding } from '@core/onboarding';
import { modelFamily, modelLabel } from '@core/summarize';
import { LocalChip, LocalTag } from './components/LocalBits';
import { LocalModelsPage } from './components/LocalModelsPage';
import type { SessionView } from '@core/state';
import { AgentDrawer } from './components/AgentDrawer';
import { AgentGraph } from './components/AgentGraph';
import { Tour, Welcome } from './components/Onboarding';
import { LogPanel } from './components/LogPanel';
import { ModePanel } from './components/ModePanel';
import { PlanRail, PlanToggle, usePlanModel, usePlanRailPrefs } from './components/PlanRail';
import { Overview } from './components/Overview';
import { SessionList, type Page } from './components/SessionList';
import { SettingsDialog } from './components/SettingsDialog';
import { StatusBar } from './components/StatusBar';
import { UsageMeters } from './components/UsageMeters';
import { useConfig, useHookServer, useLiveState, useNow, useSelected, useSessions } from './hooks';
import { useReplay } from './replay';
import { LayoutToolbar, PanelGrid, SidebarResizeHandle, usePanelLayout } from './layout';
import { clock } from './util';

const FAMILY_ROLE: Record<string, string> = { opus: 'plan / main', sonnet: 'build', haiku: 'search', fable: 'agents', local: 'local model', other: 'other' };

function Legend({ view }: { view: SessionView }) {
  // one entry per Claude family, but one per model for local models (qwen and llama are different things)
  const groups = new Map<string, { fam: string; model: string; count: number }>();
  for (const a of Object.values(view.agents)) {
    if (!a.model) continue;
    const fam = modelFamily(a.model);
    const key = fam === 'local' ? `local:${a.model}` : fam;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { fam, model: a.model, count: 1 });
  }
  if (groups.size === 0) return <div className="legend">waiting for the first model response…</div>;
  return (
    <div className="legend">
      {[...groups.entries()].map(([key, g]) => (
        <span key={key} className={`fam-${g.fam}`} data-testid="legend-item">
          <span className="sw" />
          {modelLabel(g.model).toLowerCase()} · {g.count > 1 ? `${g.count} agents` : FAMILY_ROLE[g.fam]}
          {g.fam === 'local' && (
            <>
              {' '}
              <LocalTag />
            </>
          )}
        </span>
      ))}
    </div>
  );
}

export function App() {
  const sessions = useSessions();
  const selected = useSelected();
  const live = useLiveState();
  const config = useConfig();
  const hookSrv = useHookServer();
  const wallNow = useNow(1000);
  const { replay, start, stop, goto, setPlaying, setSpeed } = useReplay();
  const [showSettings, setShowSettings] = useState(false);
  const [onboarding, setOnboarding] = useState<'none' | 'welcome' | 'tour'>('none');
  const onboardingChecked = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const [agentSel, setAgentSel] = useState<string | null>(null);
  const [logAgent, setLogAgent] = useState<string | null>(null);
  // "active only": hide recent sessions and finished agents everywhere (remembered per machine)
  const [activeOnly, setActiveOnlyState] = useState(() => {
    try {
      return localStorage.getItem('cvis.activeOnly') === '1';
    } catch {
      return false;
    }
  });
  const setActiveOnly = (on: boolean) => {
    setActiveOnlyState(on);
    try {
      localStorage.setItem('cvis.activeOnly', on ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  };
  const showFinished = !activeOnly;
  const [hlAgents, setHlAgents] = useState<Set<string> | undefined>(undefined);
  const [hoverAgent, setHoverAgent] = useState<string | null>(null);
  const planPrefs = usePlanRailPrefs();
  const layoutApi = usePanelLayout();
  const { layout } = layoutApi;
  const [editingLayout, setEditingLayout] = useState(false);
  const [page, setPageState] = useState<Page>(() => {
    try {
      const p = localStorage.getItem('cvis.page');
      return p === 'overview' || p === 'local' ? p : 'session';
    } catch {
      return 'session';
    }
  });
  const setPage = (p: Page) => {
    setPageState(p);
    try {
      localStorage.setItem('cvis.page', p);
    } catch {
      /* storage unavailable */
    }
  };
  const openSession = (id: string) => {
    void window.api.select(id);
    setPage('session');
  };

  // tray "Open settings": either pushed, or waiting for us if the window was still loading
  useEffect(() => {
    void window.api.takeOpenSettings().then((pending) => pending && setShowSettings(true));
    return window.api.onOpenSettings(() => setShowSettings(true));
  }, []);
  // first launch (or a newer tour version): show the welcome screen once per app start
  useEffect(() => {
    if (!config || onboardingChecked.current) return;
    onboardingChecked.current = true;
    void window.api.setupStatus().then((s) => {
      if (shouldShowOnboarding(config, ONBOARDING_VERSION, s.skipOnboarding)) setOnboarding('welcome');
    });
  }, [config]);
  // tray menu: "Show welcome & tour"
  useEffect(() => window.api.onShowOnboarding(() => setOnboarding('welcome')), []);
  const finishOnboarding = () => {
    setOnboarding('none');
    void window.api.setConfig({ onboardingDone: true, onboardingVersion: ONBOARDING_VERSION });
  };
  const startTour = () => {
    // the tour points at the sidebar and the one-session page
    setCollapsed(false);
    setPage('session');
    setOnboarding('tour');
  };

  // leaving the session ends replay and clears per-session selections
  useEffect(() => {
    if (replay && replay.sessionId !== selected) stop();
    setAgentSel(null);
    setLogAgent(null);
    setHlAgents(undefined);
    setHoverAgent(null);
  }, [selected]);

  const view = replay ? replay.view : live && live.id === selected ? live : null;
  const now = replay ? replay.now : wallNow;
  const summary = sessions.find((s) => s.id === selected);
  const plan = usePlanModel(view);

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
          onHelp={() => setOnboarding('welcome')}
          activeOnly={activeOnly}
          onActiveOnly={setActiveOnly}
        />
        {!collapsed && <SidebarResizeHandle api={layoutApi} />}
      </div>
      {page === 'local' ? (
        <LocalModelsPage onOpenSession={openSession} onSettings={() => setShowSettings(true)} />
      ) : page === 'overview' ? (
        <Overview onOpen={openSession} onLocal={() => setPage('local')} activeOnly={activeOnly} />
      ) : view ? (
        <div className="view">
          <div className="topbar">
            <div className="title">
              {view.title ?? 'untitled session'} <span className="proj">· {summary?.project ?? view.cwd?.split(/[\\/]/).pop() ?? ''}</span>
            </div>
            <UsageMeters />
            <LocalChip onOpen={() => setPage('local')} />
            <div className="actions">
              <button data-tour="open-in-claude" onClick={() => void window.api.openInClaude(view.id)} title="Open this session in the Claude desktop app">
                ↗ open in Claude
              </button>
              {replay ? (
                <button className="on" onClick={stop}>
                  ■ back to live
                </button>
              ) : (
                <button onClick={() => void start(view.id)} title="Replay this session from the start">
                  ⟲ replay
                </button>
              )}
              <button data-tour="mini" onClick={() => void window.api.toggleMini()} title="Small always-on-top window">
                ▣ mini
              </button>
              <button data-tour="hooks" onClick={() => setShowSettings(true)} title="Hooks and settings">
                ⚙ hooks
              </button>
              <button
                className={editingLayout ? 'on' : ''}
                onClick={() => setEditingLayout(!editingLayout)}
                title="Rearrange and resize the panels"
                data-testid="layout-toggle"
              >
                ⧉ layout
              </button>
            </div>
          </div>
          {editingLayout && <LayoutToolbar api={layoutApi} onDone={() => setEditingLayout(false)} />}
          {!layout.hidden.legend && (
            <div data-flip="legend">
              <Legend view={view} />
            </div>
          )}
          {replay && (
            <div className="replaybar">
              <button onClick={() => setPlaying(!replay.playing)}>{replay.playing ? '❚❚' : '▶'}</button>
              {[1, 8, 32, 128].map((sp) => (
                <button key={sp} className={replay.speed === sp ? 'on' : ''} onClick={() => setSpeed(sp)}>
                  {sp}×
                </button>
              ))}
              <input type="range" min={0} max={replay.events.length} value={replay.idx} onChange={(e) => goto(Number(e.target.value))} />
              <span className="rt">
                {clock(replay.now)} · {replay.idx}/{replay.events.length}
              </span>
            </div>
          )}
          <PanelGrid
            api={layoutApi}
            editing={editingLayout}
            panels={{
              mode: <ModePanel view={view} now={now} hookSrv={hookSrv} />,
              graph: (
                <div className={`graph-host ${plan && planPrefs.prefs.open ? `plan-${planPrefs.prefs.side}` : ''}`}>
                  <div className="graph-main">
                    <AgentGraph
                      view={view}
                      now={now}
                      selectedAgent={agentSel}
                      onSelect={setAgentSel}
                      showFinished={showFinished}
                      onToggleFinished={() => setActiveOnly(!activeOnly)}
                      highlight={hlAgents}
                      onHoverAgent={plan ? setHoverAgent : undefined}
                      extraTools={plan ? <PlanToggle plan={plan} prefs={planPrefs} /> : undefined}
                    />
                    {agentSel && <AgentDrawer view={view} id={agentSel} now={now} onClose={() => setAgentSel(null)} onFilterLog={setLogAgent} />}
                  </div>
                  {plan && planPrefs.prefs.open && (
                    <PlanRail
                      view={view}
                      plan={plan}
                      prefs={planPrefs}
                      hoverAgent={hoverAgent}
                      onHighlight={setHlAgents}
                      onSelect={setAgentSel}
                      onFilterLog={setLogAgent}
                    />
                  )}
                </div>
              ),
              log: <LogPanel view={view} agentFilter={logAgent} onAgentFilter={setLogAgent} />,
            }}
          />
          {!layout.hidden.status && (
            <div data-flip="status">
              <StatusBar view={view} now={now} hookSrv={hookSrv} replaying={!!replay} />
            </div>
          )}
        </div>
      ) : (
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
              <button className="primary" onClick={() => setOnboarding('welcome')}>
                open the welcome guide
              </button>
            </div>
          )}
        </div>
      )}
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
