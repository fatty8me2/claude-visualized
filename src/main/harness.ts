// Kiln's agent harness as a session source (see src/core/harness.ts). Strictly read-only: opens the harness's SQLite database
// (<Kiln userData>/harness.db) with readOnly: true, runs short SELECTs, never writes, never sets a pragma that changes the file,
// and never reads anything else of Kiln's (its secrets.json holds a bridge token: never touched).
//
// MAX(events.seq) is the cheap change signal (the harness appends a row there for every durable change: a message, a usage
// record, a task update). Tasks a Claude session's delegate_task calls created are injected into that session's watcher as child
// agents; tasks no session claims and the app's local Agent conversations are listed as sessions of their own.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentEvent } from '@core/events';
import {
  HARNESS,
  freshItems,
  harnessCallsOf,
  harnessConversationItems,
  harnessSessionId,
  harnessTaskItems,
  harnessTitle,
  matchHarnessTask,
  mergeByTime,
  parseHxMessage,
  parseHxModel,
  taskFinished,
  taskShown,
  type HxConversation,
  type HxData,
  type HxItem,
  type HxMessage,
  type HxTask,
  type HxUsage,
} from '@core/harness';
import { sameDir } from '@core/kiln';
import { MAIN, newSession, type SessionState, type SessionSummary } from '@core/state';
import { apply } from '@core/reducer';
import { projectName } from '@core/history';
import { LIVE_MS } from './indexer';
import type { Foldable } from './kiln';
import { normalizeBaseUrl } from '@core/localModels';

type Json = Record<string, any>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : 0);

/** Where the Kiln app keeps harness.db (Electron userData of the app named "Kiln"; it was called CustomHarness before). */
export function harnessDbCandidates(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir(), platform: string = process.platform): string[] {
  const test = env.CLAUDE_VIS_HARNESS_DB?.trim();
  if (test) return [test];
  // tests that point CLAUDE_VIS_HOME at a fixture must never read the real Kiln data of the machine they run on
  if (env.CLAUDE_VIS_HOME?.trim()) return [];
  const out: string[] = [];
  if (env.HARNESS_PROFILE_DIR?.trim()) out.push(path.join(env.HARNESS_PROFILE_DIR.trim(), 'harness.db'));
  let base: string;
  if (platform === 'darwin') base = path.join(home, 'Library', 'Application Support');
  else if (platform === 'win32') base = env.APPDATA?.trim() || path.join(home, 'AppData', 'Roaming');
  else base = env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config');
  for (const name of ['Kiln', 'kiln', 'CustomHarness']) out.push(path.join(base, name, 'harness.db'));
  return out;
}

export interface HarnessOptions {
  enabled: boolean;
}

/** how often the change signal is re-read even when MAX(seq) did not move (a row that missed its event) */
const FORCE_MS = 5_000;
const DETECT_MS = 5_000;
const TASK_LIMIT = 300;
const CONV_LIMIT = 100;
/** a task no session claims is listed when it is this recent */
const ORPHAN_MAX_AGE = 3 * 24 * 3_600_000;
const MAX_ORPHANS = 100;
/** a followed session that has not claimed a task in its folder this long after it was created does not own it */
const UNCLAIMED_MS = 60_000;
const MSG_CONTENT = 2000;

const TASK_SQL = `select t.id, t.title, substr(t.brief, 1, 4000) as brief, t.role, t.state, t.model, t.tier,
  substr(coalesce(t.summary, ''), 1, 4000) as summary, coalesce(t.state_reason, '') as state_reason, t.attempt, t.created_at, t.updated_at,
  coalesce(p.root_path, '') as root, (select count(*) from messages m where m.task_id = t.id) as n
  from tasks t left join projects p on p.id = t.project_id`;

const CONV_SQL = `select c.id, c.title, c.model, c.status, c.mode, c.created_at, c.updated_at, coalesce(p.root_path, '') as root,
  (select count(*) from messages m where m.conversation_id = c.id) as n
  from conversations c left join projects p on p.id = c.project_id where coalesce(c.archived, 0) = 0
  order by c.updated_at desc limit ${CONV_LIMIT}`;

/** only the fields the mapper reads: a big write_file argument or tool output is clipped by SQLite, not parsed here */
const MSG_COLS = `id, created_at, json_extract(message, '$.role') as role, substr(json_extract(message, '$.content'), 1, ${MSG_CONTENT}) as content,
  json_extract(message, '$.toolCalls') as calls, json_extract(message, '$.toolCallId') as tcid, json_extract(message, '$.toolName') as tname,
  json_extract(message, '$.isError') as err, json_extract(message, '$.subagent') as sub`;

function taskOf(r: Json): HxTask {
  return {
    id: str(r.id),
    title: str(r.title),
    brief: str(r.brief),
    role: str(r.role),
    state: str(r.state),
    model: parseHxModel(r.model),
    tier: str(r.tier) || 'local',
    summary: str(r.summary),
    stateReason: str(r.state_reason),
    attempt: num(r.attempt) || 1,
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    root: str(r.root),
    messages: num(r.n),
  };
}

function convOf(r: Json): HxConversation {
  return {
    id: str(r.id),
    title: str(r.title),
    model: parseHxModel(r.model),
    status: str(r.status),
    mode: str(r.mode),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    root: str(r.root),
    messages: num(r.n),
  };
}

const parse = (v: unknown): unknown => {
  if (typeof v !== 'string') return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
};

function messageOf(r: Json): HxMessage | null {
  return parseHxMessage(str(r.id), num(r.created_at), {
    role: r.role,
    content: r.content,
    toolCalls: parse(r.calls),
    toolCallId: r.tcid,
    toolName: r.tname,
    isError: r.err,
    subagent: parse(r.sub),
  });
}

/** A task's or conversation's rows, read incrementally. `gen` changes when rows went away (a rewind or compaction). */
interface Owner {
  kind: 'task' | 'conversation';
  id: string;
  data: HxData;
  /** bumped whenever the data changed */
  version: number;
  gen: number;
  checked: string;
  count: number;
  maxTs: number;
  ids: Set<string>;
  usageCount: number;
  usageMax: number;
  todosAt: number;
}

interface Link {
  taskId: string;
  sent: Set<string>;
  stamp: string;
}

export class HarnessSource {
  file: string | null = null;
  private enabled = false;
  private db: DatabaseSync | null = null;
  private lastDetect = 0;
  /** the change signal: MAX(events.seq), and a counter bumped on every reload */
  private signal = '';
  private lastSeq = '';
  private tick = 0;
  private lastForce = 0;
  /** bumped on every change, so callers can skip work */
  version = 0;
  private tasks: HxTask[] = [];
  private taskById = new Map<string, { t: HxTask; at: string }>();
  private convs: HxConversation[] = [];
  private owners = new Map<string, Owner>();
  /** task id -> "<sessionId>:<toolUseId>" of the call that claimed it */
  private claimed = new Map<string, string>();
  private links = new WeakMap<SessionState, Map<string, Link>>();
  private summaryCache: SessionSummary[] = [];
  private summaryKey = '';
  private endpointList: { id: string; name: string; url: string }[] = [];
  private lastEndpointsAt = 0;

  setConfig(o: HarnessOptions) {
    this.enabled = o.enabled;
    this.close();
    this.file = null;
    this.lastDetect = 0;
    this.endpointList = [];
    this.lastEndpointsAt = 0;
    this.reset();
    if (o.enabled) this.detect();
  }

  /** Model servers the harness runs itself (read from its settings), for the local-model monitor; [] when disabled. */
  endpoints(): { id: string; name: string; url: string }[] {
    return this.enabled ? this.endpointList : [];
  }

  get active(): boolean {
    return !!this.file;
  }

  private reset() {
    this.signal = '';
    this.lastSeq = '';
    this.tasks = [];
    this.convs = [];
    this.taskById.clear();
    this.owners.clear();
    this.claimed.clear();
    this.links = new WeakMap();
    this.summaryKey = '';
    this.version++;
  }

  private detect() {
    if (!this.enabled || this.file || Date.now() - this.lastDetect < DETECT_MS) return;
    this.lastDetect = Date.now();
    this.file = harnessDbCandidates().find((f) => fs.existsSync(f)) ?? null;
  }

  private open(): DatabaseSync | null {
    if (this.db) return this.db;
    if (!this.file) return null;
    try {
      this.db = new DatabaseSync(this.file, { readOnly: true });
      // a read waits briefly for the harness's writer instead of failing (a connection setting, nothing is written)
      this.db.exec('PRAGMA busy_timeout = 250');
    } catch {
      this.db = null;
    }
    return this.db;
  }

  close() {
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
    this.db = null;
    this.endpointList = [];
  }

  /** The worker's own model server(s), straight from the harness settings (a DB without a settings table just yields []). */
  private readEndpoints(db: DatabaseSync) {
    try {
      const rows = db.prepare("select key, value from settings where key in ('openaiCompatBaseUrl', 'ollamaBaseUrl')").all() as Json[];
      const out: { id: string; name: string; url: string }[] = [];
      for (const r of rows) {
        let v: unknown;
        try {
          v = JSON.parse(String(r.value));
        } catch {
          v = String(r.value);
        }
        if (typeof v !== 'string') continue;
        const url = normalizeBaseUrl(v);
        if (!url) continue;
        out.push(r.key === 'ollamaBaseUrl' ? { id: 'kiln-ollama', name: 'Kiln worker (Ollama)', url } : { id: 'kiln-openai', name: 'Kiln worker', url });
      }
      this.endpointList = out;
    } catch {
      this.endpointList = [];
    }
  }

  private run<T>(fn: (db: DatabaseSync) => T, fallback: T): T {
    const db = this.open();
    if (!db) return fallback;
    try {
      return fn(db);
    } catch (e) {
      // locked mid-write, a schema this version does not know, the file replaced: reopen next time, never crash the app
      if (/not a database|disk I\/O|malformed|unable to open|no such table/i.test(String((e as Error)?.message))) this.close();
      return fallback;
    }
  }

  /** Read the change signal; on a change reload the task and conversation lists. Returns true when anything may have changed. */
  poll(): boolean {
    if (!this.enabled) return false;
    if (!this.file) {
      this.detect();
      if (!this.file) return false;
    }
    const db = this.open();
    if (db && Date.now() - this.lastEndpointsAt >= 30_000) {
      this.lastEndpointsAt = Date.now();
      this.readEndpoints(db);
    }
    const seq = this.run((db) => String(num((db.prepare('select max(seq) as s from events').get() as Json | undefined)?.s)), '');
    if (!seq) return false;
    const now = Date.now();
    const force = now - this.lastForce > FORCE_MS;
    if (!force && seq === this.lastSeq) return false;
    if (force) this.lastForce = now;
    const moved = seq !== this.lastSeq;
    this.lastSeq = seq;
    // a new signal: every task and conversation re-checks its rows (two cheap counts) the next time it is asked for
    this.signal = `${seq}:${++this.tick}`;
    const tasks = this.run((db) => (db.prepare(`${TASK_SQL} order by t.created_at desc limit ${TASK_LIMIT}`).all() as Json[]).map(taskOf), null);
    const convs = this.run((db) => (db.prepare(CONV_SQL).all() as Json[]).map(convOf), null);
    if (!tasks || !convs) return false;
    const key = (a: { id: string; updatedAt: number; messages: number; state?: string; status?: string }[]) =>
      a.map((x) => `${x.id}:${x.updatedAt}:${x.messages}:${x.state ?? x.status}`).join(',');
    const changed = moved || key(tasks) !== key(this.tasks) || key(convs) !== key(this.convs);
    this.tasks = tasks;
    this.convs = convs;
    for (const t of tasks) this.taskById.set(t.id, { t, at: this.signal });
    if (changed) this.version++;
    return changed;
  }

  /** A task by id (the recent list, else one read). */
  task(id: string): HxTask | null {
    const c = this.taskById.get(id);
    if (c && c.at === this.signal) return c.t;
    const t = this.run((db) => {
      const r = db.prepare(`${TASK_SQL} where t.id = ?`).get(id) as Json | undefined;
      return r ? taskOf(r) : null;
    }, c?.t ?? null);
    if (t) this.taskById.set(id, { t, at: this.signal });
    if (this.taskById.size > TASK_LIMIT * 3) for (const k of [...this.taskById.keys()].slice(0, TASK_LIMIT)) this.taskById.delete(k);
    return t;
  }

  conversation(id: string): HxConversation | null {
    return (
      this.convs.find((c) => c.id === id) ??
      this.run((db) => {
        const r = db.prepare(CONV_SQL.replace('where coalesce(c.archived, 0) = 0', 'where c.id = ?')).get(id) as Json | undefined;
        return r ? convOf(r) : null;
      }, null)
    );
  }

  /** A task's or conversation's rows, re-read only when the change signal moved. */
  owner(kind: 'task' | 'conversation', id: string): Owner {
    const k = `${kind}:${id}`;
    let o = this.owners.get(k);
    if (!o) {
      o = {
        kind,
        id,
        data: { messages: [], usage: [], todos: null },
        version: 0,
        gen: 0,
        checked: '',
        count: -1,
        maxTs: 0,
        ids: new Set(),
        usageCount: -1,
        usageMax: 0,
        todosAt: -1,
      };
      this.owners.set(k, o);
      if (this.owners.size > 400) for (const old of [...this.owners.keys()].slice(0, 100)) this.owners.delete(old);
    }
    if (o.checked === this.signal && this.signal) return o;
    o.checked = this.signal;
    const col = kind === 'task' ? 'task_id' : 'conversation_id';
    const owner = o;
    this.run((db) => {
      // messages: appended rows only, unless some went away (then everything again)
      const m = db.prepare(`select count(*) as c, max(created_at) as t from messages where ${col} = ?`).get(id) as Json;
      const count = num(m.c);
      const maxTs = num(m.t);
      if (count !== owner.count || maxTs !== owner.maxTs) {
        const read = (since: number) =>
          (
            db
              .prepare(`select ${MSG_COLS} from messages where ${col} = ? and created_at >= ? and json_valid(message) order by created_at, rowid`)
              .all(id, since) as Json[]
          )
            .map(messageOf)
            .filter((x): x is HxMessage => !!x);
        let next: HxMessage[] | null = null;
        if (owner.count >= 0 && count >= owner.count && maxTs >= owner.maxTs) {
          // the usual case: rows appended
          const add = read(owner.maxTs).filter((x) => !owner.ids.has(x.id));
          if (owner.data.messages.length + add.length === count) next = [...owner.data.messages, ...add];
        }
        if (!next) {
          next = read(0);
          // rows that were there are gone (a rewind, a compaction): whoever shows them starts over
          if (owner.count >= 0) {
            const now = new Set(next.map((x) => x.id));
            if ([...owner.ids].some((x) => !now.has(x))) owner.gen++;
          }
        }
        owner.data.messages = next;
        owner.ids = new Set(next.map((x) => x.id));
        owner.count = count;
        owner.maxTs = maxTs;
        owner.version++;
      }
      const u = db.prepare(`select count(*) as c, max(ts) as t from usage_records where ${col} = ?`).get(id) as Json;
      if (num(u.c) !== owner.usageCount || num(u.t) !== owner.usageMax) {
        owner.data.usage = (db.prepare(`select * from usage_records where ${col} = ? order by ts, rowid`).all(id) as Json[]).map((r): HxUsage => ({
          id: str(r.id),
          ts: num(r.ts),
          provider: str(r.provider),
          model: str(r.model),
          in: num(r.input_tokens),
          out: num(r.output_tokens),
          source: str(r.source),
          tps: num(r.decode_tps),
        }));
        owner.usageCount = num(u.c);
        owner.usageMax = num(u.t);
        owner.version++;
      }
      if (kind === 'conversation') {
        const t = db.prepare(`select items, updated_at from todos where owner_kind = 'conversation' and owner_id = ?`).get(id) as Json | undefined;
        const at = t ? num(t.updated_at) : 0;
        if (at !== owner.todosAt) {
          const items = parse(t?.items);
          owner.data.todos = Array.isArray(items)
            ? { items: items.map((x: Json) => ({ content: str(x?.content), status: str(x?.status) })), updatedAt: at }
            : null;
          owner.todosAt = at;
          owner.version++;
        }
      }
      return null;
    }, null);
    return o;
  }

  private taken = (key: string) => (taskId: string) => {
    const by = this.claimed.get(taskId);
    return !!by && by !== key;
  };

  /**
   * Attach the tasks a Claude session's delegate_task calls created, as child agents of the calling agent, and keep them up to
   * date. Returns true when the session's state changed.
   */
  link(w: Foldable): boolean {
    if (!this.file || !w.primed) return false;
    const calls = w.state.internal.harnessCalls;
    if (!calls) return false;
    let links = this.links.get(w.state);
    if (!links) this.links.set(w.state, (links = new Map()));
    let changed = false;
    for (const [toolUseId, c] of Object.entries(calls)) {
      const key = `${w.sessionId}:${toolUseId}`;
      let l = links.get(toolUseId);
      if (l && c.taskId && c.taskId !== l.taskId) {
        // matched by brief before the result was in, and the result names another task: follow the result
        if (this.claimed.get(l.taskId) === key) this.claimed.delete(l.taskId);
        links.delete(toolUseId);
        l = undefined;
      }
      if (!l) {
        let id = c.taskId ?? null;
        if (!id) id = matchHarnessTask({ toolUseId, ...c }, this.tasks, this.taken(key))?.id ?? null;
        if (!id) continue;
        this.claimed.set(id, key);
        links.set(toolUseId, (l = { taskId: id, sent: new Set(), stamp: '' }));
      }
      const t = this.task(l.taskId);
      if (!t || !taskShown(t)) continue;
      const o = this.owner('task', t.id);
      const stamp = `${t.updatedAt}|${t.state}|${o.version}`;
      if (stamp === l.stamp) continue;
      l.stamp = stamp;
      const evs = freshItems(harnessTaskItems(t, o.data, w.sessionId, toolUseId), l.sent);
      if (evs.length) {
        w.ingest(evs);
        changed = true;
      }
    }
    return changed;
  }

  /** For replay: a Claude session's events plus the harness tasks it handed off. */
  withTasks(events: AgentEvent[], sessionId: string): AgentEvent[] {
    if (!this.file) return events;
    const calls = harnessCallsOf(events);
    if (!calls.length) return events;
    const used = new Set<string>();
    const extra: AgentEvent[] = [];
    for (const c of calls) {
      const id = c.taskId ?? matchHarnessTask(c, this.tasks, (tid) => used.has(tid))?.id ?? null;
      if (!id || used.has(id)) continue;
      used.add(id);
      const t = this.task(id);
      if (!t || !taskShown(t)) continue;
      extra.push(...harnessTaskItems(t, this.owner('task', id).data, sessionId, c.toolUseId).map((i) => i.e));
    }
    return mergeByTime(events, extra);
  }

  /** The session (if any) that claimed a task. */
  claimedBy(taskId: string): string | null {
    const k = this.claimed.get(taskId);
    return k ? k.slice(0, k.indexOf(':')) : null;
  }

  /**
   * Sidebar rows: the local Agent conversations, and recent tasks no Claude session claims. A task is left out while a Claude
   * session in its folder was active since it was created and is not followed yet (opening that session claims it); a session
   * that is followed had its chance: a task it has not claimed a minute after it was created gets its own row.
   */
  scan(claude: readonly SessionSummary[], followed: (sessionId: string) => boolean = () => false): SessionSummary[] {
    if (!this.file) {
      this.summaryCache = [];
      return this.summaryCache;
    }
    const now = Date.now();
    const accounted = (t: HxTask) =>
      claude.some((s) => s.cwd && sameDir(s.cwd, t.root) && s.mtime >= t.createdAt - 60_000 && !(followed(s.id) && now - t.createdAt > UNCLAIMED_MS));
    const orphans = this.tasks
      .filter((t) => taskShown(t) && !this.claimed.has(t.id) && now - t.updatedAt < ORPHAN_MAX_AGE && !accounted(t))
      .slice(0, MAX_ORPHANS);
    const convs = this.convs.filter((c) => c.messages > 0);
    const liveConv = (c: HxConversation) => c.status === 'running' || now - c.updatedAt < LIVE_MS;
    const liveTask = (t: HxTask) => !taskFinished(t) && now - t.updatedAt < LIVE_MS;
    const key = `${this.version}:${orphans.map((t) => t.id + liveTask(t)).join(',')}:${convs.map((c) => c.id + liveConv(c)).join(',')}`;
    if (key === this.summaryKey) return this.summaryCache;
    this.summaryKey = key;
    const row = (id: string, file: string, root: string, title: string | null, mtime: number, live: boolean): SessionSummary => ({
      id,
      file,
      projectDir: root,
      project: projectName(root || null, root || 'kiln'),
      cwd: root || null,
      title,
      mtime,
      size: 0,
      live,
      entrypoint: HARNESS,
      source: HARNESS,
    });
    this.summaryCache = [
      ...convs.map((c) => row(harnessSessionId(c.id), `${HARNESS}:conversation:${c.id}`, c.root, c.title.trim() || null, c.updatedAt, liveConv(c))),
      ...orphans.map((t) => row(harnessSessionId(t.id), `${HARNESS}:task:${t.id}`, t.root, harnessTitle(t.title, t.brief), t.updatedAt, liveTask(t))),
    ];
    return this.summaryCache;
  }

  watcher(sessionId: string, file: string): HarnessWatcher {
    return new HarnessWatcher(sessionId, file, this);
  }

  /** The items of a session of its own (`kiln-harness:<kind>:<id>`), or null when its rows are gone. */
  itemsOf(file: string, sessionId: string): { items: HxItem[]; gen: number; status: string } | null {
    const m = /^kiln-harness:(task|conversation):(.+)$/.exec(file);
    if (!m) return null;
    const [, kind, id] = m;
    if (kind === 'task') {
      const t = this.task(id);
      if (!t) return null;
      const o = this.owner('task', id);
      return { items: harnessTaskItems(t, o.data, sessionId, null), gen: o.gen, status: taskFinished(t) || t.state === 'review' ? 'idle' : 'running' };
    }
    const c = this.conversation(id);
    if (!c) return null;
    const o = this.owner('conversation', id);
    return { items: harnessConversationItems(c, o.data, sessionId), gen: o.gen, status: c.status };
  }
}

/** One harness conversation (or a task nobody claims) shown as a session. */
export class HarnessWatcher implements Foldable {
  state: SessionState;
  primed = false;
  backlogSink: ((events: AgentEvent[]) => void) | null = null;
  private sent = new Set<string>();
  private gen = -1;
  private recent: AgentEvent[] = [];
  private seen = -1;

  constructor(
    readonly sessionId: string,
    readonly mainFile: string,
    private src: HarnessSource,
  ) {
    this.state = newSession(sessionId);
  }

  get mtimeMs(): number {
    return this.state.lastActivity ?? 0;
  }

  drainRecent(): AgentEvent[] {
    const r = this.recent;
    this.recent = [];
    return r;
  }

  ingest(events: AgentEvent[]) {
    for (const e of events) apply(this.state, e);
    if (this.primed) this.recent.push(...events);
  }

  async poll(): Promise<boolean> {
    if (this.primed && this.seen === this.src.version) return false;
    this.seen = this.src.version;
    const r = this.src.itemsOf(this.mainFile, this.sessionId);
    if (!r) {
      const was = this.primed;
      this.primed = true;
      return !was;
    }
    if (this.gen !== -1 && r.gen !== this.gen) {
      // rows went away (a rewind, a compaction): start over rather than keep what is gone
      this.state = newSession(this.sessionId);
      this.sent.clear();
      this.primed = false;
    }
    this.gen = r.gen;
    const fresh = freshItems(r.items, this.sent);
    if (!this.primed) this.backlogSink?.(r.items.map((i) => i.e));
    this.ingest(fresh);
    const main = this.state.agents[MAIN];
    if (r.status !== 'running' && main?.status === 'running' && !Object.values(this.state.internal.pending).some((p) => p.agentId === MAIN)) {
      main.status = 'idle';
      main.endedAt = Math.max(main.lastActivity, main.endedAt ?? 0);
    }
    this.primed = true;
    return fresh.length > 0;
  }

  async collectAllEvents(): Promise<AgentEvent[]> {
    return this.src.itemsOf(this.mainFile, this.sessionId)?.items.map((i) => i.e) ?? [];
  }
}
