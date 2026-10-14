import { Worker } from 'node:worker_threads';
import workerPath from './backlogWorker?modulePath';
import type { BacklogLoader, BacklogSnapshot } from './watcher';

/** BacklogLoader that runs the initial load in a short-lived worker thread. */
export const loadBacklogInWorker: BacklogLoader = (sessionId, mainFile, wantEvents) =>
  new Promise<BacklogSnapshot>((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: { sessionId, mainFile, wantEvents } });
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      void worker.terminate();
    };
    worker.once('message', (m: { ok: boolean; snapshot?: BacklogSnapshot; error?: string }) =>
      done(() => (m.ok ? resolve(m.snapshot!) : reject(new Error(m.error)))),
    );
    worker.once('error', (e) => done(() => reject(e)));
    worker.once('exit', (code) => done(() => reject(new Error(`worker exited with code ${code}`))));
  });
