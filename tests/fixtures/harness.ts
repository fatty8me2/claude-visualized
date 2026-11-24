// A fake harness.db of Kiln's agent harness, for tests: the real schema of the tables Claude Visualized reads (column lists copied
// from the harness's migrations: legacy 1-2, 003-foundation, 006-review, 014-model-rules, 016-speed, 019-local-tries), written
// the way the harness writes it (one events row per durable change, messages as ChatMessage JSON, times in epoch ms).
// Sanitized: no real paths, names or content.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LEAD_SESSIONS_SQL } from './agy';

const SCHEMA = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  check_commands TEXT NOT NULL DEFAULT '[]',
  worker_model TEXT,
  allowed_providers TEXT NOT NULL DEFAULT '["ollama","openai-compat"]',
  trusted INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  role TEXT NOT NULL,
  state TEXT NOT NULL,
  model TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  repair_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  feedback TEXT,
  last_checks TEXT,
  state_reason TEXT,
  checkpoint_before TEXT,
  checkpoint_after TEXT,
  lead_session_id TEXT,
  reported INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX tasks_project ON tasks(project_id, updated_at);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  task_id TEXT,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_conv ON messages(conversation_id, created_at);
CREATE INDEX messages_task ON messages(task_id, created_at);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT,
  payload TEXT NOT NULL
);
CREATE TABLE usage_records (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  task_id TEXT,
  conversation_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX usage_ts ON usage_records(ts);
ALTER TABLE tasks ADD COLUMN tier TEXT NOT NULL DEFAULT 'local';
ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'default';
ALTER TABLE conversations ADD COLUMN think INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN context_tokens INTEGER;
CREATE TABLE todos (
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  items TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_kind, owner_id)
);
ALTER TABLE tasks ADD COLUMN commit_sha TEXT;
ALTER TABLE tasks ADD COLUMN routing TEXT;
ALTER TABLE usage_records ADD COLUMN ttft_ms INTEGER;
ALTER TABLE usage_records ADD COLUMN gen_ms INTEGER;
ALTER TABLE usage_records ADD COLUMN total_ms INTEGER;
ALTER TABLE usage_records ADD COLUMN decode_tps REAL;
ALTER TABLE usage_records ADD COLUMN estimated INTEGER;
ALTER TABLE tasks ADD COLUMN local_tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN tuning TEXT;
`;

export const QWEN = { provider: 'openai-compat', model: 'local/qwen3.8-27b-q6' };

export class FakeHarness {
  db: DatabaseSync;
  private n = 0;
  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fresh = !fs.existsSync(file);
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    if (fresh) this.db.exec(SCHEMA);
  }

  private id(prefix: string) {
    return `${prefix}_${(++this.n).toString(16).padStart(12, '0')}`;
  }

  /** the bus: every durable change appends an events row */
  event(type: string, ts: number, taskId: string | null = null) {
    this.db.prepare('INSERT INTO events(ts, type, project_id, task_id, payload) VALUES(?,?,?,?,?)').run(ts, type, null, taskId, '{}');
  }

  project(id: string, root: string, ts: number) {
    this.db.prepare('INSERT INTO projects(id, name, root_path, created_at) VALUES(?,?,?,?)').run(id, path.basename(root), root, ts);
  }

  task(t: {
    id: string;
    project: string;
    title: string;
    brief: string;
    state: string;
    ts: number;
    role?: string;
    tier?: string;
    model?: object | null;
    summary?: string;
    reason?: string;
  }) {
    this.db
      .prepare(
        'INSERT INTO tasks(id, project_id, title, brief, acceptance, role, state, model, tier, summary, state_reason, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        t.id,
        t.project,
        t.title,
        t.brief,
        'Tests pass.',
        t.role ?? 'writer',
        t.state,
        t.model === null ? null : JSON.stringify(t.model ?? QWEN),
        t.tier ?? 'local',
        t.summary ?? null,
        t.reason ?? null,
        t.ts,
        t.ts,
      );
    this.event('task.created', t.ts, t.id);
  }

  setTask(id: string, patch: { state?: string; summary?: string; reason?: string; tier?: string; model?: object }, ts: number) {
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    const cols = { state: 'state', summary: 'summary', reason: 'state_reason', tier: 'tier', model: 'model' } as const;
    for (const [k, col] of Object.entries(cols)) {
      const v = patch[k as keyof typeof patch];
      if (v === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(typeof v === 'string' ? v : JSON.stringify(v));
    }
    sets.push('updated_at = ?');
    vals.push(ts, id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    this.event('task.updated', ts, id);
  }

  conversation(c: { id: string; project: string; title: string; ts: number; status?: string; model?: object; mode?: string }) {
    this.db
      .prepare('INSERT INTO conversations(id, project_id, title, model, status, mode, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(
        c.id,
        c.project,
        c.title,
        JSON.stringify(c.model ?? { provider: 'ollama', model: 'qwen3.8:27b' }),
        c.status ?? 'idle',
        c.mode ?? 'default',
        c.ts,
        c.ts,
      );
    this.event('conversation.created', c.ts);
  }

  setConversation(id: string, status: string, ts: number) {
    this.db.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, id);
    this.event('conversation.updated', ts);
  }

  /** a ChatMessage row of a task or a conversation; returns its id */
  message(owner: { task?: string; conversation?: string }, message: object, ts: number, id = this.id('msg')): string {
    this.db
      .prepare('INSERT INTO messages(id, conversation_id, task_id, message, created_at) VALUES(?,?,?,?,?)')
      .run(id, owner.conversation ?? null, owner.task ?? null, JSON.stringify(message), ts);
    this.event(owner.task ? 'task.message' : 'conversation.message', ts, owner.task ?? null);
    if (owner.conversation) this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(ts, owner.conversation);
    return id;
  }

  usage(owner: { task?: string; conversation?: string }, u: { in: number; out: number; ts: number; model?: string; provider?: string; tps?: number }) {
    this.db
      .prepare(
        'INSERT INTO usage_records(id, ts, task_id, conversation_id, provider, model, input_tokens, output_tokens, cost_usd, source, decode_tps) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        this.id('use'),
        u.ts,
        owner.task ?? null,
        owner.conversation ?? null,
        u.provider ?? QWEN.provider,
        u.model ?? QWEN.model,
        u.in,
        u.out,
        0,
        'local',
        u.tps ?? 42,
      );
    this.event('usage.recorded', u.ts, owner.task ?? null);
  }

  todos(kind: 'task' | 'conversation', id: string, items: { content: string; status: string }[], ts: number) {
    this.db.prepare('INSERT OR REPLACE INTO todos(owner_kind, owner_id, items, updated_at) VALUES(?,?,?,?)').run(kind, id, JSON.stringify(items), ts);
    this.event(`${kind}.todos`, ts);
  }

  /** a lead session Kiln launched (Claude Code, Codex or Antigravity), in Kiln's lead_sessions table (created on first use) */
  leadSession(l: { kind: 'claude' | 'codex' | 'agy'; nativeId: string; project: string; ts: number; transcript?: string }) {
    const has = this.db.prepare("select 1 from sqlite_master where type = 'table' and name = 'lead_sessions'").get();
    if (!has) this.db.exec(LEAD_SESSIONS_SQL);
    this.db
      .prepare('INSERT INTO lead_sessions(id, project_id, kind, native_session_id, started_at, transcript_path) VALUES(?,?,?,?,?,?)')
      .run(this.id('lead'), l.project, l.kind, l.nativeId, l.ts, l.transcript ?? null);
    this.event('lead.session', l.ts);
  }

  close() {
    this.db.close();
  }
}

/** an assistant message with tool calls */
export const asst = (content: string, calls: [id: string, name: string, args: object][] = []) => ({
  role: 'assistant',
  content,
  ...(calls.length ? { toolCalls: calls.map(([id, name, args]) => ({ id, name, arguments: args })) } : {}),
});
export const toolMsg = (toolCallId: string, toolName: string, content: string, extra: object = {}) => ({
  role: 'tool',
  toolCallId,
  toolName,
  content,
  ...extra,
});
export const SYSTEM = { role: 'system', content: 'You are a coding worker.' };
export const userMsg = (content: string) => ({ role: 'user', content });

/** what the harness's MCP server returns for delegate_task (JSON.stringify(value, null, 2), mcp/server.ts) */
export const delegateResult = (taskId: string) =>
  JSON.stringify(
    {
      taskId,
      tier: 'local',
      state: 'implementing',
      model: `${QWEN.provider}:${QWEN.model}`,
      note: null,
      subagent: null,
      next: `Call task_result with taskId "${taskId}" and wait=true.`,
    },
    null,
    2,
  );

/** a sub-agent trace on a `task` tool result (toolkit/task.ts) */
export const subTrace = (steps: [tool: string, summary: string, ok: boolean][], over: object = {}) => ({
  type: 'explore',
  description: 'Find the tax helpers',
  steps: steps.map(([tool, summary, ok]) => ({ tool, summary, ok })),
  turns: 4,
  inputTokens: 18_000,
  outputTokens: 900,
  durationMs: 20_000,
  outcome: 'done',
  ...over,
});
