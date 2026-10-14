import { useEffect, useState } from 'react';
import { modelFamily, modelLabel } from '@core/summarize';
import type { SessionView } from '@core/state';
import { AgentDrawer } from './components/AgentDrawer';
import { AgentGraph } from './components/AgentGraph';
import { LogPanel } from './components/LogPanel';
import { ModePanel } from './components/ModePanel';
import { Overview } from './components/Overview';
import { SessionList, type Page } from './components/SessionList';
import { SettingsDialog } from './components/SettingsDialog';
import { StatusBar } from './components/StatusBar';
import { UsageMeters } from './components/UsageMeters';
import { useConfig, useHookServer, useLiveState, useNow, useSelected, useSessions } from './hooks';
import { useReplay } from './replay';
import { clock } from './util';

const FAMILY_ROLE: Record<string, string> = { opus: 'plan / main', sonnet: 'build', haiku: 'search', fable: 'agents', other: 'other' };

function Legend({ view }: { view: SessionView }) {
  const models = new Map<string, string>();
  for (const a of Object.values(view.agents)) if (a.model) models.set(modelFamily(a.model), a.model);
  if (models.size === 0) return <div className="legend">waiting for the first model response…</div>;
  return (
    <div className="legend">
      {[...models.entries()].map(([fam, model]) => {
        const count = Object.values(view.agents).filter((a) => a.model && modelFamily(a.model) === fam).length;
        return (
          <span key={fam} className={`fam-${fam}`}>
            <span className="sw" />
            {modelLabel(model).toLowerCase()} · {count > 1 ? `${count} agents` : FAMILY_ROLE[fam]}
          </span>
        );
      })}
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
  const [collapsed, setCollapsed] = useState(false);
  const [agentSel, setAgentSel] = useState<string | null>(null);
  const [logAgent, setLogAgent] = useState<string | null>(null);
  const [showFinished, setShowFinished] = useState(true);
  const [page, setPageState] = useState<Page>(() => {
    try {
      return localStorage.getItem('cvis.page') === 'overview' ? 'overview' : 'session';
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
    if (config?.openInClaudeOnClick) void window.api.openInClaude(id);
  };

  // leaving the session ends replay and clears per-session selections
  useEffect(() => {
    if (replay && replay.sessionId !== selected) stop();
    setAgentSel(null);
    setLogAgent(null);
  }, [selected]);

  const view = replay ? replay.view : live && live.id === selected ? live : null;
  const now = replay ? replay.now : wallNow;
  const summary = sessions.find((s) => s.id === selected);

  return (
    <div className="app">
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
      />
      {page === 'overview' ? (
        <Overview onOpen={openSession} />
      ) : view ? (
        <div className="view">
          <div className="topbar">
            <div className="title">
              {view.title ?? 'untitled session'} <span className="proj">· {summary?.project ?? view.cwd?.split(/[\\/]/).pop() ?? ''}</span>
            </div>
            <UsageMeters />
            <div className="actions">
              <button onClick={() => void window.api.openInClaude(view.id)} title="Open this session in the Claude desktop app">
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
              <button onClick={() => void window.api.toggleMini()} title="Small always-on-top window">
                ▣ mini
              </button>
              <button onClick={() => setShowSettings(true)} title="Hooks and settings">
                ⚙ hooks
              </button>
            </div>
          </div>
          <Legend view={view} />
          <div className="body">
            <ModePanel view={view} now={now} hookSrv={hookSrv} />
            <div style={{ position: 'relative', minWidth: 0, minHeight: 0, display: 'grid' }}>
              <AgentGraph view={view} now={now} selectedAgent={agentSel} onSelect={setAgentSel} showFinished={showFinished} onToggleFinished={() => setShowFinished(!showFinished)} />
              {agentSel && <AgentDrawer view={view} id={agentSel} now={now} onClose={() => setAgentSel(null)} onFilterLog={setLogAgent} />}
            </div>
          </div>
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
          <LogPanel view={view} agentFilter={logAgent} onAgentFilter={setLogAgent} />
          <StatusBar view={view} now={now} hookSrv={hookSrv} replaying={!!replay} />
        </div>
      ) : (
        <div className="empty">
          {selected ? (
            <div>loading session…</div>
          ) : (
            <div>
              <div style={{ fontSize: 15, color: 'var(--text)', marginBottom: 8 }}>No Claude Code sessions found yet</div>
              <div>Start a session in the Claude desktop app or the CLI and it will appear here.</div>
            </div>
          )}
        </div>
      )}
      {showSettings && config && <SettingsDialog config={config} hookSrv={hookSrv} onClose={() => setShowSettings(false)} />}
    </div>
  );
}
