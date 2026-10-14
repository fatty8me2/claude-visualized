// Main-thread side of the history index: owns the worker, schedules passes and forwards progress. All SQLite work stays in the worker.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { HistoryStatus, HistorySummary, SearchArgs, SearchResult, SummaryArgs } from '@core/history';
import workerPath from './historyWorker?modulePath';

export const REINDEX_MS = 60_000;

export function emptyStatus(): HistoryStatus {
  return {
    state: 'starting',
    phase: null,
    done: 0,
    total: 0,
    error: null,
    lastRunAt: null,
    lastRunMs: null,
    sessions: 0,
    docs: 0,
    dbBytes: 0,
    engine: 'node:sqlite',
    sqliteVersion: '',
    fts: false,
  };
}

export class HistoryService extends EventEmitter {
  private worker: Worker | null = null;
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private last: HistoryStatus | null = null;

  constructor(
    private userData: string,
    private projectsDir: string,
  ) {
    super();
  }

  get dbPath(): string {
    return path.join(this.userData, 'history.db');
  }

  start() {
    if (this.worker) return;
    const w = new Worker(workerPath, { workerData: { dbPath: this.dbPath, projectsDir: this.projectsDir } });
    this.worker = w;
    w.on('message', (m: { id?: number; ok?: boolean; result?: unknown; error?: string; status?: HistoryStatus }) => {
      if (m.status) {
        this.last = m.status;
        this.emit('status', m.status);
        return;
      }
      const p = m.id !== undefined ? this.pending.get(m.id) : undefined;
      if (!p) return;
      this.pending.delete(m.id!);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error));
    });
    const fail = (e: Error) => {
      this.last = { ...(this.last ?? emptyStatus()), state: 'error', error: String(e?.message ?? e) };
      this.emit('status', this.last);
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
      this.worker = null;
    };
    w.on('error', fail);
    w.on('exit', (code) => {
      if (this.worker === w) fail(new Error(`history worker exited with code ${code}`));
    });
    // first pass right away, then on a timer; a pass that is still running makes the call a no-op
    void this.call('index').catch(() => {});
    this.timer = setInterval(() => void this.call('index').catch(() => {}), REINDEX_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const w = this.worker;
    this.worker = null;
    void w?.terminate();
  }

  private call<T>(method: string, args?: unknown): Promise<T> {
    const w = this.worker;
    if (!w) return Promise.reject(new Error(this.last?.error ?? 'history worker is not running'));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      w.postMessage({ id, method, args });
    });
  }

  status(): Promise<HistoryStatus> {
    return this.worker ? this.call<HistoryStatus>('status') : Promise.resolve(this.last ?? { ...emptyStatus(), state: 'idle' });
  }
  summary(a: SummaryArgs): Promise<HistorySummary> {
    return this.call('summary', a);
  }
  search(a: SearchArgs): Promise<SearchResult> {
    return this.call('search', a);
  }
  async rebuild(): Promise<void> {
    await this.call('rebuild');
  }
}
