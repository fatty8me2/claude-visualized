// One poll of one local model server. Pure apart from the injected `req` function, so it can be
// tested with canned responses. `req` is bound to the server's base URL by the caller (main process).

import {
  parseLlamaHealth,
  parseLlamaMetrics,
  parseLlamaProps,
  parseLlamaSlots,
  parseLmStudioModels,
  parseOllamaPs,
  parseOllamaShow,
  parseOllamaTags,
  parseOllamaVersion,
  parseOpenAiModels,
  type LocalModelInfo,
  type LocalServerKind,
  type LocalServerStatus,
  type OllamaShow,
} from './localModels';

export interface PollResponse {
  status: number;
  /** parsed JSON, null when the body was not JSON */
  body: unknown;
  text: string;
}

/** Rejects on network errors / timeouts; resolves with the response for any HTTP status. */
export type PollRequest = (path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }) => Promise<PollResponse>;

export interface PollTarget {
  id: string;
  kind: LocalServerKind;
  name: string;
  baseUrl: string;
}

const ok = (r: PollResponse) => r.status >= 200 && r.status < 300;

export function baseStatus(t: PollTarget, now: number): LocalServerStatus {
  return {
    id: t.id,
    kind: t.kind,
    name: t.name,
    baseUrl: t.baseUrl,
    state: 'checking',
    version: null,
    error: null,
    loaded: [],
    installed: [],
    inFlight: null,
    slots: null,
    tokensPerSec: null,
    notes: [],
    checkedAt: now,
    failures: 0,
    nextPollAt: null,
  };
}

async function tryReq(req: PollRequest, path: string, init?: Parameters<PollRequest>[1]): Promise<PollResponse | null> {
  try {
    return await req(path, init);
  } catch {
    return null;
  }
}

export type OllamaShowCache = Map<string, OllamaShow>;

async function pollOllama(t: PollTarget, req: PollRequest, now: number, showCache: OllamaShowCache): Promise<LocalServerStatus> {
  const s = baseStatus(t, now);
  const ver = await req('/api/version'); // network failure here means the server is down
  if (!ok(ver)) throw new Error(`HTTP ${ver.status} from /api/version`);
  s.state = 'up';
  s.version = parseOllamaVersion(ver.body);
  const [ps, tags] = await Promise.all([tryReq(req, '/api/ps'), tryReq(req, '/api/tags')]);
  if (ps && ok(ps)) s.loaded = parseOllamaPs(ps.body, now);
  else s.notes.push('could not read /api/ps (loaded models)');
  if (tags && ok(tags)) s.installed = parseOllamaTags(tags.body);
  // context length and capabilities, once per loaded model
  for (const m of s.loaded) {
    const key = `${m.id}|${m.sizeBytes ?? ''}`;
    let show = showCache.get(key);
    if (!show) {
      const r = await tryReq(req, '/api/show', { method: 'POST', body: { model: m.id } });
      if (r && ok(r)) {
        show = parseOllamaShow(r.body);
        showCache.set(key, show);
      }
    }
    if (show) {
      m.maxContext = show.maxContext;
      m.contextLength ??= show.numCtx;
      m.capabilities = show.capabilities;
    }
  }
  // only keep cache entries for models still around
  if (showCache.size > 64) showCache.clear();
  s.notes.push('Ollama reports no live tokens/sec or request counts; this view shows what is loaded and for how long.');
  return s;
}

async function pollLmStudio(t: PollTarget, req: PollRequest, now: number): Promise<LocalServerStatus> {
  const s = baseStatus(t, now);
  const v0 = await tryReq(req, '/api/v0/models');
  if (v0 && ok(v0)) {
    s.installed = parseLmStudioModels(v0.body);
    s.loaded = s.installed.filter((m) => m.loaded);
  } else {
    const v1 = await tryReq(req, '/api/v1/models');
    if (v1 && ok(v1)) {
      s.installed = parseLmStudioModels(v1.body);
      s.loaded = s.installed.filter((m) => m.loaded);
    } else {
      const oa = await req('/v1/models'); // throws when nothing answers
      if (!ok(oa)) throw new Error(`HTTP ${oa.status} from /v1/models`);
      s.installed = parseOpenAiModels(oa.body).map((m) => ({ ...m, loaded: false }));
      s.notes.push('Only the OpenAI-compatible list is available, so loaded vs. not loaded is unknown. Update LM Studio for /api/v0/models.');
    }
  }
  s.state = 'up';
  s.notes.push('LM Studio reports no live tokens/sec or request counts.');
  return s;
}

async function pollOpenAi(t: PollTarget, req: PollRequest, now: number): Promise<LocalServerStatus> {
  const s = baseStatus(t, now);
  const [models, health, props, slots, metrics] = await Promise.all([
    tryReq(req, '/v1/models'),
    tryReq(req, '/health'),
    tryReq(req, '/props'),
    tryReq(req, '/slots'),
    tryReq(req, '/metrics'),
  ]);
  const h = health ? parseLlamaHealth(health.status, health.body) : null;
  if (!models && !health) throw new Error('no response');
  if (models && !ok(models) && !(h && (h.ok || h.loading))) throw new Error(`HTTP ${models.status} from /v1/models`);
  s.state = 'up';
  if (models && ok(models)) {
    s.loaded = parseOpenAiModels(models.body);
    s.installed = s.loaded;
  }
  const llama = props && ok(props) ? parseLlamaProps(props.body) : null;
  if (llama) {
    s.version = llama.version;
    if (llama.nCtx) for (const m of s.loaded) m.contextLength ??= llama.nCtx;
    s.notes.push('llama.cpp server detected (/props).');
  }
  if (h?.loading) s.notes.push('the server is up but still loading its model');
  const sl = slots && ok(slots) ? parseLlamaSlots(slots.body) : null;
  if (sl) {
    s.slots = sl;
    s.inFlight = sl.busy;
    if (sl.nCtx) for (const m of s.loaded) m.contextLength ??= sl.nCtx;
  } else if (llama) s.notes.push('/slots is disabled on this server, so requests in flight are unknown unless /metrics is on.');
  const mt = metrics && ok(metrics) ? parseLlamaMetrics(metrics.text) : null;
  if (mt) {
    if (mt.processing != null) s.inFlight = mt.processing;
    s.tokensPerSec = { generation: mt.generationTps, prompt: mt.promptTps };
    s.notes.push('tokens/sec is the server-side average from /metrics, not a live rate.');
  } else if (llama) s.notes.push('start llama-server with --metrics to see tokens/sec.');
  return s;
}

/**
 * Poll one server. Never throws: a server that does not answer comes back as state 'down' with the reason.
 * `showCache` keeps Ollama /api/show results between polls.
 */
export async function pollServer(t: PollTarget, req: PollRequest, now: number, showCache: OllamaShowCache = new Map()): Promise<LocalServerStatus> {
  try {
    if (t.kind === 'ollama') return await pollOllama(t, req, now, showCache);
    if (t.kind === 'lmstudio') return await pollLmStudio(t, req, now);
    return await pollOpenAi(t, req, now);
  } catch (e) {
    const s = baseStatus(t, now);
    s.state = 'down';
    s.error = (e as Error)?.message ?? 'not reachable';
    return s;
  }
}

export type { LocalModelInfo };
