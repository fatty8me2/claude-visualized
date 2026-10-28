// OpenCode (sst/opencode) adapter: maps its sessions / messages / parts onto AgentEvents so the reducer, graph, log and overview
// work unchanged. Pure (no fs): src/main/opencode*.ts reads the storage (SQLite since ~1.1, JSON files before) and feeds rows in.
// Defensive on purpose: every field may be missing or a different type in some version; unknown fields are ignored.

import type { AgentEvent, TodoInput, UsageNumbers } from './events';

export const OPENCODE = 'opencode';

type Json = Record<string, any>;

/** A session row, normalized from either storage format. Times are epoch ms. */
export interface OcSession {
  id: string;
  parentId: string | null;
  directory: string;
  title: string;
  version: string;
  agent: string | null;
  timeCreated: number;
  timeUpdated: number;
  archived: boolean;
  /** provider/model of the session row (newer versions) */
  model?: string | null;
}

export interface OcMessage {
  id: string;
  sessionId: string;
  timeCreated: number;
  data: Json;
}

export interface OcPart {
  id: string;
  messageId: string;
  sessionId: string;
  timeCreated: number;
  timeUpdated: number;
  data: Json;
}

export interface OcTodo {
  content: string;
  status: string;
}

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** "openrouter" + "deepseek/x" -> "openrouter/deepseek/x"; a bare model id keeps its provider so classifyModel can tell local from hosted. */
export function openCodeModelId(providerID: unknown, modelID: unknown): string | null {
  const m = str(modelID).trim();
  if (!m) return null;
  const p = str(providerID).trim();
  return p && !m.startsWith(p + '/') ? `${p}/${m}` : m;
}

/** The model of a session row's JSON `model` column ({"id","providerID"} in 1.18, sometimes {"modelID","providerID"}). */
export function parseSessionModel(raw: unknown): string | null {
  let o: Json = {};
  if (typeof raw === 'string') {
    try {
      o = obj(JSON.parse(raw));
    } catch {
      return null;
    }
  } else o = obj(raw);
  return openCodeModelId(o.providerID, o.modelID ?? o.id);
}

const TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  patch: 'Edit',
  multiedit: 'MultiEdit',
  grep: 'Grep',
  glob: 'Glob',
  list: 'LS',
  ls: 'LS',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  codesearch: 'WebSearch',
  task: 'Agent',
  todowrite: 'TodoWrite',
  todoread: 'TodoRead',
  skill: 'Skill',
};

export function mapToolName(tool: string): string {
  return TOOL_NAMES[tool.toLowerCase()] ?? tool;
}

/** OpenCode tool input -> the shape summarizeTool / the reducer know (file_path, command, ...). Big strings are dropped or clipped. */
export function mapToolInput(tool: string, input: unknown): Json {
  const i = obj(input);
  const out: Json = {};
  const path = str(i.filePath) || str(i.file_path) || str(i.path);
  switch (tool.toLowerCase()) {
    case 'read':
    case 'edit':
    case 'write':
    case 'multiedit':
      out.file_path = path;
      break;
    case 'bash':
      out.command = clip(str(i.command), 400);
      if (i.description) out.description = clip(str(i.description), 200);
      break;
    case 'grep':
      out.pattern = clip(str(i.pattern), 200);
      if (path) out.path = path;
      break;
    case 'glob':
      out.pattern = clip(str(i.pattern), 200);
      break;
    case 'webfetch':
      out.url = str(i.url);
      break;
    case 'websearch':
    case 'codesearch':
      out.query = clip(str(i.query), 200);
      break;
    case 'task':
      out.subagent_type = str(i.subagent_type) || str(i.subagentType);
      out.description = clip(str(i.description), 200);
      out.prompt = clip(str(i.prompt), 600);
      break;
    case 'todowrite':
      out.todos = Array.isArray(i.todos) ? i.todos.slice(0, 50).map((t) => ({ content: clip(str(obj(t).content), 160), status: str(obj(t).status) })) : [];
      break;
    case 'skill':
      out.skill = str(i.name) || str(i.skill);
      break;
    default:
      for (const [k, v] of Object.entries(i).slice(0, 8)) {
        if (typeof v === 'string') out[k] = clip(v, 200);
        else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
      }
  }
  return out;
}

/** Default titles OpenCode gives a session before it has named it. */
export function isPlaceholderTitle(t: string): boolean {
  return !t.trim() || /^(new session|child session)\b/i.test(t.trim());
}

/** tokens of one step -> the usage the reducer sums. Reasoning tokens count as output. */
export function stepUsage(tokens: unknown): UsageNumbers | null {
  const t = obj(tokens);
  const c = obj(t.cache);
  const u = { in: num(t.input), out: num(t.output) + num(t.reasoning), cacheRead: num(c.read), cacheWrite: num(c.write) };
  return u.in + u.out + u.cacheRead + u.cacheWrite > 0 ? u : null;
}

/** a running tool this old without an update is from an OpenCode that died; end it instead of showing it forever */
export const STALE_TOOL_MS = 30 * 60_000;

interface ToolSeen {
  started: boolean;
  ended: boolean;
  agent: string | null;
}

/**
 * Stateful, idempotent converter for one top-level session and its child sessions (OpenCode subagents).
 * feed() may be given the same rows again (overlapping reads) and only emits what is new.
 */
export class OpenCodeConverter {
  private tools = new Map<string, ToolSeen>();
  private usageSeen = new Set<string>();
  private stepMsgs = new Set<string>();
  private promptSeen = new Set<string>();
  private textSeen = new Set<string>();
  private turnEnded = new Set<string>();
  private spawned = new Set<string>();
  private lastModel = new Map<string, string>();
  private cost = new Map<string, number>();
  private costSent = -1;
  private costModels = new Map<string, number>();
  private msgRole = new Map<string, string>();
  private msgDone = new Map<string, Json>();
  private metaSent = false;
  private titleSent = '';
  private todoSig = '';
  /** child session id -> id of the task tool part that spawned it */
  private spawnTool = new Map<string, string>();

  constructor(readonly rootId: string) {}

  private ref(sessionId: string) {
    return { sessionId: this.rootId, agentId: sessionId === this.rootId ? null : sessionId };
  }

  feed(
    sessions: readonly OcSession[],
    messages: readonly OcMessage[],
    parts: readonly OcPart[],
    todos: readonly OcTodo[] | null,
    now = Date.now(),
  ): AgentEvent[] {
    const out: AgentEvent[] = [];
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const root = byId.get(this.rootId);
    const push = (e: { ts: number; k: AgentEvent['k']; sid: string; [key: string]: unknown }) => {
      const { sid, ...rest } = e;
      out.push({ ...rest, src: 'transcript', ref: this.ref(sid) } as unknown as AgentEvent);
    };

    if (root && !this.metaSent) {
      this.metaSent = true;
      out.push({
        ts: root.timeCreated,
        src: 'transcript',
        ref: this.ref(this.rootId),
        k: 'session.meta',
        cwd: root.directory || undefined,
        version: root.version || undefined,
        entrypoint: OPENCODE,
      });
    }
    if (root && !isPlaceholderTitle(root.title) && root.title !== this.titleSent) {
      this.titleSent = root.title;
      out.push({ ts: root.timeUpdated, src: 'transcript', ref: this.ref(this.rootId), k: 'title', title: clip(root.title, 120), kind: 'ai' });
    }

    for (const m of messages) {
      const role = str(m.data.role);
      this.msgRole.set(m.id, role);
      if (role === 'assistant') this.msgDone.set(m.id, m.data);
      const mid =
        role === 'user' ? openCodeModelId(obj(m.data.model).providerID, obj(m.data.model).modelID) : openCodeModelId(m.data.providerID, m.data.modelID);
      if (mid && this.lastModel.get(m.sessionId) !== mid) {
        this.lastModel.set(m.sessionId, mid);
        const effort = str(m.data.variant) || undefined;
        push({ ts: m.timeCreated, k: 'model', model: mid, effort, sid: m.sessionId });
      }
      if (role === 'assistant') {
        const c = num(m.data.cost);
        if (c > 0 && mid) {
          this.cost.set(m.id, c);
          this.costModels.set(m.id, c);
        }
      }
    }

    const ordered = [...parts].sort((a, b) => a.timeCreated - b.timeCreated || (a.id < b.id ? -1 : 1));
    for (const p of ordered) this.part(p, push, now);

    // children appear as sessions with a parent; link to the task tool that started them
    for (const s of [...sessions].sort((a, b) => a.timeCreated - b.timeCreated)) {
      if (s.id === this.rootId || !s.parentId || this.spawned.has(s.id)) continue;
      const parentKnown = s.parentId === this.rootId || this.spawned.has(s.parentId);
      if (!parentKnown && byId.has(s.parentId)) continue; // wait for its parent in this same pass (sorted by creation)
      this.spawned.add(s.id);
      const tool = this.spawnTool.get(s.id);
      push({
        ts: s.timeCreated,
        k: 'agent.spawn',
        spawn: {
          childId: s.id,
          parentToolUseId: tool,
          agentType: s.agent || agentFromTitle(s.title) || 'subagent',
          description: clip(s.title.replace(/\s*\(@\w+ subagent\)\s*$/, ''), 120),
        },
        sid: s.id,
      });
    }

    // assistant messages without step-finish parts (older versions): their own token counts
    for (const [id, d] of this.msgDone) {
      const done = num(obj(d.time).completed);
      if (!done || this.stepMsgs.has(id) || this.usageSeen.has('m:' + id)) continue;
      const u = stepUsage(d.tokens);
      if (!u) continue;
      this.usageSeen.add('m:' + id);
      const sid = messages.find((m) => m.id === id)?.sessionId;
      if (sid) push({ ts: done, k: 'usage', msgId: id, usage: u, sid });
    }
    for (const m of messages) {
      if (m.data.role !== 'assistant' || this.turnEnded.has(m.id)) continue;
      const done = num(obj(m.data.time).completed);
      const finish = str(m.data.finish);
      if (done && finish && finish !== 'tool-calls' && finish !== 'unknown') {
        this.turnEnded.add(m.id);
        push({ ts: done, k: 'turn.end', sid: m.sessionId });
      }
      const err = obj(m.data.error);
      if (err.name && !this.turnEnded.has('e:' + m.id)) {
        this.turnEnded.add('e:' + m.id);
        const detail = clip(str(obj(err.data).message) || str(err.name), 200);
        push({ ts: done || m.timeCreated, k: 'attention', kind: 'error', detail, sid: m.sessionId });
      }
    }

    if (todos) {
      const items: TodoInput[] = todos.map((t, i) => ({ id: String(i + 1), text: clip(t.content, 160), status: t.status }));
      this.emitTodos(items, now, push);
    }

    const total = [...this.cost.values()].reduce((a, b) => a + b, 0);
    if (total > 0 && total !== this.costSent) {
      this.costSent = total;
      const byModel: Record<string, number> = {};
      for (const [id, c] of this.cost) {
        const mid = this.lastModelOfMessage(id, messages);
        if (mid) byModel[mid] = (byModel[mid] ?? 0) + c;
      }
      out.push({ ts: now, src: 'transcript', ref: this.ref(this.rootId), k: 'cost', totalCostUSD: total, byModel });
    }
    return out;
  }

  private modelByMsg = new Map<string, string>();
  private lastModelOfMessage(id: string, messages: readonly OcMessage[]): string | null {
    const m = messages.find((x) => x.id === id);
    if (m) {
      const mid = openCodeModelId(m.data.providerID, m.data.modelID);
      if (mid) this.modelByMsg.set(id, mid);
    }
    return this.modelByMsg.get(id) ?? null;
  }

  private emitTodos(items: TodoInput[], ts: number, push: (e: any) => void) {
    const sig = JSON.stringify(items.map((t) => [t.text, t.status]));
    if (sig === this.todoSig) return;
    this.todoSig = sig;
    push({ ts, k: 'todos.replace', items, sid: this.rootId });
  }

  private part(p: OcPart, push: (e: any) => void, now: number) {
    const d = obj(p.data);
    const type = str(d.type);
    const role = this.msgRole.get(p.messageId) ?? '';
    const sid = p.sessionId;
    switch (type) {
      case 'text': {
        const text = str(d.text);
        if (!text.trim() || d.synthetic === true || d.ignored === true) break;
        if (role === 'user') {
          if (this.promptSeen.has(p.id)) break;
          this.promptSeen.add(p.id);
          push({ ts: num(obj(d.time).start) || p.timeCreated, k: 'prompt', text, sid });
        } else if (num(obj(d.time).end) && !this.textSeen.has(p.id)) {
          this.textSeen.add(p.id);
          push({ ts: num(obj(d.time).end), k: 'text', role: 'assistant', preview: clip(text.replace(/\s+/g, ' ').trim(), 200), endTurn: false, sid });
        }
        break;
      }
      case 'step-finish': {
        this.stepMsgs.add(p.messageId);
        if (this.usageSeen.has(p.id)) break;
        const u = stepUsage(d.tokens);
        if (!u) break;
        this.usageSeen.add(p.id);
        const c = num(d.cost);
        if (c > 0) this.cost.set(p.messageId, Math.max(this.cost.get(p.messageId) ?? 0, c));
        push({ ts: p.timeUpdated || p.timeCreated, k: 'usage', msgId: p.id, usage: u, sid });
        break;
      }
      case 'tool': {
        const tool = str(d.tool);
        if (!tool) break;
        const st = obj(d.state);
        const status = str(st.status) || 'pending';
        let seen = this.tools.get(p.id);
        if (!seen) {
          seen = { started: false, ended: false, agent: sid };
          this.tools.set(p.id, seen);
        }
        const name = mapToolName(tool);
        const time = obj(st.time);
        const startTs = num(time.start) || p.timeCreated;
        const child = str(obj(st.metadata).sessionId);
        if (tool === 'task' && child) this.spawnTool.set(child, p.id);
        if (!seen.started) {
          seen.started = true;
          push({ ts: startTs, k: 'tool.start', toolUseId: p.id, name, input: mapToolInput(tool, st.input), sid });
        }
        if (tool === 'todowrite' && Array.isArray(obj(st.input).todos) && status !== 'error') {
          const items = (obj(st.input).todos as unknown[]).map((t, i) => ({
            id: String(i + 1),
            text: clip(str(obj(t).content), 160),
            status: str(obj(t).status) || 'pending',
          }));
          this.emitTodos(items, startTs, push);
        }
        if (seen.ended) break;
        const endTs = num(time.end) || p.timeUpdated || now;
        if (status === 'completed' || status === 'error') {
          seen.ended = true;
          const ok = status === 'completed';
          const result: Json | undefined =
            tool === 'task' ? { agentId: child || undefined, status: ok ? 'completed' : 'error', description: str(obj(st.input).description) } : undefined;
          push({ ts: endTs, k: 'tool.end', toolUseId: p.id, ok, name, result, error: ok ? undefined : clip(str(st.error), 300), sid });
        } else if ((status === 'running' || status === 'pending') && now - (p.timeUpdated || startTs) > STALE_TOOL_MS) {
          seen.ended = true;
          push({ ts: (p.timeUpdated || startTs) + 1, k: 'tool.end', toolUseId: p.id, ok: false, name, error: 'interrupted (OpenCode stopped)', sid });
        }
        break;
      }
      default:
        break; // reasoning, patch, step-start, snapshot, agent, file, retry, compaction ...
    }
    if (type === 'compaction' && !this.promptSeen.has('c:' + p.id)) {
      this.promptSeen.add('c:' + p.id);
      push({ ts: p.timeCreated, k: 'compact', sid });
    }
  }
}

function agentFromTitle(title: string): string | null {
  return /\(@(\w+) subagent\)/.exec(title)?.[1] ?? null;
}
