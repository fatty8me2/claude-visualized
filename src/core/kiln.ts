// Kiln (github.com/fatty8me2/kiln): a coding agent for local models that Claude Code hands work to through its MCP tool
// `mcp__kiln__delegate_task`. Kiln narrates every delegated run to an append-only JSONL file (~/.config/kiln/events.jsonl):
// task_started, tool_call / tool_result, model_text, task_finished, plus status_check from `local_model_status`.
//
// This module is pure (no fs): it folds those lines into runs (KilnLog), matches a run to the Claude tool call that started
// it (same task text, same folder, a few seconds later), and turns a run into AgentEvents so the graph, log, drawer and
// overview show it as a local-model subagent of that Claude agent. A run nobody claims becomes a session of its own.
// Defensive on purpose: every field may be missing or of another type in some Kiln version.

import type { AgentEvent, KilnInfo } from './events';

export const KILN = 'kiln';
/** agent type of a Kiln run in the graph */
export const KILN_AGENT = 'kiln';

type Json = Record<string, any>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Claude Code's name for Kiln's hand-off tool: `mcp__kiln__delegate_task`, or a plugin-bundled `mcp__plugin_kiln_kiln__delegate_task`. */
export function isKilnDelegate(name: string | null | undefined): boolean {
  return !!name && /^mcp__[\w-]*kiln[\w-]*__delegate_task$/i.test(name);
}

/** One step of a run, in file order. */
export interface KilnStep {
  ts: number;
  kind: 'call' | 'result' | 'text';
  /** Kiln's tool name (read_file, bash, ...) for call / result */
  tool?: string;
  /** call: the argument summary (a path, a command, a pattern); result: the first ~300 chars; text: what the model said */
  text: string;
  ok?: boolean;
}

export interface KilnRun {
  id: string;
  pid: number;
  /** epoch ms */
  startedAt: number;
  lastAt: number;
  finishedAt: number | null;
  task: string;
  cwd: string;
  model: string;
  profile: string;
  effort: string;
  readonly: boolean;
  steps: KilnStep[];
  ok: boolean | null;
  error: string | null;
  answer: string;
  filesChanged: string[];
  diffStat: string | null;
  promptTokens: number;
  completionTokens: number;
  seconds: number;
  tokensPerSec: number;
  /** set by the main process: no task_finished and Kiln's process is gone */
  lost: boolean;
}

export interface KilnStatusCheck {
  ts: number;
  profile: string;
  model: string;
  baseUrl: string;
  reachable: boolean;
  servedModels: string[];
  detail: string;
}

const STEP_CAP = 400;
const RUN_CAP = 400;

/** One line of the events file, or null when it is not a Kiln event. Times become epoch ms. */
export function parseKilnLine(line: string): Json | null {
  const t = line.trim();
  if (!t || t[0] !== '{') return null;
  try {
    const o = JSON.parse(t);
    if (!o || typeof o !== 'object' || typeof o.kind !== 'string') return null;
    return o as Json;
  } catch {
    return null;
  }
}

/** Kiln writes unix seconds (float); anything that already looks like ms is kept. */
const toMs = (v: unknown): number => {
  const n = num(v);
  return n > 1e12 ? n : Math.round(n * 1000);
};

/** Every run seen in the events file (both rotations), newest kept when there are too many. */
export class KilnLog {
  runs = new Map<string, KilnRun>();
  status: KilnStatusCheck | null = null;
  /** bumped on every change, so callers can skip work */
  version = 0;
  private seen = new Set<string>();

  /** Fold one parsed line in. Returns true when it changed anything (a line read twice, e.g. after a rotation, does not). */
  add(e: Json): boolean {
    const kind = str(e.kind);
    const ts = toMs(e.ts);
    const key = `${e.ts}|${e.pid}|${kind}|${str(e.task_id)}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 200_000) this.seen.clear();
    if (kind === 'status_check') {
      if (this.status && ts < this.status.ts) return false;
      this.status = {
        ts,
        profile: str(e.profile),
        model: str(e.model),
        baseUrl: str(e.base_url),
        reachable: e.reachable === true,
        servedModels: Array.isArray(e.served_models) ? e.served_models.filter((m: unknown) => typeof m === 'string').slice(0, 50) : [],
        detail: str(e.detail) || str(e.error),
      };
      this.version++;
      return true;
    }
    const id = str(e.task_id);
    if (!id) return false;
    let r = this.runs.get(id);
    if (!r) {
      if (kind !== 'task_started' && kind !== 'task_finished' && kind !== 'tool_call' && kind !== 'tool_result' && kind !== 'model_text') return false;
      r = newRun(id, num(e.pid), ts);
      this.runs.set(id, r);
      this.prune();
    }
    if (ts > r.lastAt) r.lastAt = ts;
    switch (kind) {
      case 'task_started':
        r.startedAt = Math.min(r.startedAt, ts);
        r.task = str(e.task) || r.task;
        r.cwd = str(e.cwd) || r.cwd;
        r.model = str(e.model) || r.model;
        r.profile = str(e.profile) || r.profile;
        r.effort = str(e.effort) || r.effort;
        r.readonly = e.readonly === true || e.approval === 'readonly';
        break;
      case 'tool_call':
        pushStep(r, { ts, kind: 'call', tool: str(e.tool), text: str(e.args_preview) || stripToolName(str(e.summary), str(e.tool)) });
        break;
      case 'tool_result':
        pushStep(r, { ts, kind: 'result', tool: str(e.tool), text: str(e.preview), ok: e.ok !== false });
        break;
      case 'model_text':
        if (str(e.text).trim()) pushStep(r, { ts, kind: 'text', text: str(e.text).trim() });
        break;
      case 'task_finished':
        r.finishedAt = ts;
        r.ok = e.ok === true;
        r.error = str(e.error) || null;
        r.answer = str(e.answer);
        r.filesChanged = Array.isArray(e.files_changed) ? e.files_changed.filter((f: unknown) => typeof f === 'string').slice(0, 200) : [];
        r.diffStat = str(e.diff_stat) || null;
        r.promptTokens = num(e.prompt_tokens);
        r.completionTokens = num(e.completion_tokens);
        r.seconds = num(e.seconds);
        r.tokensPerSec = num(e.tokens_per_sec);
        r.model = str(e.model) || r.model;
        r.lost = false;
        if (!r.startedAt || r.startedAt > ts) r.startedAt = ts - Math.round(r.seconds * 1000);
        break;
      default:
        return false;
    }
    this.version++;
    return true;
  }

  /** runs newest first */
  list(): KilnRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  private prune() {
    if (this.runs.size <= RUN_CAP) return;
    const old = [...this.runs.values()].sort((a, b) => a.lastAt - b.lastAt).slice(0, this.runs.size - RUN_CAP);
    for (const r of old) this.runs.delete(r.id);
  }
}

function newRun(id: string, pid: number, ts: number): KilnRun {
  return {
    id,
    pid,
    startedAt: ts,
    lastAt: ts,
    finishedAt: null,
    task: '',
    cwd: '',
    model: '',
    profile: '',
    effort: '',
    readonly: false,
    steps: [],
    ok: null,
    error: null,
    answer: '',
    filesChanged: [],
    diffStat: null,
    promptTokens: 0,
    completionTokens: 0,
    seconds: 0,
    tokensPerSec: 0,
    lost: false,
  };
}

function pushStep(r: KilnRun, s: KilnStep) {
  r.steps.push(s);
  // keep the first steps (they hold the spawn order the converter relies on) and drop from the middle
  if (r.steps.length > STEP_CAP) r.steps.splice(STEP_CAP / 2, r.steps.length - STEP_CAP);
}

/** older Kiln versions had no args_preview: their summary is "<tool> <args>" */
function stripToolName(summary: string, tool: string): string {
  return tool && summary.startsWith(tool + ' ') ? summary.slice(tool.length + 1) : summary;
}

export const runEnded = (r: KilnRun) => r.finishedAt !== null || r.lost;

// ---------------------------------------------------------------- matching a run to its Claude tool call

/** A delegate_task call seen in a Claude session (recorded by the reducer in internal.kilnCalls). */
export interface KilnCall {
  toolUseId: string;
  /** the Claude agent that made the call */
  agentId: string;
  ts: number;
  /** the first 300 characters of the brief (normalize.ts compactInput) */
  task: string;
  cwd: string;
  /** when the call returned, if it has */
  endTs?: number;
}

/** whitespace evened out, and the ellipsis Kiln puts on a clipped field (events.py _trunc) dropped */
const norm = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/…$/, '')
    .trimEnd();
export const sameDir = (a: string, b: string) => {
  const n = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
  return !!a && !!b && n(a) === n(b);
};

/**
 * A run can start long after its call: Claude Code runs MCP tools one at a time, so when Claude hands off several tasks at once
 * the later ones wait for the earlier ones. A run belongs to a call when it started before the call returned; while the call
 * is still waiting, up to this long after it.
 */
const MATCH_PENDING_MS = 6 * 3_600_000;
/** clocks and message timestamps can be a little off */
const MATCH_BEFORE_MS = 15_000;

/** Same brief: one is a prefix of the other once whitespace is evened out (both sides are clipped, at different lengths). */
export function sameTask(callTask: string, runTask: string): boolean {
  const a = norm(callTask);
  const b = norm(runTask);
  if (a.length < 8 || b.length < 8) return a === b && !!a;
  return a.length <= b.length ? b.startsWith(a) : a.startsWith(b);
}

/** The run a call started: same brief, starting within a few minutes of the call; a run in the same folder and closest in time wins. */
export function matchKilnRun(call: KilnCall, runs: Iterable<KilnRun>, taken: (runId: string) => boolean): KilnRun | null {
  let best: KilnRun | null = null;
  let bestScore = Infinity;
  for (const r of runs) {
    if (!r.task || taken(r.id)) continue;
    const dt = r.startedAt - call.ts;
    const latest = call.endTs !== undefined ? Math.max(0, call.endTs - call.ts) + MATCH_BEFORE_MS : MATCH_PENDING_MS;
    if (dt < -MATCH_BEFORE_MS || dt > latest) continue;
    if (!sameTask(call.task, r.task)) continue;
    const score = Math.abs(dt) + (call.cwd && r.cwd && !sameDir(call.cwd, r.cwd) ? 10 * 60_000 : 0);
    if (score < bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------- a run as AgentEvents

/** Kiln's tools under the names the rest of the app knows (tool mix, files, commands, summaries, countdowns). */
function toolOf(tool: string, arg: string): { name: string; input: Json } {
  switch (tool) {
    case 'read_file':
      return { name: 'Read', input: { file_path: arg } };
    case 'write_file':
      return { name: 'Write', input: { file_path: arg } };
    case 'edit_file':
      return { name: 'Edit', input: { file_path: arg } };
    case 'list_dir':
      return { name: 'LS', input: { path: arg } };
    case 'glob':
      return { name: 'Glob', input: { pattern: arg } };
    case 'grep':
      return { name: 'Grep', input: { pattern: arg } };
    case 'bash':
      return { name: 'Bash', input: { command: arg } };
    default:
      return { name: tool || 'tool', input: arg ? { summary: arg } : {} };
  }
}

export const kilnAgentId = (runId: string) => `kiln-${runId}`;

/** A one-line description of a brief for the graph card. */
export function kilnTitle(task: string): string {
  const first = task.split('\n').find((l) => l.trim()) ?? '';
  return clip(first.trim(), 90) || 'Kiln task';
}

export function kilnInfo(r: KilnRun): KilnInfo {
  return {
    runId: r.id,
    model: r.model,
    profile: r.profile,
    effort: r.effort,
    readonly: r.readonly,
    ok: r.lost ? false : r.ok,
    error: r.lost ? 'Kiln stopped before the task finished (its process is gone).' : r.error,
    answer: clip(r.answer, 4000),
    filesChanged: r.filesChanged.slice(0, 100),
    diffStat: r.diffStat,
    steps: r.steps.filter((s) => s.kind === 'call').length,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    seconds: r.seconds || (r.finishedAt !== null ? (r.finishedAt - r.startedAt) / 1000 : 0),
    tokensPerSec: r.tokensPerSec,
    finished: runEnded(r),
  };
}

/**
 * The run as AgentEvents. `parentToolUseId` set: a child agent of the Claude agent that made that call. Null: the run is the
 * session's main agent (a run nobody claimed). The list only ever grows at the end while the run goes on (the info and the end
 * come last), so a caller can inject `events.slice(alreadySent)` on every poll.
 */
export function kilnRunEvents(r: KilnRun, sessionId: string, parentToolUseId: string | null): AgentEvent[] {
  const child = parentToolUseId !== null;
  const agentId = child ? kilnAgentId(r.id) : null;
  const ref = { sessionId, agentId };
  const infoId = agentId ?? 'main';
  const out: AgentEvent[] = [];
  const t0 = r.startedAt;
  if (child) {
    out.push({ ts: t0, src: 'transcript', ref, k: 'agent.spawn', spawn: { childId: agentId!, parentToolUseId: parentToolUseId!, agentType: KILN_AGENT, description: kilnTitle(r.task) } });
  } else {
    out.push({ ts: t0, src: 'transcript', ref, k: 'session.meta', cwd: r.cwd || undefined, entrypoint: KILN });
    out.push({ ts: t0, src: 'transcript', ref, k: 'title', title: kilnTitle(r.task), kind: 'prompt' });
    // Kiln runs unattended: it edits and runs commands without asking, or (read-only) only reads
    out.push({ ts: t0, src: 'transcript', ref, k: 'mode', mode: r.readonly ? 'plan' : 'bypassPermissions' });
  }
  if (r.model) out.push({ ts: t0, src: 'transcript', ref, k: 'model', model: kilnModelId(r.model), effort: r.effort || undefined });
  out.push({ ts: t0, src: 'transcript', ref, k: 'prompt', text: r.task || '(no brief)' });
  out.push({ ts: t0, src: 'transcript', ref, k: 'kiln', agentId: infoId, info: { ...kilnInfo(r), finished: false, ok: null, error: null } });
  let n = 0;
  let open: { id: string; name: string } | null = null;
  for (const s of r.steps) {
    if (s.kind === 'call') {
      const t = toolOf(s.tool ?? '', s.text);
      open = { id: `${infoId}:${r.id}:${++n}`, name: t.name };
      out.push({ ts: s.ts, src: 'transcript', ref, k: 'tool.start', toolUseId: open.id, name: t.name, input: t.input });
    } else if (s.kind === 'result') {
      if (!open) continue;
      out.push({ ts: s.ts, src: 'transcript', ref, k: 'tool.end', toolUseId: open.id, ok: s.ok !== false, name: open.name, ...(s.ok === false ? { error: clip(s.text, 300) } : {}) });
      open = null;
    } else {
      out.push({ ts: s.ts, src: 'transcript', ref, k: 'text', role: 'assistant', preview: clip(s.text, 400), endTurn: false });
    }
  }
  if (runEnded(r)) {
    const end = r.finishedAt ?? r.lastAt;
    const info = kilnInfo(r);
    if (open) out.push({ ts: end, src: 'transcript', ref, k: 'tool.end', toolUseId: open.id, ok: false, name: open.name, error: 'interrupted' });
    out.push({ ts: end, src: 'transcript', ref, k: 'kiln', agentId: infoId, info });
    // the local model's tokens: counted as local (no Anthropic cost or limits), never as Claude's
    if (r.promptTokens + r.completionTokens > 0)
      out.push({ ts: end, src: 'transcript', ref, k: 'usage', msgId: `kiln:${r.id}`, usage: { in: r.promptTokens, out: r.completionTokens, cacheRead: 0, cacheWrite: 0 } });
    if (child) {
      out.push({ ts: end, src: 'transcript', ref, k: 'agent.stop', childId: agentId!, status: info.ok ? 'done' : 'error', detail: info.error ?? undefined });
    } else {
      if (r.answer) out.push({ ts: end, src: 'transcript', ref, k: 'text', role: 'assistant', preview: clip(r.answer, 400), endTurn: true });
      if (!info.ok) out.push({ ts: end, src: 'transcript', ref, k: 'attention', kind: 'error', detail: info.error ?? 'Kiln task failed' });
      out.push({ ts: end, src: 'transcript', ref, k: 'turn.end' });
    }
  }
  return out;
}

/** A model id the app classifies as local: Kiln always runs on this machine's model server. */
export function kilnModelId(model: string): string {
  return model.includes('/') && !/^(ollama|lmstudio|vllm|local|kiln)\//i.test(model) ? `kiln/${model.split('/').pop()}` : model;
}

/**
 * For replay: the session's events with every Kiln run its delegate_task calls started, as child agents. `taken` runs are
 * skipped. Returns the input unchanged when there is nothing to add.
 */
export function withKilnRuns(events: AgentEvent[], runs: readonly KilnRun[], sessionId: string): AgentEvent[] {
  if (!runs.length) return events;
  const used = new Set<string>();
  const extra: AgentEvent[] = [];
  const ends = new Map<string, number>();
  for (const e of events) if (e.k === 'tool.end' && !ends.has(e.toolUseId)) ends.set(e.toolUseId, e.ts);
  let cwd = '';
  for (const e of events) {
    if (e.k === 'session.meta' && e.cwd) cwd = e.cwd;
    if (e.k !== 'tool.start' || !isKilnDelegate(e.name)) continue;
    const i = obj(e.input);
    const call: KilnCall = {
      toolUseId: e.toolUseId,
      agentId: e.ref.agentId ?? 'main',
      ts: e.ts,
      task: str(i.task),
      cwd: str(i.cwd) || cwd,
      endTs: ends.get(e.toolUseId),
    };
    const r = matchKilnRun(call, runs, (id) => used.has(id));
    if (!r) continue;
    used.add(r.id);
    extra.push(...kilnRunEvents(r, sessionId, e.toolUseId));
  }
  if (!extra.length) return events;
  return [...events, ...extra].map((e, i) => [e, i] as const).sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1]).map(([e]) => e);
}

/** How long past hand-offs took, for the running delegate_task countdown (cmdEta.ts): key per effort, project = folder name. */
export function kilnDurations(runs: Iterable<KilnRun>): { key: string; project: string; ms: number }[] {
  const out: { key: string; project: string; ms: number }[] = [];
  for (const r of runs) {
    if (r.finishedAt === null || !r.ok || !(r.seconds > 0)) continue;
    const parts = r.cwd.split(/[\\/]/).filter(Boolean);
    out.push({ key: kilnEtaKey(r.effort, r.readonly), project: parts[parts.length - 1] ?? '', ms: r.seconds * 1000 });
  }
  return out;
}

/** "Kiln hand-off (medium)" / "Kiln hand-off (high, read-only)" */
export function kilnEtaKey(effort: string | null | undefined, readonly?: boolean): string {
  return `Kiln hand-off (${effort || 'medium'}${readonly ? ', read-only' : ''})`;
}

// ---------------------------------------------------------------- History search

export interface KilnSearchHit {
  run: KilnRun;
  /** where the words were found */
  field: 'task' | 'answer' | 'text';
  snippet: { text: string; hit: boolean }[];
}

/** Runs whose brief, answer or messages contain every word of the query (case-insensitive), newest first. */
export function searchKilnRuns(runs: readonly KilnRun[], q: string, limit = 10): KilnSearchHit[] {
  const terms = (q.match(/"[^"]+"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, '').toLowerCase()).filter((t) => t.length > 1);
  if (!terms.length) return [];
  const out: KilnSearchHit[] = [];
  for (const r of [...runs].sort((a, b) => b.startedAt - a.startedAt)) {
    const fields: [KilnSearchHit['field'], string][] = [
      ['task', r.task],
      ['answer', r.answer],
      ['text', r.steps.filter((s) => s.kind === 'text').map((s) => s.text).join('\n')],
    ];
    const all = fields.map(([, t]) => t.toLowerCase()).join('\n');
    if (!terms.every((t) => all.includes(t))) continue;
    const [field, text] = fields.find(([, t]) => terms.some((w) => t.toLowerCase().includes(w)))!;
    out.push({ run: r, field, snippet: snippetOf(text, terms) });
    if (out.length >= limit) break;
  }
  return out;
}

function snippetOf(text: string, terms: string[]): { text: string; hit: boolean }[] {
  const flat = text.replace(/\s+/g, ' ').trim();
  const low = flat.toLowerCase();
  const first = Math.min(...terms.map((t) => low.indexOf(t)).filter((i) => i >= 0));
  const from = Math.max(0, first - 50);
  const slice = (from > 0 ? '…' : '') + flat.slice(from, from + 160) + (flat.length > from + 160 ? '…' : '');
  const lowSlice = slice.toLowerCase();
  const marks: boolean[] = new Array(slice.length).fill(false);
  for (const t of terms) for (let i = lowSlice.indexOf(t); i >= 0; i = lowSlice.indexOf(t, i + t.length)) marks.fill(true, i, i + t.length);
  const parts: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < slice.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.hit === marks[i]) last.text += slice[i];
    else parts.push({ text: slice[i], hit: marks[i] });
  }
  return parts;
}
