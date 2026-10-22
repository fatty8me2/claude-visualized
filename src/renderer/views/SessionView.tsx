import { useMemo, useState } from 'react';
import type { HookServerStatusView } from '@core/api';
import { modelFamily, modelLabel } from '@core/summarize';
import type { SessionSummary, SessionView as CoreSessionView } from '@core/state';
import { AgentDrawer } from '../components/AgentDrawer';
import { LocalTag } from '../components/LocalBits';
import { LogPanel } from '../components/LogPanel';
import { ModePanel } from '../components/ModePanel';
import { PlanRail, PlanToggle, usePlanModel, usePlanRailPrefs } from '../components/PlanRail';
import { StatusBar } from '../components/StatusBar';
import { Icon } from '../components/Icon';
import { useGraphPrefs } from '../state/graphPrefs';
import { LayoutToolbar, PanelGrid, type LayoutApi } from '../layout';
import type { useReplay } from '../replay';
import type { SessionUi } from '../state/sessionUi';
import { clock } from '../util';
import { MachineChip } from '../components/MachineChip';
import { openInClaude } from '../state/toast';
import { eventIndexAt } from '@core/timeline';
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
  layoutApi: LayoutApi;
  ui: SessionUi;
  /** title of the newly selected session while it loads (this view still shows the previous one); null when current */
  loading: string | null;
}

/** The one-session page: topbar, model legend, replay bar, the panel grid (mode / graph / log) and the status bar. */
export function SessionView({ view, summary, now, replay: replayApi, hookSrv, layoutApi, ui, loading }: SessionViewProps) {
  const { replay, start, stop, goto, setPlaying, setSpeed } = replayApi;
  const { layout } = layoutApi;
  const { agentSel, setAgentSel, logAgent, setLogAgent, hlAgents, setHlAgents, hoverAgent, setHoverAgent, editingLayout, setEditingLayout } = ui;
  const planPrefs = usePlanRailPrefs();
  const plan = usePlanModel(view);
  const [graphViewId, setGraphViewId] = useState(GRAPH_VIEWS[0].id);
  const [graphPrefs, setGraphPrefs] = useGraphPrefs();
  const eventTimes = useMemo(() => replay?.events.map((e) => e.ts), [replay?.events]);
  const graphView = GRAPH_VIEWS.find((g) => g.id === graphViewId) ?? GRAPH_VIEWS[0];

  return (
    <div className="view">
      <div className="topbar">
        <div className="title">
          {view.machine && (
            <>
              <MachineChip machine={view.machine} offline={summary?.offlineSince != null} />{' '}
            </>
          )}
          <span className="tt">{view.title ?? 'untitled session'}</span>
          <span className="proj">
            {summary?.project ?? view.cwd?.split(/[\\/]/).pop() ?? ''}
            {view.gitBranch ? (
              <>
                {' '}
                <Icon name="branch" size="xs" /> {view.gitBranch}
              </>
            ) : null}
          </span>
        </div>
        <div className="actions">
          <button
            data-tour="open-in-claude"
            data-testid="open-in-claude"
            onClick={() => void openInClaude(view.id)}
            title={view.machine ? `This session is running on ${view.machine}` : 'Open this session in the Claude desktop app'}
          >
            <Icon name="openExternal" size="xs" />
            open in Claude
          </button>
          {replay ? (
            <button className="on" onClick={stop}>
              <Icon name="live" size="xs" />
              back to live
            </button>
          ) : view.machine ? null : (
            <button onClick={() => void start(view.id)} title="Replay this session from the start">
              <Icon name="replay" size="xs" />
              replay
            </button>
          )}
          <button
            className={editingLayout ? 'on' : ''}
            onClick={() => setEditingLayout(!editingLayout)}
            title="Rearrange and resize the panels"
            data-testid="layout-toggle"
          >
            <Icon name="layout" size="xs" />
            layout
          </button>
        </div>
      </div>
      {loading && (
        <div className="loading-strip" data-testid="loading-strip" aria-busy>
          <span className="loading">loading {loading}…</span>
        </div>
      )}
      {editingLayout && <LayoutToolbar api={layoutApi} onDone={() => setEditingLayout(false)} />}
      {!layout.hidden.legend && (
        <div data-flip="legend">
          <Legend view={view} />
        </div>
      )}
      {replay && (
        <div className="replaybar">
          <button
            className="btn-icon"
            onClick={() => setPlaying(!replay.playing)}
            aria-label={replay.playing ? 'pause' : 'play'}
            title={replay.playing ? 'Pause' : 'Play'}
          >
            <Icon name={replay.playing ? 'pause' : 'play'} />
          </button>
          <div className="seg">
            {[1, 8, 32, 128].map((sp) => (
              <button key={sp} className={replay.speed === sp ? 'on' : ''} onClick={() => setSpeed(sp)} title={`${sp}× speed`}>
                {sp}×
              </button>
            ))}
          </div>
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
          mode: <ModePanel view={view} now={now} hookSrv={hookSrv} onSelectAgent={setAgentSel} />,
          graph: (
            <div className={`graph-host ${plan && planPrefs.prefs.open ? `plan-${planPrefs.prefs.side}` : ''}`}>
              <div className="graph-main">
                {GRAPH_VIEWS.length > 1 && (
                  <div className="graph-views">
                    <div className="seg">
                      {GRAPH_VIEWS.map((g) => (
                        <button key={g.id} className={g.id === graphView.id ? 'on' : ''} onClick={() => setGraphViewId(g.id)}>
                          <Icon name={g.icon} size="xs" />
                          {g.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {graphView.render({
                  view,
                  now,
                  selectedAgent: agentSel,
                  onSelectAgent: setAgentSel,
                  showFinished: !graphPrefs.hideFinished,
                  onToggleFinished: () => setGraphPrefs({ hideFinished: !graphPrefs.hideFinished }),
                  highlight: hlAgents,
                  onHoverAgent: plan ? setHoverAgent : undefined,
                  replaying: !!replay,
                  onSeekTime: eventTimes ? (ts) => goto(eventIndexAt(eventTimes, ts)) : undefined,
                  extraTools: plan ? <PlanToggle plan={plan} prefs={planPrefs} /> : undefined,
                })}
                {agentSel && (
                  <AgentDrawer
                    view={view}
                    id={agentSel}
                    now={now}
                    onClose={() => setAgentSel(null)}
                    onFilterLog={setLogAgent}
                    onSelect={setAgentSel}
                    onShowInTimeline={
                      GRAPH_VIEWS.some((g) => g.id === 'timeline') && graphView.id !== 'timeline' ? () => setGraphViewId('timeline') : undefined
                    }
                  />
                )}
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
