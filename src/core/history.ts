// History and analytics: pure logic shared by the indexer worker (main) and the History page (renderer).
// Date bucketing (local timezone, weeks start on Monday), usage aggregation, per-file delta extraction from
// transcript lines, and full-text search query building. No I/O here; the SQLite layer lives in src/main/historyDb.ts.

import { classifyGoal, toolCategory, type Goal, type ToolMix } from './goal';
import { classifyModel } from './models';
import { normalizeLine, cleanPrompt } from './normalize';
import { modelFamily, summarizeTool, toolLabel } from './summarize';

// ---------- dates (local timezone) ----------

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "2026-10-14": the local calendar day of a timestamp. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local hour of day, 0-23. */
export function hourOf(ts: number): number {
  return new Date(ts).getHours();
}

function parseDay(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.split('-').map(Number);
  return { y, m, d };
}

/** Calendar arithmetic on day keys is done in UTC so DST never shifts a day. */
export function addDays(day: string, n: number): string {
  const { y, m, d } = parseDay(day);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** 0 = Monday ... 6 = Sunday. */
export function weekdayIndex(day: string): number {
  const { y, m, d } = parseDay(day);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** The Monday on or before this day. */
export function weekStart(day: string): string {
  return addDays(day, -weekdayIndex(day));
}

/** Local midnight (ms) at the start of a day key. */
export function dayStartMs(day: string): number {
  const { y, m, d } = parseDay(day);
  return new Date(y, m - 1, d).getTime();
}

export function daysBetween(a: string, b: string): number {
  const pa = parseDay(a);
  const pb = parseDay(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}

export type RangeKey = '7d' | '30d' | '90d' | 'all';
export const RANGES: RangeKey[] = ['7d', '30d', '90d', 'all'];
const RANGE_DAYS: Record<Exclude<RangeKey, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90 };

/** First local day included in a range ending today; null = everything. */
export function rangeFromDay(range: RangeKey, now: number): string | null {
  if (range === 'all') return null;
  return addDays(dayKey(now), -(RANGE_DAYS[range] - 1));
}

export type GroupBy = 'day' | 'week' | 'project' | 'model';

// ---------- usage aggregation ----------

/** One row of the usage_daily table. */
export interface UsageRow {
  day: string;
  project: string;
  model: string;
  provider: string;
  family: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
}

export interface TokenSums {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
}

/** Tokens the model actually read fresh and wrote; cache reads are shown separately because they dwarf everything else. */
export const ioTokens = (t: Pick<TokenSums, 'tokensIn' | 'tokensOut'>) => t.tokensIn + t.tokensOut;
export const allTokens = (t: Pick<TokenSums, 'tokensIn' | 'tokensOut' | 'cacheRead' | 'cacheWrite'>) => t.tokensIn + t.tokensOut + t.cacheRead + t.cacheWrite;

export interface GroupRow extends TokenSums {
  key: string;
  label: string;
  /** model family -> input+output tokens */
  byFamily: Record<string, number>;
  /** model family -> input+output+cache tokens */
  byFamilyAll: Record<string, number>;
}

export const emptySums = (): TokenSums => ({ tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });

export function addSums(into: TokenSums, r: TokenSums): TokenSums {
  into.tokensIn += r.tokensIn;
  into.tokensOut += r.tokensOut;
  into.cacheRead += r.cacheRead;
  into.cacheWrite += r.cacheWrite;
  into.messages += r.messages;
  return into;
}

export function sumRows(rows: UsageRow[]): TokenSums {
  const t = emptySums();
  for (const r of rows) addSums(t, r);
  return t;
}

function bucketOf(r: UsageRow, by: GroupBy): { key: string; label: string } {
  switch (by) {
    case 'day':
      return { key: r.day, label: r.day };
    case 'week': {
      const w = weekStart(r.day);
      return { key: w, label: `week of ${w}` };
    }
    case 'project':
      return { key: r.project || '(unknown)', label: r.project || '(unknown)' };
    case 'model': {
      const c = classifyModel(r.model);
      return { key: r.model || '(unknown)', label: r.model ? c.label : '(unknown)' };
    }
  }
}

/** Group usage rows. Time groups come back oldest first, project/model groups biggest first (by input + output tokens). */
export function aggregateUsage(rows: UsageRow[], by: GroupBy): GroupRow[] {
  const map = new Map<string, GroupRow>();
  for (const r of rows) {
    const { key, label } = bucketOf(r, by);
    let g = map.get(key);
    if (!g) {
      g = { key, label, ...emptySums(), byFamily: {}, byFamilyAll: {} };
      map.set(key, g);
    }
    addSums(g, r);
    g.byFamily[r.family] = (g.byFamily[r.family] ?? 0) + ioTokens(r);
    g.byFamilyAll[r.family] = (g.byFamilyAll[r.family] ?? 0) + allTokens(r);
  }
  const out = [...map.values()];
  if (by === 'day' || by === 'week') out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  else out.sort((a, b) => ioTokens(b) - ioTokens(a) || allTokens(b) - allTokens(a) || (a.key < b.key ? -1 : 1));
  return out;
}

/** Insert empty buckets so a time axis has no gaps. fromDay/toDay are inclusive day keys. */
export function fillTimeGroups(groups: GroupRow[], by: 'day' | 'week', fromDay: string, toDay: string): GroupRow[] {
  const have = new Map(groups.map((g) => [g.key, g]));
  const out: GroupRow[] = [];
  const step = by === 'day' ? 1 : 7;
  let cur = by === 'day' ? fromDay : weekStart(fromDay);
  const end = by === 'day' ? toDay : weekStart(toDay);
  while (cur <= end) {
    out.push(have.get(cur) ?? { key: cur, label: by === 'day' ? cur : `week of ${cur}`, ...emptySums(), byFamily: {}, byFamilyAll: {} });
    cur = addDays(cur, step);
  }
  return out;
}

/** weekday x hour message counts. Row 0 = Monday. */
export function buildHeatmap(rows: { day: string; hour: number; messages: number }[]): number[][] {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const r of rows) {
    if (r.hour >= 0 && r.hour < 24) grid[weekdayIndex(r.day)][r.hour] += r.messages;
  }
  return grid;
}

// ---------- full-text search ----------

const MAX_TERMS = 12;

/**
 * User text -> a safe FTS5 MATCH expression. Words become quoted prefix terms joined with AND ("retr" finds "retry");
 * "double quoted" text is a phrase. Every FTS operator and punctuation character is neutralised by quoting, so any input is valid.
 */
export function buildFtsQuery(input: string): string | null {
  const parts: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) && parts.length < MAX_TERMS) {
    const quoted = m[1] !== undefined;
    const raw = quoted ? m[1] : m[2];
    // FTS5's unicode61 tokenizer splits on anything that is not a letter or digit; mirror that so the phrase tokens line up
    const words = raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (words.length === 0) continue;
    if (quoted && words.length > 1) parts.push(`"${words.join(' ')}"`);
    else if (words.length === 1 || quoted) parts.push(`"${words[0]}"*`);
    else parts.push(`"${words.join(' ')}"*`); // a path or identifier like src/api.ts: match it as an adjacent phrase
  }
  return parts.length ? parts.join(' AND ') : null;
}

export const MARK_START = '\u0001';
export const MARK_END = '\u0002';

export interface SnippetPart {
  text: string;
  hit: boolean;
}

/** Split an FTS5 snippet() string (matches wrapped in MARK_START/MARK_END) into plain and highlighted parts. */
export function parseSnippet(s: string): SnippetPart[] {
  const out: SnippetPart[] = [];
  let hit = false;
  let buf = '';
  const flush = () => {
    if (buf) out.push({ text: buf, hit });
    buf = '';
  };
  for (const ch of s) {
    if (ch === MARK_START) {
      flush();
      hit = true;
    } else if (ch === MARK_END) {
      flush();
      hit = false;
    } else buf += ch;
  }
  flush();
  return out;
}

// ---------- IPC shapes ----------

export type IndexState = 'starting' | 'idle' | 'indexing' | 'error';

export interface HistoryStatus {
  state: IndexState;
  /** which phase the indexer is in while indexing */
  phase: 'scan' | 'sessions' | 'rollup' | null;
  done: number;
  total: number;
  error: string | null;
  lastRunAt: number | null;
  lastRunMs: number | null;
  sessions: number;
  docs: number;
  dbBytes: number;
  engine: string;
  sqliteVersion: string;
  fts: boolean;
}

export interface SummaryArgs {
  range: RangeKey;
  groupBy: GroupBy;
}

export interface HistoryKpis {
  tokens: TokenSums;
  costUsd: number;
  costSessions: number;
  sessions: number;
  agents: number;
  activeDays: number;
}

export interface GoalCount {
  goal: Goal;
  count: number;
}

export interface HistorySummary {
  range: RangeKey;
  groupBy: GroupBy;
  /** first and last local day of the range ('all' = first day with data to today) */
  fromDay: string | null;
  toDay: string;
  kpis: HistoryKpis;
  /** grouped by `groupBy`; day/week groups have no gaps */
  groups: GroupRow[];
  /** always per day (gap free), for the stacked chart when groupBy is a time unit */
  byProject: GroupRow[];
  byModel: GroupRow[];
  tools: { tool: string; count: number }[];
  goals: GoalCount[];
  /** [weekday 0=Mon][hour] message counts */
  heat: number[][];
  generatedAt: number;
}

export interface SearchArgs {
  q: string;
  limit?: number;
  project?: string;
}

export interface SearchHit {
  sessionId: string;
  title: string;
  project: string;
  ts: number;
  kind: 'prompt' | 'assistant' | 'tool';
  agentId: string;
  agent: string;
  snippet: SnippetPart[];
}

export interface SearchResult {
  q: string;
  hits: SearchHit[];
  /** the query was empty or only punctuation */
  empty: boolean;
}

// ---------- extracting facts from transcript lines ----------

export interface UsageMsg {
  msgId: string;
  ts: number;
  model: string;
  tin: number;
  tout: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface DocRow {
  ts: number;
  kind: 'prompt' | 'assistant' | 'tool';
  text: string;
}

export interface AgentDelta {
  agentId: string;
  firstTs: number;
  lastTs: number;
  model: string | null;
  models: Set<string>;
  usage: Map<string, UsageMsg>;
  toolCount: number;
  toolMix: ToolMix;
  /** `${day}\t${tool}` -> calls */
  toolDays: Map<string, number>;
  firstPrompt: string | null;
  lastPrompt: string | null;
  docs: DocRow[];
}

export interface FileDelta {
  agents: Map<string, AgentDelta>;
  cwd: string | null;
  entrypoint: string | null;
  title: { title: string; rank: 2 | 3 } | null;
  costUsd: number | null;
  firstTs: number;
  lastTs: number;
  lines: number;
}

export const MAIN_AGENT = 'main';
export const DOC_CAP = 2000;
const TOOL_DOC_CAP = 400;

const LOG_TITLE_MAX = 80;

function newAgentDelta(agentId: string): AgentDelta {
  return {
    agentId,
    firstTs: 0,
    lastTs: 0,
    model: null,
    models: new Set(),
    usage: new Map(),
    toolCount: 0,
    toolMix: {},
    toolDays: new Map(),
    firstPrompt: null,
    lastPrompt: null,
    docs: [],
  };
}

/** Lines that cannot contribute to history and are expensive to parse (tool results, file snapshots). */
export function skipLine(line: string): boolean {
  return line.includes('"type":"tool_result"') || line.startsWith('{"type":"file-history-snapshot"') || line.includes('"type":"file-history-snapshot"');
}

function assistantTexts(line: string): string[] {
  try {
    const o = JSON.parse(line);
    const c = o?.message?.content;
    if (!Array.isArray(c)) return [];
    const out: string[] = [];
    for (const b of c) if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push(b.text.trim().slice(0, DOC_CAP));
    return out;
  } catch {
    return [];
  }
}

/**
 * Fold new transcript lines of ONE file into a delta. `fileAgentId` is the agent the file belongs to (null = main transcript).
 * Usage is keyed by message id (the last line of a message wins) exactly as reducer.ts does, so a message split over several lines counts once.
 */
export function extractDelta(sessionId: string, fileAgentId: string | null, lines: Iterable<string>): FileDelta {
  const d: FileDelta = { agents: new Map(), cwd: null, entrypoint: null, title: null, costUsd: null, firstTs: 0, lastTs: 0, lines: 0 };
  const agent = (id: string | null): AgentDelta => {
    const key = id ?? MAIN_AGENT;
    let a = d.agents.get(key);
    if (!a) {
      a = newAgentDelta(key);
      d.agents.set(key, a);
    }
    return a;
  };
  const ctx = { sessionId, agentId: fileAgentId };
  const seenTools = new Set<string>();
  for (const line of lines) {
    if (!line || skipLine(line)) continue;
    d.lines++;
    const events = normalizeLine(line, ctx, 0);
    let hasText = false;
    for (const e of events) {
      const a = agent(e.ref.agentId);
      if (e.ts > 0) {
        if (!a.firstTs || e.ts < a.firstTs) a.firstTs = e.ts;
        if (e.ts > a.lastTs) a.lastTs = e.ts;
        if (e.k !== 'unknown') {
          if (!d.firstTs || e.ts < d.firstTs) d.firstTs = e.ts;
          if (e.ts > d.lastTs) d.lastTs = e.ts;
        }
      }
      switch (e.k) {
        case 'session.meta':
          if (e.cwd && !d.cwd) d.cwd = e.cwd;
          if (e.entrypoint && !d.entrypoint) d.entrypoint = e.entrypoint;
          break;
        case 'title':
          if (e.kind === 'custom') d.title = { title: e.title, rank: 3 };
          else if (e.kind === 'ai' && d.title?.rank !== 3) d.title = { title: e.title, rank: 2 };
          break;
        case 'model':
          a.model = e.model;
          a.models.add(e.model);
          break;
        case 'prompt': {
          const text = e.text.trim();
          if (!text) break;
          if (!a.firstPrompt) a.firstPrompt = text.slice(0, 600);
          a.lastPrompt = text.slice(0, 600);
          a.docs.push({ ts: e.ts, kind: 'prompt', text: text.slice(0, DOC_CAP) });
          break;
        }
        case 'tool.start': {
          if (seenTools.has(e.toolUseId)) break;
          seenTools.add(e.toolUseId);
          a.toolCount++;
          const cat = toolCategory(e.name, e.input);
          a.toolMix[cat] = (a.toolMix[cat] ?? 0) + 1;
          if (e.ts > 0) {
            const k = `${dayKey(e.ts)}\t${e.name}`;
            a.toolDays.set(k, (a.toolDays.get(k) ?? 0) + 1);
          }
          const sum = summarizeTool(e.name, e.input);
          a.docs.push({ ts: e.ts, kind: 'tool', text: `${toolLabel(e.name)}${sum ? ' ' + sum : ''}`.slice(0, TOOL_DOC_CAP) });
          break;
        }
        case 'usage':
          if (e.ts > 0)
            a.usage.set(e.msgId, {
              msgId: e.msgId,
              ts: e.ts,
              model: a.model ?? '',
              tin: e.usage.in,
              tout: e.usage.out,
              cacheRead: e.usage.cacheRead,
              cacheWrite: e.usage.cacheWrite,
            });
          break;
        case 'cost':
          d.costUsd = e.totalCostUSD;
          break;
        case 'text':
          hasText = true;
          break;
      }
    }
    if (hasText) {
      // the event only keeps a 400 character preview; search wants the whole block
      const owner = events.find((e) => e.k === 'text');
      if (owner) {
        const a = agent(owner.ref.agentId);
        for (const t of assistantTexts(line)) a.docs.push({ ts: owner.ts, kind: 'assistant', text: t });
      }
    }
  }
  return d;
}

/** "C--Users-fatty-Desktop-junkerberg" -> "junkerberg" when no cwd is known. */
export function projectName(cwd: string | null, dirName: string): string {
  if (cwd) {
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? cwd;
  }
  const parts = dirName.split('-').filter(Boolean);
  return parts[parts.length - 1] ?? dirName;
}

/** A session title from its first real prompt, as the session picker does. */
export function titleFromPrompt(text: string | null): string | null {
  if (!text) return null;
  const t = cleanPrompt(text);
  if (!t || t.startsWith('<')) return null;
  return t.replace(/\s+/g, ' ').slice(0, LOG_TITLE_MAX);
}

export interface AgentGoalInput {
  isMain: boolean;
  agentType: string;
  description: string;
  phase: string | null;
  prompt: string | null;
  toolMix: ToolMix;
}

export function goalOfAgent(a: AgentGoalInput): Goal {
  return classifyGoal({
    kind: a.isMain ? 'main' : 'agent',
    agentType: a.agentType,
    description: a.description,
    phase: a.phase,
    prompt: a.prompt,
    toolMix: a.toolMix,
  }).goal;
}

export function providerAndFamily(model: string): { provider: string; family: string } {
  return { provider: classifyModel(model).provider, family: modelFamily(model) };
}

// ---------- chart helpers ----------

/** Round axis ticks from 0 up to just above `max`, with about `count` steps (1, 2, 5 x 10^n). */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out: number[] = [0];
  for (let i = 1; (i - 1) * step < max; i++) out.push(i * step);
  return out;
}

export function formatUsd(n: number): string {
  if (n >= 100) return `$${Math.round(n).toLocaleString('en-US')}`;
  return `$${n.toFixed(2)}`;
}
