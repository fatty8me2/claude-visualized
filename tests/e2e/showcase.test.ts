// A scripted ~20 s live scenario on the showcase session (48 direct children, a nested tree, a workflow group), for judging the graph
// visuals by eye. Skipped unless SHOWCASE=1. Screenshots go to tests/e2e/artifacts/showcase-01..12.png; frame times (rAF deltas and
// long tasks) are printed at the end.
//   npx electron-vite build
//   $env:SHOWCASE='1'; $env:E2E_PORT='47954'; npx vitest run --config vitest.e2e.config.ts tests/e2e/showcase.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type CDPSession, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as show from '../fixtures/showcase';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 47954);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const trace = (m: string) => {
  fs.mkdirSync(ART, { recursive: true });
  fs.appendFileSync(path.join(ART, 'showcase-trace.log'), `${new Date().toISOString()} ${m}\n`);
};

const describeShowcase = process.env.SHOWCASE === '1' ? describe : describe.skip;

describeShowcase('showcase scenario (fixture data, live)', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;
  let cdp: CDPSession;
  let sh: show.Showcase;

  /** a 2x crop of the graph (or of a region of it), so the details are readable */
  const shot = async (n: number, clipSel?: string[]) => {
    const name = `showcase-${String(n).padStart(2, '0')}.png`;
    await sleep(120);
    const wrap = (await page.locator('.graph-wrap').boundingBox())!;
    let clip = { x: wrap.x, y: wrap.y, width: wrap.width, height: wrap.height };
    if (clipSel?.length) {
      // a card that is not on screen (folded into the chip, or gone) is skipped rather than waited for
      const boxes = await Promise.all(clipSel.map(async (s) => ((await page.locator(s).count()) ? page.locator(s).first().boundingBox() : null)));
      const ok = boxes.filter((b): b is NonNullable<typeof b> => !!b);
      const x0 = Math.min(...ok.map((b) => b.x)) - 24;
      const y0 = Math.min(...ok.map((b) => b.y)) - 24;
      const x1 = Math.max(...ok.map((b) => b.x + b.width)) + 24;
      const y1 = Math.max(...ok.map((b) => b.y + b.height)) + 24;
      const w = Math.min(wrap.x + wrap.width, x1) - Math.max(wrap.x, x0);
      const h = Math.min(wrap.y + wrap.height, y1) - Math.max(wrap.y, y0);
      // nothing of the selection is on screen: keep the whole graph
      if (w > 4 && h > 4) clip = { x: Math.max(wrap.x, x0), y: Math.max(wrap.y, y0), width: w, height: h };
    }
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 2 } });
    fs.writeFileSync(path.join(ART, name), Buffer.from(r.data, 'base64'));
    return name;
  };

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-showcase-home-'));
    // belt and braces: this test must never touch the user's real ~/.claude
    if (path.resolve(home) === path.resolve(os.homedir(), '.claude')) throw new Error('refusing to run on ~/.claude');
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-showcase-ud-'));
    sh = show.writeShowcase(home);
    app = await electron.launch({
      args: [ROOT],
      cwd: ROOT,
      env: {
        ...process.env,
        CLAUDE_VIS_HOME: home,
        CLAUDE_VIS_USER_DATA: userData,
        CLAUDE_VIS_PORT: String(PORT),
        CLAUDE_VIS_NO_EXTERNAL: '1',
        CLAUDE_VIS_NO_SYSTEM_INTEGRATION: '1',
        CLAUDE_VIS_NO_USAGE_API: '1',
        CLAUDE_VIS_SKIP_ONBOARDING: '1',
        CLAUDE_VIS_NO_UPDATES: '1',
        CLAUDE_VIS_DESKTOP_DIR: path.join(userData, 'no-desktop'),
        CLAUDE_VIS_BACKGROUND_WINDOWS: '1',
      } as Record<string, string>,
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
    cdp = await page.context().newCDPSession(page);
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('renders the 48-child session, runs the scenario and reports frame times', async () => {
    // select the session and wait for the graph
    const main = page.locator('[data-agent="main"]');
    if (!(await main.isVisible().catch(() => false))) {
      await page.getByText(show.SHOW_TITLE).first().click({ timeout: 20_000 });
    }
    await main.waitFor({ timeout: 20_000 });
    await page.locator('[data-agent="r8"]').waitFor({ timeout: 20_000 });
    await page.locator('[data-agent="wf:wf_show"]').waitFor({ timeout: 20_000 });
    await sleep(1500);

    // 01: the fit view (fit never goes below a readable scale, so this shows the top of the 48-child graph);
    // 02: zoomed out as far as the app allows, for the whole graph
    trace('fit');
    await page.getByRole('button', { name: 'fit' }).click();
    await sleep(600);
    const n1 = await shot(1);
    trace('zoom out');
    for (let i = 0; i < 8; i++) await page.getByRole('button', { name: 'zoom out' }).click();
    await sleep(700);
    const n2 = await shot(2);
    trace('back to fit');
    await page.getByRole('button', { name: 'fit' }).click();
    await sleep(500);
    trace('before scenario');

    const runningBefore = await page
      .locator('.graph-count')
      .innerText()
      .catch(() => '');
    const badgeBefore = (() => {
      const m = /(\d+)\/(\d+)/.exec(runningBefore);
      return m ? { running: Number(m[1]), total: Number(m[2]) } : null;
    })();
    const nodesBefore = await page.locator('.node[data-agent]').count();
    const chips = await page.locator('.node.collapsed').allInnerTexts();
    const shape = await page.evaluate(() => {
      const r = (document.querySelector('.graph-canvas > div') as HTMLElement | null)?.getBoundingClientRect();
      const w = document.querySelector('.graph-wrap') as HTMLElement | null;
      return { canvasW: r ? Math.round(r.width) : 0, canvasH: r ? Math.round(r.height) : 0, wrapW: w?.clientWidth ?? 0, wrapH: w?.clientHeight ?? 0 };
    });
    trace(`before: ${nodesBefore} cards, badge "${runningBefore.trim()}", chips ${JSON.stringify(chips)}, canvas ${JSON.stringify(shape)}`);
    console.log(
      `[showcase] before the scenario: ${nodesBefore} cards, badge "${runningBefore.trim()}", chips ${JSON.stringify(chips)}, canvas ${JSON.stringify(shape)}, shots ${n1} ${n2}`,
    );
    expect(nodesBefore).toBeGreaterThanOrEqual(10);

    // frame sampling: rAF deltas and long tasks, from here to the end of the scenario
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__frames = [];
      w.__longTasks = [];
      let stop = false;
      w.__stopFrames = () => (stop = true);
      try {
        const po = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) (w.__longTasks as number[]).push(e.duration);
        });
        po.observe({ type: 'longtask', buffered: false });
        w.__po = po;
      } catch {
        /* longtask not supported here */
      }
      let last = performance.now();
      const loop = (t: number) => {
        (w.__frames as number[]).push(t - last);
        last = t;
        if (!stop) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });

    const t0 = Date.now();
    const shots: string[] = [];
    const after = (ms: number) => sleep(Math.max(0, t0 + ms - Date.now()));

    // 1. spawn three agents, one at a time, ~1.5 s apart
    trace('spawn r10');
    show.spawn(sh, 'main', { id: 'r10', desc: 'W6: review plan parser', model: show.HAIKU, type: 'Explore' });
    await sleep(1500);
    trace('spawn r11');
    show.spawn(sh, 'main', { id: 'r11', desc: 'search repo for hooks', model: show.SONNET, type: 'Explore' });
    await sleep(1500);
    trace('spawn r12');
    show.spawn(sh, 'main', { id: 'r12', desc: 'run tests again', model: show.HAIKU });
    await sleep(500);
    await page.locator('[data-agent="r12"]').waitFor({ timeout: 5000 });

    // 2. tool calls flow across the running agents
    const busy = ['r2', 'r4', 'r5', 'r6', 'r7', 'r10', 'r11', 'r12', 'n1'];
    for (let round = 0; round < 5; round++) {
      trace(`pulse ${round}`);
      show.pulse(sh, busy.slice(round % 3, (round % 3) + 6));
      await sleep(700);
    }
    trace('shot 3');
    shots.push(await shot(3));
    await after(7_700);
    shots.push(await shot(4));

    // 3. finish two agents
    show.finish(sh, 'r1');
    await sleep(450);
    show.finish(sh, 'r5');
    await sleep(900);
    shots.push(await shot(5));

    // 4. error one agent
    await sleep(600);
    show.fail(sh, 'r3');
    await sleep(900);
    shots.push(await shot(6));

    // 5. spawn into the nested tree (n1 gets a new child)
    show.spawn(sh, 'n1', { id: 'n1d', desc: 'deep dive retry docs', model: show.HAIKU, type: 'Explore' });
    await sleep(1200);
    shots.push(await shot(7, ['[data-agent="n1"]', '[data-agent="n1a"]', '[data-agent="n1b"]', '[data-agent="n1c"]', '[data-agent="n1d"]']));

    // 6. finish the workflow group
    show.finishWorkflow(sh);
    await sleep(1200);
    shots.push(await shot(8, ['[data-agent="wf:wf_show"]']));

    // 7. the main agent waits on a permission request (hook receiver), then real activity clears it
    await show.permissionRequest(PORT);
    await page
      .locator('[data-agent="main"].waiting')
      .waitFor({ timeout: 5000 })
      .catch(() => console.log('[showcase] main did not show waiting'));
    await sleep(900);
    shots.push(await shot(9, ['[data-agent="main"]']));
    show.mainStep(sh, 'Bash', { command: 'npm run check', description: 'Run the checks' });
    await sleep(900);
    show.finish(sh, 'r8');
    await sleep(900);
    shots.push(await shot(10));

    // 8. settle, the full fit view again, then a zoomed crop of the busy row
    await after(19_500);
    await page
      .getByRole('button', { name: 'fit' })
      .click()
      .catch(() => {});
    await sleep(700);
    shots.push(await shot(11));
    shots.push(await shot(12, ['[data-agent="r2"]', '[data-agent="r4"]', '[data-agent="r6"]', '[data-agent="r10"]']));

    // read the frame stats
    const stats = await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __longTasks: number[]; __stopFrames: () => void; __po?: PerformanceObserver };
      w.__stopFrames();
      w.__po?.disconnect();
      return { frames: w.__frames.slice(1), longTasks: w.__longTasks.slice() };
    });
    const f = stats.frames.slice().sort((a, b) => a - b);
    const avg = f.reduce((a, b) => a + b, 0) / Math.max(1, f.length);
    const p95 = f[Math.min(f.length - 1, Math.floor(f.length * 0.95))] ?? 0;
    const max = f[f.length - 1] ?? 0;
    const lt = stats.longTasks;
    const ltMax = lt.length ? Math.max(...lt) : 0;
    const ltTotal = lt.reduce((a, b) => a + b, 0);
    const fps = avg > 0 ? 1000 / avg : 0;
    const frameLine =
      `[showcase] frames ${f.length}: avg ${avg.toFixed(1)} ms (${fps.toFixed(0)} fps), p95 ${p95.toFixed(1)} ms, max ${max.toFixed(1)} ms | ` +
      `long tasks ${lt.length} (max ${ltMax.toFixed(0)} ms, total ${ltTotal.toFixed(0)} ms)`;
    console.log(frameLine);
    trace(frameLine);
    console.log(`[showcase] screenshots: ${[n1, n2, ...shots].map((s) => path.join(ART, s)).join(', ')}`);

    // the scenario landed: the new agents are on the graph, and the badge counts four more subagents in total
    for (const id of ['r10', 'r11', 'r12', 'n1d']) expect(await page.locator(`[data-agent="${id}"]`).count(), id).toBe(1);
    const badge = async () => {
      const m = /(\d+)\/(\d+)/.exec(await page.locator('.graph-count').innerText());
      return m ? { running: Number(m[1]), total: Number(m[2]) } : null;
    };
    const end = await badge();
    console.log(`[showcase] badge before ${JSON.stringify(badgeBefore)}, after ${JSON.stringify(end)}`);
    expect(end!.total - badgeBefore!.total).toBe(4);
    expect(end!.running).toBeLessThan(badgeBefore!.running + 4);
  }, 120_000);
});
