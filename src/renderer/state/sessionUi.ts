import { useEffect, useState } from 'react';

/** Per-session UI selections. They live at app level (they survive page switches) and are cleared whenever the selected session changes. */
export function useSessionUi(selected: string | null) {
  const [agentSel, setAgentSel] = useState<string | null>(null);
  const [logAgent, setLogAgent] = useState<string | null>(null);
  const [hlAgents, setHlAgents] = useState<Set<string> | undefined>(undefined);
  const [hoverAgent, setHoverAgent] = useState<string | null>(null);
  const [editingLayout, setEditingLayout] = useState(false);
  useEffect(() => {
    setAgentSel(null);
    setLogAgent(null);
    setHlAgents(undefined);
    setHoverAgent(null);
  }, [selected]);
  return { agentSel, setAgentSel, logAgent, setLogAgent, hlAgents, setHlAgents, hoverAgent, setHoverAgent, editingLayout, setEditingLayout };
}

export type SessionUi = ReturnType<typeof useSessionUi>;
