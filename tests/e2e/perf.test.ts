// Opt-in performance benchmark (PERF=1). Launches the BUILT app on a synthetic large session
// (300 agents, 30k tool calls, live appends) and, with PERF_REAL=1, on the user's biggest real
// session (read-only). Prints a table and writes tests/e2e/artifacts/perf-<label>.json.
//   PERF=1 [PERF_LABEL=before] [PERF_REAL=1] E2E_PORT=47915 npx vitest run --config vitest.e2e.config.ts tests/e2e/perf.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { LARGE_SID, writeLargeSession } from '../fixtures/large';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 47915);
const LABEL = process.env.PERF_LABEL ?? 'run';
const REAL_SID = '02d785f3-40f3-4031-9659-a2a414e7dc1b';
const APPEND_SECONDS = Number(process.env.PERF_SECONDS ?? 20);

interface Result {
  scenario: string;
  firstRenderMs: number;
  nodes: number;
  pushes: number;
  bytesPerPushAvg: number;
  bytesPerPushMax: number;
  longTasks: number;
  longTaskMsTotal: number;
  longTaskMsMax: number;
  frameAvgMs: number;
  frameP95Ms: number;
  frameMaxMs: number;
  rendererHeapMB: number;
  rendererWorkingSetMB: number;
  mainWorkingSetMB: number;
  mainCpuPct: number;
  rendererCpuPct: number;
  /** Chrome task / script / style+layout seconds spent in the renderer per wall second of the window */
  taskPct: number;
  scriptPct: number;
  layoutStylePct: number;
}

const results: Result[] = [];

async function launch(env: Record<string, string>) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-perf-ud-'));
  const app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      CLAUDE_VIS_USER_DATA: userData,
      CLAUDE_VIS_PORT: String(PORT),
      CLAUDE_VIS_NO_EXTERNAL: '1',
      CLAUDE_VIS_NO_SYSTEM_INTEGRATION: '1',
      CLAUDE_VIS_NO_USAGE_API: '1',
      CLAUDE_VIS_SKIP_ONBOARDING: '1',
      CLAUDE_VIS_NO_HOOK_SERVER: '1',
      CLAUDE_VIS_PERF: '1',
      CLAUDE_VIS_DESKTOP_DIR: path.join(userData, 'no-desktop'),
      ...env,
    } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
  return { app, page, userData };
}

async function metrics(app: ElectronApplication) {
  return app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({ type: m.type, ws: m.memory.workingSetSize, cpu: m.cpu.percentCPUUsage })));
}

async function instrument(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __p: { long: number[]; frames: number[]; stop: boolean } };
    w.__p = { long: [], frames: [], stop: false };
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__p.long.push(e.duration);
    }).observe({ entryTypes: ['longtask'] });
    let last = performance.now();
    const loop = (t: number) => {
      w.__p.frames.push(t - last);
      last = t;
      if (!w.__p.stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}

async function scenario(name: string, page: Page, app: ElectronApplication, sid: string, drive: () => Promise<void>, prep?: () => Promise<void>) {
  await page.locator('.session-row').first().waitFor({ timeout: 30_000 });
  await instrument(page);
  const t0 = Date.now();
  await page.evaluate((id) => window.api.select(id), sid);
  await page.waitForFunction((id) => window.api.getState().then((s) => s?.id === id), sid, { timeout: 60_000, polling: 100 });
  await page.locator('.node:not(.collapsed)').first().waitFor({ timeout: 30_000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const firstRenderMs = Date.now() - t0;
  await prep?.();
  await page.waitForTimeout(1500);
  // measure a steady window
  await page.evaluate(() => {
    const w = window as unknown as { __p: { long: number[]; frames: number[] } };
    w.__p.long = [];
    w.__p.frames = [];
  });
  const before = await app.evaluate(
    () => JSON.parse(JSON.stringify((globalThis as unknown as { __perf: unknown }).__perf)) as Record<string, { n: number; bytes: number; max: number }>,
  );
  await metrics(app); // prime the CPU counters
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const cm = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  const c0 = await cm();
  const w0 = Date.now();
  await drive();
  const c1 = await cm();
  const wall = (Date.now() - w0) / 1000;
  const pct = (k: string) => +(((c1[k] - c0[k]) / wall) * 100).toFixed(1);
  const after = await app.evaluate(
    () => JSON.parse(JSON.stringify((globalThis as unknown as { __perf: unknown }).__perf)) as Record<string, { n: number; bytes: number; max: number }>,
  );
  const m = await metrics(app);
  const p = await page.evaluate(() => {
    const w = window as unknown as { __p: { long: number[]; frames: number[]; stop: boolean } };
    w.__p.stop = true;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return { long: w.__p.long, frames: w.__p.frames, heap: mem?.usedJSHeapSize ?? 0, nodes: document.querySelectorAll('.node').length };
  });
  const n = (after.state?.n ?? 0) - (before.state?.n ?? 0);
  const bytes = (after.state?.bytes ?? 0) - (before.state?.bytes ?? 0);
  const frames = [...p.frames].sort((a, b) => a - b);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const proc = (t: string) => m.filter((x) => x.type === t);
  const r: Result = {
    scenario: name,
    firstRenderMs,
    nodes: p.nodes,
    pushes: n,
    bytesPerPushAvg: n ? Math.round(bytes / n) : 0,
    bytesPerPushMax: after.state?.max ?? 0,
    longTasks: p.long.length,
    longTaskMsTotal: Math.round(sum(p.long)),
    longTaskMsMax: Math.round(Math.max(0, ...p.long)),
    frameAvgMs: +(sum(frames) / Math.max(1, frames.length)).toFixed(1),
    frameP95Ms: +(frames[Math.floor(frames.length * 0.95)] ?? 0).toFixed(1),
    frameMaxMs: +(frames[frames.length - 1] ?? 0).toFixed(1),
    rendererHeapMB: +(p.heap / 1e6).toFixed(1),
    rendererWorkingSetMB: +(sum(proc('Tab').map((x) => x.ws)) / 1024).toFixed(0) as unknown as number,
    mainWorkingSetMB: +(sum(proc('Browser').map((x) => x.ws)) / 1024).toFixed(0) as unknown as number,
    mainCpuPct: +sum(proc('Browser').map((x) => x.cpu)).toFixed(1),
    rendererCpuPct: +sum(proc('Tab').map((x) => x.cpu)).toFixed(1),
    taskPct: pct('TaskDuration'),
    scriptPct: pct('ScriptDuration'),
    layoutStylePct: +(pct('LayoutDuration') + pct('RecalcStyleDuration')).toFixed(1),
  };
  results.push(r);
  return r;
}

afterAll(() => {
  if (!results.length) return;
  fs.mkdirSync(ART, { recursive: true });
  fs.writeFileSync(path.join(ART, `perf-${LABEL}.json`), JSON.stringify(results, null, 2));
  console.table(results);
});

describe.skipIf(!process.env.PERF)('performance', () => {
  for (const expanded of [false, true]) {
    it(`synthetic large session (300 agents, 30k tool calls, live appends${expanded ? ', all cards expanded' : ''})`, async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-perf-home-'));
      const big = writeLargeSession(home);
      const { app, page, userData } = await launch({ CLAUDE_VIS_HOME: home });
      try {
        const r = await scenario(
          expanded ? 'synthetic-live-expanded' : 'synthetic-live',
          page,
          app,
          LARGE_SID,
          async () => {
            const end = Date.now() + APPEND_SECONDS * 1000;
            while (Date.now() < end) {
              big.append(30);
              await page.waitForTimeout(500);
            }
          },
          expanded
            ? async () => {
                await page.locator('.node.collapsed').first().click();
                await page.waitForFunction(() => document.querySelectorAll('.node:not(.collapsed)').length > 200, null, { timeout: 30_000 });
              }
            : undefined,
        );
        expect(r.nodes).toBeGreaterThan(20);
      } finally {
        await app.close();
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(userData, { recursive: true, force: true });
      }
    }, 180_000);
  }

  it.skipIf(!process.env.PERF_REAL)('real biggest session (read-only)', { timeout: 180_000 }, async () => {
    const { app, page, userData } = await launch({});
    try {
      await scenario('real-idle', page, app, REAL_SID, async () => {
        await page.waitForTimeout(APPEND_SECONDS * 1000);
      });
    } finally {
      await app.close();
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });
});
