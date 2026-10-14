// Worker thread that owns history.db: indexes in the background and answers queries, so the UI thread never touches SQLite.
// Protocol: main -> worker {id, method, args}; worker -> main {id, ok, result|error} for replies and {status} for progress pushes.
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import type { HistoryStatus, SearchArgs, SummaryArgs } from '@core/history';
import { HistoryDb } from './historyDb';
import { runIndex, type IndexProgress } from './historyIndex';

const { dbPath, projectsDir } = workerData as { dbPath: string; projectsDir: string };

let db: HistoryDb | null = null;
let running = false;
let cancel = false;
let waiters: (() => void)[] = [];
const status: HistoryStatus = {
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

function push() {
  if (db) {
    try {
      const c = db.counts();
      status.sessions = c.sessions;
      status.docs = c.docs;
      status.dbBytes = db.dbBytes();
    } catch {
      /* closed while rebuilding */
    }
  }
  parentPort!.postMessage({ status });
}

function open() {
  db = new HistoryDb(dbPath);
  status.sqliteVersion = db.sqliteVersion();
  status.fts = db.hasFts();
}

async function index(): Promise<void> {
  if (running || !db) return;
  running = true;
  cancel = false;
  status.state = 'indexing';
  status.error = null;
  let lastPush = 0;
  const onProgress = (p: IndexProgress) => {
    status.phase = p.phase;
    status.done = p.done;
    status.total = p.total;
    const now = Date.now();
    if (now - lastPush > 150) {
      lastPush = now;
      push();
    }
  };
  push();
  try {
    const r = await runIndex(db, { projectsDir, onProgress, cancelled: () => cancel });
    status.lastRunAt = Date.now();
    status.lastRunMs = r.ms;
    status.state = 'idle';
  } catch (e) {
    status.state = 'error';
    status.error = String((e as Error)?.stack ?? e);
  } finally {
    running = false;
    status.phase = null;
    push();
    const w = waiters;
    waiters = [];
    for (const f of w) f();
  }
}

async function idle(): Promise<void> {
  if (!running) return;
  await new Promise<void>((r) => waiters.push(r));
}

async function rebuild(): Promise<void> {
  cancel = true;
  await idle();
  db?.close();
  db = null;
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  open();
  push();
  await index();
}

const methods: Record<string, (args: any) => unknown> = {
  status: () => {
    push();
    return status;
  },
  index: () => {
    void index();
    return true;
  },
  rebuild: () => {
    void rebuild();
    return true;
  },
  summary: (a: SummaryArgs) => db!.summary(a),
  search: (a: SearchArgs) => db!.search(a),
  close: () => {
    cancel = true;
    db?.close();
    db = null;
    return true;
  },
};

try {
  // stays 'starting' until the first pass begins (the service asks for it right away), so the page never shows an empty "idle" index
  open();
} catch (e) {
  status.state = 'error';
  status.error = `history database unavailable: ${String((e as Error)?.message ?? e)}`;
}
push();

parentPort!.on('message', (m: { id: number; method: string; args?: unknown }) => {
  try {
    if (!db && m.method !== 'status') throw new Error(status.error ?? 'history database is not open');
    const r = methods[m.method]?.(m.args);
    parentPort!.postMessage({ id: m.id, ok: true, result: r });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, ok: false, error: String((e as Error)?.message ?? e) });
  }
});
