import { parentPort, workerData } from 'node:worker_threads';
import { loadBacklogInProcess } from './watcher';

// Runs the whole initial read + normalize + sort + fold off the main thread (see workerLoader.ts).
async function main() {
  const { sessionId, mainFile, wantEvents } = workerData as { sessionId: string; mainFile: string; wantEvents: boolean };
  const snapshot = await loadBacklogInProcess(sessionId, mainFile, wantEvents);
  parentPort!.postMessage({ ok: true, snapshot });
}

main().catch((e) => parentPort!.postMessage({ ok: false, error: String(e?.stack ?? e) }));
