// Turns raw transcript lines, subagent meta files and hook payloads into AgentEvent[].
// The transcript format is internal to Claude Code and changes between versions, so every
// field is treated as optional and anything unrecognized is dropped rather than thrown.

import type { AgentEvent, AgentRef, SpawnInfo, TodoInput, UsageNumbers } from './events';

type Json = Record<string, any>;

export interface LineContext {
  sessionId: string;
  /** agent id implied by the file (subagent transcript), null for the main transcript */
  agentId: string | null;
}

const IGNORED_TYPES = new Set([
  'file-history-snapshot',
  'file-history-delta',
  'last-prompt',
  'atis-latch',
  'bridge-session',
  'frame-link',
  'artifact-comment-monitor',
  'artifact-autoreact-ledger',
  'pr-link',
  'mode', // UI display mode ("normal"), not the permission mode
]);

const IGNORED_ATTACHMENTS = new Set([
  'deferred_tools_delta',
  'deferred_tools_record',
  'agent_listing_delta',
  'mcp_instructions_delta',
  'skill_listing',
  'total_tokens_reminder',
  'environment',
  'session_context',
  'date',
  'date_change',
  'credential_org',
  'remote_session_change',
  'prompt_snapshot',
  'silent_turn_reminder',
  'batching_reminder_sent',
  'task_reminder',
  'instructions',
  'nested_memory',
  'edited_text_file',
  'read_truncation_notice',
  'thinking_drop',
  'thinking_stripped',
  'file',
  'compact_file_reference',
  'command_permissions',
  'hook_success',
  'hook_additional_context',
]);

/** plan text is kept whole (unlike other tool inputs) but capped */
export const PLAN_CAP = 40_000;

export function parseTs(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return fallback;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function usageFrom(u: Json | undefined): UsageNumbers | null {
  if (!u || typeof u !== 'object') return null;
  const n = {
    in: num(u.input_tokens),
    out: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
  };
  return n.in + n.out + n.cacheRead + n.cacheWrite > 0 ? n : null;
}

const NOTIFY_RE = /^\s*<task-notification>/;

export function parseTaskNotification(text: string): { taskId: string; status: string; summary?: string } | null {
  if (!NOTIFY_RE.test(text)) return null;
  const taskId = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1]?.trim();
  const status = /<status>([^<]+)<\/status>/.exec(text)?.[1]?.trim();
  if (!taskId || !status) return null;
  const summary = /<summary>([^<]*)<\/summary>/.exec(text)?.[1]?.trim();
  return { taskId, status, summary };
}

/** Strip system-reminder style wrappers from a user prompt for display. */
export function cleanPrompt(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g, '')
    .replace(/<local-command-[a-z-]+>[\s\S]*?<\/local-command-[a-z-]+>/g, '')
    .trim();
}

function todoWriteItems(input: Json): TodoInput[] | null {
  const todos = input?.todos;
  if (!Array.isArray(todos)) return null;
  return todos.map((t: Json, i: number) => ({
    id: str(t.id) ?? String(i + 1),
    text: str(t.content) ?? str(t.subject) ?? str(t.activeForm) ?? '',
    status: str(t.status) ?? 'pending',
  }));
}

export function normalizeLine(line: string, ctx: LineContext, fallbackTs = 0): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let o: Json;
  try {
    o = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!o || typeof o !== 'object') return [];

  const type = str(o.type) ?? '';
  if (IGNORED_TYPES.has(type)) return [];

  const ts = parseTs(o.timestamp, fallbackTs);
  const agentId: string | null = o.isSidechain && str(o.agentId) ? o.agentId : ctx.agentId;
  const ref: AgentRef = { sessionId: str(o.sessionId) ?? ctx.sessionId, agentId };
  const out: AgentEvent[] = [];
  const ev = (e: any) => out.push({ ts, src: 'transcript', ref, ...e } as AgentEvent);

  switch (type) {
    case 'custom-title':
      if (str(o.customTitle)) ev({ k: 'title', title: o.customTitle, kind: 'custom' });
      return out;
    case 'ai-title':
      if (str(o.aiTitle)) ev({ k: 'title', title: o.aiTitle, kind: 'ai' });
      return out;
    case 'agent-name':
      if (str(o.agentName)) ev({ k: 'title', title: o.agentName, kind: 'custom' });
      return out;
    case 'cost-state': {
      const byModel: Record<string, number> = {};
      for (const [m, v] of Object.entries((o.modelUsage ?? {}) as Json)) byModel[m] = num((v as Json)?.costUSD);
      ev({ k: 'cost', totalCostUSD: num(o.totalCostUSD), byModel });
      return out;
    }
    case 'queue-operation': {
      if (o.operation === 'enqueue' && str(o.content)) {
        const n = parseTaskNotification(o.content);
        if (n) ev({ k: 'task.notification', ...n });
      }
      return out;
    }
    case 'system': {
      if (o.subtype === 'compact_boundary') ev({ k: 'compact', detail: str(o.content) });
      else if (o.subtype === 'api_error') ev({ k: 'attention', kind: 'error', detail: 'API error' + (o.retryAttempt ? ` (retry ${o.retryAttempt})` : '') });
      return out;
    }
    case 'attachment': {
      const a = o.attachment as Json | undefined;
      const at = str(a?.type) ?? '';
      if (!at || IGNORED_ATTACHMENTS.has(at)) return out;
      if (at === 'plan_mode' && !a?.isSubAgent) {
        ev({ k: 'mode', mode: 'plan' });
        if (str(a?.planFilePath)) ev({ k: 'plan', path: a!.planFilePath, source: 'path' });
      } else if (at === 'plan_mode_exit') {
        ev({ k: 'mode', mode: 'default' });
        if (str(a?.planFilePath)) ev({ k: 'plan', path: a!.planFilePath, source: 'path' });
      } else if (at === 'plan_file_reference') {
        if (str(a?.planFilePath)) ev({ k: 'plan', path: a!.planFilePath, text: str(a?.planContent)?.slice(0, PLAN_CAP), source: 'reference' });
      } else if (at === 'auto_mode') ev({ k: 'mode', mode: 'auto' });
      else if (at === 'auto_mode_exit') ev({ k: 'mode', mode: 'default' });
      else if (at === 'model' && str(a?.identity?.modelId)) ev({ k: 'model', model: a!.identity.modelId });
      else if (at === 'queued_command' && str(a?.prompt)) {
        const n = parseTaskNotification(a!.prompt);
        if (n) ev({ k: 'task.notification', ...n });
      } else if (at === 'task_status' && str(a?.taskId) && str(a?.status)) {
        ev({ k: 'task.notification', taskId: a!.taskId, status: a!.status, summary: str(a?.description) });
      }
      return out;
    }
    case 'user':
    case 'assistant':
      break;
    default:
      return [{ ts, src: 'transcript', ref, k: 'unknown', raw: type || trimmed.slice(0, 60) }];
  }

  // shared session metadata, emitted cheaply; the reducer ignores repeats
  if (str(o.cwd) || str(o.version)) {
    ev({ k: 'session.meta', cwd: str(o.cwd), version: str(o.version), entrypoint: str(o.entrypoint), gitBranch: str(o.gitBranch) });
  }

  const msg = (o.message ?? {}) as Json;
  const content = msg.content;

  if (type === 'user') {
    if (str(o.permissionMode) && !o.isSidechain) ev({ k: 'mode', mode: o.permissionMode });
    if (typeof content === 'string') {
      const n = parseTaskNotification(content);
      if (n) ev({ k: 'task.notification', ...n });
      else if (!o.isMeta && !o.isCompactSummary) {
        const text = cleanPrompt(content);
        if (text) ev({ k: 'prompt', text });
      }
    } else if (Array.isArray(content)) {
      for (const b of content as Json[]) {
        if (b?.type === 'tool_result' && str(b.tool_use_id)) {
          ev({ k: 'tool.end', toolUseId: b.tool_use_id, ok: !b.is_error, result: compactResult(o.toolUseResult) });
        } else if (b?.type === 'text' && str(b.text) && !o.isMeta && !o.isCompactSummary) {
          const n = parseTaskNotification(b.text);
          if (n) ev({ k: 'task.notification', ...n });
          else {
            const text = cleanPrompt(b.text);
            if (text && !o.sourceToolUseID) ev({ k: 'prompt', text });
          }
        }
      }
    }
    return out;
  }

  // assistant
  const model = str(msg.model);
  if (model && model !== '<synthetic>') ev({ k: 'model', model, effort: str(o.effort) });
  const u = usageFrom(msg.usage);
  if (u && str(msg.id)) ev({ k: 'usage', msgId: msg.id, usage: u });
  if (o.isApiErrorMessage) ev({ k: 'attention', kind: 'error', detail: str(o.error) ?? 'API error' });
  const q = o.quotaLimits as Json | undefined;
  if (q && str(q.status) && str(q.rateLimitType)) {
    ev({ k: 'quota', limitType: q.rateLimitType, status: q.status, resetsAt: typeof q.resetsAt === 'number' ? q.resetsAt * 1000 : null });
  }
  if (Array.isArray(content)) {
    for (const b of content as Json[]) {
      if (b?.type === 'tool_use' && str(b.id) && str(b.name)) {
        ev({ k: 'tool.start', toolUseId: b.id, name: b.name, input: compactInput(b.input) });
        if (b.name === 'ExitPlanMode') {
          const text = str(b.input?.plan);
          if (text || str(b.input?.planFilePath))
            ev({ k: 'plan', text: text?.slice(0, PLAN_CAP), path: str(b.input?.planFilePath), source: 'exit', toolUseId: b.id });
        }
        if (b.name === 'TodoWrite') {
          const items = todoWriteItems(b.input);
          if (items) ev({ k: 'todos.replace', items });
        }
      } else if (b?.type === 'text' && str(b.text) && b.text.trim()) {
        ev({ k: 'text', role: 'assistant', preview: b.text.trim().slice(0, 400), endTurn: msg.stop_reason === 'end_turn' });
      }
    }
  }
  if (msg.stop_reason === 'end_turn') ev({ k: 'turn.end' });
  return out;
}

/** Keep tool inputs small: they are summarized, never shown in full. */
export function compactInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Json = {};
  for (const [k, v] of Object.entries(input as Json)) {
    if (typeof v === 'string') out[k] = v.length > 300 ? v.slice(0, 300) : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (k === 'questions' && Array.isArray(v)) out[k] = v.slice(0, 1).map((q: Json) => ({ question: String(q?.question ?? '').slice(0, 200) }));
  }
  return out;
}

const RESULT_KEYS = [
  'task',
  'taskId',
  'statusChange',
  'agentId',
  'resolvedModel',
  'description',
  'isAsync',
  'status',
  'runId',
  'workflowName',
  'summary',
  'resumedAgentId',
];

/** Keep only the tool-result fields the reducer reads. */
export function compactResult(r: unknown): unknown {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
  const out: Json = {};
  let any = false;
  for (const k of RESULT_KEYS) {
    const v = (r as Json)[k];
    if (v === undefined) continue;
    out[k] = typeof v === 'string' && v.length > 300 ? v.slice(0, 300) : v;
    any = true;
  }
  return any ? out : undefined;
}

/** subagents/workflows/<runId>/journal.jsonl line -> events. */
export function normalizeJournalLine(line: string, sessionId: string, ts: number): AgentEvent[] {
  let o: Json;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  if (o?.type === 'result' && typeof o.agentId === 'string') {
    return [
      {
        ts,
        src: 'transcript',
        ref: { sessionId, agentId: null },
        k: 'agent.stop',
        childId: o.agentId,
        status: o.error ? 'error' : 'done',
        atLastActivity: true,
      },
    ];
  }
  return [];
}

/** agent-<id>.meta.json -> spawn event. */
export function normalizeMeta(meta: Json, childId: string, sessionId: string, ts: number, workflowRunId?: string): AgentEvent {
  const spawn: SpawnInfo = {
    childId,
    parentToolUseId: str(meta?.toolUseId),
    agentType: str(meta?.agentType),
    description: str(meta?.description),
    depth: typeof meta?.spawnDepth === 'number' ? meta.spawnDepth : undefined,
    background: meta?.requestShape === 'background',
    workflowRunId,
    workflowPhase: str(meta?.workflowPhase),
  };
  return { ts, src: 'transcript', ref: { sessionId, agentId: null }, k: 'agent.spawn', spawn };
}

/** A hook payload (the JSON Claude Code POSTs / pipes to hooks) -> events. */
export function normalizeHook(p: Json, now: number): AgentEvent[] {
  const sessionId = str(p?.session_id);
  const name = str(p?.hook_event_name);
  if (!sessionId || !name) return [];
  const agentId = str(p.agent_id) ?? null;
  const out: AgentEvent[] = [];
  const ev = (e: any, ref: AgentRef = { sessionId, agentId }) => out.push({ ts: now, src: 'hook', ref, ...e } as AgentEvent);

  if (str(p.permission_mode) && !agentId) ev({ k: 'mode', mode: p.permission_mode });
  if (str(p.cwd) && name === 'SessionStart') ev({ k: 'session.meta', cwd: p.cwd });

  switch (name) {
    case 'SessionStart':
      if (str(p.model)) ev({ k: 'model', model: p.model });
      break;
    case 'UserPromptSubmit':
      if (str(p.prompt)) ev({ k: 'prompt', text: cleanPrompt(p.prompt) });
      break;
    case 'PreToolUse':
      if (str(p.tool_use_id) && str(p.tool_name)) {
        ev({ k: 'tool.start', toolUseId: p.tool_use_id, name: p.tool_name, input: compactInput(p.tool_input) });
        if (p.tool_name === 'ExitPlanMode' && !agentId && str(p.tool_input?.plan)) {
          ev({ k: 'plan', text: p.tool_input.plan.slice(0, PLAN_CAP), path: str(p.tool_input.planFilePath), source: 'exit', toolUseId: p.tool_use_id });
        }
      }
      break;
    case 'PostToolUse':
      if (str(p.tool_use_id)) ev({ k: 'tool.end', toolUseId: p.tool_use_id, ok: true, durationMs: num(p.duration_ms) || undefined, name: str(p.tool_name) });
      break;
    case 'PostToolUseFailure':
      if (str(p.tool_use_id)) ev({ k: 'tool.end', toolUseId: p.tool_use_id, ok: false, name: str(p.tool_name) });
      break;
    case 'SubagentStart':
      if (agentId) ev({ k: 'agent.spawn', spawn: { childId: agentId, agentType: str(p.agent_type) } }, { sessionId, agentId: null });
      break;
    case 'SubagentStop':
      if (agentId)
        ev({ k: 'agent.stop', childId: agentId, status: 'done', detail: str(p.last_assistant_message)?.slice(0, 300) }, { sessionId, agentId: null });
      break;
    case 'PermissionRequest':
      ev({ k: 'attention', kind: 'permission', detail: `Permission needed: ${str(p.tool_name) ?? 'tool'}` });
      break;
    case 'Notification':
      ev({ k: 'attention', kind: 'notification', detail: str(p.message) ?? str(p.title) ?? 'Notification' });
      break;
    case 'Stop':
      if (!agentId) ev({ k: 'turn.end' });
      break;
    case 'StopFailure':
      ev({ k: 'attention', kind: 'error', detail: 'Turn ended with an error' });
      break;
    case 'PreCompact':
      ev({ k: 'compact', detail: `Compacting (${str(p.trigger) ?? 'auto'})` });
      break;
    case 'PostModelSwitch':
      if (str(p.to_model)) ev({ k: 'model', model: p.to_model });
      break;
    case 'SessionEnd':
      ev({ k: 'session.end', detail: str(p.reason) });
      break;
  }
  return out;
}
