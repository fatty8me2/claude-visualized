// Unified event model. Both transcript lines and hook payloads normalize into AgentEvent[],
// and a single pure reducer folds them into SessionState.

export type Source = 'transcript' | 'hook';

/** agentId null = the main agent of the session. */
export interface AgentRef {
  sessionId: string;
  agentId: string | null;
}

export interface UsageNumbers {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TodoInput {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed' | string;
}

export interface SpawnInfo {
  childId: string;
  /** tool_use id of the Agent call that spawned this child (from meta.json); absent for workflow agents / hook-only spawns */
  parentToolUseId?: string;
  agentType?: string;
  description?: string;
  depth?: number;
  background?: boolean;
  /** workflow run id when the agent lives under subagents/workflows/<runId>/ */
  workflowRunId?: string;
  workflowPhase?: string;
}

type Base = { ts: number; src: Source; ref: AgentRef };

export type AgentEvent = Base &
  (
    | { k: 'session.meta'; cwd?: string; version?: string; entrypoint?: string; gitBranch?: string }
    | { k: 'title'; title: string; kind: 'custom' | 'ai' | 'prompt' }
    | { k: 'mode'; mode: string }
    | { k: 'model'; model: string; effort?: string }
    | { k: 'prompt'; text: string }
    | { k: 'tool.start'; toolUseId: string; name: string; input: unknown }
    | { k: 'tool.end'; toolUseId: string; ok: boolean; result?: unknown; durationMs?: number; name?: string }
    | { k: 'usage'; msgId: string; usage: UsageNumbers }
    | { k: 'agent.spawn'; spawn: SpawnInfo }
    | { k: 'agent.stop'; childId: string; status: 'done' | 'error'; detail?: string; /** event time is only a file mtime: end at the agent's last activity instead */ atLastActivity?: boolean }
    | { k: 'task.notification'; taskId: string; status: string; summary?: string }
    | { k: 'todos.replace'; items: TodoInput[] }
    | { k: 'text'; role: 'assistant'; preview: string; endTurn: boolean }
    | { k: 'turn.end' }
    | { k: 'cost'; totalCostUSD: number; byModel: Record<string, number> }
    | { k: 'compact'; detail?: string }
    | { k: 'attention'; kind: 'permission' | 'notification' | 'error'; detail: string }
    | { k: 'session.end'; detail?: string }
    | { k: 'unknown'; raw: string }
  );

export type EventKind = AgentEvent['k'];
