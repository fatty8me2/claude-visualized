import type { ReactNode } from 'react';
import type { SessionView } from '@core/state';
import { AgentGraph } from '../components/AgentGraph';
import { Timeline } from '../components/Timeline';

/**
 * Registry of the views that can fill the session page's "graph" panel (the agent graph, and later e.g. a timeline).
 *
 * To add a view, append ONE entry to GRAPH_VIEWS: an id, a tab label and a render function. As soon as there is more than one entry the
 * session page shows a small tab switcher above the panel; with a single entry nothing changes visually.
 */
export interface GraphViewContext {
  view: SessionView;
  now: number;
  selectedAgent: string | null;
  onSelectAgent: (id: string | null) => void;
  showFinished: boolean;
  onToggleFinished: () => void;
  highlight: Set<string> | undefined;
  onHoverAgent?: (id: string | null) => void;
  /** extra buttons for the view's toolbar (e.g. the plan toggle) */
  extraTools?: ReactNode;
  /** true while replaying */
  replaying?: boolean;
  /** seek the replay to a wall-clock time; undefined when not replaying */
  onSeekTime?: (ts: number) => void;
}

export interface GraphViewDef {
  id: string;
  label: string;
  render: (ctx: GraphViewContext) => ReactNode;
}

export const GRAPH_VIEWS: readonly GraphViewDef[] = [
  {
    id: 'graph',
    label: 'graph',
    render: (c) => (
      <AgentGraph
        view={c.view}
        now={c.now}
        selectedAgent={c.selectedAgent}
        onSelect={c.onSelectAgent}
        showFinished={c.showFinished}
        onToggleFinished={c.onToggleFinished}
        highlight={c.highlight}
        onHoverAgent={c.onHoverAgent}
        extraTools={c.extraTools}
      />
    ),
  },
  {
    id: 'timeline',
    label: 'timeline',
    render: (c) => (
      <Timeline
        view={c.view}
        now={c.now}
        selectedAgent={c.selectedAgent}
        onSelect={c.onSelectAgent}
        highlight={c.highlight}
        onHoverAgent={c.onHoverAgent}
        replaying={c.replaying}
        onSeekTime={c.onSeekTime}
      />
    ),
  },
];
