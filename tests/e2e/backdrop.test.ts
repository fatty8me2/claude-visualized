// Visual check of the graph backdrop: idle grid, spawn ripple, done bloom, error shock, many-running heat. Frames go to
// tests/e2e/artifacts/fx-backdrop-*.png. Also asserts it is quiet on load, never takes the mouse and stays behind the cards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SID, writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 47899) + 2;
const ts = () => new Date().toISOString();

describe('graph backdrop (fixture data)', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;
  let sub: string;
  let main: string;

  const addAgent = (id: string, model: string, desc: string) => {
    fs.writeFileSync(path.join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: desc, toolUseId: `toolu_${id}` }));
    fs.writeFileSync(
      path.join(sub, `agent-${id}.jsonl`),
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        agentId: id,
        sessionId: SID,
        timestamp: ts(),
        message: { id: `m${id}`, model, content: [{ type: 'tool_use', id: `toolu_q${id}`, name: 'Grep', input: { pattern: 'x' } }] },
      }) + '\n',
    );
  };
  const finish = (id: string, status: 'completed' | 'failed') => {
    const notif = `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>Agent "x" ${status}</summary>\n</task-notification>`;
    fs.appendFileSync(
      main,
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: ts(), sessionId: SID, content: notif }) +
        '\n' +
        JSON.stringify({ type: 'user', isSidechain: false, sessionId: SID, timestamp: ts(), message: { role: 'user', content: notif } }) +
        '\n',
    );
  };
  const bd = () => page.locator('canvas.gb-canvas').getAttribute('data-bd');
  const ripples = async () => Number(((await bd()) ?? '0').split('|')[0]);

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-bdhome-'));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-bdud-'));
    writeFixture(home);
    main = path.join(home, 'projects', 'C--demo-app', `${SID}.jsonl`);
    sub = path.join(home, 'projects', 'C--demo-app', SID, 'subagents');
    fs.appendFileSync(main, JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: SID, timestamp: ts() }) + '\n');
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
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(2000, 1000));
    await page.setViewportSize({ width: 2000, height: 1000 }).catch(() => {});
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('draws behind the graph, reacts to spawn / done / error, heats up under load', async () => {
    await page.locator('[data-agent="a1"]').waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1500);
    const clip = (await page.locator('.graph-wrap').boundingBox())!;
    const shot = (name: string) => page.screenshot({ path: path.join(ART, `fx-backdrop-${name}.png`), clip });

    // quiet on load, behind the cards, never in the way of the mouse
    expect(await ripples()).toBe(0);
    const probe = await page.evaluate(() => {
      const c = document.querySelector('canvas.gb-canvas') as HTMLCanvasElement;
      const cs = getComputedStyle(c);
      const node = document.querySelector('.node[data-agent]')!.getBoundingClientRect();
      const top = document.elementFromPoint(node.left + node.width / 2, node.top + node.height / 2);
      return { pe: cs.pointerEvents, w: c.clientWidth, h: c.clientHeight, onTop: top?.classList.contains('gb-canvas') ?? true };
    });
    expect(probe.pe).toBe('none');
    expect(probe.onTop).toBe(false);
    expect(probe.w).toBeGreaterThan(300);
    await shot('1-idle');

    // spawn
    addAgent('b1', 'claude-opus-5-5', 'design the docs update');
    await page.waitForFunction(() => Number(document.querySelector('canvas.gb-canvas')?.getAttribute('data-bd')?.split('|')[0]) > 0, undefined, { timeout: 10_000, polling: 16 });
    await page.waitForTimeout(550);
    await shot('2-spawn');
    await page.waitForTimeout(2200);
    expect(await ripples()).toBe(0);

    // done
    finish('b1', 'completed');
    await page.waitForFunction(() => Number(document.querySelector('canvas.gb-canvas')?.getAttribute('data-bd')?.split('|')[0]) > 0, undefined, { timeout: 10_000, polling: 16 });
    await page.waitForTimeout(450);
    await shot('3-done');
    await page.waitForTimeout(1800);

    // error
    addAgent('b2', 'claude-sonnet-5-5', 'migrate the schema');
    await page.waitForTimeout(2600);
    finish('b2', 'failed');
    await page.waitForFunction(() => Number(document.querySelector('canvas.gb-canvas')?.getAttribute('data-bd')?.split('|')[0]) > 0, undefined, { timeout: 10_000, polling: 16 });
    await page.waitForTimeout(300);
    await shot('4-error');
    await page.waitForTimeout(1800);

    // many running: heat, dust
    const models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'];
    for (let i = 0; i < 9; i++) addAgent(`h${i}`, models[i % 3], `scan module ${i}`);
    await page.waitForTimeout(3500);
    await shot('5-heat');
    expect(((await bd()) ?? '').split('|')[3]).toBe('n');

    // past the heavy threshold: cheap mode
    for (let i = 9; i < 20; i++) addAgent(`h${i}`, models[i % 3], `scan module ${i}`);
    await page.waitForTimeout(3000);
    expect(((await bd()) ?? '').split('|')[3]).toBe('h');
    await shot('6-heavy');
  });
});
