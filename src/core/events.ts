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

/**
 * A shipping step a shell command performs: a git commit or push, opening a pull request, building or uploading a
 * release that is not public yet (a draft, `npm run release`), or publishing one (what update checks and installs see).
 */
export type ShipKind = 'commit' | 'push' | 'pr' | 'release' | 'publish';

/** A change to the main agent's task list that only makes sense against the current list (Claude desktop's task list tool). */
export interface TodoOp {
  /** a whole new list */
  replace?: TodoInput[];
  /** complete the step in progress and start the next pending one */
  advance?: boolean;
  /** 1-based positions to mark completed */
  done?: number[];
  /** 1-based position to mark in progress */
  start?: number;
  /** the turn was wrapped up: every step left counts as completed */
  finish?: boolean;
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
    | {
        k: 'tool.start';
        toolUseId: string;
        name: string;
        input: unknown;
        /** shipping steps the call's shell command performs, read from the full command (the input above is clipped) */
        ship?: ShipKind[];
        /** task-list change carried by the call (Claude desktop's update_plan / wrap_up), applied once per call */
        todo?: TodoOp;
      }
    | {
        k: 'tool.end';
        toolUseId: string;
        ok: boolean;
        result?: unknown;
        durationMs?: number;
        name?: string;
        /** first ~300 chars of a failed call's output */ error?: string;
      }
    | { k: 'usage'; msgId: string; usage: UsageNumbers }
    | { k: 'agent.spawn'; spawn: SpawnInfo }
    | {
        k: 'agent.stop';
        childId: string;
        status: 'done' | 'error';
        detail?: string;
        /** event time is only a file mtime: end at the agent's last activity instead */ atLastActivity?: boolean;
      }
    | { k: 'task.notification'; taskId: string; status: string; summary?: string }
    | { k: 'todos.replace'; items: TodoInput[] }
    /**
     * Plan text and/or the plan file's path. source: 'exit' = ExitPlanMode input, 'file' = read from the plan file,
     * 'reference' = plan_file_reference attachment, 'path' = only the path is known (plan_mode attachments).
     */
    | { k: 'plan'; text?: string; path?: string; source: 'exit' | 'file' | 'reference' | 'path'; toolUseId?: string }
    | { k: 'text'; role: 'assistant'; preview: string; endTurn: boolean }
    | { k: 'turn.end' }
    | { k: 'cost'; totalCostUSD: number; byModel: Record<string, number> }
    /** recorded by Claude Code when a usage limit is hit or near (assistant line quotaLimits) */
    | { k: 'quota'; limitType: string; status: string; resetsAt: number | null }
    | { k: 'compact'; detail?: string }
    | { k: 'attention'; kind: 'permission' | 'notification' | 'error'; detail: string }
    | { k: 'session.end'; detail?: string }
    | { k: 'unknown'; raw: string }
  );

export type EventKind = AgentEvent['k'];
