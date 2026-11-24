// Google Antigravity CLI (`agy`, Gemini) as a session source. Kiln (the user's harness) runs agy as its "lead" in place of Claude
// Code. agy writes one transcript per conversation, a JSONL step log:
//   ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl
// (agy reports ~/.gemini/antigravity/brain/... as transcript_path but writes under antigravity-cli; both are read). Every line is a
// numbered step:
//   {"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","created_at":"…Z","content":"<USER_REQUEST>…</USER_REQUEST>…"}
//   {"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","model":"gemini-4-neon-high","input_tokens":…,"cache_read_tokens":…,
//    "output_tokens":…,"thinking":"…","content":"…","tool_calls":[{"name":"run_command","args":{"CommandLine":"\"ls -la\""}}]}
//   {"step_index":2,"source":"MODEL","type":"GENERIC","status":"DONE","content":"Created At: …\nCompleted At: …\n<the tool's output>"}
// A response's tool calls carry no ids: their results follow as GENERIC steps, one per call, in call order. Some arguments are
// JSON-encoded strings ("\"/abs/path\""). The plan is the `update_steps` tool (a JSON list of {title, status}). The transcript has
// no cwd: it comes from Kiln's lead_sessions (src/main/harness.ts) or from a run_command Cwd argument.
//
// This module is pure (no fs): src/main/agy.ts tails the file and feeds lines in. The format is the one Kiln's own tailer reads
// (Kiln src/engine/lead/transcript.ts and its agy fixture, agy 1.5.16); unknown step types and fields are ignored.

import type { AgentEvent, TodoInput } from './events';
import { harnessTaskIdOf } from './harness';
import { geminiEffort } from './models';
import { toolShipKinds } from './ship';

export const AGY = 'antigravity';

type Json = Record<string, any>;
/** an AgentEvent without ts, src and ref */
type Body = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, 'ts' | 'src' | 'ref'> : never) : never;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** The app's session id for an agy conversation (no ':' in it: the harness keys claims as `<sessionId>:<toolUseId>`). */
export const agySessionId = (conversationId: string) => `agy-${conversationId}`;
export const agyConversationOf = (sessionId: string): string | null => (sessionId.startsWith('agy-') ? sessionId.slice(4) : null);

/** a running tool this old without any newer step is from an agy that stopped; end it instead of showing it forever */
export const AGY_STALE_TOOL_MS = 30 * 60_000;

/** One JSON-encoded level of an argument unwrapped: "\"ls -la\"" -> "ls -la", "[{…}]" -> the array. */
export function agyArg(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'))) {
    try {
      return JSON.parse(t);
    } catch {
      /* as is */
    }
  }
  return v;
}

export function agyArgs(args: unknown): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(obj(args))) out[k] = agyArg(v);
  return out;
}

const pick = (a: Json, ...keys: string[]): string => {
  for (const k of keys) {
    const v = a[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
};

/** Kiln's harness tools by their own names (the lead sees them through Kiln's MCP bridge, server "kiln-harness_harness"). */
const HARNESS_TOOLS = 'delegate_task|submit_task|task_result|review_task|list_tasks|cancel_task|harness_status|preview_[a-z_]+';
const HARNESS_BARE = new RegExp(`^(delegate_task|submit_task|task_result|review_task|cancel_task|harness_status)$`);
const HARNESS_NS = new RegExp(`^(?:mcp_+)?([\\w.-]*?)(?:__|_|/|:|\\.)(${HARNESS_TOOLS})$`, 'i');

/**
 * An agy tool name -> Claude Code's spelling where the app knows the tool. Kiln's harness tools become `mcp__harness__<tool>`, so the
 * hand-off linking (src/main/harness.ts), labels and countdowns treat an Antigravity lead exactly like a Claude one.
 */
export function agyToolName(name: string, args: Json = {}): string {
  const n = name.trim();
  // an MCP call recorded through a generic tool: {ServerName, ToolName, Arguments}
  const server = pick(args, 'ServerName', 'server_name', 'serverName', 'server');
  const tool = pick(args, 'ToolName', 'tool_name', 'toolName');
  if (/mcp/i.test(n) && server && tool) return agyToolName(`mcp__${server}__${tool}`);
  if (HARNESS_BARE.test(n)) return `mcp__harness__${n}`;
  const h = HARNESS_NS.exec(n);
  if (h && /harness|kiln/i.test(h[1])) return `mcp__harness__${h[2].toLowerCase()}`;
  switch (n.toLowerCase()) {
    case 'run_command':
    case 'run_shell_command':
    case 'shell':
      return 'Bash';
    case 'read_file':
    case 'view_file':
    case 'view_file_outline':
    case 'view_code_item':
      return 'Read';
    case 'write_file':
    case 'write_to_file':
    case 'create_file':
      return 'Write';
    case 'edit_file':
    case 'replace_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'replace':
      return 'Edit';
    case 'list_dir':
    case 'list_directory':
      return 'LS';
    case 'grep_search':
    case 'search_file_content':
    case 'codebase_search':
      return 'Grep';
    case 'find_by_name':
    case 'glob':
      return 'Glob';
    case 'search_web':
    case 'web_search':
    case 'google_web_search':
      return 'WebSearch';
    case 'read_url_content':
    case 'web_fetch':
    case 'fetch_url':
      return 'WebFetch';
    case 'update_steps':
      return 'TodoWrite';
  }
  if (/subagent/i.test(n)) return 'Agent';
  return n || 'tool';
}

/** The plan items of an update_steps call (statuses: pending | in_progress | done | skipped). */
export function agySteps(args: Json): TodoInput[] | null {
  let steps = agyArg(args.steps ?? args.Steps);
  if (typeof steps === 'string') steps = agyArg(steps);
  if (!Array.isArray(steps)) return null;
  return steps.slice(0, 50).map((t, i) => {
    const o = obj(t);
    const st = str(o.status).toLowerCase();
    const status = st === 'in_progress' ? 'in_progress' : st === 'done' || st === 'completed' || st === 'skipped' ? 'completed' : 'pending';
    return { id: String(i + 1), text: clip(str(o.title) || str(o.content) || 'Step', 160), status };
  });
}

/** agy arguments -> the input shape summarizeTool / the reducer know (file_path, command, ...). Big strings are clipped. */
export function agyToolInput(mapped: string, name: string, args: Json): Json {
  const path = pick(args, 'TargetFile', 'AbsolutePath', 'Path', 'FilePath', 'file_path', 'path', 'File');
  switch (mapped) {
    case 'Bash': {
      const out: Json = { command: clip(pick(args, 'CommandLine', 'command', 'Command'), 400) };
      const desc = pick(args, 'toolSummary', 'description');
      if (desc) out.description = clip(desc, 200);
      const cwd = pick(args, 'Cwd', 'cwd');
      if (cwd) out.cwd = cwd;
      return out;
    }
    case 'Read':
    case 'Write':
    case 'Edit':
      return { file_path: path };
    case 'LS':
      return { path: pick(args, 'DirectoryPath', 'Path', 'path') || path };
    case 'Grep': {
      const out: Json = { pattern: clip(pick(args, 'Query', 'Pattern', 'pattern', 'query'), 200) };
      const where = pick(args, 'SearchPath', 'SearchDirectory', 'DirectoryPath', 'path');
      if (where) out.path = where;
      return out;
    }
    case 'Glob': {
      const out: Json = { pattern: clip(pick(args, 'Pattern', 'pattern', 'Query'), 200) };
      const where = pick(args, 'SearchDirectory', 'DirectoryPath', 'path');
      if (where) out.path = where;
      return out;
    }
    case 'WebSearch':
      return { query: clip(pick(args, 'query', 'Query'), 200) };
    case 'WebFetch':
      return { url: pick(args, 'Url', 'url', 'URL') };
    case 'TodoWrite':
      return { todos: (agySteps(args) ?? []).map((t) => ({ content: t.text, status: t.status })) };
    case 'Agent':
      return {
        subagent_type: name,
        description: clip(pick(args, 'TaskName', 'Task', 'description', 'Description', 'toolSummary', 'Prompt', 'prompt'), 200),
        prompt: clip(pick(args, 'Task', 'Prompt', 'prompt', 'TaskName'), 600),
      };
  }
  // the harness hand-off keeps its full brief: the linking matches a task by title and brief before the result is in
  const harness = mapped.startsWith('mcp__harness__');
  const inner = obj(agyArg(args.Arguments ?? args.arguments));
  const src = Object.keys(inner).length && /mcp/i.test(name) ? agyArgs(inner) : args;
  const out: Json = {};
  for (const [k, v] of Object.entries(src).slice(0, 12)) {
    if (k === 'toolSummary' || k === 'ServerName' || k === 'ToolName') continue;
    if (typeof v === 'string') out[k] = clip(v, harness ? 8000 : 200);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** The request the user typed, out of agy's wrapper (<USER_REQUEST>, <ADDITIONAL_METADATA>, <USER_SETTINGS_CHANGE>). */
export function agyPrompt(content: string): string {
  const req = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content)?.[1];
  if (req !== undefined) return req.trim();
  return content
    .replace(/<([A-Z_]+)>[\s\S]*?<\/\1>/g, '')
    .replace(/<\/?[A-Z_]+>/g, '')
    .trim();
}

function tsOf(step: Json, fallback: number): number {
  const t = Date.parse(str(step.created_at));
  return Number.isFinite(t) ? t : fallback;
}

/** when a tool's result step says it completed ("Completed At: 2026-11-24T13:15:57-06:00", the last one wins) */
function completedAt(content: string): number | null {
  let best: number | null = null;
  for (const m of content.slice(0, 2000).matchAll(/Completed At:\s*(\S+)/g)) {
    const t = Date.parse(m[1]);
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best;
}

/** a result step's output without agy's "Created At / Completed At" header */
function outputOf(content: string): string {
  return content.replace(/^(?:(?:Created|Completed) At:[^\n]*\n)+/, '').trim();
}

interface OpenCall {
  id: string;
  name: string;
  raw: string;
  ts: number;
  childId?: string;
}

const isStep = (o: Json) => typeof o.step_index === 'number' && typeof o.type === 'string';

/**
 * Stateful, incremental converter for one agy transcript. push() takes complete lines (a step seen twice is skipped) and returns
 * the new AgentEvents, in transcript order.
 */
export class AgyConverter {
  private seen = new Set<number>();
  private open: OpenCall[] = [];
  private model = '';
  private metaCwd: string | null | undefined = undefined;
  private lastTs = 0;
  /** a run_command Cwd argument: the folder agy works in when nobody told us */
  cwdHint: string | null = null;
  title: string | null = null;

  constructor(
    readonly sessionId: string,
    private cwd: string | null = null,
  ) {}

  private ref(agentId: string | null = null) {
    return { sessionId: this.sessionId, agentId };
  }

  /** The folder the session works in (Kiln's project root): emitted as session metadata once known. */
  setCwd(cwd: string | null, out: AgentEvent[] = []): AgentEvent[] {
    if (cwd && cwd !== this.cwd) {
      this.cwd = cwd;
      if (this.metaCwd !== undefined) this.meta(this.lastTs, out);
    }
    return out;
  }

  get workingDir(): string | null {
    return this.cwd ?? this.cwdHint;
  }

  private meta(ts: number, out: AgentEvent[]) {
    const cwd = this.workingDir;
    if (this.metaCwd !== undefined && this.metaCwd === cwd) return;
    this.metaCwd = cwd;
    out.push({ ts, src: 'transcript', ref: this.ref(), k: 'session.meta', ...(cwd ? { cwd } : {}), entrypoint: AGY });
  }

  pushLines(lines: readonly string[]): AgentEvent[] {
    const out: AgentEvent[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let o: unknown;
      try {
        o = JSON.parse(t);
      } catch {
        continue;
      }
      if (o && typeof o === 'object' && !Array.isArray(o) && isStep(o as Json)) this.step(o as Json, out);
    }
    return out;
  }

  /** End tool calls that never got a result (agy was stopped mid-call), when nothing was written for a long time. */
  flushStale(now: number): AgentEvent[] {
    const out: AgentEvent[] = [];
    if (!this.open.length || now - this.lastTs < AGY_STALE_TOOL_MS) return out;
    for (const c of this.open.splice(0)) this.end(c, this.lastTs + 1, false, 'interrupted (Antigravity stopped)', '', out);
    return out;
  }

  private step(s: Json, out: AgentEvent[]) {
    const idx = s.step_index as number;
    if (this.seen.has(idx)) return;
    this.seen.add(idx);
    const ts = Math.max(tsOf(s, this.lastTs || Date.now()), 0);
    this.lastTs = Math.max(this.lastTs, ts);
    const ev = (e: Body, agentId: string | null = null) => out.push({ ts, src: 'transcript', ref: this.ref(agentId), ...e } as AgentEvent);
    const type = str(s.type);
    const content = str(s.content);
    // the folder may only show in a later call (run_command Cwd): first, emit what is known
    this.meta(ts, out);

    if (type === 'USER_INPUT') {
      const source = str(s.source);
      if (source && source !== 'USER_EXPLICIT' && source !== 'USER') return;
      const text = agyPrompt(content);
      if (!text) return;
      if (!this.title) this.title = clip(text.replace(/\s+/g, ' '), 120);
      ev({ k: 'prompt', text });
      return;
    }

    if (type === 'PLANNER_RESPONSE') {
      // the previous response's calls all have their results by now
      for (const c of this.open.splice(0)) this.end(c, ts, true, '', '', out);
      const model = str(s.model);
      if (model && model !== this.model) {
        this.model = model;
        const effort = geminiEffort(model);
        ev({ k: 'model', model, ...(effort ? { effort } : {}) });
      }
      const u = {
        in: num(s.input_tokens),
        out: num(s.output_tokens) + num(s.thinking_tokens),
        cacheRead: num(s.cache_read_tokens),
        cacheWrite: num(s.cache_write_tokens) + num(s.cache_creation_tokens),
      };
      if (u.in + u.out + u.cacheRead + u.cacheWrite > 0) ev({ k: 'usage', msgId: `agy:${this.sessionId}:${idx}`, usage: u });
      const calls = Array.isArray(s.tool_calls) ? (s.tool_calls as unknown[]).map(obj).filter((c) => str(c.name)) : [];
      if (content.trim()) ev({ k: 'text', role: 'assistant', preview: content.trim().slice(0, 400), endTurn: calls.length === 0 });
      calls.forEach((c, i) => this.call(c, `agy:${idx}:${i}`, ts, out));
      if (!calls.length) ev({ k: 'turn.end' });
      return;
    }

    const status = str(s.status);
    const failed = /\b(error|errored|failed|failure|cancel+ed)\b/i.test(status) || /ERROR/.test(type);
    if (/ERROR/.test(type) && !this.open.length) {
      const detail = clip(outputOf(content).replace(/\s+/g, ' ') || type, 200);
      ev({ k: 'attention', kind: 'error', detail });
      return;
    }
    // a result step (GENERIC, or any other step while calls wait): the oldest waiting call's
    if (this.open.length && (type === 'GENERIC' || /RESULT|OUTPUT|ERROR|TOOL/.test(type))) {
      const c = this.open.shift()!;
      const output = outputOf(content);
      const exit = /Command exited with code (-?\d+)/.exec(content);
      const ok = !failed && !(exit && exit[1] !== '0');
      const done = Math.max(completedAt(content) ?? ts, c.ts);
      this.lastTs = Math.max(this.lastTs, done);
      this.end(c, done, ok, ok ? '' : clip(output.replace(/\s+/g, ' ') || status || 'failed', 300), content, out);
    }
  }

  private call(c: Json, id: string, ts: number, out: AgentEvent[]) {
    const raw = str(c.name);
    const args = agyArgs(c.args ?? c.arguments);
    const name = agyToolName(raw, args);
    const input = agyToolInput(name, raw, args);
    if (name === 'Bash' && !this.cwd && !this.cwdHint && typeof input.cwd === 'string' && input.cwd) {
      this.cwdHint = input.cwd;
      this.meta(ts, out);
    }
    const ship = name === 'Bash' ? toolShipKinds(name, { command: pick(args, 'CommandLine', 'command') }) : [];
    out.push({ ts, src: 'transcript', ref: this.ref(), k: 'tool.start', toolUseId: id, name, input, ...(ship.length ? { ship } : {}) });
    const open: OpenCall = { id, name, raw, ts };
    if (name === 'TodoWrite') {
      const items = agySteps(args);
      if (items) out.push({ ts, src: 'transcript', ref: this.ref(), k: 'todos.replace', items });
    } else if (name === 'Agent') {
      // agy's subagents (browser_subagent, …) leave no transcript of their own: a child that runs until the call returns
      open.childId = `agy-sub-${id.slice(4).replace(':', '-')}`;
      out.push({
        ts,
        src: 'transcript',
        ref: this.ref(open.childId),
        k: 'agent.spawn',
        spawn: { childId: open.childId, parentToolUseId: id, agentType: raw, description: str(input.description) || raw },
      });
      if (this.model) out.push({ ts, src: 'transcript', ref: this.ref(open.childId), k: 'model', model: this.model });
      if (str(input.prompt)) out.push({ ts, src: 'transcript', ref: this.ref(open.childId), k: 'prompt', text: str(input.prompt) });
    }
    this.open.push(open);
  }

  private end(c: OpenCall, ts: number, ok: boolean, error: string, content: string, out: AgentEvent[]) {
    const harnessTaskId = ok && c.name === 'mcp__harness__delegate_task' ? harnessTaskIdOf(content) : null;
    const result = c.childId ? { agentId: c.childId, status: ok ? 'completed' : 'error' } : undefined;
    out.push({
      ts,
      src: 'transcript',
      ref: this.ref(),
      k: 'tool.end',
      toolUseId: c.id,
      ok,
      name: c.name,
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
      ...(harnessTaskId ? { harnessTaskId } : {}),
    });
    if (c.childId) out.push({ ts, src: 'transcript', ref: this.ref(), k: 'agent.stop', childId: c.childId, status: ok ? 'done' : 'error' });
  }
}

/** What the sidebar needs from the head of a transcript: the first request (the title), the model, a Cwd hint. */
export function agyPeek(lines: readonly string[]): { title: string | null; model: string | null; cwd: string | null; firstTs: number | null } {
  const conv = new AgyConverter('peek');
  let model: string | null = null;
  let firstTs: number | null = null;
  for (const e of conv.pushLines(lines)) {
    if (firstTs === null) firstTs = e.ts;
    if (e.k === 'model' && !model) model = e.model;
  }
  return { title: conv.title, model, cwd: conv.cwdHint, firstTs };
}
