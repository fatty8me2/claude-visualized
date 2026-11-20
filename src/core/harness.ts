// Kiln's agent harness (the Kiln desktop app): Claude Code runs as its "lead" and hands coding tasks to a local model (qwen)
// through the MCP tool `mcp__harness__delegate_task`. The harness keeps everything in a SQLite database (<userData>/harness.db):
// tasks, their worker's chat messages, usage per model call, todo lists, and the local Agent conversations run in the app.
//
// This module is pure (no fs, no SQLite): the main process reads the rows (src/main/harness.ts) and this turns them into
// AgentEvents. A task becomes a child agent of the Claude agent whose delegate_task call created it; a `task` tool call of the
// worker becomes a grandchild (the harness's own sub-agent); a local Agent conversation is a session of its own.
//
// Every event carries a stable key (HxItem): callers send the items whose key they have not sent yet, so rows that arrive out
// of order, a usage record written after the next message, or a revived task never resend or skip anything.

import type { AgentEvent, KilnInfo, TodoInput } from './events';
import { classifyModel } from './models';
import { sameTask } from './kiln';

export const HARNESS = 'kiln-harness';
/** agent types of the harness's workers and helpers in the graph */
export const HARNESS_WORKER = 'kiln-worker';
export const HARNESS_HELPER = 'kiln-helper';

type Json = Record<string, any>;
/** an AgentEvent without src and ref (Omit on each member of the union) */
type Body = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, 'src' | 'ref'> : never) : never;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Claude Code's name for the harness's hand-off tool: `mcp__harness__delegate_task` (or a plugin-bundled spelling). */
export function isHarnessDelegate(name: string | null | undefined): boolean {
  return !!name && /^mcp__[\w-]*harness[\w-]*__delegate_task$/i.test(name);
}

const TASK_ID_RE = /"taskId"\s*:\s*"(task_[0-9a-f]{6,32})"/;

/** The taskId in a delegate_task result: JSON.stringify({taskId, tier, state, ...}, null, 2), as a string or text blocks. */
export function harnessTaskIdOf(content: unknown): string | null {
  let t = '';
  if (typeof content === 'string') t = content.slice(0, 4000);
  else if (Array.isArray(content)) {
    for (const b of content as Json[]) {
      if (b?.type === 'text' && typeof b.text === 'string') t += b.text.slice(0, 4000);
      if (t.length >= 4000) break;
    }
  }
  if (!t.includes('"taskId"')) return null;
  return TASK_ID_RE.exec(t)?.[1] ?? null;
}

// ---------------------------------------------------------------- rows (as src/main/harness.ts reads them)

export interface HxModel {
  provider: string;
  model: string;
}

export interface HxTask {
  id: string;
  title: string;
  brief: string;
  /** 'writer' | 'reader' */
  role: string;
  state: string;
  model: HxModel | null;
  /** 'local' | 'sonnet' | 'opus' */
  tier: string;
  summary: string;
  stateReason: string;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  /** the project's folder */
  root: string;
  /** message rows the task has (its worker ran) */
  messages: number;
}

export interface HxConversation {
  id: string;
  title: string;
  model: HxModel | null;
  /** 'idle' | 'running' | 'paused' | 'error' */
  status: string;
  mode: string;
  createdAt: number;
  updatedAt: number;
  root: string;
  messages: number;
}

export interface HxToolCall {
  id: string;
  name: string;
  arguments: Json;
}

/** What a harness sub-agent (the `task` tool) did, kept on its tool result. */
export interface HxSubagent {
  type: string;
  description: string;
  steps: { tool: string; summary: string; ok: boolean }[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  outcome: string;
}

export interface HxMessage {
  id: string;
  ts: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: HxToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  subagent?: HxSubagent | null;
}

export interface HxUsage {
  id: string;
  ts: number;
  provider: string;
  model: string;
  in: number;
  out: number;
  /** 'local' | 'paid' */
  source: string;
  /** decode tokens per second, when measured */
  tps: number;
}

export interface HxTodo {
  content: string;
  status: string;
}

/** A task's or conversation's rows. */
export interface HxData {
  messages: HxMessage[];
  usage: HxUsage[];
  todos?: { items: HxTodo[]; updatedAt: number } | null;
}

/** A stored ChatMessage (or its fields, as extracted by SQL) as an HxMessage; null when it is not one. */
export function parseHxMessage(id: string, ts: number, m: unknown): HxMessage | null {
  const o = obj(m);
  const role = str(o.role);
  if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') return null;
  const out: HxMessage = { id, ts, role, content: str(o.content) };
  if (role === 'assistant' && Array.isArray(o.toolCalls)) {
    out.toolCalls = (o.toolCalls as unknown[])
      .map(obj)
      .filter((c) => str(c.name))
      .map((c) => ({ id: str(c.id), name: str(c.name), arguments: obj(c.arguments) }));
  }
  if (role === 'tool') {
    out.toolCallId = str(o.toolCallId);
    out.toolName = str(o.toolName);
    out.isError = o.isError === true || o.isError === 1;
    const s = obj(o.subagent);
    if (Array.isArray(s.steps) || str(s.type)) {
      out.subagent = {
        type: str(s.type),
        description: str(s.description),
        steps: (Array.isArray(s.steps) ? s.steps : []).map(obj).map((x) => ({ tool: str(x.tool), summary: str(x.summary), ok: x.ok !== false })),
        turns: num(s.turns),
        inputTokens: num(s.inputTokens),
        outputTokens: num(s.outputTokens),
        durationMs: num(s.durationMs),
        outcome: str(s.outcome) || 'done',
      };
    }
  }
  return out;
}

/** `{"provider":"ollama","model":"qwen3.8:27b"}` (a JSON column) as an HxModel. */
export function parseHxModel(v: unknown): HxModel | null {
  let o: Json = {};
  if (typeof v === 'string') {
    try {
      o = obj(JSON.parse(v));
    } catch {
      return v ? { provider: '', model: v } : null;
    }
  } else o = obj(v);
  const model = str(o.model) || str(o.id);
  return model ? { provider: str(o.provider), model } : null;
}

// ---------------------------------------------------------------- models

const LOCAL_PROVIDERS = new Set(['ollama', 'openai-compat', 'lmstudio', 'llamacpp', '']);

/**
 * A model id the app classifies right: models the harness runs on this machine (Ollama, an OpenAI-compatible local server) as
 * local, whatever they are called; Claude (the lead's subagents) as Claude.
 */
export function harnessModelId(m: HxModel | null, paid = false): string {
  if (!m?.model) return '';
  if (m.provider === 'claude-code') return /claude/i.test(m.model) ? m.model : `claude-${m.model}`;
  if (LOCAL_PROVIDERS.has(m.provider) && !paid && classifyModel(m.model).provider !== 'local') return `local/${m.model.split('/').pop()}`;
  return m.model;
}

/** The model a task's worker ran on: its latest local usage record (an escalated task's row now names Claude), else the task's. */
function workerModel(t: HxTask, usage: HxUsage[]): string {
  for (let i = usage.length - 1; i >= 0; i--) {
    const u = usage[i];
    if (u.provider !== 'claude-code' && u.model) return harnessModelId({ provider: u.provider, model: u.model }, u.source === 'paid');
  }
  return harnessModelId(t.model);
}

// ---------------------------------------------------------------- tools

/** The harness's tools under the names the rest of the app knows (tool mix, files, commands, summaries, countdowns). */
export function harnessToolOf(name: string, args: Json): { name: string; input: Json } {
  const a = args ?? {};
  const s = (k: string) => str(a[k]);
  switch (name) {
    case 'read_file':
      return { name: 'Read', input: { file_path: s('path') || s('file_path') } };
    case 'write_file':
      return { name: 'Write', input: { file_path: s('path') || s('file_path') } };
    case 'edit_file':
      return { name: 'Edit', input: { file_path: s('path') || s('file_path') } };
    case 'multi_edit':
      return { name: 'MultiEdit', input: { file_path: s('path') || s('file_path') } };
    case 'notebook_edit':
      return { name: 'NotebookEdit', input: { notebook_path: s('path') || s('notebook_path') } };
    case 'run_command':
    case 'bash':
      return { name: 'Bash', input: { command: s('command'), ...(s('description') ? { description: s('description') } : {}) } };
    case 'run_background':
      return { name: 'Bash', input: { command: s('command'), run_in_background: true } };
    case 'bash_output':
      return { name: 'BashOutput', input: { bash_id: s('shell_id') } };
    case 'kill_shell':
      return { name: 'KillShell', input: { shell_id: s('shell_id') } };
    case 'glob':
      return { name: 'Glob', input: { pattern: s('pattern'), ...(s('path') ? { path: s('path') } : {}) } };
    case 'list_files':
      return { name: 'Glob', input: { pattern: s('pattern') || '**/*' } };
    case 'grep':
      return { name: 'Grep', input: { pattern: s('pattern'), ...(s('path') ? { path: s('path') } : {}), ...(s('glob') ? { glob: s('glob') } : {}) } };
    case 'web_fetch':
      return { name: 'WebFetch', input: { url: s('url') } };
    case 'web_search':
      return { name: 'WebSearch', input: { query: s('query') } };
    case 'todo_write':
      return { name: 'TodoWrite', input: {} };
    case 'task':
      return { name: 'Task', input: { description: s('description'), subagent_type: s('subagent_type') || 'general' } };
    case 'skill':
      return { name: 'Skill', input: { skill: s('name') } };
    case 'ask_user_question':
      return { name: 'AskUserQuestion', input: {} };
    case 'exit_plan_mode':
      return { name: 'ExitPlanMode', input: {} };
    default:
      return { name: name || 'tool', input: small(a) };
  }
}

/** a step of a sub-agent trace ("read_file src/a.ts", 'grep "foo"') as a tool call */
function stepTool(tool: string, summary: string): { name: string; input: Json } {
  let arg = summary.startsWith(tool + ' ') ? summary.slice(tool.length + 1) : summary === tool ? '' : summary;
  if (arg.startsWith('"')) {
    try {
      const v = JSON.parse(arg);
      if (typeof v === 'string') arg = v;
    } catch {
      /* keep it quoted */
    }
  }
  const key: Record<string, string> = {
    read_file: 'path',
    write_file: 'path',
    edit_file: 'path',
    multi_edit: 'path',
    notebook_edit: 'path',
    run_command: 'command',
    run_background: 'command',
    glob: 'pattern',
    list_files: 'pattern',
    grep: 'pattern',
    web_fetch: 'url',
    web_search: 'query',
    skill: 'name',
    bash_output: 'shell_id',
    kill_shell: 'shell_id',
  };
  const k = key[tool];
  return k ? harnessToolOf(tool, { [k]: arg }) : { name: tool || 'tool', input: arg ? { summary: arg } : {} };
}

/** short string, number and boolean fields only: tool inputs are summarized, never shown in full */
function small(input: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = v.length > 300 ? v.slice(0, 300) : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- states

const RUNNING_STATES = new Set(['delegated', 'implementing', 'checks', 'revising']);

/** How a task's worker ended, or null while it works (or waits to start). */
export function taskEnd(t: Pick<HxTask, 'state' | 'stateReason'>): { status: 'done' | 'error'; detail?: string } | null {
  const why = t.stateReason.trim();
  switch (t.state) {
    case 'accepted':
      return { status: 'done', detail: why || undefined };
    case 'review':
      return { status: 'done', detail: why || 'waiting for the lead to review it' };
    case 'paused':
      return { status: 'done', detail: why ? `paused: ${why}` : 'paused' };
    case 'escalated':
      return { status: 'error', detail: why ? `escalated: ${why}` : 'escalated to Claude' };
    case 'failed':
    case 'cancelled':
    case 'needs_inspection':
      return { status: 'error', detail: why || t.state.replace('_', ' ') };
    default:
      return RUNNING_STATES.has(t.state) || !t.state ? null : { status: 'done', detail: t.state };
  }
}

export const taskFinished = (t: Pick<HxTask, 'state'>) => t.state === 'accepted' || t.state === 'failed' || t.state === 'cancelled';

/** A task the graph shows: local-tier work, or any task whose local worker ran (an escalation keeps the local run). */
export const taskShown = (t: Pick<HxTask, 'tier' | 'messages'>) => t.tier === 'local' || !t.tier || t.messages > 0;

// ---------------------------------------------------------------- events

export interface HxItem {
  key: string;
  e: AgentEvent;
}

export const harnessAgentId = (taskId: string) => `kh-${taskId}`;
export const harnessSessionId = (id: string) => `kh-${id}`;

/** A one-line title for a card. */
export function harnessTitle(title: string, brief = ''): string {
  const first = (title.trim() ? title : brief).split('\n').find((l) => l.trim()) ?? '';
  return clip(first.trim(), 90) || 'Kiln task';
}

interface AgentCtx {
  sessionId: string;
  /** null = the session's main agent */
  agentId: string;
  ref: { sessionId: string; agentId: string | null };
  /** prefix of tool-use ids and child agent ids */
  base: string;
  model: string;
  main: boolean;
}

/**
 * The messages and usage of one harness agent (a task's worker or a conversation) as keyed items, in time order: text, tool
 * calls and results, todo lists, sub-agents (grandchild agents) and per-call usage. Returns the calls still waiting for a
 * result, so the caller can close them when the agent ended.
 */
function agentItems(c: AgentCtx, data: HxData, skipFirstUser: boolean): { items: HxItem[]; open: { toolUseId: string; name: string; childId?: string }[] } {
  const items: HxItem[] = [];
  const { ref } = c;
  const push = (key: string, e: Body & { ref?: AgentEvent['ref'] }) => items.push({ key, e: { src: 'transcript', ref, ...e } as AgentEvent });
  const open = new Map<string, { toolUseId: string; name: string; childId?: string; ts: number }>();
  let firstUser = skipFirstUser;
  for (const m of data.messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      if (firstUser) {
        firstUser = false;
        continue;
      }
      const text = m.content.trim();
      if (text) push(`p:${m.id}`, { ts: m.ts, k: 'prompt', text: text.slice(0, 2000) });
      continue;
    }
    if (m.role === 'assistant') {
      const calls = m.toolCalls ?? [];
      const text = m.content.trim();
      if (text) push(`t:${m.id}`, { ts: m.ts, k: 'text', role: 'assistant', preview: clip(text, 400), endTurn: c.main && !calls.length });
      calls.forEach((call, i) => {
        const toolUseId = `${c.base}:${m.id}:${i}`;
        const t = harnessToolOf(call.name, call.arguments);
        push(`s:${toolUseId}`, { ts: m.ts, k: 'tool.start', toolUseId, name: t.name, input: t.input });
        const entry: { toolUseId: string; name: string; childId?: string; ts: number } = { toolUseId, name: t.name, ts: m.ts };
        if (call.name === 'task') {
          // the harness's sub-agent: a grandchild under this call, live from the moment it starts
          const childId = `${c.base}-${m.id}-${i}`;
          const cref = { sessionId: c.sessionId, agentId: childId };
          const a = call.arguments ?? {};
          entry.childId = childId;
          push(`sp:${childId}`, {
            ts: m.ts,
            k: 'agent.spawn',
            spawn: {
              childId,
              parentToolUseId: toolUseId,
              agentType: str(a.subagent_type) || 'general',
              description: clip(str(a.description) || 'sub-agent', 120),
            },
          });
          if (c.model) push(`sm:${childId}`, { ts: m.ts, ref: cref, k: 'model', model: c.model });
          if (str(a.prompt)) push(`sq:${childId}`, { ts: m.ts, ref: cref, k: 'prompt', text: str(a.prompt).slice(0, 2000) });
        }
        if (call.name === 'todo_write' && c.main && Array.isArray(call.arguments?.todos)) {
          push(`td:${toolUseId}`, { ts: m.ts, k: 'todos.replace', items: todoItems(call.arguments.todos as unknown[]) });
        }
        if (call.id) open.set(call.id, entry);
      });
      if (c.main && !calls.length) push(`te:${m.id}`, { ts: m.ts, k: 'turn.end' });
      continue;
    }
    // a tool result: it ends the latest call with that id
    const o = m.toolCallId ? open.get(m.toolCallId) : undefined;
    if (!o) continue;
    open.delete(m.toolCallId!);
    const err = m.isError ? clip(m.content.replace(/\s+/g, ' ').trim(), 300) : '';
    push(`e:${o.toolUseId}`, { ts: m.ts, k: 'tool.end', toolUseId: o.toolUseId, ok: !m.isError, name: o.name, ...(err ? { error: err } : {}) });
    if (o.childId) items.push(...subagentItems(c, o.childId, o.ts, m));
  }
  // usage: one record per model call, counted on the model it ran on
  let lastModel = c.model;
  for (const u of data.usage) {
    const model = u.provider === 'claude-code' ? c.model : harnessModelId({ provider: u.provider, model: u.model }, u.source === 'paid');
    if (model && model !== lastModel) {
      push(`m:${u.id}`, { ts: u.ts, k: 'model', model });
      lastModel = model;
    }
    if (u.in + u.out > 0) push(`u:${u.id}`, { ts: u.ts, k: 'usage', msgId: `hx:${u.id}`, usage: { in: u.in, out: u.out, cacheRead: 0, cacheWrite: 0 } });
  }
  return { items: byTime(items), open: [...open.values()] };
}

/** A finished sub-agent call: its steps as tool calls spread over its run, its tokens, and its end. */
function subagentItems(c: AgentCtx, childId: string, startTs: number, m: HxMessage): HxItem[] {
  const out: HxItem[] = [];
  const ref = { sessionId: c.sessionId, agentId: childId };
  const tr = m.subagent;
  const end = m.ts;
  if (!tr) {
    out.push({
      key: `${childId}:stop`,
      e: {
        ts: end,
        src: 'transcript',
        ref: c.ref,
        k: 'agent.stop',
        childId,
        status: m.isError ? 'error' : 'done',
        detail: m.isError ? clip(m.content, 300) : undefined,
      },
    });
    return out;
  }
  const start = Math.max(startTs, end - Math.max(0, tr.durationMs));
  const n = tr.steps.length;
  tr.steps.forEach((s, j) => {
    const t0 = start + Math.round(((end - start) * j) / (n + 1));
    const t1 = start + Math.round(((end - start) * (j + 0.8)) / (n + 1));
    const id = `${childId}:${j}`;
    const t = stepTool(s.tool, s.summary);
    out.push({ key: `${id}:s`, e: { ts: t0, src: 'transcript', ref, k: 'tool.start', toolUseId: id, name: t.name, input: t.input } });
    out.push({
      key: `${id}:e`,
      e: { ts: t1, src: 'transcript', ref, k: 'tool.end', toolUseId: id, ok: s.ok, name: t.name, ...(s.ok ? {} : { error: 'failed' }) },
    });
  });
  const ok = tr.outcome === 'done' && !m.isError;
  const report = m.content.replace(/\n*\[[^\]\n]*sub-agent:[^\]\n]*\]\s*$/, '').trim();
  const info: KilnInfo = {
    runId: childId,
    model: c.model,
    profile: `${tr.type || 'general'} sub-agent`,
    effort: '',
    readonly: tr.type === 'explore',
    ok,
    error: ok ? null : `ended: ${tr.outcome}`,
    answer: clip(report, 4000),
    filesChanged: [],
    diffStat: null,
    steps: n,
    promptTokens: tr.inputTokens,
    completionTokens: tr.outputTokens,
    seconds: tr.durationMs / 1000,
    tokensPerSec: tr.durationMs > 0 ? tr.outputTokens / (tr.durationMs / 1000) : 0,
    finished: true,
  };
  // the info first: the reducer then does not read the summed prompt tokens as a context size
  out.push({ key: `${childId}:info`, e: { ts: end, src: 'transcript', ref: c.ref, k: 'kiln', agentId: childId, info } });
  if (report)
    out.push({ key: `${childId}:text`, e: { ts: end, src: 'transcript', ref, k: 'text', role: 'assistant', preview: clip(report, 400), endTurn: false } });
  if (tr.inputTokens + tr.outputTokens > 0)
    out.push({
      key: `${childId}:u`,
      e: {
        ts: end,
        src: 'transcript',
        ref,
        k: 'usage',
        msgId: `hx:${childId}`,
        usage: { in: tr.inputTokens, out: tr.outputTokens, cacheRead: 0, cacheWrite: 0 },
      },
    });
  out.push({
    key: `${childId}:stop`,
    e: { ts: end, src: 'transcript', ref: c.ref, k: 'agent.stop', childId, status: ok ? 'done' : 'error', detail: ok ? undefined : `ended: ${tr.outcome}` },
  });
  return out;
}

function todoItems(list: unknown[]): TodoInput[] {
  return list.map(obj).map((t, i) => ({ id: String(i + 1), text: str(t.content) || str(t.activeForm), status: str(t.status) || 'pending' }));
}

/** stable sort by time */
function byTime(items: HxItem[]): HxItem[] {
  return items
    .map((it, i) => [it, i] as const)
    .sort((a, b) => a[0].e.ts - b[0].e.ts || a[1] - b[1])
    .map(([it]) => it);
}

function taskInfo(t: HxTask, data: HxData, model: string, finished: boolean): KilnInfo {
  const end = finished ? taskEnd(t) : null;
  const calls = data.messages.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0);
  const inTok = data.usage.reduce((n, u) => n + u.in, 0);
  const outTok = data.usage.reduce((n, u) => n + u.out, 0);
  const tps = data.usage.filter((u) => u.tps > 0);
  return {
    runId: t.id,
    model,
    profile: `${t.tier || 'local'} tier`,
    effort: '',
    readonly: t.role === 'reader',
    ok: end ? end.status === 'done' : null,
    error: end && end.status === 'error' ? (end.detail ?? null) : null,
    answer: finished ? clip(t.summary, 4000) : '',
    filesChanged: [],
    diffStat: null,
    steps: calls,
    promptTokens: inTok,
    completionTokens: outTok,
    seconds: finished ? Math.max(0, (t.updatedAt - t.createdAt) / 1000) : 0,
    tokensPerSec: tps.length ? tps.reduce((n, u) => n + u.tps, 0) / tps.length : 0,
    finished,
    source: 'harness',
    state: t.state,
  };
}

/**
 * A task as keyed AgentEvents. `parentToolUseId` set: a child agent of the Claude agent that made that delegate_task call.
 * Null: the task is the session's main agent (a task no Claude session claims).
 */
export function harnessTaskItems(t: HxTask, data: HxData, sessionId: string, parentToolUseId: string | null): HxItem[] {
  const child = parentToolUseId !== null;
  const agentId = child ? harnessAgentId(t.id) : null;
  const infoId = agentId ?? 'main';
  const ref = { sessionId, agentId };
  const model = workerModel(t, data.usage);
  const t0 = t.createdAt;
  const head: HxItem[] = [];
  const ev = (key: string, e: Body) => head.push({ key, e: { src: 'transcript', ref, ...e } as AgentEvent });
  if (child) {
    head.push({
      key: 'spawn',
      e: {
        ts: t0,
        src: 'transcript',
        ref,
        k: 'agent.spawn',
        spawn: {
          childId: agentId!,
          parentToolUseId: parentToolUseId!,
          agentType: t.role === 'reader' ? HARNESS_HELPER : HARNESS_WORKER,
          description: harnessTitle(t.title, t.brief),
        },
      },
    });
  } else {
    ev('meta', { ts: t0, k: 'session.meta', cwd: t.root || undefined, entrypoint: HARNESS });
    ev('title', { ts: t0, k: 'title', title: harnessTitle(t.title, t.brief), kind: 'prompt' });
    // workers run unattended: a writer edits and runs commands without asking, a reader only reads
    ev('mode', { ts: t0, k: 'mode', mode: t.role === 'reader' ? 'plan' : 'bypassPermissions' });
  }
  if (model) ev(`model:${model}`, { ts: t0, k: 'model', model });
  ev('prompt', { ts: t0, k: 'prompt', text: (t.brief || t.title || '(no brief)').slice(0, 4000) });
  ev(`info:run:${t.attempt}`, { ts: t0, k: 'kiln', agentId: infoId, info: taskInfo(t, data, model, false) });

  const { items, open } = agentItems({ sessionId, agentId: infoId, ref, base: agentId ?? harnessAgentId(t.id), model, main: !child }, data, true);
  const out = [...head, ...items];
  const end = taskEnd(t);
  if (end) {
    const last = Math.max(
      t.updatedAt,
      out.reduce((m, i) => Math.max(m, i.e.ts), 0),
    );
    const stamp = `${t.state}:${t.updatedAt}`;
    for (const o of open) {
      out.push({
        key: `e:${o.toolUseId}`,
        e: { ts: last, src: 'transcript', ref, k: 'tool.end', toolUseId: o.toolUseId, ok: false, name: o.name, error: 'interrupted' },
      });
      if (o.childId)
        out.push({
          key: `${o.childId}:stop`,
          e: { ts: last, src: 'transcript', ref, k: 'agent.stop', childId: o.childId, status: 'error', detail: 'interrupted' },
        });
    }
    out.push({ key: `info:${stamp}`, e: { ts: last, src: 'transcript', ref, k: 'kiln', agentId: infoId, info: taskInfo(t, data, model, true) } });
    if (child) {
      out.push({ key: `stop:${stamp}`, e: { ts: last, src: 'transcript', ref, k: 'agent.stop', childId: agentId!, status: end.status, detail: end.detail } });
    } else {
      if (t.summary.trim())
        out.push({
          key: `sum:${stamp}`,
          e: { ts: last, src: 'transcript', ref, k: 'text', role: 'assistant', preview: clip(t.summary.trim(), 400), endTurn: true },
        });
      if (end.status === 'error')
        out.push({ key: `err:${stamp}`, e: { ts: last, src: 'transcript', ref, k: 'attention', kind: 'error', detail: end.detail ?? 'Kiln task failed' } });
      out.push({ key: `end:${stamp}`, e: { ts: last, src: 'transcript', ref, k: 'turn.end' } });
    }
  }
  return out;
}

const MODE: Record<string, string> = {
  bypass: 'bypassPermissions',
  bypassPermissions: 'bypassPermissions',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  default: 'default',
};

/** A local Agent conversation of the Kiln app as a session of its own: the conversation is the main agent. */
export function harnessConversationItems(cv: HxConversation, data: HxData, sessionId: string): HxItem[] {
  const ref = { sessionId, agentId: null };
  const model = harnessModelId(cv.model);
  const t0 = cv.createdAt;
  const head: HxItem[] = [];
  const ev = (key: string, e: Body) => head.push({ key, e: { src: 'transcript', ref, ...e } as AgentEvent });
  ev('meta', { ts: t0, k: 'session.meta', cwd: cv.root || undefined, entrypoint: HARNESS });
  if (cv.title.trim()) ev(`title:${cv.title}`, { ts: t0, k: 'title', title: clip(cv.title.trim(), 120), kind: 'ai' });
  ev(`mode:${cv.mode}`, { ts: t0, k: 'mode', mode: MODE[cv.mode] ?? (cv.mode || 'default') });
  if (model) ev(`model:${model}`, { ts: t0, k: 'model', model });
  const { items } = agentItems({ sessionId, agentId: 'main', ref, base: harnessSessionId(cv.id), model, main: true }, data, false);
  const out = [...head, ...items];
  const td = data.todos;
  if (td && td.items.length)
    out.push({ key: `todos:${td.updatedAt}`, e: { ts: td.updatedAt, src: 'transcript', ref, k: 'todos.replace', items: todoItems(td.items as unknown[]) } });
  if (cv.status === 'error')
    out.push({
      key: `err:${cv.updatedAt}`,
      e: { ts: cv.updatedAt, src: 'transcript', ref, k: 'attention', kind: 'error', detail: 'The Kiln agent stopped with an error' },
    });
  return out;
}

/** The items whose key is not in `sent` (which they are added to). */
export function freshItems(items: HxItem[], sent: Set<string>): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const i of items) {
    if (sent.has(i.key)) continue;
    sent.add(i.key);
    out.push(i.e);
  }
  return out;
}

// ---------------------------------------------------------------- matching a task to its delegate_task call

/** A delegate_task call seen in a Claude session (recorded by the reducer in internal.harnessCalls). */
export interface HarnessCall {
  toolUseId: string;
  agentId: string;
  ts: number;
  title: string;
  brief: string;
  cwd: string;
  endTs?: number;
  taskId?: string;
}

const MATCH_BEFORE_MS = 15_000;
/** delegate_task creates its task at once; a call waits behind other MCP calls at most this long */
const MATCH_PENDING_MS = 10 * 60_000;

const sameDir = (a: string, b: string) => {
  const n = (p: string) =>
    p
      .replace(/[\\/]+/g, '/')
      .replace(/\/$/, '')
      .toLowerCase();
  return !!a && !!b && n(a) === n(b);
};

/**
 * The task a call created, before its result (with the taskId) is in: same title and brief, created between the call and its
 * return (a few minutes while it is still waiting); the closest in time, in the same folder, wins.
 */
export function matchHarnessTask(call: HarnessCall, tasks: Iterable<HxTask>, taken: (taskId: string) => boolean): HxTask | null {
  let best: HxTask | null = null;
  let bestScore = Infinity;
  for (const t of tasks) {
    if (taken(t.id)) continue;
    const dt = t.createdAt - call.ts;
    const latest = call.endTs !== undefined ? Math.max(0, call.endTs - call.ts) + MATCH_BEFORE_MS : MATCH_PENDING_MS;
    if (dt < -MATCH_BEFORE_MS || dt > latest) continue;
    if (call.title.trim() && call.title.trim() !== t.title.trim()) continue;
    if (!sameTask(call.brief, t.brief)) continue;
    const score = Math.abs(dt) + (call.cwd && t.root && !sameDir(call.cwd, t.root) ? 10 * 60_000 : 0);
    if (score < bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return best;
}

/** The delegate_task calls in a session's events (for replay), with the taskIds their results carried. */
export function harnessCallsOf(events: readonly AgentEvent[]): HarnessCall[] {
  const ends = new Map<string, { ts: number; taskId?: string }>();
  for (const e of events) {
    if (e.k !== 'tool.end') continue;
    const prev = ends.get(e.toolUseId);
    ends.set(e.toolUseId, { ts: prev?.ts ?? e.ts, taskId: prev?.taskId ?? e.harnessTaskId });
  }
  let cwd = '';
  const out: HarnessCall[] = [];
  for (const e of events) {
    if (e.k === 'session.meta' && e.cwd && e.ref.agentId === null) cwd = e.cwd;
    if (e.k !== 'tool.start' || !isHarnessDelegate(e.name)) continue;
    const i = obj(e.input);
    const end = ends.get(e.toolUseId);
    out.push({
      toolUseId: e.toolUseId,
      agentId: e.ref.agentId ?? 'main',
      ts: e.ts,
      title: str(i.title),
      brief: str(i.brief),
      cwd,
      endTs: end?.ts,
      taskId: end?.taskId,
    });
  }
  return out;
}

/** Merge extra events into a session's, in time order (stable). */
export function mergeByTime(events: AgentEvent[], extra: AgentEvent[]): AgentEvent[] {
  if (!extra.length) return events;
  return [...events, ...extra]
    .map((e, i) => [e, i] as const)
    .sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1])
    .map(([e]) => e);
}
