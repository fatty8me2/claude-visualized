// Visual check of the connectors: a subagent spawns (edge draws in), runs (gradient + particles), finishes (result pulse, then a calm line).
// Frames are saved to tests/e2e/artifacts/flow-*.png. Also asserts that opening a session with finished agents plays no edge animation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SID, writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 47899) + 1;

const ts = () => new Date().toISOString();

describe('graph flow (fixture data)', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-flowhome-'));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-flowud-'));
    writeFixture(home);
    fs.appendFileSync(
      path.join(home, 'projects', 'C--demo-app', `${SID}.jsonl`),
      JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: SID, timestamp: ts() }) + '\n',
    );
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
      } as Record<string, string>,
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('draws, flows, returns and settles; edges stay quiet on first load', async () => {
    await page.locator('[data-agent="a1"]').waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1500);
    // opening the session played nothing
    expect(await page.locator('.gf-spawn, .gf-ret, .gf-pulse').count()).toBe(0);
    // every non-main card has an incoming edge, ending exactly at the card's top centre
    const geo = await page.evaluate(() => {
      const canvas = document.querySelector('.graph-canvas > div')!.getBoundingClientRect();
      const out: number[] = [];
      for (const g of document.querySelectorAll('svg.gf .gf-edge')) {
        const base = g.querySelector('.gf-base') as SVGPathElement;
        const len = base.getTotalLength();
        const end = base.getPointAtLength(len);
        const m = base.getScreenCTM()!;
        const ex = end.x * m.a + m.e;
        const ey = end.y * m.d + m.f;
        // find the card whose top-centre is nearest
        let best = 1e9;
        for (const n of document.querySelectorAll('.node[data-agent]')) {
          const r = n.getBoundingClientRect();
          best = Math.min(best, Math.hypot(ex - (r.left + r.width / 2), ey - r.top));
        }
        out.push(best);
      }
      return { out, canvasW: canvas.width };
    });
    expect(geo.out.length).toBeGreaterThan(3);
    for (const d of geo.out) expect(d).toBeLessThan(2);

    const clip = (await page.locator('.graph-wrap').boundingBox())!;
    const shot = (name: string) => page.screenshot({ path: path.join(ART, `flow-${name}.png`), clip });
    await shot('1-before');

    const sub = path.join(home, 'projects', 'C--demo-app', SID, 'subagents');
    fs.writeFileSync(path.join(sub, 'agent-a9.meta.json'), JSON.stringify({ agentType: 'Plan', description: 'design the docs update', toolUseId: 'toolu_new' }));
    fs.writeFileSync(
      path.join(sub, 'agent-a9.jsonl'),
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        agentId: 'a9',
        sessionId: SID,
        timestamp: ts(),
        message: { id: 'm9', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_q', name: 'Glob', input: { pattern: 'docs/**/*.md' } }] },
      }) + '\n',
    );
    // the edge starts drawing the moment the agent shows up
    await page.waitForFunction(() => document.querySelector('.gf-spawn'), undefined, { timeout: 10_000, polling: 16 });
    await page.waitForTimeout(150);
    await shot('2-spawn');
    await page.waitForTimeout(1600);
    await shot('3-running');
    expect(await page.locator('.gf-running .gf-particles').count()).toBeGreaterThan(0);

    // finish it: a task notification in the main transcript
    const notif = '<task-notification>\n<task-id>a9</task-id>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n</task-notification>';
    fs.appendFileSync(
      path.join(home, 'projects', 'C--demo-app', `${SID}.jsonl`),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: ts(), sessionId: SID, content: notif }) +
        '\n' +
        JSON.stringify({ type: 'user', isSidechain: false, sessionId: SID, timestamp: ts(), message: { role: 'user', content: notif } }) +
        '\n',
    );
    await page.waitForFunction(() => document.querySelector('.gf-ret'), undefined, { timeout: 10_000, polling: 16 });
    await page.waitForTimeout(300);
    await shot('4-return');
    await page.waitForTimeout(2200);
    await shot('5-settled');
    expect(await page.locator('.gf-ret, .gf-pulse').count()).toBe(0);
    expect(await page.locator('[data-agent="a9"] .status').innerText()).toContain('done');

    // hovering a card lights its path to the root
    await page.locator('[data-agent="a9"]').hover();
    await page.waitForTimeout(300);
    await page.locator('.gf-hot').first().waitFor({ state: 'attached', timeout: 3000 });
    await shot('6-hover');
  });
});
