// Polls the configured local model servers (main process only). It only ever requests the base URLs from
// the config (loopback by default; remote hosts only if the user added them), only reads status endpoints,
// and never sends transcript data anywhere.
import { EventEmitter } from 'node:events';
import { pollServer, baseStatus, type OllamaShowCache, type PollRequest, type PollTarget } from '@core/localPoll';
import { pollDelayMs, type LocalModelsConfig, type LocalModelsView, type LocalServerStatus } from '@core/localModels';

const REQUEST_TIMEOUT_MS = 2500;
const MAX_BODY_CHARS = 5_000_000;

export function httpRequester(baseUrl: string): PollRequest {
  return async (path, init) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(baseUrl + path, {
        method: init?.method ?? 'GET',
        headers: init?.body !== undefined ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: ctl.signal,
        redirect: 'error', // never follow a redirect to a host that is not configured
      });
      const text = (await res.text()).slice(0, MAX_BODY_CHARS);
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* not JSON (e.g. Prometheus text) */
      }
      return { status: res.status, body, text };
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      const code = err.cause?.code;
      throw new Error(ctl.signal.aborted ? 'timed out' : code === 'ECONNREFUSED' ? 'connection refused (not running)' : (code ?? err.message));
    } finally {
      clearTimeout(timer);
    }
  };
}

interface Slot {
  target: PollTarget;
  enabled: boolean;
  status: LocalServerStatus;
  failures: number;
  timer: NodeJS.Timeout | null;
  showCache: OllamaShowCache;
}

function targetsOf(c: LocalModelsConfig): { target: PollTarget; enabled: boolean }[] {
  return [
    { target: { id: 'ollama', kind: 'ollama', name: 'Ollama', baseUrl: c.ollama.url }, enabled: c.ollama.enabled },
    { target: { id: 'lmstudio', kind: 'lmstudio', name: 'LM Studio', baseUrl: c.lmstudio.url }, enabled: c.lmstudio.enabled },
    ...c.extra.map((e) => ({ target: { id: e.id, kind: 'openai' as const, name: e.name, baseUrl: e.url }, enabled: e.enabled })),
  ];
}

const signature = (s: LocalServerStatus) => JSON.stringify({ ...s, checkedAt: 0, nextPollAt: 0 });

export class LocalMonitor extends EventEmitter {
  private slots = new Map<string, Slot>();
  private config: LocalModelsConfig;
  private running = false;
  private generation = 0;

  constructor(config: LocalModelsConfig) {
    super();
    this.config = config;
  }

  view(): LocalModelsView {
    return { servers: [...this.slots.values()].map((s) => s.status), at: Date.now() };
  }

  start() {
    this.running = true;
    this.setConfig(this.config);
  }

  stop() {
    this.running = false;
    this.generation++;
    for (const s of this.slots.values()) if (s.timer) clearTimeout(s.timer);
  }

  setConfig(c: LocalModelsConfig) {
    this.config = c;
    this.generation++;
    const next = new Map<string, Slot>();
    for (const { target, enabled } of targetsOf(c)) {
      const old = this.slots.get(target.id);
      if (old?.timer) clearTimeout(old.timer);
      const same = old && old.target.baseUrl === target.baseUrl && old.enabled === enabled;
      const status: LocalServerStatus = same
        ? { ...old.status, name: target.name }
        : { ...baseStatus(target, Date.now()), state: enabled ? 'checking' : 'disabled' };
      next.set(target.id, { target, enabled, status, failures: same ? old.failures : 0, timer: null, showCache: same ? old.showCache : new Map() });
    }
    this.slots = next;
    this.emitIfChanged(true);
    if (this.running) for (const s of this.slots.values()) if (s.enabled) this.schedule(s, 0);
  }

  /** "check again": poll everything now and forget the backoff. */
  refreshNow() {
    this.generation++;
    for (const s of this.slots.values()) {
      if (s.timer) clearTimeout(s.timer);
      s.failures = 0;
      if (s.enabled && this.running) this.schedule(s, 0);
    }
  }

  private schedule(s: Slot, delay: number) {
    if (s.timer) clearTimeout(s.timer);
    if (delay > 0) s.status = { ...s.status, nextPollAt: Date.now() + delay };
    const gen = this.generation;
    s.timer = setTimeout(() => void this.poll(s, gen), delay);
  }

  private async poll(s: Slot, gen: number) {
    const status = await pollServer(s.target, httpRequester(s.target.baseUrl), Date.now(), s.showCache);
    if (gen !== this.generation || !this.running || this.slots.get(s.target.id) !== s) return; // config changed meanwhile
    s.failures = status.state === 'up' ? 0 : s.failures + 1;
    status.failures = s.failures;
    const delay = pollDelayMs(this.config.pollSec * 1000, s.failures);
    status.nextPollAt = Date.now() + delay;
    s.status = status;
    this.emitIfChanged(false);
    this.schedule(s, delay);
  }

  private lastSig = '';

  private emitIfChanged(force: boolean) {
    const sig = [...this.slots.values()].map((s) => signature(s.status)).join('|');
    if (!force && sig === this.lastSig) return;
    this.lastSig = sig;
    this.emit('view', this.view());
  }
}
