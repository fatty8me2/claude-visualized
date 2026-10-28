// OpenCode (sst/opencode) as a second session source. Read-only: opens its SQLite database read-only (1.1+: <data>/opencode.db) or reads the
// older JSON files (<data>/storage/{session,message,part,todo}/...). It never writes there and never touches auth.json.
// A cheap change token (SQLite PRAGMA data_version / a few stats) lets the manager poll at ~250 ms without re-reading anything unchanged.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentEvent } from '@core/events';
import { OPENCODE, OpenCodeConverter, parseSessionModel, type OcMessage, type OcPart, type OcSession, type OcTodo } from '@core/opencode';
import { newSession, type SessionState, type SessionSummary } from '@core/state';
import { apply } from '@core/reducer';
import { projectName } from '@core/history';

export const OC_LIVE_MS = 10 * 60_000;
const MAX_SESSIONS = 300;

type Json = Record<string, any>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Where OpenCode keeps its data. OpenCode uses XDG paths on every OS (~/.local/share/opencode, also on Windows and macOS). */
export function openCodeCandidates(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir(), platform: string = process.platform): string[] {
  const out: string[] = [];
  const add = (p?: string) => p && out.push(p);
  add(env.CLAUDE_VIS_OPENCODE_HOME?.trim());
  if (env.XDG_DATA_HOME?.trim()) add(path.join(env.XDG_DATA_HOME.trim(), 'opencode'));
  add(path.join(home, '.local', 'share', 'opencode'));
  if (platform === 'win32') {
    if (env.APPDATA) add(path.join(env.APPDATA, 'opencode'));
    if (env.LOCALAPPDATA) add(path.join(env.LOCALAPPDATA, 'opencode'));
  }
  if (platform === 'darwin') add(path.join(home, 'Library', 'Application Support', 'opencode'));
  return out;
}

/** The first candidate that holds sessions (a database or a storage folder), or null. `override` wins when set. */
export function detectOpenCodeDir(override: string, env: NodeJS.ProcessEnv = process.env, home?: string, platform?: string): string | null {
  const has = (d: string) => fs.existsSync(path.join(d, 'opencode.db')) || fs.existsSync(path.join(d, 'storage', 'session'));
  const list = override.trim() ? [override.trim()] : openCodeCandidates(env, home, platform);
  // tests that point CLAUDE_VIS_HOME at a fixture must never read the real OpenCode data of the machine they run on
  const testMode = !!env.CLAUDE_VIS_HOME?.trim() && !env.CLAUDE_VIS_OPENCODE_HOME?.trim();
  if (testMode && !override.trim()) return null;
  return list.find(has) ?? null;
}

export interface OcCursor {
  t: number;
  files: Map<string, number>;
}
export const newCursor = (): OcCursor => ({ t: 0, files: new Map() });

export interface OcStore {
  /** changes whenever the data may have changed; cheap */
  token(): string;
  sessions(): OcSession[];
  changes(ids: string[], cursor: OcCursor): { messages: OcMessage[]; parts: OcPart[] };
  todos(sessionId: string): OcTodo[] | null;
  close(): void;
}

// ---------------------------------------------------------------- SQLite (OpenCode 1.1+)

const PART_SQL = `select id, message_id, session_id, time_created, time_updated,
  case when json_extract(data,'$.type') = 'reasoning' then '{"type":"reasoning"}'
  else json_remove(data,'$.state.output','$.state.metadata','$.metadata','$.state.input.content','$.state.input.oldString','$.state.input.newString','$.state.raw','$.snapshot') end as data,
  json_extract(data,'$.state.metadata.sessionId') as child
  from part where session_id in (%IDS%) and time_updated >= ? order by time_created, id`;

export class SqliteStore implements OcStore {
  private db: DatabaseSync | null = null;
  constructor(private file: string) {}

  private open(): DatabaseSync | null {
    if (this.db) return this.db;
    try {
      this.db = new DatabaseSync(this.file, { readOnly: true });
      this.db.exec('PRAGMA busy_timeout = 250');
    } catch {
      this.db = null;
    }
    return this.db;
  }

  private run<T>(fn: (db: DatabaseSync) => T, fallback: T): T {
    const db = this.open();
    if (!db) return fallback;
    try {
      return fn(db);
    } catch (e) {
      // locked mid-write, schema from a version we don't know, ...: reopen next time, never crash the app
      if (/not a database|disk I\/O|malformed|unable to open/i.test(String((e as Error)?.message))) this.close();
      return fallback;
    }
  }

  token(): string {
    return this.run((db) => String((db.prepare('PRAGMA data_version').get() as Json).data_version), String(Date.now()));
  }

  sessions(): OcSession[] {
    return this.run((db) => {
      const rows = db.prepare('select * from session').all() as Json[];
      return rows.map((r) => ({
        id: str(r.id),
        parentId: str(r.parent_id) || null,
        directory: str(r.directory),
        title: str(r.title),
        version: str(r.version),
        agent: str(r.agent) || null,
        timeCreated: num(r.time_created),
        timeUpdated: num(r.time_updated),
        archived: num(r.time_archived) > 0,
        model: parseSessionModel(r.model),
      }));
    }, []);
  }

  changes(ids: string[], cursor: OcCursor) {
    if (!ids.length) return { messages: [], parts: [] };
    const marks = ids.map(() => '?').join(',');
    return this.run(
      (db) => {
        const since = cursor.t;
        const mrows = db
          .prepare(
            `select id, session_id, time_created, time_updated, data from message where session_id in (${marks}) and time_updated >= ? order by time_created, id`,
          )
          .all(...ids, since) as Json[];
        const prows = db.prepare(PART_SQL.replace('%IDS%', marks)).all(...ids, since) as Json[];
        const messages: OcMessage[] = [];
        let t = cursor.t;
        for (const r of mrows) {
          t = Math.max(t, num(r.time_updated));
          const data = safeParse(r.data);
          if (data) messages.push({ id: str(r.id), sessionId: str(r.session_id), timeCreated: num(r.time_created), data });
        }
        const parts: OcPart[] = [];
        for (const r of prows) {
          t = Math.max(t, num(r.time_updated));
          const data = safeParse(r.data);
          if (!data) continue;
          if (r.child && data.type === 'tool') data.state = { ...obj(data.state), metadata: { sessionId: r.child } };
          parts.push({
            id: str(r.id),
            messageId: str(r.message_id),
            sessionId: str(r.session_id),
            timeCreated: num(r.time_created),
            timeUpdated: num(r.time_updated),
            data,
          });
        }
        cursor.t = t;
        return { messages, parts };
      },
      { messages: [] as OcMessage[], parts: [] as OcPart[] },
    );
  }

  todos(sessionId: string): OcTodo[] | null {
    return this.run((db) => {
      const rows = db.prepare('select content, status from todo where session_id = ? order by position').all(sessionId) as Json[];
      return rows.map((r) => ({ content: str(r.content), status: str(r.status) }));
    }, null);
  }

  close() {
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
    this.db = null;
  }
}

function safeParse(s: unknown): Json | null {
  if (typeof s !== 'string') return null;
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null; // half-written
  }
}

// ---------------------------------------------------------------- JSON files (OpenCode before the SQLite move)

export class JsonStore implements OcStore {
  private sessionCache = new Map<string, { mtime: number; s: OcSession | null }>();
  constructor(private root: string) {}

  token(): string {
    return String(Date.now()); // directory mtimes don't move when a part file is rewritten; changes() is stat-only for unchanged files
  }

  private readJson(file: string): Json | null {
    try {
      return safeParse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  private ls(dir: string): string[] {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  }

  sessions(): OcSession[] {
    const out: OcSession[] = [];
    const base = path.join(this.root, 'session');
    for (const proj of this.ls(base)) {
      for (const f of this.ls(path.join(base, proj))) {
        if (!f.endsWith('.json')) continue;
        const file = path.join(base, proj, f);
        let mtime = 0;
        try {
          mtime = fs.statSync(file).mtimeMs;
        } catch {
          continue;
        }
        let c = this.sessionCache.get(file);
        if (!c || c.mtime !== mtime) {
          const j = this.readJson(file);
          const t = obj(j?.time);
          c = {
            mtime,
            s: j
              ? {
                  id: str(j.id) || f.slice(0, -5),
                  parentId: str(j.parentID) || null,
                  directory: str(j.directory),
                  title: str(j.title),
                  version: str(j.version),
                  agent: null,
                  timeCreated: num(t.created) || mtime,
                  timeUpdated: num(t.updated) || mtime,
                  archived: num(t.archived) > 0,
                }
              : null,
          };
          this.sessionCache.set(file, c);
        }
        if (c.s) out.push(c.s);
      }
    }
    return out;
  }

  changes(ids: string[], cursor: OcCursor) {
    const messages: OcMessage[] = [];
    const parts: OcPart[] = [];
    const changed = (file: string): number | null => {
      try {
        const m = fs.statSync(file).mtimeMs;
        if (cursor.files.get(file) === m) return null;
        cursor.files.set(file, m);
        return m;
      } catch {
        return null;
      }
    };
    for (const sid of ids) {
      const mdir = path.join(this.root, 'message', sid);
      const names = this.ls(mdir)
        .filter((f) => f.endsWith('.json'))
        .sort();
      names.forEach((f, idx) => {
        const mid = f.slice(0, -5);
        const mfile = path.join(mdir, f);
        if (changed(mfile) !== null) {
          const j = this.readJson(mfile);
          if (j) messages.push({ id: str(j.id) || mid, sessionId: sid, timeCreated: num(obj(j.time).created), data: j });
        }
        // parts of old messages are final: look at the newest few every time, the rest only once
        const pdir = path.join(this.root, 'part', mid);
        const recent = idx >= names.length - 4;
        const first = !cursor.files.has('dir:' + pdir);
        if (!recent && !first) return;
        cursor.files.set('dir:' + pdir, 1);
        for (const pf of this.ls(pdir)) {
          if (!pf.endsWith('.json')) continue;
          const pfile = path.join(pdir, pf);
          const mt = changed(pfile);
          if (mt === null) continue;
          const j = this.readJson(pfile);
          if (!j) {
            cursor.files.delete(pfile); // half-written: retry
            continue;
          }
          const t = obj(j.time);
          const st = obj(obj(j.state).time);
          parts.push({
            id: str(j.id) || pf.slice(0, -5),
            messageId: mid,
            sessionId: sid,
            timeCreated: num(t.start) || num(st.start) || num(obj(messages.find((m) => m.id === mid)?.data.time).created) || mt,
            timeUpdated: mt,
            data: j,
          });
        }
      });
    }
    return { messages, parts };
  }

  todos(sessionId: string): OcTodo[] | null {
    const j = (() => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.root, 'todo', `${sessionId}.json`), 'utf8'));
        return Array.isArray(raw) ? raw : null;
      } catch {
        return null;
      }
    })();
    return j ? j.map((t) => ({ content: str(obj(t).content), status: str(obj(t).status) })) : null;
  }

  close() {}
}

// ---------------------------------------------------------------- source + watcher

/** Follows one OpenCode session tree (the session and its child sessions) and folds it into a SessionState like SessionWatcher does. */
export class OpenCodeWatcher {
  state: SessionState;
  primed = false;
  readonly mainFile: string;
  backlogSink: ((events: AgentEvent[]) => void) | null = null;
  private conv: OpenCodeConverter;
  private cursor = newCursor();
  private known = new Set<string>();
  private lastToken = '';
  private recent: AgentEvent[] = [];
  private busy = false;

  constructor(
    readonly sessionId: string,
    private src: OpenCodeSource,
  ) {
    this.state = newSession(sessionId);
    this.mainFile = `opencode:${sessionId}`;
    this.conv = new OpenCodeConverter(sessionId);
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

  /** Read anything new. Returns true if state changed. */
  async poll(): Promise<boolean> {
    const store = this.src.store;
    if (!store || this.busy) return false;
    const tok = store.token();
    // a running tool part can go stale without any write, so re-check now and then even when nothing changed
    const quiet = this.primed && tok === this.lastToken && Date.now() - this.lastFull < 20_000;
    if (quiet) return false;
    this.busy = true;
    try {
      this.lastToken = tok;
      this.lastFull = Date.now();
      const tree = this.src.tree(this.sessionId);
      const ids = tree.map((s) => s.id);
      const fresh = ids.filter((id) => !this.known.has(id));
      const old = ids.filter((id) => this.known.has(id));
      const a = store.changes(old, this.cursor);
      const b = fresh.length ? store.changes(fresh, { t: 0, files: this.cursor.files }) : { messages: [], parts: [] };
      for (const id of ids) this.known.add(id);
      const todos = store.todos(this.sessionId);
      const events = this.sort(this.conv.feed(tree, [...a.messages, ...b.messages], [...a.parts, ...b.parts], todos));
      const before = this.state.eventCount;
      if (!this.primed) this.backlogSink?.(events);
      this.ingest(events);
      this.primed = true;
      return this.state.eventCount !== before;
    } finally {
      this.busy = false;
    }
  }
  private lastFull = 0;

  private sort(events: AgentEvent[]): AgentEvent[] {
    const first = new Map<string, number>();
    for (const e of events) {
      const id = e.ref.agentId;
      if (id && e.ts && (!first.has(id) || e.ts < first.get(id)!)) first.set(id, e.ts);
    }
    for (const e of events)
      if (e.k === 'agent.spawn') {
        const f = first.get(e.spawn.childId);
        if (f !== undefined && f < e.ts) e.ts = f - 1;
      }
    return events
      .map((e, i) => [e, i] as const)
      .sort((x, y) => x[0].ts - y[0].ts || x[1] - y[1])
      .map(([e]) => e);
  }

  async collectAllEvents(): Promise<AgentEvent[]> {
    const w = new OpenCodeWatcher(this.sessionId, this.src);
    let all: AgentEvent[] = [];
    w.backlogSink = (evs) => (all = evs);
    await w.poll();
    return all;
  }
}

export interface OpenCodeOptions {
  enabled: boolean;
  /** '' = auto-detect */
  dir: string;
}

export class OpenCodeSource {
  store: OcStore | null = null;
  dir: string | null = null;
  private opts: OpenCodeOptions = { enabled: true, dir: '' };
  private all: OcSession[] = [];
  private allToken = '';
  private allAt = 0;
  private summaryCache: SessionSummary[] = [];
  private summaryKey = '';
  private lastDetect = 0;

  setConfig(o: OpenCodeOptions) {
    this.opts = o;
    this.lastDetect = 0;
    this.allToken = '';
    this.summaryKey = '';
    this.refreshStore();
  }

  /** (Re)detect the data dir at most every 5 s while none is found. */
  private refreshStore() {
    if (!this.opts.enabled) {
      this.store?.close();
      this.store = null;
      this.dir = null;
      return;
    }
    if (this.store && this.dir) return;
    if (Date.now() - this.lastDetect < 5000) return;
    this.lastDetect = Date.now();
    const dir = detectOpenCodeDir(this.opts.dir);
    if (!dir) return;
    this.dir = dir;
    const db = path.join(dir, 'opencode.db');
    this.store = fs.existsSync(db) ? new SqliteStore(db) : new JsonStore(path.join(dir, 'storage'));
  }

  private sessions(): OcSession[] {
    const store = this.store;
    if (!store) return [];
    const tok = store.token();
    if (tok !== this.allToken || Date.now() - this.allAt > 2000) {
      this.allToken = tok;
      this.allAt = Date.now();
      this.all = store.sessions();
    }
    return this.all;
  }

  /** the session and every descendant, parents first */
  tree(rootId: string): OcSession[] {
    const all = this.sessions();
    const out: OcSession[] = [];
    const root = all.find((s) => s.id === rootId);
    if (!root) return out;
    out.push(root);
    for (let i = 0; i < out.length; i++) for (const s of all) if (s.parentId === out[i].id && !out.includes(s)) out.push(s);
    return out;
  }

  /** Top-level sessions as sidebar rows. The same array is returned until the data changes. */
  scan(): SessionSummary[] {
    this.refreshStore();
    if (!this.store) {
      this.summaryCache = [];
      return this.summaryCache;
    }
    const all = this.sessions();
    const key = this.allToken + ':' + all.length + ':' + (Date.now() - Math.max(0, ...all.map((s) => s.timeUpdated)) < OC_LIVE_MS);
    if (key === this.summaryKey) {
      const t = Date.now();
      for (const r of this.summaryCache) r.live = t - r.mtime < OC_LIVE_MS;
      return this.summaryCache;
    }
    this.summaryKey = key;
    const children = new Map<string, OcSession[]>();
    for (const s of all) if (s.parentId) children.set(s.parentId, [...(children.get(s.parentId) ?? []), s]);
    const newest = (s: OcSession): number => Math.max(s.timeUpdated, ...(children.get(s.id) ?? []).map(newest));
    const now = Date.now();
    this.summaryCache = all
      .filter((s) => !s.parentId && s.id)
      .map((s) => ({ s, mtime: newest(s) }))
      .filter(({ s }) => !(/^new session\b/i.test(s.title.trim()) && s.timeUpdated - s.timeCreated < 2000 && !children.has(s.id)))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_SESSIONS)
      .map(({ s, mtime }) => ({
        id: s.id,
        file: `opencode:${s.id}`,
        projectDir: s.directory,
        project: projectName(s.directory || null, s.directory || 'opencode'),
        cwd: s.directory || null,
        title: /^(new session|child session)\b/i.test(s.title.trim()) ? null : s.title,
        mtime,
        size: 0,
        live: now - mtime < OC_LIVE_MS,
        entrypoint: OPENCODE,
        source: OPENCODE,
        archived: s.archived,
      }));
    return this.summaryCache;
  }

  watcher(id: string): OpenCodeWatcher {
    return new OpenCodeWatcher(id, this);
  }

  /** change token for the manager's fast poll */
  token(): string {
    return this.store ? this.store.token() : '';
  }

  close() {
    this.store?.close();
    this.store = null;
  }
}
