// Opt-in benchmark: main-thread responsiveness while loading a huge real session (read-only).
// Run with: npx electron-vite build && REAL_DATA=1 npx vitest run tests/unit/backlog-bench.test.ts
// The worker path uses the bundled worker in out/main, so it needs a prior build.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { SessionWatcher, type BacklogLoader, type BacklogSnapshot } from '../../src/main/watcher';

const root = path.join(process.env.CLAUDE_VIS_HOME ?? path.join(os.homedir(), '.claude'), 'projects');
const BIG = process.env.BENCH_SESSION ?? '';

function findSession(id: string): string | null {
  if (!fs.existsSync(root)) return null;
  for (const p of fs.readdirSync(root)) {
    const f = path.join(root, p, `${id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function builtWorker(): string | null {
  const dir = path.resolve(__dirname, '../../out/main');
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((x) => /^backlogWorker.*\.js$/.test(x));
  return f ? path.join(dir, f) : null;
}

const workerFile = builtWorker();
const loader: BacklogLoader = (sessionId, mainFile, wantEvents) =>
  new Promise<BacklogSnapshot>((resolve, reject) => {
    const w = new Worker(workerFile!, { workerData: { sessionId, mainFile, wantEvents } });
    w.once('message', (m) => {
      void w.terminate();
      if (m.ok) resolve(m.snapshot);
      else reject(new Error(m.error));
    });
    w.once('error', reject);
  });

async function measure(label: string, make: () => SessionWatcher) {
  const h = monitorEventLoopDelay({ resolution: 1 });
  // setInterval drift probe as a second opinion
  let last = performance.now();
  let maxDrift = 0;
  const probe = setInterval(() => {
    const now = performance.now();
    maxDrift = Math.max(maxDrift, now - last - 5);
    last = now;
  }, 5);
  const w = make();
  h.enable();
  const t = performance.now();
  await w.poll();
  const total = performance.now() - t;
  h.disable();
  clearInterval(probe);
  const maxMs = h.max / 1e6;
  console.log(
    `${label}: load ${total.toFixed(0)}ms, max loop delay ${maxMs.toFixed(0)}ms, max timer drift ${maxDrift.toFixed(0)}ms, p99 ${(h.percentile(99) / 1e6).toFixed(0)}ms`,
  );
  return { w, total, maxMs, maxDrift };
}

const file = BIG ? findSession(BIG) : null;

describe.skipIf(!process.env.REAL_DATA || !file || !workerFile)('big session load responsiveness', () => {
  it('worker load keeps the loop responsive and folds to the same state as the sync path', async () => {
    const sync = await measure('sync  ', () => new SessionWatcher(BIG, file!));
    const off = await measure('worker', () => new SessionWatcher(BIG, file!, loader));

    const a = sync.w.state;
    const b = off.w.state;
    expect(Object.keys(b.agents).sort()).toEqual(Object.keys(a.agents).sort());
    for (const id of Object.keys(a.agents)) expect(b.agents[id].status).toBe(a.agents[id].status);
    expect(b.totals).toEqual(a.totals);
    expect(b.todos.length).toBe(a.todos.length);
    expect(b.eventCount).toBe(a.eventCount);
    expect(b).toEqual(a);
    for (const [label, l] of [
      ['replay sync  ', undefined],
      ['replay worker', loader],
    ] as const) {
      const h = monitorEventLoopDelay({ resolution: 1 });
      h.enable();
      const t = performance.now();
      const evs = await new SessionWatcher(BIG, file!, l).collectAllEvents();
      h.disable();
      console.log(`${label}: ${evs.length} events in ${(performance.now() - t).toFixed(0)}ms, max loop delay ${(h.max / 1e6).toFixed(0)}ms`);
    }
    console.log(`agents=${Object.keys(a.agents).length} events=${a.eventCount}`);
    expect(off.maxMs).toBeLessThan(100);
  }, 120_000);
});
