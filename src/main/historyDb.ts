// The local history index: a SQLite database (node:sqlite, FTS5) that caches facts from the transcripts so the History page
// can answer "what did I spend over 90 days" and "where did I fix that retry bug" without reading 1 GB of JSONL.
// It is a cache. Every row can be rebuilt from ~/.claude (which this code only ever reads), so a schema bump just drops it.

import { estimateRows } from '@core/pricing';
import fs from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  aggregateUsage,
  buildFtsQuery,
  buildHeatmap,
  dayKey,
  dayStartMs,
  fillTimeGroups,
  goalOfAgent,
  hourOf,
  MARK_END,
  MARK_START,
  MAIN_AGENT,
  parseSnippet,
  providerAndFamily,
  rangeFromDay,
  sumRows,
  titleFromPrompt,
  type AgentDelta,
  type FileDelta,
  type HistorySummary,
  type SearchArgs,
  type SearchHit,
  type SearchResult,
  type SummaryArgs,
  type UsageRow,
} from '@core/history';
import type { Goal, ToolMix } from '@core/goal';
import { projectName } from '@core/history';

/** Bump when the schema or what is extracted changes; an old database is rebuilt. */
export const SCHEMA_VERSION = 1;

const SCHEMA = `
create table if not exists meta (key text primary key, value text);
create table if not exists files (
  path text primary key, session_id text not null, size integer not null, mtime real not null,
  offset integer not null, head_sig text not null, tail_sig text not null
);
create index if not exists files_session on files(session_id);
create table if not exists sessions (
  id text primary key, project text not null, project_dir text not null, cwd text, title text, title_rank integer not null default 0,
  entrypoint text, first_ts integer, last_ts integer, cost_usd real, models text not null default '', agent_count integer not null default 0,
  desktop_id text
);
create index if not exists sessions_last on sessions(last_ts);
create table if not exists agents (
  session_id text not null, agent_id text not null, type text not null default '', description text not null default '', phase text,
  prompt text, goal text not null default 'general', model text, provider text, family text,
  started integer, ended integer, status text not null default 'done', tool_count integer not null default 0, tool_mix text not null default '{}',
  tokens_in integer not null default 0, tokens_out integer not null default 0, cache_read integer not null default 0, cache_write integer not null default 0,
  primary key (session_id, agent_id)
) without rowid;
create index if not exists agents_started on agents(started);
create table if not exists usage_msgs (
  session_id text not null, agent_id text not null, msg_id text not null, ts integer not null, day text not null, hour integer not null,
  model text not null, provider text not null, family text not null, tin integer not null, tout integer not null, cache_read integer not null, cache_write integer not null,
  primary key (session_id, agent_id, msg_id)
) without rowid;
create index if not exists usage_msgs_day on usage_msgs(day);
create table if not exists usage_daily (
  day text not null, project text not null, model text not null, provider text not null, family text not null,
  tokens_in integer not null, tokens_out integer not null, cache_read integer not null, cache_write integer not null, messages integer not null,
  primary key (day, project, model)
) without rowid;
create table if not exists activity (day text not null, hour integer not null, messages integer not null, primary key (day, hour)) without rowid;
create table if not exists tool_calls (session_id text not null, day text not null, tool text not null, count integer not null, primary key (session_id, day, tool)) without rowid;
create index if not exists tool_calls_day on tool_calls(day);
create table if not exists docs (id integer primary key, session_id text not null, agent_id text not null, ts integer not null, kind text not null, text text not null);
create index if not exists docs_session on docs(session_id);
create virtual table if not exists docs_fts using fts5(text, content='docs', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
create trigger if not exists docs_ai after insert on docs begin insert into docs_fts(rowid, text) values (new.id, new.text); end;
create trigger if not exists docs_ad after delete on docs begin insert into docs_fts(docs_fts, rowid, text) values ('delete', old.id, old.text); end;
`;

const DROP_ALL = `
drop trigger if exists docs_ai; drop trigger if exists docs_ad;
drop table if exists docs_fts; drop table if exists docs; drop table if exists tool_calls; drop table if exists activity; drop table if exists usage_daily;
drop table if exists usage_msgs; drop table if exists agents; drop table if exists sessions; drop table if exists files; drop table if exists meta;
`;

export interface FileRow {
  path: string;
  sessionId: string;
  size: number;
  mtime: number;
  offset: number;
  headSig: string;
  tailSig: string;
}

export interface SessionRef {
  id: string;
  projectDir: string;
}

type Row = Record<string, any>;

const LIVE_MS = 10 * 60_000;

export class HistoryDb {
  readonly db: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  /** days whose rollups need recomputing after the current batch of sessions */
  private dirtyDays = new Set<string>();

  constructor(readonly file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('pragma journal_mode = wal; pragma synchronous = normal; pragma busy_timeout = 3000; pragma temp_store = memory;');
    this.migrate();
  }

  private migrate() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let version = 0;
    let oldTz = '';
    try {
      version = Number(this.db.prepare("select value from meta where key = 'schema'").get()?.value ?? 0);
      oldTz = String(this.db.prepare("select value from meta where key = 'tz'").get()?.value ?? '');
    } catch {
      /* fresh database */
    }
    // days are bucketed in the local timezone when indexing, so a timezone change invalidates them
    if (version !== SCHEMA_VERSION || (oldTz && oldTz !== tz)) this.db.exec(DROP_ALL);
    this.db.exec(SCHEMA);
    this.setMeta('schema', String(SCHEMA_VERSION));
    this.setMeta('tz', tz);
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  setMeta(key: string, value: string) {
    this.stmt('insert or replace into meta(key, value) values (?, ?)').run(key, value);
  }

  getMeta(key: string): string | null {
    const r = this.stmt('select value from meta where key = ?').get(key);
    return r ? String(r.value) : null;
  }

  /** Fold the write-ahead log back into the main file so the database on disk is one small file. */
  checkpoint() {
    try {
      this.db.exec('pragma wal_checkpoint(truncate)');
    } catch {
      /* a reader holds it open; the next pass will retry */
    }
  }

  close() {
    this.cache.clear();
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('begin');
    try {
      const r = fn();
      this.db.exec('commit');
      return r;
    } catch (e) {
      try {
        this.db.exec('rollback');
      } catch {
        /* nothing to roll back */
      }
      throw e;
    }
  }

  // ---------- files ----------

  allFiles(): Map<string, FileRow> {
    const out = new Map<string, FileRow>();
    for (const r of this.stmt('select * from files').all() as Row[]) {
      out.set(r.path, { path: r.path, sessionId: r.session_id, size: r.size, mtime: r.mtime, offset: r.offset, headSig: r.head_sig, tailSig: r.tail_sig });
    }
    return out;
  }

  putFile(f: FileRow) {
    this.stmt('insert or replace into files(path, session_id, size, mtime, offset, head_sig, tail_sig) values (?,?,?,?,?,?,?)').run(
      f.path,
      f.sessionId,
      f.size,
      f.mtime,
      f.offset,
      f.headSig,
      f.tailSig,
    );
  }

  /** Forget everything known about a session (before re-reading it from the start). */
  dropSession(id: string) {
    for (const d of this.stmt('select distinct day from usage_msgs where session_id = ?').all(id) as Row[]) this.dirtyDays.add(d.day);
    for (const t of ['usage_msgs', 'agents', 'tool_calls', 'docs', 'files']) this.stmt(`delete from ${t} where session_id = ?`).run(id);
    this.stmt('delete from sessions where id = ?').run(id);
  }

  /** Drop sessions whose transcripts no longer exist. Returns how many. */
  pruneSessions(keep: Set<string>): number {
    const ids = (this.stmt('select id from sessions').all() as Row[]).map((r) => r.id as string).filter((id) => !keep.has(id));
    for (const id of ids) this.dropSession(id);
    return ids.length;
  }

  // ---------- ingest ----------

  /**
   * Merge what one file's new lines contained into the tables. `meta` carries the subagent's .meta.json (type, description, phase)
   * when the file belongs to a subagent. Call inside a transaction.
   */
  applyDelta(
    ref: SessionRef,
    d: FileDelta,
    meta: { agentType?: string; description?: string; phase?: string } | null,
    fileAgentId: string | null,
    now = Date.now(),
  ) {
    const sid = ref.id;
    if (d.lines === 0 && d.agents.size === 0) return;
    const s = this.stmt('select * from sessions where id = ?').get(sid) as Row | undefined;
    const cwd = s?.cwd ?? d.cwd;
    const project = projectName(cwd, ref.projectDir);
    let title: string | null = s?.title ?? null;
    let rank = Number(s?.title_rank ?? 0);
    if (d.title && d.title.rank >= rank) {
      title = d.title.title;
      rank = d.title.rank;
    }
    const mainDelta = d.agents.get(MAIN_AGENT);
    if (rank < 1) {
      const t = titleFromPrompt(mainDelta?.firstPrompt ?? null);
      if (t) {
        title = t;
        rank = 1;
      }
    }
    const models = new Set<string>((s?.models ? String(s.models).split('\n') : []).filter(Boolean));
    for (const a of d.agents.values()) for (const m of a.models) models.add(m);
    const firstTs = [s?.first_ts, d.firstTs || null].filter((x): x is number => !!x).reduce((a, b) => Math.min(a, b), Infinity);
    const lastTs = Math.max(s?.last_ts ?? 0, d.lastTs);
    this.stmt(
      `insert or replace into sessions(id, project, project_dir, cwd, title, title_rank, entrypoint, first_ts, last_ts, cost_usd, models, agent_count, desktop_id)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      sid,
      project,
      ref.projectDir,
      cwd ?? null,
      title,
      rank,
      s?.entrypoint ?? d.entrypoint ?? null,
      Number.isFinite(firstTs) ? firstTs : null,
      lastTs || null,
      d.costUsd ?? s?.cost_usd ?? null,
      [...models].join('\n'),
      s?.agent_count ?? 0,
      s?.desktop_id ?? null,
    );

    for (const a of d.agents.values()) this.applyAgent(sid, a, a.agentId === (fileAgentId ?? MAIN_AGENT) ? meta : null, now);
  }

  private applyAgent(sid: string, a: AgentDelta, meta: { agentType?: string; description?: string; phase?: string } | null, now: number) {
    const isMain = a.agentId === MAIN_AGENT;
    const old = this.stmt('select * from agents where session_id = ? and agent_id = ?').get(sid, a.agentId) as Row | undefined;
    const mix: ToolMix = old ? JSON.parse(old.tool_mix) : {};
    for (const [k, v] of Object.entries(a.toolMix)) mix[k as keyof ToolMix] = (mix[k as keyof ToolMix] ?? 0) + (v ?? 0);
    const type = meta?.agentType ?? old?.type ?? '';
    const phase = meta?.phase ?? old?.phase ?? null;
    const prompt = isMain ? (a.lastPrompt ?? old?.prompt ?? null) : (old?.prompt ?? a.firstPrompt);
    const description = (meta?.description ?? old?.description ?? '') || (!isMain && a.firstPrompt ? a.firstPrompt.slice(0, 120) : '');
    const model = a.model ?? old?.model ?? null;
    const started = Math.min(...[old?.started, a.firstTs || null].filter((x): x is number => !!x), Infinity);
    const ended = Math.max(old?.ended ?? 0, a.lastTs);
    const { provider, family } = model ? providerAndFamily(model) : { provider: null, family: null };
    const goal: Goal = goalOfAgent({ isMain, agentType: type, description, phase, prompt, toolMix: mix });
    this.stmt(
      `insert or replace into agents(session_id, agent_id, type, description, phase, prompt, goal, model, provider, family, started, ended, status, tool_count, tool_mix,
         tokens_in, tokens_out, cache_read, cache_write)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      sid,
      a.agentId,
      type,
      description,
      phase,
      prompt,
      goal,
      model,
      provider,
      family,
      Number.isFinite(started) ? started : null,
      ended || null,
      now - ended < LIVE_MS ? 'running' : 'done',
      (old?.tool_count ?? 0) + a.toolCount,
      JSON.stringify(mix),
      old?.tokens_in ?? 0,
      old?.tokens_out ?? 0,
      old?.cache_read ?? 0,
      old?.cache_write ?? 0,
    );

    const ins = this.stmt(
      `insert or replace into usage_msgs(session_id, agent_id, msg_id, ts, day, hour, model, provider, family, tin, tout, cache_read, cache_write)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const u of a.usage.values()) {
      const day = dayKey(u.ts);
      const pf = providerAndFamily(u.model);
      ins.run(sid, a.agentId, u.msgId, u.ts, day, hourOf(u.ts), u.model, pf.provider, pf.family, u.tin, u.tout, u.cacheRead, u.cacheWrite);
      this.dirtyDays.add(day);
    }
    const tool = this.stmt(
      'insert into tool_calls(session_id, day, tool, count) values (?,?,?,?) on conflict(session_id, day, tool) do update set count = count + excluded.count',
    );
    for (const [k, n] of a.toolDays) {
      const [day, name] = k.split('\t');
      tool.run(sid, day, name, n);
    }
    const doc = this.stmt('insert into docs(session_id, agent_id, ts, kind, text) values (?,?,?,?,?)');
    for (const x of a.docs) doc.run(sid, a.agentId, x.ts, x.kind, x.text);
  }

  /** After a batch of sessions: agent totals and per-day rollups for what changed, and end stale "running" agents. */
  finishBatch(sessionIds: Iterable<string>, now = Date.now()) {
    this.transaction(() => {
      for (const id of sessionIds) {
        this.stmt(
          `update agents set
             tokens_in = coalesce((select sum(tin) from usage_msgs m where m.session_id = agents.session_id and m.agent_id = agents.agent_id), 0),
             tokens_out = coalesce((select sum(tout) from usage_msgs m where m.session_id = agents.session_id and m.agent_id = agents.agent_id), 0),
             cache_read = coalesce((select sum(cache_read) from usage_msgs m where m.session_id = agents.session_id and m.agent_id = agents.agent_id), 0),
             cache_write = coalesce((select sum(cache_write) from usage_msgs m where m.session_id = agents.session_id and m.agent_id = agents.agent_id), 0)
           where session_id = ?`,
        ).run(id);
        this.stmt(
          `update sessions set agent_count = (select count(*) from agents a where a.session_id = sessions.id and a.agent_id != 'main') where id = ?`,
        ).run(id);
      }
      const delDaily = this.stmt('delete from usage_daily where day = ?');
      const delAct = this.stmt('delete from activity where day = ?');
      const insDaily = this.stmt(
        `insert into usage_daily(day, project, model, provider, family, tokens_in, tokens_out, cache_read, cache_write, messages)
         select m.day, s.project, m.model, m.provider, m.family, sum(m.tin), sum(m.tout), sum(m.cache_read), sum(m.cache_write), count(*)
         from usage_msgs m join sessions s on s.id = m.session_id where m.day = ? group by m.day, s.project, m.model`,
      );
      const insAct = this.stmt('insert into activity(day, hour, messages) select day, hour, count(*) from usage_msgs where day = ? group by day, hour');
      for (const day of this.dirtyDays) {
        delDaily.run(day);
        delAct.run(day);
        insDaily.run(day);
        insAct.run(day);
      }
      this.dirtyDays.clear();
      this.stmt("update agents set status = 'done' where status = 'running' and coalesce(ended, 0) < ?").run(now - LIVE_MS);
    });
  }

  /** After an interrupted run the rollups may lag the raw rows; recompute everything from usage_msgs. */
  markAllDirty(): string[] {
    for (const r of this.stmt('select distinct day from usage_msgs').all() as Row[]) this.dirtyDays.add(r.day);
    return (this.stmt('select id from sessions').all() as Row[]).map((r) => r.id as string);
  }

  // ---------- queries ----------

  counts(): { sessions: number; docs: number } {
    const s = this.stmt('select count(*) n from sessions').get() as Row;
    const d = this.stmt('select count(*) n from docs').get() as Row;
    return { sessions: s.n, docs: d.n };
  }

  sqliteVersion(): string {
    return String((this.db.prepare('select sqlite_version() v').get() as Row).v);
  }

  hasFts(): boolean {
    try {
      this.db.prepare("select count(*) from docs_fts where docs_fts match 'x'").get();
      return true;
    } catch {
      return false;
    }
  }

  summary(args: SummaryArgs, now = Date.now()): HistorySummary {
    const today = dayKey(now);
    const fromDay = rangeFromDay(args.range, now);
    const fromTs = fromDay ? dayStartMs(fromDay) : 0;
    const dayFilter = fromDay ?? '0000-00-00';
    const rows = (this.stmt('select * from usage_daily where day >= ?').all(dayFilter) as Row[]).map((r): UsageRow => ({
      day: r.day,
      project: r.project,
      model: r.model,
      provider: r.provider,
      family: r.family,
      tokensIn: r.tokens_in,
      tokensOut: r.tokens_out,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
      messages: r.messages,
    }));
    // exact per model: each usage row carries its model
    const est = estimateRows(rows.map((r) => ({ model: r.model, in: r.tokensIn, out: r.tokensOut, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite })));
    const first = rows.length ? rows.reduce((m, r) => (r.day < m ? r.day : m), rows[0].day) : today;
    const startDay = fromDay ?? first;
    let groups = aggregateUsage(rows, args.groupBy);
    if (args.groupBy === 'day' || args.groupBy === 'week') groups = fillTimeGroups(groups, args.groupBy, startDay, today);

    const sess = this.stmt(
      `select count(*) n, coalesce(sum(case when cost_usd is not null then cost_usd else 0 end), 0) cost, sum(case when cost_usd is not null then 1 else 0 end) withcost
       from sessions where coalesce(last_ts, 0) >= ?`,
    ).get(fromTs) as Row;
    const agents = this.stmt("select count(*) n from agents where agent_id != 'main' and coalesce(started, 0) >= ?").get(fromTs) as Row;
    const active = this.stmt('select count(distinct day) n from activity where day >= ?').get(dayFilter) as Row;
    const tools = (
      this.stmt('select tool, sum(count) n from tool_calls where day >= ? group by tool order by n desc, tool limit 12').all(dayFilter) as Row[]
    ).map((r) => ({
      tool: r.tool as string,
      count: r.n as number,
    }));
    const goals = (
      this.stmt('select goal, count(*) n from agents where coalesce(started, 0) >= ? group by goal order by n desc, goal').all(fromTs) as Row[]
    ).map((r) => ({
      goal: r.goal as Goal,
      count: r.n as number,
    }));
    const heat = buildHeatmap(
      this.stmt('select day, hour, messages from activity where day >= ?').all(dayFilter) as { day: string; hour: number; messages: number }[],
    );
    return {
      range: args.range,
      groupBy: args.groupBy,
      fromDay: fromDay,
      toDay: today,
      kpis: {
        tokens: sumRows(rows),
        costUsd: sess.cost,
        costSessions: sess.withcost ?? 0,
        costEstimatedUsd: est.usd,
        costUnpriced: est.unpriced,
        sessions: sess.n,
        agents: agents.n,
        activeDays: active.n,
      },
      groups,
      byProject: aggregateUsage(rows, 'project'),
      byModel: aggregateUsage(rows, 'model'),
      tools,
      goals,
      heat,
      generatedAt: now,
    };
  }

  search(args: SearchArgs): SearchResult {
    const match = buildFtsQuery(args.q);
    if (!match) return { q: args.q, hits: [], empty: true };
    const limit = Math.max(1, Math.min(args.limit ?? 40, 200));
    const params: (string | number)[] = [match];
    let where = 'docs_fts match ?';
    if (args.project) {
      where += ' and s.project = ?';
      params.push(args.project);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `select d.session_id sid, d.agent_id aid, d.ts ts, d.kind kind, s.title title, s.project project, a.type atype, a.description adesc,
                snippet(docs_fts, 0, '${MARK_START}', '${MARK_END}', '…', 20) snip
         from docs_fts
         join docs d on d.id = docs_fts.rowid
         join sessions s on s.id = d.session_id
         left join agents a on a.session_id = d.session_id and a.agent_id = d.agent_id
         where ${where}
         order by rank limit ?`,
      )
      .all(...params) as Row[];
    const hits: SearchHit[] = rows.map((r) => ({
      sessionId: r.sid,
      title: r.title ?? '(untitled)',
      project: r.project,
      ts: r.ts,
      kind: r.kind,
      agentId: r.aid,
      agent: r.aid === MAIN_AGENT ? 'main agent' : r.adesc || r.atype || r.aid,
      snippet: parseSnippet(String(r.snip)),
    }));
    return { q: args.q, hits, empty: false };
  }

  dbBytes(): number {
    let n = 0;
    for (const suffix of ['', '-wal']) {
      try {
        n += fs.statSync(this.file + suffix).size;
      } catch {
        /* missing */
      }
    }
    return n;
  }
}
