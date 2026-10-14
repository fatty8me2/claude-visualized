import type { UsageNumbers } from './events';
import type { ToolMix } from './goal';

export type AgentStatus = 'running' | 'waiting' | 'idle' | 'done' | 'error';

export interface CurrentTool {
  id: string;
  name: string;
  summary: string;
  since: number;
  /** compact tool input (strings clipped), for plain-English activity phrases */
  input?: unknown;
}

export interface RecentTool {
  id: string;
  name: string;
  summary: string;
  ts: number;
  /** null while the call is still running */
  ok: boolean | null;
}

export const RECENT_CAP = 10;
export const FILES_CAP = 30;
export const COMMANDS_CAP = 10;
export const PROMPT_CAP = 600;

export interface AgentNode {
  /** 'main' for the session's main agent, 'wf:<runId>' for a workflow group, else the subagent id */
  id: string;
  parentId: string | null;
  kind: 'main' | 'agent' | 'workflow';
  agentType: string;
  description: string;
  model: string | null;
  effort: string | null;
  status: AgentStatus;
  tokens: UsageNumbers;
  /** input side of the latest API message (not a sum): how full the context window is; 0 = unknown */
  contextTokens: number;
  contextAt: number;
  /** highest contextTokens ever seen (survives compaction); evidence of a 1M window */
  contextPeak: number;
  currentTool: CurrentTool | null;
  toolCount: number;
  errorCount: number;
  startedAt: number;
  endedAt: number | null;
  lastActivity: number;
  /** timestamps of recent tool starts, for the activity sparkline */
  activity: number[];
  background: boolean;
  depth: number;
  phase: string | null;
  /** tool_use id of the spawning Agent call, used to resolve the parent lazily */
  parentToolUseId: string | null;
  lastText: string | null;
  lastTextAt: number;
  /** tool calls by category, for the goal classifier and the drawer bars */
  toolMix: ToolMix;
  /** the task: first prompt of a subagent (~600 chars), latest prompt of the main agent */
  prompt: string | null;
  /** last ~10 tool calls, oldest first */
  recent: RecentTool[];
  /** files read or edited, most recent last, at most 30 */
  files: string[];
  /** shell commands run, most recent last, at most 10 */
  commands: string[];
}

export interface TodoItem {
  id: string;
  text: string;
  status: string;
  owner: string;
}

export type LogKind = 'prompt' | 'tool' | 'tool-error' | 'agent' | 'done' | 'mode' | 'model' | 'text' | 'notice' | 'attention';

export interface LogEntry {
  seq: number;
  ts: number;
  agentId: string;
  kind: LogKind;
  text: string;
}

export interface SessionState {
  id: string;
  cwd: string | null;
  title: string | null;
  titleKind: 'custom' | 'ai' | 'prompt' | null;
  version: string | null;
  entrypoint: string | null;
  gitBranch: string | null;
  mode: string;
  modeSource: 'transcript' | 'hook' | null;
  agents: Record<string, AgentNode>;
  todos: TodoItem[];
  log: LogEntry[];
  totals: UsageNumbers;
  costUSD: number | null;
  costByModel: Record<string, number>;
  /** last usage-limit record seen in this session's transcript */
  quota: { limitType: string; status: string; resetsAt: number | null; ts: number } | null;
  startedAt: number | null;
  lastActivity: number | null;
  ended: boolean;
  lastHookAt: number | null;
  warnings: number;
  eventCount: number;
  /** bookkeeping, not rendered */
  internal: SessionInternal;
}

export interface PendingTool {
  agentId: string;
  name: string;
  input: unknown;
  start: number;
}

export interface SessionInternal {
  pending: Record<string, PendingTool>;
  /** tool_use ids already counted, so hook + transcript copies of one call count once */
  seenTools: Record<string, string>;
  /** per agent: msgId -> usage, so repeated per-block usage lines are counted once */
  usage: Record<string, Record<string, UsageNumbers>>;
  /** Agent tool_use id -> spawned agent id (from tool_result) */
  agentByToolUse: Record<string, string>;
  /** workflow runId -> tool_use id of the Workflow call */
  workflowToolUse: Record<string, string>;
  /** workflow task id (from task-notification) -> runId */
  workflowByTask: Record<string, string>;
  /** task id -> last notified status; notifications arrive via queue, attachment and user line */
  notified: Record<string, string>;
  logSeq: number;
}

export const LOG_CAP = 1500;
export const ACTIVITY_CAP = 120;
export const MAIN = 'main';

export const zeroUsage = (): UsageNumbers => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });

export function newAgent(id: string, kind: AgentNode['kind'], ts: number, parentId: string | null): AgentNode {
  return {
    id,
    parentId,
    kind,
    agentType: kind === 'main' ? 'main' : kind === 'workflow' ? 'workflow' : 'agent',
    description: '',
    model: null,
    effort: null,
    status: kind === 'main' ? 'idle' : 'running',
    tokens: zeroUsage(),
    contextTokens: 0,
    contextAt: 0,
    contextPeak: 0,
    currentTool: null,
    toolCount: 0,
    errorCount: 0,
    startedAt: ts,
    endedAt: null,
    lastActivity: ts,
    activity: [],
    background: false,
    depth: kind === 'main' ? 0 : 1,
    phase: null,
    parentToolUseId: null,
    lastText: null,
    lastTextAt: 0,
    toolMix: {},
    prompt: null,
    recent: [],
    files: [],
    commands: [],
  };
}

export function newSession(id: string): SessionState {
  return {
    id,
    cwd: null,
    title: null,
    titleKind: null,
    version: null,
    entrypoint: null,
    gitBranch: null,
    mode: 'default',
    modeSource: null,
    agents: { [MAIN]: newAgent(MAIN, 'main', 0, null) },
    todos: [],
    log: [],
    totals: zeroUsage(),
    costUSD: null,
    costByModel: {},
    quota: null,
    startedAt: null,
    lastActivity: null,
    ended: false,
    lastHookAt: null,
    warnings: 0,
    eventCount: 0,
    internal: {
      pending: {},
      seenTools: {},
      usage: {},
      agentByToolUse: {},
      workflowToolUse: {},
      workflowByTask: {},
      notified: {},
      logSeq: 0,
    },
  };
}

/** The renderer-facing snapshot: everything except bookkeeping. */
export type SessionView = Omit<SessionState, 'internal'>;

export function toView(s: SessionState): SessionView {
  const { internal: _internal, ...view } = s;
  return view;
}

/** Lightweight row for the session picker / tray. */
export interface SessionSummary {
  id: string;
  file: string;
  projectDir: string;
  project: string;
  cwd: string | null;
  title: string | null;
  /** last real activity (transcript timestamps, desktop lastActivityAt, subagent writes) */
  mtime: number;
  size: number;
  live: boolean;
  entrypoint: string | null;
  running?: number;
  mode?: string;
  waiting?: boolean;
  /** the Claude desktop app's own id (local_…) when it knows this session */
  desktopId?: string | null;
  /** hidden in the desktop app's sidebar */
  archived?: boolean;
}
