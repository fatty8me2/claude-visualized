// The graph's camera, end to end on the showcase session: minimap (shows when the graph overflows, click and drag move the view),
// edge chips for running agents out of view (click flies there and selects), the main node's core halo (pulses on a spawn), and
// the eased fly-to. Screenshots: tests/e2e/artifacts/vis-graph-*.png.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as show from '../fixtures/showcase';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 47960);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('graph camera (fixture data)', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;
  let sh: show.Showcase;

  const shot = async (name: string) => {
    await sleep(200);
    await page.locator('.graph-wrap').screenshot({ path: path.join(ART, `vis-graph-${name}.png`) });
  };
  const scroll = () => page.evaluate(() => {
    const w = document.querySelector('.graph-wrap') as HTMLElement;
    return { left: w.scrollLeft, top: w.scrollTop };
  });
  const inView = (id: string) =>
    page.evaluate((i) => {
      const w = document.querySelector('.graph-wrap') as HTMLElement;
      const c = document.querySelector(`[data-agent="${i}"]`) as HTMLElement;
      const a = w.getBoundingClientRect();
      const b = c.getBoundingClientRect();
      return b.left >= a.left - 2 && b.right <= a.right + 2 && b.top >= a.top - 2 && b.bottom <= a.bottom + 2;
    }, id);

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-cam-home-'));
    if (path.resolve(home) === path.resolve(os.homedir(), '.claude')) throw new Error('refusing to run on ~/.claude');
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-cam-ud-'));
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
    await page.evaluate(() => localStorage.setItem('cvis.graph.v1', JSON.stringify({ zoom: 1, compact: 'off', hideFinished: false })));
    await page.reload();
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('shows a minimap when the graph overflows, and moves the view from it', async () => {
    const main = page.locator('[data-agent="main"]');
    if (!(await main.isVisible().catch(() => false))) await page.getByText(show.SHOW_TITLE).first().click({ timeout: 20_000 });
    await main.waitFor({ timeout: 20_000 });
    await page.locator('[data-agent="r8"]').waitFor({ timeout: 20_000 });
    await sleep(1200);
    const map = page.locator('[data-testid="minimap"]');
    await map.waitFor({ state: 'visible', timeout: 5000 });
    await shot('minimap');
    const box = (await map.boundingBox())!;
    const before = await scroll();
    await page.mouse.click(box.x + box.width * 0.85, box.y + box.height * 0.85);
    await sleep(900);
    const after = await scroll();
    expect(after.top).toBeGreaterThan(before.top + 50);
    // drag scrubs back to the top
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.9);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + 3, { steps: 6 });
    await page.mouse.up();
    await sleep(200);
    expect((await scroll()).top).toBeLessThan(after.top);
    await shot('minimap-top');
    // zoomed out so everything fits, the map is not needed
    await page.getByRole('button', { name: 'fit' }).click();
    for (let i = 0; i < 8; i++) await page.getByRole('button', { name: 'zoom out' }).click();
    await sleep(700);
    const cls = await map.getAttribute('class');
    expect(cls).toContain('on');
  });

  it('points at running agents out of view; a chip flies there and selects the agent', async () => {
    await page.getByRole('button', { name: 'zoom in' }).click();
    await page.getByTestId('zoom-pct').click();
    await sleep(600);
    await page.evaluate(() => {
      const w = document.querySelector('.graph-wrap') as HTMLElement;
      w.scrollTo(0, 0);
    });
    await sleep(500);
    const chip = page.locator('.gcam-chip').first();
    await chip.waitFor({ timeout: 5000 });
    expect(await page.locator('.gcam-chip').count()).toBeLessThanOrEqual(4);
    await shot('chips');
    const id = (await chip.getAttribute('data-chase'))!;
    expect(await inView(id)).toBe(false);
    await page.locator(`.gcam-chip[data-chase="${id}"]`).click();
    await sleep(1400);
    expect(await inView(id)).toBe(true);
    expect(await page.locator(`[data-agent="${id}"].sel`).count()).toBe(1);
    await shot('flown');
  });

  it('pulses the core when the main agent spawns a child', async () => {
    await page.keyboard.press('Escape');
    show.spawn(sh, 'main', { id: 'zz1', desc: 'a late arrival', model: show.HAIKU, type: 'Explore' });
    await page.locator('[data-agent="zz1"]').waitFor({ timeout: 8000 });
    expect(await page.locator('.core-halo').count()).toBe(1);
    await sleep(250);
    expect(await page.locator('.core-halo.fire').count()).toBe(1);
    await page.locator('[data-agent="main"]').scrollIntoViewIfNeeded();
    await shot('core');
  });
});
