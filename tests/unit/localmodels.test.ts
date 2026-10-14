import { describe, expect, it } from 'vitest';
import { contextInfo } from '@core/context';
import {
  applyUrlOverrides,
  DEFAULT_LOCAL_CONFIG,
  findLoadedModel,
  formatBytes,
  isLoopbackUrl,
  loadedText,
  localSummary,
  localWindowFor,
  memorySplit,
  normalizeBaseUrl,
  normalizeLocalConfig,
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
  pollDelayMs,
  tokensByProvider,
  unloadsIn,
  type LocalServerStatus,
} from '@core/localModels';
import { baseStatus, pollServer, type PollRequest, type PollResponse } from '@core/localPoll';
import { newAgent } from '@core/state';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const GB = 1024 ** 3;

// ---- sample payloads, shaped after the official API docs ----
const OLLAMA_PS = {
  models: [
    {
      name: 'qwen2.5-coder:32b',
      model: 'qwen2.5-coder:32b',
      size: 21_474_836_480,
      digest: 'a'.repeat(64),
      details: { parent_model: '', format: 'gguf', family: 'qwen2', families: ['qwen2'], parameter_size: '32.8B', quantization_level: 'Q4_K_M' },
      expires_at: '2026-10-14T12:04:12Z',
      size_vram: 19_551_000_000,
    },
    {
      name: 'llama3.1:8b',
      model: 'llama3.1:8b',
      size: 6_000_000_000,
      details: { family: 'llama', parameter_size: '8.0B', quantization_level: 'Q4_0' },
      expires_at: '2318-01-01T00:00:00Z', // keep_alive -1
      size_vram: 0,
      context_length: 8192,
    },
  ],
};
const OLLAMA_TAGS = {
  models: [
    {
      name: 'qwen2.5-coder:32b',
      model: 'qwen2.5-coder:32b',
      modified_at: '2026-09-01T10:00:00Z',
      size: 19_851_336_192,
      digest: 'b',
      details: { family: 'qwen2', parameter_size: '32.8B', quantization_level: 'Q4_K_M' },
    },
    {
      name: 'llama3.2:latest',
      model: 'llama3.2:latest',
      size: 2_019_393_189,
      details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' },
    },
  ],
};
const OLLAMA_SHOW = {
  modelfile: '# Modelfile\nFROM x\nPARAMETER num_ctx 16384\n',
  parameters: 'num_ctx                        16384\nstop                           "<|im_end|>"',
  model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32768, 'qwen2.embedding_length': 5120 },
  capabilities: ['completion', 'tools'],
};
const LMSTUDIO_V0 = {
  object: 'list',
  data: [
    {
      id: 'qwen2.5-coder-32b-instruct',
      object: 'model',
      type: 'llm',
      publisher: 'lmstudio-community',
      arch: 'qwen2',
      compatibility_type: 'gguf',
      quantization: 'Q4_K_M',
      state: 'loaded',
      max_context_length: 32768,
    },
    {
      id: 'llama-3.2-3b-instruct',
      object: 'model',
      type: 'llm',
      publisher: 'lmstudio-community',
      arch: 'llama',
      quantization: 'Q4_K_M',
      state: 'not-loaded',
      max_context_length: 131072,
    },
    { id: 'text-embedding-nomic-embed-text-v1.5', object: 'model', type: 'embeddings', state: 'not-loaded', max_context_length: 2048 },
  ],
};
const LMSTUDIO_V1 = {
  models: [
    {
      type: 'llm',
      publisher: 'google',
      key: 'google/gemma-3-27b',
      display_name: 'Gemma 3 27B',
      architecture: 'gemma3',
      quantization: { name: 'Q4_K_M', bits_per_weight: 4 },
      size_bytes: 16_000_000_000,
      params_string: '27B',
      loaded_instances: [{ id: 'google/gemma-3-27b', config: { context_length: 8192 } }],
      max_context_length: 131072,
    },
    { type: 'llm', key: 'x/y', loaded_instances: [], max_context_length: 4096 },
  ],
};
const OPENAI_MODELS = { object: 'list', data: [{ id: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', object: 'model', created: 0, owned_by: 'llamacpp' }] };
const LLAMA_PROPS = {
  default_generation_settings: { n_ctx: 8192 },
  total_slots: 2,
  model_path: '../models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
  build_info: 'b4567-abc',
};
const LLAMA_SLOTS = [
  { id: 0, n_ctx: 4096, is_processing: true },
  { id: 1, n_ctx: 4096, is_processing: false },
];
const LLAMA_METRICS = `# HELP llamacpp:prompt_tokens_total Number of prompt tokens processed.
# TYPE llamacpp:prompt_tokens_total counter
llamacpp:prompt_tokens_total 6
# HELP llamacpp:prompt_tokens_seconds Average prompt throughput in tokens/s.
# TYPE llamacpp:prompt_tokens_seconds gauge
llamacpp:prompt_tokens_seconds 102.5
# TYPE llamacpp:predicted_tokens_seconds gauge
llamacpp:predicted_tokens_seconds 31.25
# TYPE llamacpp:requests_processing gauge
llamacpp:requests_processing 1
# TYPE llamacpp:requests_deferred gauge
llamacpp:requests_deferred 0
`;

describe('Ollama parsers', () => {
  it('parses /api/version', () => {
    expect(parseOllamaVersion({ version: '0.12.3' })).toBe('0.12.3');
    expect(parseOllamaVersion(null)).toBeNull();
  });

  it('parses /api/ps with the VRAM/RAM split, expiry and context', () => {
    const [q, l] = parseOllamaPs(OLLAMA_PS, NOW);
    expect(q).toMatchObject({
      id: 'qwen2.5-coder:32b',
      label: 'Qwen2.5 Coder 32B',
      loaded: true,
      params: '32.8B',
      quant: 'Q4_K_M',
      family: 'qwen2',
      contextLength: null,
    });
    expect(q.expiresAt).toBe(Date.parse('2026-10-14T12:04:12Z'));
    const split = memorySplit(q)!;
    expect(split.vram).toBe(19_551_000_000);
    expect(split.ram).toBe(21_474_836_480 - 19_551_000_000);
    expect(split.vramPct).toBe(91);
    expect(l.contextLength).toBe(8192);
    expect(l.expiresAt).toBeNull(); // far-future = never unloads
    expect(memorySplit(l)!.vramPct).toBe(0);
  });

  it('parses /api/tags', () => {
    const m = parseOllamaTags(OLLAMA_TAGS);
    expect(m.map((x) => x.id)).toEqual(['qwen2.5-coder:32b', 'llama3.2:latest']);
    expect(m[0]).toMatchObject({ loaded: false, sizeBytes: 19_851_336_192, params: '32.8B' });
  });

  it('parses /api/show for context length and capabilities', () => {
    expect(parseOllamaShow(OLLAMA_SHOW)).toEqual({ maxContext: 32768, numCtx: 16384, capabilities: ['completion', 'tools'] });
    expect(parseOllamaShow({ model_info: { 'llama.context_length': 8192 } })).toEqual({ maxContext: 8192, numCtx: null, capabilities: [] });
    expect(parseOllamaShow(null)).toEqual({ maxContext: null, numCtx: null, capabilities: [] });
  });

  it('survives junk', () => {
    expect(parseOllamaPs({ models: [{}, null, { name: '' }] }, NOW)).toEqual([]);
    expect(parseOllamaPs('nope', NOW)).toEqual([]);
    expect(memorySplit(parseOllamaTags({ models: [{ name: 'x' }] })[0])).toBeNull();
  });
});

describe('LM Studio parsers', () => {
  it('parses /api/v0/models and skips embeddings', () => {
    const m = parseLmStudioModels(LMSTUDIO_V0);
    expect(m.map((x) => x.id)).toEqual(['qwen2.5-coder-32b-instruct', 'llama-3.2-3b-instruct']);
    expect(m[0]).toMatchObject({ loaded: true, quant: 'Q4_K_M', family: 'qwen2', maxContext: 32768 });
    expect(m[1].loaded).toBe(false);
  });

  it('parses the newer /api/v1/models shape', () => {
    const m = parseLmStudioModels(LMSTUDIO_V1);
    expect(m[0]).toMatchObject({
      id: 'google/gemma-3-27b',
      loaded: true,
      contextLength: 8192,
      maxContext: 131072,
      quant: 'Q4_K_M',
      params: '27B',
      sizeBytes: 16_000_000_000,
    });
    expect(m[1].loaded).toBe(false);
  });
});

describe('OpenAI-compatible / llama.cpp parsers', () => {
  it('parses /v1/models as served models', () => {
    const m = parseOpenAiModels(OPENAI_MODELS);
    expect(m).toHaveLength(1);
    expect(m[0].loaded).toBe(true);
    expect(parseOpenAiModels({ data: [{ id: 'm', max_model_len: 32768 }] })[0].maxContext).toBe(32768);
  });

  it('parses /health, /props, /slots and /metrics', () => {
    expect(parseLlamaHealth(200, { status: 'ok' })).toEqual({ ok: true, loading: false });
    expect(parseLlamaHealth(503, { error: { code: 503, message: 'Loading model' } })).toEqual({ ok: false, loading: true });
    expect(parseLlamaProps(LLAMA_PROPS)).toEqual({
      nCtx: 8192,
      totalSlots: 2,
      modelPath: '../models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
      version: 'b4567-abc',
    });
    expect(parseLlamaSlots(LLAMA_SLOTS)).toEqual({ total: 2, busy: 1, nCtx: 4096 });
    expect(parseLlamaSlots({ error: 'disabled' })).toBeNull();
    expect(parseLlamaMetrics(LLAMA_METRICS)).toEqual({ processing: 1, deferred: 0, generationTps: 31.25, promptTps: 102.5 });
    expect(parseLlamaMetrics('# nothing useful')).toBeNull();
  });
});

// ---- poller with canned responses ----
function fake(routes: Record<string, unknown | ((init?: Parameters<PollRequest>[1]) => unknown)>): { req: PollRequest; calls: string[] } {
  const calls: string[] = [];
  const req: PollRequest = async (path, init) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (!(path in routes)) throw new Error('connection refused (not running)');
    const r = routes[path];
    const v = typeof r === 'function' ? (r as (i?: Parameters<PollRequest>[1]) => unknown)(init) : r;
    if (v && typeof v === 'object' && 'status' in (v as object) && '__resp' in (v as object)) return v as unknown as PollResponse;
    return { status: 200, body: v, text: typeof v === 'string' ? v : JSON.stringify(v) };
  };
  return { req, calls };
}
const status = (code: number, body: unknown = null): PollResponse & { __resp: true } => ({ __resp: true, status: code, body, text: '' });

describe('pollServer', () => {
  it('polls Ollama: version, ps, tags and show once per loaded model', async () => {
    const f = fake({ '/api/version': { version: '0.12.3' }, '/api/ps': OLLAMA_PS, '/api/tags': OLLAMA_TAGS, '/api/show': OLLAMA_SHOW });
    const cache = new Map();
    const t = { id: 'ollama', kind: 'ollama' as const, name: 'Ollama', baseUrl: 'http://127.0.0.1:11434' };
    const s = await pollServer(t, f.req, NOW, cache);
    expect(s.state).toBe('up');
    expect(s.version).toBe('0.12.3');
    expect(s.loaded.map((m) => m.id)).toEqual(['qwen2.5-coder:32b', 'llama3.1:8b']);
    expect(s.installed).toHaveLength(2);
    expect(s.loaded[0]).toMatchObject({ contextLength: 16384, maxContext: 32768, capabilities: ['completion', 'tools'] });
    expect(s.loaded[1].contextLength).toBe(8192); // ps value wins over show
    expect(f.calls.filter((c) => c === 'POST /api/show')).toHaveLength(2);
    await pollServer(t, f.req, NOW, cache);
    expect(f.calls.filter((c) => c === 'POST /api/show')).toHaveLength(2); // cached
    // honest about what Ollama does not report
    expect(s.inFlight).toBeNull();
    expect(s.tokensPerSec).toBeNull();
    expect(s.notes.join(' ')).toContain('no live tokens/sec');
  });

  it('reports a server that does not answer as down, never throws', async () => {
    const t = { id: 'ollama', kind: 'ollama' as const, name: 'Ollama', baseUrl: 'http://127.0.0.1:1' };
    const s = await pollServer(t, fake({}).req, NOW);
    expect(s.state).toBe('down');
    expect(s.error).toContain('connection refused');
    expect(s.loaded).toEqual([]);
  });

  it('treats an Ollama with a failing /api/ps as up with a note', async () => {
    const f = fake({ '/api/version': { version: '0.1' }, '/api/ps': status(500), '/api/tags': OLLAMA_TAGS });
    const s = await pollServer({ id: 'ollama', kind: 'ollama', name: 'Ollama', baseUrl: 'x' }, f.req, NOW);
    expect(s.state).toBe('up');
    expect(s.loaded).toEqual([]);
    expect(s.notes.join(' ')).toContain('/api/ps');
  });

  it('polls LM Studio v0, with fallbacks to v1 and to the OpenAI list', async () => {
    const t = { id: 'lmstudio', kind: 'lmstudio' as const, name: 'LM Studio', baseUrl: 'x' };
    const v0 = await pollServer(t, fake({ '/api/v0/models': LMSTUDIO_V0 }).req, NOW);
    expect(v0.state).toBe('up');
    expect(v0.loaded.map((m) => m.id)).toEqual(['qwen2.5-coder-32b-instruct']);
    expect(v0.installed).toHaveLength(2);
    const v1 = await pollServer(t, fake({ '/api/v1/models': LMSTUDIO_V1 }).req, NOW);
    expect(v1.loaded.map((m) => m.id)).toEqual(['google/gemma-3-27b']);
    const oa = await pollServer(t, fake({ '/v1/models': OPENAI_MODELS }).req, NOW);
    expect(oa.state).toBe('up');
    expect(oa.loaded).toEqual([]);
    expect(oa.installed).toHaveLength(1);
    expect(oa.notes.join(' ')).toContain('unknown');
  });

  it('polls a llama.cpp server for slots, context and metrics', async () => {
    const t = { id: 'openai:x', kind: 'openai' as const, name: 'llama.cpp', baseUrl: 'x' };
    const s = await pollServer(
      t,
      fake({ '/v1/models': OPENAI_MODELS, '/health': { status: 'ok' }, '/props': LLAMA_PROPS, '/slots': LLAMA_SLOTS, '/metrics': LLAMA_METRICS }).req,
      NOW,
    );
    expect(s.state).toBe('up');
    expect(s.version).toBe('b4567-abc');
    expect(s.loaded[0].contextLength).toBe(8192);
    expect(s.slots).toEqual({ total: 2, busy: 1, nCtx: 4096 });
    expect(s.inFlight).toBe(1);
    expect(s.tokensPerSec).toEqual({ generation: 31.25, prompt: 102.5 });
    expect(s.notes.join(' ')).toContain('not a live rate');
  });

  it('works against a bare OpenAI-compatible endpoint (vLLM, LocalAI)', async () => {
    const t = { id: 'openai:x', kind: 'openai' as const, name: 'vLLM', baseUrl: 'x' };
    const s = await pollServer(t, fake({ '/v1/models': { object: 'list', data: [{ id: 'Qwen/Qwen3-8B', max_model_len: 40960 }] } }).req, NOW);
    expect(s.state).toBe('up');
    expect(s.loaded[0].maxContext).toBe(40960);
    expect(s.slots).toBeNull();
    expect(s.inFlight).toBeNull();
    expect(s.tokensPerSec).toBeNull();
  });

  it('is down when /v1/models errors and there is no health', async () => {
    const t = { id: 'openai:x', kind: 'openai' as const, name: 'x', baseUrl: 'x' };
    expect((await pollServer(t, fake({ '/v1/models': status(404) }).req, NOW)).state).toBe('down');
    expect((await pollServer(t, fake({}).req, NOW)).state).toBe('down');
  });
});

describe('poll backoff', () => {
  it('keeps the interval while the server answers and doubles up to 60 s while it is down', () => {
    expect(pollDelayMs(5000, 0)).toBe(5000);
    expect([1, 2, 3, 4, 5, 6, 20].map((n) => pollDelayMs(5000, n))).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000]);
  });
  it('never polls faster than the configured interval', () => {
    expect(pollDelayMs(120_000, 3)).toBe(120_000);
    expect(pollDelayMs(30_000, 1)).toBe(60_000);
  });
});

describe('config', () => {
  it('fills defaults and validates', () => {
    expect(normalizeLocalConfig(undefined)).toEqual(DEFAULT_LOCAL_CONFIG);
    const c = normalizeLocalConfig({
      pollSec: 1,
      ollama: { enabled: false, url: 'localhost:11435/' },
      lmstudio: { url: 'ftp://nope' },
      extra: [{ name: 'llama.cpp', url: 'http://127.0.0.1:8080/v1' }, { url: 'http://127.0.0.1:8080' }, { url: '' }, { url: 'file:///etc/passwd' }],
    });
    expect(c.pollSec).toBe(2);
    expect(c.ollama).toEqual({ enabled: false, url: 'http://localhost:11435' });
    expect(c.lmstudio.url).toBe('http://127.0.0.1:1234');
    expect(c.extra).toEqual([{ id: 'openai:http://127.0.0.1:8080', name: 'llama.cpp', url: 'http://127.0.0.1:8080', enabled: true }]);
  });
  it('only accepts http(s) URLs and knows loopback', () => {
    expect(normalizeBaseUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeBaseUrl('192.168.1.5:8000')).toBe('http://192.168.1.5:8000');
    expect(isLoopbackUrl('http://127.0.0.1:11434')).toBe(true);
    expect(isLoopbackUrl('http://localhost:1234')).toBe(true);
    expect(isLoopbackUrl('http://192.168.1.5:1234')).toBe(false);
    expect(isLoopbackUrl('https://example.com')).toBe(false);
  });
  it('applies the test URL overrides', () => {
    const c = applyUrlOverrides(DEFAULT_LOCAL_CONFIG, { CLAUDE_VIS_OLLAMA_URL: 'http://127.0.0.1:5555', CLAUDE_VIS_LMSTUDIO_URL: 'off' });
    expect(c.ollama.url).toBe('http://127.0.0.1:5555');
    expect(c.lmstudio.enabled).toBe(false);
    expect(DEFAULT_LOCAL_CONFIG.lmstudio.enabled).toBe(true); // not mutated
  });
});

// ---- linking and context ----
function up(
  id: string,
  kind: LocalServerStatus['kind'],
  name: string,
  loaded: ReturnType<typeof parseOllamaPs>,
  installed: ReturnType<typeof parseOllamaPs> = [],
): LocalServerStatus {
  return { ...baseStatus({ id, kind, name, baseUrl: 'x' }, NOW), state: 'up', loaded, installed };
}

describe('linking agents to servers', () => {
  const ollama = up('ollama', 'ollama', 'Ollama', parseOllamaPs(OLLAMA_PS, NOW));
  const lm = up(
    'lmstudio',
    'lmstudio',
    'LM Studio',
    parseLmStudioModels(LMSTUDIO_V0).filter((m) => m.loaded),
  );

  it('finds the server that has the agent’s model loaded', () => {
    const l = findLoadedModel('qwen2.5-coder:32b', [lm, ollama])!;
    expect(l.server.id).toBe('ollama');
    expect(loadedText(l)).toBe('loaded in Ollama · 18.2 GB VRAM + 1.8 GB RAM');
    expect(findLoadedModel('ollama/llama3.1:8b', [ollama])!.model.id).toBe('llama3.1:8b');
    expect(findLoadedModel('qwen/qwen2.5-coder-32b-instruct', [ollama, lm])!.server.id).toBe('lmstudio');
  });

  it('does not link Claude models, unloaded models or servers that are down', () => {
    expect(findLoadedModel('claude-opus-5-5', [ollama])).toBeNull();
    expect(findLoadedModel('mistral:7b', [ollama])).toBeNull();
    expect(findLoadedModel('qwen2.5-coder:32b', [{ ...ollama, state: 'down' }])).toBeNull();
    expect(findLoadedModel(null, [ollama])).toBeNull();
  });

  it('shows plain VRAM when fully on the GPU and RAM when CPU only', () => {
    const gpu = parseOllamaPs({ models: [{ name: 'a:1b', size: 4 * GB, size_vram: 4 * GB }] }, NOW)[0];
    const cpu = parseOllamaPs({ models: [{ name: 'b:1b', size: 2 * GB, size_vram: 0 }] }, NOW)[0];
    expect(loadedText({ server: ollama, model: gpu })).toBe('loaded in Ollama · 4.0 GB VRAM');
    expect(loadedText({ server: ollama, model: cpu })).toBe('loaded in Ollama · 2.0 GB RAM');
  });

  it('summarises and formats', () => {
    expect(localSummary([ollama, lm, { ...ollama, state: 'down' }])).toEqual({ up: 2, loaded: 3 });
    expect(formatBytes(18.2 * GB)).toBe('18.2 GB');
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB');
    expect(unloadsIn(NOW + 252_000, NOW)).toBe('4m 12s');
    expect(unloadsIn(NOW + 5000, NOW)).toBe('5s');
    expect(unloadsIn(null, NOW)).toBeNull();
  });
});

describe('context length for local agents', () => {
  const agent = (model: string, tokens = 12_000) => ({ model, contextTokens: tokens, contextPeak: tokens });
  const ps = parseOllamaPs({ models: [{ name: 'qwen2.5-coder:32b', size: GB, size_vram: GB, context_length: 32768 }] }, NOW);
  const maxOnly = parseOllamaPs({ models: [{ name: 'llama3.1:8b', size: GB, size_vram: GB }] }, NOW);
  maxOnly[0].maxContext = 131072;
  const servers = [up('ollama', 'ollama', 'Ollama', [...ps, ...maxOnly], parseOllamaTags({ models: [{ name: 'gemma3:27b' }] }))];

  it('uses the context a running server reports', () => {
    const w = localWindowFor('qwen2.5-coder:32b', servers);
    expect(w).toEqual({ size: 32768, estimated: false });
    const c = contextInfo(agent('qwen2.5-coder:32b'), null, w)!;
    expect(c).toMatchObject({ windowKnown: true, size: 32768, pct: 37, estimated: false });
  });

  it('falls back to the model maximum, flagged as an estimate', () => {
    expect(localWindowFor('llama3.1:8b', servers)).toEqual({ size: 131072, estimated: true });
  });

  it('shows tokens without a percentage when no server knows the model', () => {
    expect(localWindowFor('gemma3:27b', servers)).toBeNull();
    const c = contextInfo(agent('gemma3:27b'), null, null)!;
    expect(c).toMatchObject({ windowKnown: false, pct: 0, size: 0, tokens: 12_000 });
    expect(contextInfo(agent('gpt-4o'), null, null)!.windowKnown).toBe(false);
    expect(localWindowFor('gemma3:27b', [])).toBeNull();
  });

  it('keeps the Claude window logic unchanged and ignores servers for Claude models', () => {
    expect(contextInfo(agent('claude-opus-5-5', 100_000), null, { size: 5, estimated: false })).toMatchObject({
      size: 200_000,
      estimated: true,
      windowKnown: true,
      pct: 50,
    });
    expect(localWindowFor('claude-opus-5-5', servers)).toBeNull();
  });
});

describe('token split by provider', () => {
  it('counts local agents apart from Claude agents', () => {
    const main = newAgent('main', 'main', 0, null);
    main.model = 'claude-opus-5-5';
    main.tokens = { in: 100, out: 50, cacheRead: 1000, cacheWrite: 10 };
    const sub = newAgent('a1', 'agent', 0, 'main');
    sub.model = 'llama3.1:8b';
    sub.tokens = { in: 400, out: 80, cacheRead: 0, cacheWrite: 0 };
    const totals = { in: 500, out: 130, cacheRead: 1000, cacheWrite: 10 };
    const r = tokensByProvider({ main, a1: sub }, totals);
    expect(r.localAgents).toBe(1);
    expect(r.local).toEqual({ in: 400, out: 80, cacheRead: 0, cacheWrite: 0 });
    expect(r.claude).toEqual({ in: 100, out: 50, cacheRead: 1000, cacheWrite: 10 });
  });
});
