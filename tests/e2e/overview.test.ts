// End-to-end checks for the all-sessions page: drag-resizing the grid, panel sizes, maximize, swapping, density,
// pin/hide, persistence and reset. Windows stay off-screen (vitest.e2e.config.ts). Run `npx electron-vite build` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROJECT, SID, writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 47899);
const EXTRA = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '66666666-6666-4666-8666-666666666666'];

const freshLine = (sid: string) => JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: sid, timestamp: new Date().toISOString() }) + '\n';

describe('all-sessions overview (fixture data, 4 live sessions)', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;

  const panel = (sid: string) => page.locator(`.ov-panel[data-session="${sid}"]`);
  const box = async (sel: string) => (await page.locator(sel).boundingBox())!;
  const order = () => page.locator('.ov-panel').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.session));
  const settle = (ms = 900) => page.waitForTimeout(ms);
  const openOverview = async () => {
    await page.getByRole('button', { name: /all sessions/ }).click();
    await page.locator('.ov-panel').first().waitFor({ timeout: 15_000 });
    await vi.waitFor(async () => expect(await page.locator('.ov-panel').count()).toBe(4), { timeout: 15_000 });
    await settle(600);
  };

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-ov-home-'));
    writeFixture(home);
    const src = fs.readFileSync(path.join(home, 'projects', PROJECT, `${SID}.jsonl`), 'utf8');
    fs.appendFileSync(path.join(home, 'projects', PROJECT, `${SID}.jsonl`), freshLine(SID));
    EXTRA.forEach((sid, i) => {
      const dir = path.join(home, 'projects', `C--other-proj-${i}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${sid}.jsonl`), src.replaceAll(SID, sid).replaceAll('Retry + docs', `Session number ${i + 2}`) + freshLine(sid));
    });
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-ov-ud-'));
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
    await page.locator('[data-agent="a1"]').first().waitFor({ timeout: 20_000 });
    await openOverview();
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('starts as an even two-by-two grid', async () => {
    const o = (await order()) as string[];
    expect(o.length).toBe(4);
    const a = await box(`.ov-panel[data-session="${o[0]}"]`);
    const b = await box(`.ov-panel[data-session="${o[1]}"]`);
    expect(Math.abs(a.width - b.width)).toBeLessThan(3);
    await page.screenshot({ path: path.join(ART, 'overview-resize-1-default.png') });
  });

  it('drags a column border and a row border, and the graphs re-fit', async () => {
    const o = (await order()) as string[];
    const first = `.ov-panel[data-session="${o[0]}"]`;
    const w0 = (await box(first)).width;
    const h0 = (await box(first)).height;
    const graphW = () => page.locator(`${first} [data-agent="main"]`).evaluate((el) => el.getBoundingClientRect().width);
    const g0 = await graphW();
    const h = await box('[data-testid="ov-rz-col-0"]');
    expect(h.width).toBeGreaterThanOrEqual(8);
    await page.mouse.move(h.x + h.width / 2, h.y + 100);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2 + 200, h.y + 100, { steps: 8 });
    await page.mouse.up();
    await settle(300);
    const w1 = (await box(first)).width;
    expect(w1).toBeGreaterThan(w0 + 150);
    expect(await graphW()).not.toBe(g0);
    // the other column shrank but stays usable
    const second = (await box(`.ov-panel[data-session="${o[1]}"]`)).width;
    expect(second).toBeGreaterThanOrEqual(255);

    // far past the limit: the neighbour keeps its minimum
    const h2 = await box('[data-testid="ov-rz-col-0"]');
    await page.mouse.move(h2.x + h2.width / 2, h2.y + 100);
    await page.mouse.down();
    await page.mouse.move(h2.x + h2.width / 2 + 2000, h2.y + 100, { steps: 6 });
    await page.mouse.up();
    await settle(300);
    expect((await box(`.ov-panel[data-session="${o[1]}"]`)).width).toBeGreaterThanOrEqual(255);
    // pull it back to a moderate split
    const h3 = await box('[data-testid="ov-rz-col-0"]');
    await page.mouse.move(h3.x + h3.width / 2, h3.y + 100);
    await page.mouse.down();
    await page.mouse.move(h3.x + h3.width / 2 - 300, h3.y + 100, { steps: 6 });
    await page.mouse.up();

    const r = await box('[data-testid="ov-rz-row-0"]');
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2 + 60, { steps: 6 });
    await page.mouse.up();
    await settle(300);
    expect((await box(first)).height).toBeGreaterThan(h0 + 30);
    await page.screenshot({ path: path.join(ART, 'overview-resize-2-dragged.png') });
  });

  it('gives a panel a 2x2 span', async () => {
    const o = (await order()) as string[];
    const target = o[1];
    const before = (await box(`.ov-panel[data-session="${target}"]`)).width;
    await panel(target).getByTestId('size-2×2').click();
    await settle();
    expect(await panel(target).getAttribute('data-size')).toBe('2×2');
    expect((await box(`.ov-panel[data-session="${target}"]`)).width).toBeGreaterThan(before * 1.4);
    await page.screenshot({ path: path.join(ART, 'overview-resize-3-span-2x2.png') });
  });

  it('maximizes a panel with the button and Esc, and with a double-click', async () => {
    const o = (await order()) as string[];
    const target = o[2];
    await panel(target).getByTestId('ov-max').click();
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(ART, 'overview-resize-4-maximize-animating.png') });
    await settle();
    const grid = await box('.ov-grid');
    const m = await box(`.ov-panel[data-session="${target}"]`);
    expect(m.width).toBeGreaterThan(grid.width - 40);
    expect(m.height).toBeGreaterThan(grid.height - 40);
    expect(await page.locator('.ov-panel:visible').count()).toBe(1);
    await page.screenshot({ path: path.join(ART, 'overview-resize-5-maximized.png') });
    await page.keyboard.press('Escape');
    await settle();
    expect(await page.locator('.ov-panel:visible').count()).toBe(4);
    // double-click on the header maximizes instead of opening the session
    await panel(target)
      .locator('.ov-head')
      .dblclick({ position: { x: 60, y: 12 } });
    await settle();
    expect(await page.locator('.ov-panel:visible').count()).toBe(1);
    expect(await page.locator('.modebox').count()).toBe(0);
    await panel(target).getByTestId('ov-max').click();
    await settle();
    expect(await page.locator('.ov-panel:visible').count()).toBe(4);
  });

  it('swaps two panels by dragging a header onto another', async () => {
    const o = (await order()) as string[];
    await panel(o[1]).getByTestId('size-1×1').click(); // back to a plain grid so every panel is on screen
    await settle();
    const a = o[2];
    const b = o[3];
    const ha = await box(`.ov-panel[data-session="${a}"] .ov-titles`);
    const pb = await box(`.ov-panel[data-session="${b}"] .ov-graph`);
    await page.mouse.move(ha.x + 20, ha.y + ha.height / 2);
    await page.mouse.down();
    await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2, { steps: 10 });
    await page.locator(`.ov-panel[data-session="${b}"].drop-target`).waitFor();
    await page.screenshot({ path: path.join(ART, 'overview-resize-6-dragging.png') });
    await page.mouse.up();
    await settle();
    expect(await order()).toEqual([o[0], o[1], b, a]);
    expect(await page.locator('.modebox').count()).toBe(0);
  });

  it('switches density: compact forces the small tier (graph + log) and shrinks the header', async () => {
    const o = (await order()) as string[];
    const hh = (await box(`.ov-panel[data-session="${o[0]}"] .ov-head`)).height;
    expect(await page.locator('.ov-log').count()).toBeGreaterThan(0);
    await page.getByTestId('density-compact').click();
    await settle();
    expect(await page.locator('.ov-panel:not([data-tier="small"])').count()).toBe(0);
    expect(await page.locator('.px-rail').count()).toBe(0);
    expect((await box(`.ov-panel[data-session="${o[0]}"] .ov-head`)).height).toBeLessThan(hh);
    expect(await page.locator('.ov-grid').getAttribute('data-cols')).toBe('3');
    await page.screenshot({ path: path.join(ART, 'overview-resize-7-compact.png') });
    await page.getByTestId('density-spacious').click();
    await settle();
    expect(await page.locator('.ov-grid').getAttribute('data-cols')).toBe('2');
    await page.getByTestId('density-comfortable').click();
    await settle();
  });

  it('pins a session to the top-left and hides one with a show-hidden toggle', async () => {
    const o = (await order()) as string[];
    await panel(o[3]).getByTestId('ov-pin').click();
    await settle();
    expect((await order())![0]).toBe(o[3]);
    const hiddenOne = o[1];
    await panel(hiddenOne).getByTestId('ov-hide').click();
    await settle();
    expect(await page.locator('.ov-panel').count()).toBe(3);
    await page.getByTestId('ov-show-hidden').click();
    await settle();
    expect(await page.locator('.ov-panel').count()).toBe(4);
    expect(await panel(hiddenOne).evaluate((e) => e.classList.contains('ghosted'))).toBe(true);
    await page.screenshot({ path: path.join(ART, 'overview-resize-8-pinned-hidden.png') });
    await panel(hiddenOne).getByTestId('ov-hide').click(); // unhide
    await settle(600);
    expect(await page.getByTestId('ov-show-hidden').count()).toBe(0);
  });

  it('keeps the layout across a reload, then resets it', async () => {
    const before = (await order()) as string[];
    await panel(before[1]).getByTestId('size-2×1').click();
    await settle();
    const sizes = await page.locator('.ov-panel').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.size));
    const w = (await box(`.ov-panel[data-session="${before[1]}"]`)).width;
    expect(sizes).toContain('2×1');
    await page.reload();
    await page.locator('[data-agent="a1"]').first().waitFor({ timeout: 20_000 });
    await openOverview();
    expect(await order()).toEqual(before);
    expect(await page.locator('.ov-panel').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.size))).toEqual(sizes);
    expect(Math.abs((await box(`.ov-panel[data-session="${before[1]}"]`)).width - w)).toBeLessThan(4);
    await page.screenshot({ path: path.join(ART, 'overview-resize-9-after-reload.png') });

    await page.getByTestId('ov-reset').click();
    await settle();
    expect(await page.locator('.ov-panel').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.size))).toEqual(['1×1', '1×1', '1×1', '1×1']);
    const a = await box('.ov-panel >> nth=0');
    const b = await box('.ov-panel >> nth=1');
    expect(Math.abs(a.width - b.width)).toBeLessThan(3);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cvis.overview.v1') ?? '{}').sizes)).toEqual({});
    await page.screenshot({ path: path.join(ART, 'overview-resize-10-reset.png') });
  });
});
