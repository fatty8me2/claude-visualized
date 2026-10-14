import { useState } from 'react';
import type { HookServerStatusView } from '@core/api';
import { modelFamily, modelLabel } from '@core/summarize';
import type { SessionSummary, SessionView as CoreSessionView } from '@core/state';
import { AgentDrawer } from '../components/AgentDrawer';
import { LocalChip, LocalTag } from '../components/LocalBits';
import { LogPanel } from '../components/LogPanel';
import { ModePanel } from '../components/ModePanel';
import { PlanRail, PlanToggle, usePlanModel, usePlanRailPrefs } from '../components/PlanRail';
import { StatusBar } from '../components/StatusBar';
import { UsageMeters } from '../components/UsageMeters';
import { LayoutToolbar, PanelGrid, type LayoutApi } from '../layout';
import type { useReplay } from '../replay';
import type { SessionUi } from '../state/sessionUi';
import { clock } from '../util';
import { GRAPH_VIEWS } from './graphViews';

const FAMILY_ROLE: Record<string, string> = { opus: 'plan / main', sonnet: 'build', haiku: 'search', fable: 'agents', local: 'local model', other: 'other' };

function Legend({ view }: { view: CoreSessionView }) {
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

export interface SessionViewProps {
  view: CoreSessionView;
  summary: SessionSummary | undefined;
  /** replay clock when replaying, wall clock otherwise */
  now: number;
  replay: ReturnType<typeof useReplay>;
  hookSrv: HookServerStatusView | null;
  activeOnly: boolean;
  onActiveOnly: (on: boolean) => void;
  onSettings: () => void;
  onLocal: () => void;
  layoutApi: LayoutApi;
  ui: SessionUi;
}

/** The one-session page: topbar, model legend, replay bar, the panel grid (mode / graph / log) and the status bar. */
export function SessionView({
  view,
  summary,
  now,
  replay: replayApi,
  hookSrv,
  activeOnly,
  onActiveOnly,
  onSettings,
  onLocal,
  layoutApi,
  ui,
}: SessionViewProps) {
  const { replay, start, stop, goto, setPlaying, setSpeed } = replayApi;
  const { layout } = layoutApi;
  const { agentSel, setAgentSel, logAgent, setLogAgent, hlAgents, setHlAgents, hoverAgent, setHoverAgent, editingLayout, setEditingLayout } = ui;
  const planPrefs = usePlanRailPrefs();
  const plan = usePlanModel(view);
  const [graphViewId, setGraphViewId] = useState(GRAPH_VIEWS[0].id);
  const graphView = GRAPH_VIEWS.find((g) => g.id === graphViewId) ?? GRAPH_VIEWS[0];

  return (
    <div className="view">
      <div className="topbar">
        <div className="title">
          {view.title ?? 'untitled session'} <span className="proj">· {summary?.project ?? view.cwd?.split(/[\\/]/).pop() ?? ''}</span>
        </div>
        <UsageMeters />
        <LocalChip onOpen={onLocal} />
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
          <button data-tour="hooks" onClick={onSettings} title="Hooks and settings">
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
                {GRAPH_VIEWS.length > 1 && (
                  <div className="graph-views">
                    {GRAPH_VIEWS.map((g) => (
                      <button key={g.id} className={g.id === graphView.id ? 'on' : ''} onClick={() => setGraphViewId(g.id)}>
                        {g.label}
                      </button>
                    ))}
                  </div>
                )}
                {graphView.render({
                  view,
                  now,
                  selectedAgent: agentSel,
                  onSelectAgent: setAgentSel,
                  showFinished: !activeOnly,
                  onToggleFinished: () => onActiveOnly(!activeOnly),
                  highlight: hlAgents,
                  onHoverAgent: plan ? setHoverAgent : undefined,
                  extraTools: plan ? <PlanToggle plan={plan} prefs={planPrefs} /> : undefined,
                })}
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
  );
}
