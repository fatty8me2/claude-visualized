// Local model servers (Ollama, LM Studio, llama.cpp / vLLM / any OpenAI-compatible endpoint):
// shared types, tolerant parsers for each server's JSON, poll backoff, config validation and the
// link between a transcript's model id and a model a server currently has loaded.
//
// Sources (response shapes):
//  - Ollama:    https://github.com/ollama/ollama/blob/main/docs/api.md   (/api/version, /api/ps, /api/tags, /api/show)
//  - LM Studio: https://lmstudio.ai/docs/developer/rest/endpoints          (/api/v0/models, newer /api/v1/models)
//  - llama.cpp: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md (/health /props /slots /metrics)
//  - OpenAI-compatible: GET /v1/models, `max_model_len` on vLLM
// Every field is optional: servers add and rename fields between versions.

import type { LocalWindow } from './context';
import type { UsageNumbers } from './events';
import { classifyModel, sameModel } from './models';
import type { AgentNode } from './state';

type Json = Record<string, any>;

export type LocalServerKind = 'ollama' | 'lmstudio' | 'openai';

export interface LocalModelInfo {
  /** the server's own id, e.g. "qwen2.5-coder:32b" */
  id: string;
  /** prettified, e.g. "Qwen2.5 Coder 32B" */
  label: string;
  loaded: boolean;
  /** loaded: memory the model occupies; installed: size on disk */
  sizeBytes: number | null;
  /** part of sizeBytes that sits in GPU memory (Ollama size_vram) */
  vramBytes: number | null;
  params: string | null;
  quant: string | null;
  family: string | null;
  /** context length the model is running with (runtime), when the server says */
  contextLength: number | null;
  /** the model's maximum context length */
  maxContext: number | null;
  /** epoch ms when the server will unload it; null = never / unknown */
  expiresAt: number | null;
  capabilities: string[];
}

export interface LocalSlots {
  total: number;
  busy: number;
  nCtx: number | null;
}

export interface LocalServerStatus {
  id: string;
  kind: LocalServerKind;
  name: string;
  baseUrl: string;
  state: 'up' | 'down' | 'disabled' | 'checking';
  version: string | null;
  error: string | null;
  loaded: LocalModelInfo[];
  installed: LocalModelInfo[];
  /** requests being processed right now, when the server reports it (llama.cpp /slots, /metrics) */
  inFlight: number | null;
  slots: LocalSlots | null;
  /** average generation speed the server reports for itself (llama.cpp /metrics only) */
  tokensPerSec: { generation: number | null; prompt: number | null } | null;
  /** what this server can and can't tell us, shown verbatim in the UI */
  notes: string[];
  checkedAt: number;
  /** consecutive failed polls, for the backoff */
  failures: number;
  nextPollAt: number | null;
}

export interface LocalModelsView {
  servers: LocalServerStatus[];
  at: number;
}

export const emptyLocalView = (): LocalModelsView => ({ servers: [], at: 0 });

// ---------------- config ----------------

export interface LocalServerEntry {
  enabled: boolean;
  url: string;
}

export interface ExtraEndpoint extends LocalServerEntry {
  id: string;
  name: string;
}

export interface LocalModelsConfig {
  pollSec: number;
  ollama: LocalServerEntry;
  lmstudio: LocalServerEntry;
  extra: ExtraEndpoint[];
}

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_LMSTUDIO_URL = 'http://127.0.0.1:1234';
export const DEFAULT_POLL_SEC = 5;
export const MAX_BACKOFF_MS = 60_000;

export const DEFAULT_LOCAL_CONFIG: LocalModelsConfig = {
  pollSec: DEFAULT_POLL_SEC,
  ollama: { enabled: true, url: DEFAULT_OLLAMA_URL },
  lmstudio: { enabled: true, url: DEFAULT_LMSTUDIO_URL },
  extra: [],
};

/** "http://127.0.0.1:8080/v1/" -> "http://127.0.0.1:8080"; null when it is not an http(s) URL. */
export function normalizeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    const path = u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return null;
  }
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h);
  } catch {
    return false;
  }
}

function entry(raw: unknown, def: LocalServerEntry): LocalServerEntry {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Json;
  return { enabled: typeof r.enabled === 'boolean' ? r.enabled : def.enabled, url: normalizeBaseUrl(r.url) ?? def.url };
}

/** Fill defaults and drop anything invalid; the monitor only ever talks to URLs that come out of here. */
export function normalizeLocalConfig(raw: unknown): LocalModelsConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Json;
  const pollSec = typeof r.pollSec === 'number' && Number.isFinite(r.pollSec) ? Math.max(2, Math.min(300, Math.round(r.pollSec))) : DEFAULT_POLL_SEC;
  const extra: ExtraEndpoint[] = [];
  const seen = new Set<string>();
  for (const e of Array.isArray(r.extra) ? r.extra : []) {
    const url = normalizeBaseUrl(e?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const name = typeof e?.name === 'string' && e.name.trim() ? e.name.trim().slice(0, 40) : new URL(url).host;
    extra.push({ id: `openai:${url}`, name, url, enabled: typeof e?.enabled === 'boolean' ? e.enabled : true });
  }
  return { pollSec, ollama: entry(r.ollama, DEFAULT_LOCAL_CONFIG.ollama), lmstudio: entry(r.lmstudio, DEFAULT_LOCAL_CONFIG.lmstudio), extra };
}

/** Test/override hooks: CLAUDE_VIS_OLLAMA_URL / CLAUDE_VIS_LMSTUDIO_URL ("off" disables that server). */
export function applyUrlOverrides(c: LocalModelsConfig, env: Record<string, string | undefined>): LocalModelsConfig {
  const next = { ...c, ollama: { ...c.ollama }, lmstudio: { ...c.lmstudio } };
  for (const [key, field] of [
    ['CLAUDE_VIS_OLLAMA_URL', 'ollama'],
    ['CLAUDE_VIS_LMSTUDIO_URL', 'lmstudio'],
  ] as const) {
    const v = env[key];
    if (!v) continue;
    if (v === 'off') next[field].enabled = false;
    else {
      const u = normalizeBaseUrl(v);
      if (u) next[field] = { enabled: true, url: u };
    }
  }
  return next;
}

// ---------------- backoff ----------------

/**
 * Delay before the next poll: the configured interval while the server answers, doubling per
 * consecutive failure up to 60 s while it is down (never shorter than the interval itself).
 */
export function pollDelayMs(intervalMs: number, failures: number): number {
  if (failures <= 0) return intervalMs;
  return Math.max(intervalMs, Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** failures));
}

// ---------------- helpers ----------------

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

function blankModel(id: string, loaded: boolean): LocalModelInfo {
  return {
    id,
    label: classifyModel(id).label,
    loaded,
    sizeBytes: null,
    vramBytes: null,
    params: null,
    quant: null,
    family: null,
    contextLength: null,
    maxContext: null,
    expiresAt: null,
    capabilities: [],
  };
}

/** Ollama writes far-future or zero-year timestamps for keep_alive = -1 ("never unload"). */
function expiry(v: unknown, now: number): number | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t) || t <= 0 || t - now > 180 * 86_400_000) return null;
  return t;
}

// ---------------- Ollama ----------------

export function parseOllamaVersion(body: unknown): string | null {
  return str((body as Json | null)?.version);
}

function ollamaDetails(m: LocalModelInfo, d: Json | undefined) {
  if (!d || typeof d !== 'object') return;
  m.params = str(d.parameter_size);
  m.quant = str(d.quantization_level);
  m.family = str(d.family);
}

/** GET /api/ps: models currently loaded in memory. */
export function parseOllamaPs(body: unknown, now = Date.now()): LocalModelInfo[] {
  const out: LocalModelInfo[] = [];
  for (const m of arr((body as Json | null)?.models)) {
    const id = str(m?.name) ?? str(m?.model);
    if (!id) continue;
    const info = blankModel(id, true);
    info.sizeBytes = num(m.size);
    info.vramBytes = num(m.size_vram);
    ollamaDetails(info, m.details);
    info.contextLength = num(m.context_length) || null;
    info.expiresAt = expiry(m.expires_at, now);
    out.push(info);
  }
  return out;
}

/** GET /api/tags: installed models (size is the size on disk). */
export function parseOllamaTags(body: unknown): LocalModelInfo[] {
  const out: LocalModelInfo[] = [];
  for (const m of arr((body as Json | null)?.models)) {
    const id = str(m?.name) ?? str(m?.model);
    if (!id) continue;
    const info = blankModel(id, false);
    info.sizeBytes = num(m.size);
    ollamaDetails(info, m.details);
    out.push(info);
  }
  return out;
}

export interface OllamaShow {
  /** the model's maximum context ("<arch>.context_length" in model_info) */
  maxContext: number | null;
  /** num_ctx set in the Modelfile / parameters, if any */
  numCtx: number | null;
  capabilities: string[];
}

/** POST /api/show */
export function parseOllamaShow(body: unknown): OllamaShow {
  const b = (body && typeof body === 'object' ? body : {}) as Json;
  let maxContext: number | null = null;
  const info = b.model_info;
  if (info && typeof info === 'object') {
    for (const [k, v] of Object.entries(info as Json)) if (/\.context_length$/.test(k) && num(v)) maxContext = num(v);
  }
  const text = `${str(b.parameters) ?? ''}\n${str(b.modelfile) ?? ''}`;
  const m = /(?:^|\n)\s*(?:PARAMETER\s+)?num_ctx\s+(\d+)/i.exec(text);
  return { maxContext, numCtx: m ? Number(m[1]) : null, capabilities: arr(b.capabilities).filter((c) => typeof c === 'string') };
}

// ---------------- LM Studio ----------------

/** GET /api/v0/models (data[] with state) or /api/v1/models (models[] with loaded_instances). */
export function parseLmStudioModels(body: unknown): LocalModelInfo[] {
  const b = (body && typeof body === 'object' ? body : {}) as Json;
  const out: LocalModelInfo[] = [];
  for (const m of arr(b.data)) {
    const id = str(m?.id);
    if (!id) continue;
    if (m.type === 'embeddings' || m.type === 'embedding') continue;
    const info = blankModel(id, m.state === 'loaded');
    info.family = str(m.arch);
    info.quant = typeof m.quantization === 'string' ? m.quantization : null;
    info.maxContext = num(m.max_context_length);
    info.contextLength = info.loaded ? num(m.loaded_context_length) : null;
    out.push(info);
  }
  for (const m of arr(b.models)) {
    const id = str(m?.key) ?? str(m?.id);
    if (!id) continue;
    if (m.type === 'embedding' || m.type === 'embeddings') continue;
    const inst = arr(m.loaded_instances);
    const info = blankModel(id, inst.length > 0);
    info.family = str(m.architecture);
    info.quant = str(m.quantization?.name) ?? (typeof m.quantization === 'string' ? m.quantization : null);
    info.params = str(m.params_string);
    info.sizeBytes = num(m.size_bytes);
    info.maxContext = num(m.max_context_length);
    info.contextLength = inst.length ? num(inst[0]?.config?.context_length) : null;
    out.push(info);
  }
  return out;
}

// ---------------- OpenAI-compatible / llama.cpp ----------------

/** GET /v1/models. Everything listed is being served, so it counts as loaded. */
export function parseOpenAiModels(body: unknown): LocalModelInfo[] {
  const out: LocalModelInfo[] = [];
  for (const m of arr((body as Json | null)?.data)) {
    const id = str(m?.id);
    if (!id) continue;
    const info = blankModel(id, true);
    info.maxContext = num(m.max_model_len) || num(m.context_length) || null;
    out.push(info);
  }
  return out;
}

/** GET /health: 200 {"status":"ok"} when ready, 503 while the model loads. */
export function parseLlamaHealth(status: number, body: unknown): { ok: boolean; loading: boolean } {
  const s = str((body as Json | null)?.status);
  if (status === 503) return { ok: false, loading: true };
  return { ok: status === 200 && (s === null || s === 'ok'), loading: false };
}

export interface LlamaProps {
  nCtx: number | null;
  totalSlots: number | null;
  modelPath: string | null;
  version: string | null;
}

/** GET /props */
export function parseLlamaProps(body: unknown): LlamaProps {
  const b = (body && typeof body === 'object' ? body : {}) as Json;
  const path = str(b.model_path) ?? str(b.model_alias);
  return {
    nCtx: num(b.default_generation_settings?.n_ctx),
    totalSlots: num(b.total_slots),
    modelPath: path,
    version: str(b.build_info),
  };
}

/** GET /slots: one entry per parallel slot. */
export function parseLlamaSlots(body: unknown): LocalSlots | null {
  if (!Array.isArray(body)) return null;
  const busy = body.filter((s) => s?.is_processing === true || s?.state === 1).length;
  const nCtx = num(body[0]?.n_ctx);
  return { total: body.length, busy, nCtx };
}

export interface LlamaMetrics {
  processing: number | null;
  deferred: number | null;
  generationTps: number | null;
  promptTps: number | null;
}

/** GET /metrics (Prometheus text; needs --metrics). */
export function parseLlamaMetrics(text: string): LlamaMetrics | null {
  const get = (name: string): number | null => {
    const m = new RegExp(`^${name.replace(':', '\\:')}(?:\\{[^}]*\\})?\\s+([-+0-9.eE]+|NaN|Inf)\\s*$`, 'm').exec(text);
    if (!m) return null;
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : null;
  };
  const r: LlamaMetrics = {
    processing: get('llamacpp:requests_processing'),
    deferred: get('llamacpp:requests_deferred'),
    generationTps: get('llamacpp:predicted_tokens_seconds'),
    promptTps: get('llamacpp:prompt_tokens_seconds'),
  };
  return Object.values(r).every((v) => v === null) ? null : r;
}

// ---------------- linking sessions to servers ----------------

export interface LocalLink {
  server: LocalServerStatus;
  model: LocalModelInfo;
}

/** The loaded model (on a server that is up) that a transcript's model id refers to. */
export function findLoadedModel(model: string | null | undefined, servers: LocalServerStatus[]): LocalLink | null {
  if (!model || classifyModel(model).provider === 'anthropic') return null;
  for (const server of servers) {
    if (server.state !== 'up') continue;
    const m = server.loaded.find((l) => sameModel(model, l.id));
    if (m) return { server, model: m };
  }
  return null;
}

/** Context length a server reported for this model: runtime context if loaded, else the model maximum (estimated). */
export function localWindowFor(model: string | null | undefined, servers: LocalServerStatus[]): LocalWindow | null {
  if (!model || classifyModel(model).provider === 'anthropic') return null;
  let fallback: LocalWindow | null = null;
  for (const server of servers) {
    if (server.state !== 'up') continue;
    for (const m of [...server.loaded, ...server.installed]) {
      if (!sameModel(model, m.id)) continue;
      if (m.loaded && m.contextLength) return { size: m.contextLength, estimated: false };
      const mx = m.maxContext ?? m.contextLength;
      if (mx && !fallback) fallback = { size: mx, estimated: true };
    }
  }
  return fallback;
}

export function serverKindName(kind: LocalServerKind): string {
  return kind === 'ollama' ? 'Ollama' : kind === 'lmstudio' ? 'LM Studio' : 'OpenAI-compatible';
}

export function localSummary(servers: LocalServerStatus[]): { up: number; loaded: number } {
  const ups = servers.filter((s) => s.state === 'up');
  return { up: ups.length, loaded: ups.reduce((n, s) => n + s.loaded.length, 0) };
}

/** "18.2 GB" */
export function formatBytes(n: number): string {
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 100 ? 0 : 1)} GB`;
  const mb = n / 1024 ** 2;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

/** Where a loaded model sits: all GPU, all CPU/RAM, or split. null when the server doesn't say. */
export function memorySplit(m: LocalModelInfo): { vram: number; ram: number; vramPct: number } | null {
  if (m.sizeBytes == null || m.vramBytes == null || m.sizeBytes <= 0) return null;
  const vram = Math.min(m.sizeBytes, Math.max(0, m.vramBytes));
  return { vram, ram: m.sizeBytes - vram, vramPct: Math.round((vram / m.sizeBytes) * 100) };
}

/** "loaded in Ollama · 18.2 GB VRAM" (or "14.1 GB VRAM + 4.1 GB RAM" when split, "RAM" when CPU only). */
export function loadedText(link: LocalLink): string {
  const where = `loaded in ${link.server.kind === 'openai' ? link.server.name : serverKindName(link.server.kind)}`;
  const split = memorySplit(link.model);
  if (split) {
    if (split.ram <= 0) return `${where} · ${formatBytes(split.vram)} VRAM`;
    if (split.vram <= 0) return `${where} · ${formatBytes(split.ram)} RAM`;
    return `${where} · ${formatBytes(split.vram)} VRAM + ${formatBytes(split.ram)} RAM`;
  }
  return link.model.sizeBytes ? `${where} · ${formatBytes(link.model.sizeBytes)}` : where;
}

/**
 * Tokens split by who served them. Local agents have no Anthropic cost or limits, so their tokens are
 * counted apart: `claude` is everything else (totals minus the local agents' tokens).
 */
export function tokensByProvider(agents: Record<string, AgentNode>, totals: UsageNumbers): { claude: UsageNumbers; local: UsageNumbers; localAgents: number } {
  const local: UsageNumbers = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  let localAgents = 0;
  for (const a of Object.values(agents)) {
    if (classifyModel(a.model).provider !== 'local') continue;
    localAgents++;
    local.in += a.tokens.in;
    local.out += a.tokens.out;
    local.cacheRead += a.tokens.cacheRead;
    local.cacheWrite += a.tokens.cacheWrite;
  }
  const claude: UsageNumbers = {
    in: Math.max(0, totals.in - local.in),
    out: Math.max(0, totals.out - local.out),
    cacheRead: Math.max(0, totals.cacheRead - local.cacheRead),
    cacheWrite: Math.max(0, totals.cacheWrite - local.cacheWrite),
  };
  return { claude, local, localAgents };
}

/** "unloads in 4m 12s" countdown text; null when unknown. */
export function unloadsIn(expiresAt: number | null, now: number): string | null {
  if (expiresAt == null) return null;
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
