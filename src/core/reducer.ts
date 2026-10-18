// Pure-ish reducer: folds AgentEvents into a SessionState. It mutates the state it is given
// (cheap for 10k+ event transcripts) and returns it; callers that need a new identity copy it.

import type { AgentEvent, UsageNumbers } from './events';
import {
  ACTIVITY_CAP,
  LOG_CAP,
  MAIN,
  SEEN_TOOLS_CAP,
  USAGE_MSGS_CAP,
  newAgent,
  newSession,
  type AgentNode,
  type AttentionKind,
  type LogEntry,
  type LogKind,
  type SessionState,
} from './state';
import { summarizeTool, toolLabel } from './summarize';
import { toolCategory } from './goal';
import { COMMANDS_CAP, FILES_CAP, PROMPT_CAP, RECENT_CAP } from './state';

function firstLineOf(t: string, max: number): string {
  const line = (t.split('\n').find((l) => l.trim()) ?? '').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** per-agent bookkeeping for one tool call: mix, recent list, files, commands */
function recordTool(a: AgentNode, id: string, name: string, input: unknown, summary: string, ts: number) {
  const cat = toolCategory(name, input);
  a.toolMix[cat] = (a.toolMix[cat] ?? 0) + 1;
  a.recent.push({ id, name, summary, ts, ok: null });
  if (a.recent.length > RECENT_CAP) a.recent.splice(0, a.recent.length - RECENT_CAP);
  const i = (input && typeof input === 'object' ? input : {}) as Json;
  if (FILE_TOOLS.has(name)) {
    const p = typeof i.file_path === 'string' ? i.file_path : typeof i.notebook_path === 'string' ? i.notebook_path : '';
    if (p) {
      const at = a.files.indexOf(p);
      if (at >= 0) a.files.splice(at, 1);
      a.files.push(p);
      if (a.files.length > FILES_CAP) a.files.splice(0, a.files.length - FILES_CAP);
    }
  } else if ((name === 'Bash' || name === 'PowerShell') && typeof i.command === 'string' && i.command.trim()) {
    const cmd = i.command.trim();
    if (a.commands[a.commands.length - 1] !== cmd) a.commands.push(cmd);
    if (a.commands.length > COMMANDS_CAP) a.commands.splice(0, a.commands.length - COMMANDS_CAP);
  }
}

type Json = Record<string, any>;

const TITLE_RANK = { prompt: 1, ai: 2, custom: 3 } as const;

function agentKey(id: string | null): string {
  return id ?? MAIN;
}

function ensureAgent(s: SessionState, id: string | null, ts: number): AgentNode {
  const key = agentKey(id);
  let a = s.agents[key];
  if (!a) {
    a = newAgent(key, 'agent', ts, MAIN);
    s.agents[key] = a;
  }
  return a;
}

function ensureWorkflow(s: SessionState, runId: string, ts: number): AgentNode {
  const key = `wf:${runId}`;
  let w = s.agents[key];
  if (!w) {
    const toolId = s.internal.workflowToolUse[runId];
    const parent = (toolId && s.internal.seenTools[toolId]) || MAIN;
    w = newAgent(key, 'workflow', ts, parent);
    w.agentType = 'workflow';
    w.description = runId;
    w.depth = (s.agents[parent]?.depth ?? 0) + 1;
    s.agents[key] = w;
  }
  return w;
}

/**
 * seenTools only has to dedupe near-simultaneous copies of a call (hook + transcript) and resolve a spawned agent's parent;
 * once it grows past the cap, drop the oldest entries that nothing refers to any more.
 */
function pruneSeenTools(s: SessionState) {
  const i = s.internal;
  const keep = new Set<string>([...Object.keys(i.pending), ...Object.keys(i.agentByToolUse), ...Object.values(i.workflowToolUse)]);
  for (const a of Object.values(s.agents)) if (a.parentToolUseId) keep.add(a.parentToolUseId);
  if (s.plan?.exitToolUseId) keep.add(s.plan.exitToolUseId);
  let drop = Object.keys(i.seenTools).length - Math.floor(SEEN_TOOLS_CAP * 0.75);
  for (const id of Object.keys(i.seenTools)) {
    if (drop <= 0) break;
    if (keep.has(id)) continue;
    delete i.seenTools[id];
    drop--;
  }
  i.seenCount = Object.keys(i.seenTools).length;
}

function log(s: SessionState, ts: number, agentId: string, kind: LogKind, text: string, attn?: AttentionKind) {
  const entry: LogEntry = { seq: ++s.internal.logSeq, ts, agentId, kind, text: text.length > 240 ? text.slice(0, 239) + '…' : text };
  if (attn) entry.attn = attn;
  s.log.push(entry);
  if (s.log.length > LOG_CAP * 1.2) s.log.splice(0, s.log.length - LOG_CAP);
}

/** a line written within this window of an agent's end belongs to that end, not a resumption */
const REVIVE_GRACE_MS = 2000;

/** Mark activity on an agent: anything clearly newer than its end flips it back to running. */
function touch(s: SessionState, a: AgentNode, ts: number) {
  if (ts > a.lastActivity) a.lastActivity = ts;
  const grace = a.status === 'done' || a.status === 'error' ? REVIVE_GRACE_MS : 0;
  if (a.status !== 'running' && ts > (a.endedAt ?? 0) + grace) {
    a.status = 'running';
    a.endedAt = null;
  }
  if (!s.startedAt || (ts && ts < s.startedAt)) s.startedAt = ts || s.startedAt;
  if (!s.lastActivity || ts > s.lastActivity) s.lastActivity = ts;
  if (a.startedAt === 0 || (ts && ts < a.startedAt)) a.startedAt = ts;
  // a workflow is as active as its busiest agent
  const p = a.parentId ? s.agents[a.parentId] : undefined;
  if (p?.kind === 'workflow' && ts > p.lastActivity) p.lastActivity = ts;
}

function finish(a: AgentNode, status: 'done' | 'error' | 'idle' | 'waiting', ts: number) {
  a.status = status;
  a.endedAt = Math.max(ts, a.lastActivity);
  if (status === 'done' || status === 'error') a.currentTool = null;
}

function addUsage(t: UsageNumbers, u: UsageNumbers, sign: 1 | -1) {
  t.in += sign * u.in;
  t.out += sign * u.out;
  t.cacheRead += sign * u.cacheRead;
  t.cacheWrite += sign * u.cacheWrite;
}

function refreshCurrentTool(s: SessionState, a: AgentNode) {
  let best: { id: string; start: number; name: string; input: unknown } | null = null;
  for (const [id, p] of Object.entries(s.internal.pending)) {
    if (p.agentId === a.id && (!best || p.start > best.start)) best = { id, ...p };
  }
  a.currentTool = best ? { id: best.id, name: best.name, summary: summarizeTool(best.name, best.input), since: best.start, input: best.input } : null;
}

function setTodo(s: SessionState, id: string, patch: { text?: string; status?: string }, owner: string) {
  const t = s.todos.find((x) => x.id === id);
  if (t) {
    if (patch.text) t.text = patch.text;
    if (patch.status) t.status = patch.status;
  } else if (patch.text) {
    s.todos.push({ id, text: patch.text, status: patch.status ?? 'pending', owner });
  }
  if (patch.status === 'deleted') s.todos = s.todos.filter((x) => x.id !== id);
}

function statusFromNotification(status: string): 'done' | 'error' | 'running' {
  const st = status.toLowerCase();
  if (st === 'running' || st === 'async_launched') return 'running';
  if (st === 'completed' || st === 'complete' || st === 'done' || st === 'success') return 'done';
  return 'error';
}

function label(s: SessionState, id: string): string {
  const a = s.agents[id];
  if (!a) return id;
  if (a.kind === 'main') return 'main';
  return a.agentType || 'agent';
}

export function apply(s: SessionState, e: AgentEvent): SessionState {
  s.eventCount++;
  const ts = e.ts;
  if (e.src === 'hook') s.lastHookAt = Math.max(s.lastHookAt ?? 0, ts);

  switch (e.k) {
    case 'session.meta': {
      if (e.ref.agentId === null || !s.cwd) {
        if (e.cwd) s.cwd = e.cwd;
        if (e.version) s.version = e.version;
        if (e.entrypoint) s.entrypoint = e.entrypoint;
        if (e.gitBranch) s.gitBranch = e.gitBranch;
      }
      break;
    }
    case 'title': {
      const cur = s.titleKind ? TITLE_RANK[s.titleKind] : 0;
      if (TITLE_RANK[e.kind] >= cur) {
        s.title = e.title;
        s.titleKind = e.kind;
      }
      break;
    }
    case 'mode': {
      if (e.ref.agentId !== null) break;
      // once hooks are flowing they are authoritative; transcript lines can lag behind
      if (e.src === 'transcript' && s.modeSource === 'hook' && s.lastHookAt && ts < s.lastHookAt) break;
      if (s.mode !== e.mode) {
        log(s, ts, MAIN, 'mode', `mode → ${e.mode}`);
        s.mode = e.mode;
      }
      s.modeSource = e.src;
      break;
    }
    case 'model': {
      const a = ensureAgent(s, e.ref.agentId, ts);
      if (a.model && a.model !== e.model && a.kind === 'main') log(s, ts, a.id, 'model', `model → ${e.model}`);
      a.model = e.model;
      if (e.effort) a.effort = e.effort;
      break;
    }
    case 'prompt': {
      const a = ensureAgent(s, e.ref.agentId, ts);
      touch(s, a, ts);
      const text = e.text.replace(/\s+/g, ' ');
      // the same prompt can arrive from both a hook and the transcript
      const dupe = s.log
        .slice(-8)
        .some((l) => l.kind === 'prompt' && l.agentId === a.id && Math.abs(l.ts - ts) < 120_000 && text.startsWith(l.text.replace(/…$/, '')));
      if (!dupe) log(s, ts, a.id, 'prompt', text);
      if (a.kind === 'main' && !s.title) {
        s.title = text.slice(0, 80);
        s.titleKind = 'prompt';
      }
      if (a.kind === 'agent' && !a.description) a.description = text.slice(0, 120);
      // the task: a subagent's first line, the main agent's latest prompt
      if (a.kind === 'main' || (a.kind === 'agent' && !a.prompt)) a.prompt = e.text.trim().slice(0, PROMPT_CAP);
      break;
    }
    case 'tool.start': {
      const a = ensureAgent(s, e.ref.agentId, ts);
      touch(s, a, ts);
      const known = s.internal.seenTools[e.toolUseId];
      if (!known) {
        s.internal.seenTools[e.toolUseId] = a.id;
        s.internal.seenCount ??= Object.keys(s.internal.seenTools).length;
        if (++s.internal.seenCount > SEEN_TOOLS_CAP) pruneSeenTools(s);
        a.toolCount++;
        a.activity.push(ts);
        if (a.activity.length > ACTIVITY_CAP) a.activity.splice(0, a.activity.length - ACTIVITY_CAP);
        s.internal.pending[e.toolUseId] = { agentId: a.id, name: e.name, input: e.input, start: ts };
        const summary = summarizeTool(e.name, e.input);
        log(s, ts, a.id, 'tool', `${toolLabel(e.name)}${summary ? '  ' + summary : ''}`);
        a.currentTool = { id: e.toolUseId, name: e.name, summary, since: ts, input: e.input };
        recordTool(a, e.toolUseId, e.name, e.input, summary, ts);
        // late parent resolution for children whose meta was read before this call
        if (e.name === 'Agent' || e.name === 'Task') {
          for (const c of Object.values(s.agents)) {
            if (c.parentToolUseId === e.toolUseId && c.parentId !== a.id) {
              c.parentId = a.id;
              c.depth = a.depth + 1;
            }
          }
        }
        if (e.name === 'TaskUpdate') {
          const i = (e.input ?? {}) as Json;
          if (typeof i.taskId === 'string') setTodo(s, i.taskId, { status: i.status, text: i.subject }, a.id);
        }
      }
      break;
    }
    case 'tool.end': {
      const p = s.internal.pending[e.toolUseId];
      const ownerId = p?.agentId ?? s.internal.seenTools[e.toolUseId] ?? agentKey(e.ref.agentId);
      const a = s.agents[ownerId] ?? ensureAgent(s, e.ref.agentId, ts);
      const name = p?.name ?? e.name ?? '';
      const rec = a.recent.find((r) => r.id === e.toolUseId);
      // the hook and the transcript both report a failure; whichever carries the message fills it in
      if (rec && !e.ok && e.error && !rec.error) rec.error = e.error;
      if (p) {
        delete s.internal.pending[e.toolUseId];
        if (rec) rec.ok = e.ok;
        if (!e.ok) {
          a.errorCount++;
          log(s, ts, a.id, 'tool-error', `${toolLabel(name)} failed${e.error ? `: ${firstLineOf(e.error, 140)}` : ''}`);
        }
        if (a.currentTool?.id === e.toolUseId) refreshCurrentTool(s, a);
        touch(s, a, ts);
      }
      if (name === 'ExitPlanMode' && s.plan?.exitToolUseId === e.toolUseId) s.plan.approved = e.ok;
      const r = (e.result ?? null) as Json | null;
      if (r && typeof r === 'object') onToolResult(s, a, name, e.toolUseId, r, e.ok, ts, p?.input);
      // a subagent handing its report back is its last act
      if (p && name === 'SubagentHandback' && a.kind === 'agent' && a.status === 'running') {
        finish(a, 'done', ts);
        log(s, ts, a.id, 'done', 'handed back to caller');
      }
      break;
    }
    case 'usage': {
      const a = ensureAgent(s, e.ref.agentId, ts);
      touch(s, a, ts);
      const book = (s.internal.usage[a.id] ??= {});
      const prev = book[e.msgId];
      if (prev) {
        addUsage(a.tokens, prev, -1);
        addUsage(s.totals, prev, -1);
      }
      if (!prev) {
        const counts = (s.internal.usageCount ??= {});
        counts[a.id] ??= Object.keys(book).length;
        if (++counts[a.id] > USAGE_MSGS_CAP * 1.5) {
          // message ids are only repeated close together: forget the oldest
          const old = Object.keys(book).slice(0, counts[a.id] - USAGE_MSGS_CAP);
          for (const k of old) delete book[k];
          counts[a.id] = Object.keys(book).length + 1;
        }
      }
      book[e.msgId] = e.usage;
      addUsage(a.tokens, e.usage, 1);
      addUsage(s.totals, e.usage, 1);
      const ctx = e.usage.in + e.usage.cacheRead + e.usage.cacheWrite;
      if (ctx > 0 && ts >= a.contextAt) {
        a.contextTokens = ctx;
        a.contextAt = ts;
        if (ctx > a.contextPeak) a.contextPeak = ctx;
      }
      break;
    }
    case 'agent.spawn': {
      const sp = e.spawn;
      const existed = !!s.agents[sp.childId];
      const c = s.agents[sp.childId] ?? newAgent(sp.childId, 'agent', ts, MAIN);
      s.agents[sp.childId] = c;
      if (sp.agentType) c.agentType = sp.agentType;
      if (sp.description) c.description = sp.description;
      if (sp.background !== undefined) c.background = sp.background;
      if (sp.workflowPhase) c.phase = sp.workflowPhase;
      let parent: AgentNode | undefined;
      if (sp.workflowRunId) {
        parent = ensureWorkflow(s, sp.workflowRunId, ts);
        if (parent.status !== 'running' && ts > (parent.endedAt ?? 0)) touch(s, parent, ts);
      } else if (sp.parentToolUseId) {
        c.parentToolUseId = sp.parentToolUseId;
        parent = s.agents[s.internal.seenTools[sp.parentToolUseId] ?? MAIN];
      } else if (!existed) {
        parent = s.agents[MAIN];
      }
      if (parent && parent.id !== c.id) {
        c.parentId = parent.id;
        c.depth = parent.depth + 1;
      }
      if (!existed) {
        c.startedAt = ts;
        c.lastActivity = Math.max(c.lastActivity, ts);
        log(s, ts, c.id, 'agent', `spawned${c.background ? ' (background)' : ''}${c.description ? ': ' + c.description : ''}`);
        // the workflow's completion can be read (from the main transcript) before its agents' files
        if (parent?.kind === 'workflow' && (parent.status === 'done' || parent.status === 'error') && parent.endedAt) {
          c.status = parent.status;
          c.endedAt = parent.endedAt;
        }
      }
      break;
    }
    case 'agent.stop': {
      const c = s.agents[e.childId];
      if (c && c.status !== e.status) {
        const at = e.atLastActivity ? c.lastActivity : ts;
        finish(c, e.status, at);
        log(s, at, c.id, 'done', e.status === 'done' ? 'finished' : 'failed');
      }
      break;
    }
    case 'task.notification': {
      const st = statusFromNotification(e.status);
      const target = s.agents[e.taskId] ?? (s.internal.workflowByTask[e.taskId] ? s.agents[`wf:${s.internal.workflowByTask[e.taskId]}`] : undefined);
      if (target) {
        if (st === 'running') touch(s, target, ts);
        else if (target.status !== st || target.endedAt === null) {
          finish(target, st, ts);
          log(s, ts, target.id, 'done', `${st === 'done' ? 'finished' : 'ended: ' + e.status}${e.summary ? ' · ' + e.summary : ''}`);
          if (target.kind === 'workflow') {
            for (const c of Object.values(s.agents)) if (c.parentId === target.id && c.status === 'running') finish(c, st, ts);
          }
        }
      } else if (st !== 'running' && s.internal.notified[e.taskId] !== e.status) {
        log(s, ts, MAIN, 'notice', `background task ${e.taskId} ${e.status}${e.summary ? ' · ' + e.summary : ''}`);
      }
      s.internal.notified[e.taskId] = e.status;
      break;
    }
    case 'todos.replace': {
      const owner = agentKey(e.ref.agentId);
      s.todos = e.items.map((t) => ({ id: t.id, text: t.text, status: t.status, owner }));
      break;
    }
    case 'plan': {
      if (e.ref.agentId !== null) break;
      const p = (s.plan ??= { text: null, path: null, source: null, at: 0, since: 0, exitToolUseId: null, approved: null });
      if (e.source === 'path' && e.path && p.path && p.path !== e.path) {
        // a new plan file: the old text belongs to the previous plan
        p.text = null;
        p.source = null;
        p.approved = null;
        p.exitToolUseId = null;
        p.at = 0;
        p.since = 0;
      }
      if (e.path) p.path = e.path;
      if (e.text !== undefined && e.source !== 'path' && ts >= p.at) {
        p.text = e.text;
        p.source = e.source;
        p.at = ts;
        if (e.source === 'exit' || !p.since) p.since = ts;
        if (e.source === 'exit') {
          p.exitToolUseId = e.toolUseId ?? null;
          p.approved = null;
        }
      }
      break;
    }
    case 'text': {
      const a = ensureAgent(s, e.ref.agentId, ts);
      touch(s, a, ts);
      a.lastText = e.preview;
      a.lastTextAt = ts;
      log(s, ts, a.id, 'text', e.preview.replace(/\s+/g, ' '));
      break;
    }
    case 'turn.end': {
      const a = ensureAgent(s, e.ref.agentId, ts);
      if (Object.values(s.internal.pending).some((p) => p.agentId === a.id && p.name !== 'Agent' && p.name !== 'Task')) break;
      if (a.kind === 'main') {
        if (a.status === 'running') finish(a, 'idle', ts);
      } else if (a.status === 'running') {
        finish(a, 'done', ts);
        log(s, ts, a.id, 'done', 'finished');
      }
      break;
    }
    case 'cost': {
      s.costUSD = e.totalCostUSD;
      s.costByModel = e.byModel;
      break;
    }
    case 'quota': {
      s.quota = { limitType: e.limitType, status: e.status, resetsAt: e.resetsAt, ts };
      if (e.status === 'rejected') log(s, ts, agentKey(e.ref.agentId), 'attention', `${e.limitType.replace('_', '-')} usage limit reached`, 'quota');
      break;
    }
    case 'compact': {
      log(s, ts, agentKey(e.ref.agentId), 'notice', e.detail ? `compacted · ${e.detail.slice(0, 80)}` : 'context compacted');
      break;
    }
    case 'attention': {
      const a = ensureAgent(s, e.ref.agentId, ts);
      log(s, ts, a.id, 'attention', e.detail, e.kind);
      if (e.kind !== 'error') finish(a, 'waiting', ts);
      break;
    }
    case 'session.end': {
      s.ended = true;
      const m = s.agents[MAIN];
      finish(m, 'idle', ts);
      log(s, ts, MAIN, 'notice', `session ended${e.detail ? ' (' + e.detail + ')' : ''}`);
      break;
    }
    case 'unknown':
      s.warnings++;
      break;
  }
  return s;
}

function onToolResult(s: SessionState, a: AgentNode, name: string, toolUseId: string, r: Json, ok: boolean, ts: number, input?: unknown) {
  switch (name) {
    case 'TaskCreate': {
      const t = r.task as Json | undefined;
      if (t && t.id != null) setTodo(s, String(t.id), { text: String(t.subject ?? ''), status: 'pending' }, a.id);
      break;
    }
    case 'TaskUpdate': {
      if (r.taskId != null && r.statusChange?.to) setTodo(s, String(r.taskId), { status: r.statusChange.to }, a.id);
      break;
    }
    case 'Agent':
    case 'Task': {
      const childId = typeof r.agentId === 'string' ? r.agentId : null;
      if (!childId) {
        if (!ok) log(s, ts, a.id, 'tool-error', 'subagent launch failed');
        break;
      }
      s.internal.agentByToolUse[toolUseId] = childId;
      let c = s.agents[childId];
      if (!c) {
        c = newAgent(childId, 'agent', ts, a.id);
        c.depth = a.depth + 1;
        c.parentToolUseId = toolUseId;
        s.agents[childId] = c;
      }
      if (typeof r.resolvedModel === 'string' && !c.model) c.model = r.resolvedModel;
      if (typeof r.description === 'string' && !c.description) c.description = r.description;
      if (r.isAsync) c.background = true;
      const given = (input as Json | undefined)?.prompt;
      if (typeof given === 'string' && !c.prompt) c.prompt = given.slice(0, 300);
      const st = typeof r.status === 'string' ? r.status : '';
      if (st === 'completed' || (!r.isAsync && st && st !== 'async_launched' && ok)) {
        if (c.status !== 'done') {
          finish(c, 'done', ts);
          log(s, ts, c.id, 'done', 'finished');
        }
      } else if (st === 'rejected' || !ok) {
        finish(c, 'error', ts);
      }
      break;
    }
    case 'Workflow': {
      if (typeof r.runId !== 'string') break;
      s.internal.workflowToolUse[r.runId] = toolUseId;
      if (typeof r.taskId === 'string') s.internal.workflowByTask[r.taskId] = r.runId;
      const w = ensureWorkflow(s, r.runId, ts);
      if (w.parentId !== a.id) {
        w.parentId = a.id;
        w.depth = a.depth + 1;
      }
      if (typeof r.workflowName === 'string') w.agentType = r.workflowName;
      if (typeof r.summary === 'string') w.description = r.summary;
      touch(s, w, ts);
      break;
    }
    case 'SendMessage': {
      const id = typeof r.resumedAgentId === 'string' ? r.resumedAgentId : null;
      if (id && s.agents[id]) touch(s, s.agents[id], ts);
      break;
    }
  }
}

/** Fold a full event list into a fresh session (used by replay and tests). */
export function foldEvents(sessionId: string, events: AgentEvent[], upto = events.length): SessionState {
  const s = newSession(sessionId);
  for (let i = 0; i < upto && i < events.length; i++) apply(s, events[i]);
  return s;
}

export { label as agentLabel };
