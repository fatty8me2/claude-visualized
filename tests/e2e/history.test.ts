// End-to-end for the History page: indexes a fixture ~/.claude in the app's worker thread, checks the tiles and charts,
// searches, and opens a hit. SHOT_REAL=1 also indexes the real ~/.claude (read-only) into an isolated userData dir and times it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SID, writeFixture } from '../fixtures/build';
import { writeSecondFixture } from '../fixtures/history';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 47899);

async function launch(env: Record<string, string>) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-ud-'));
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
      CLAUDE_VIS_DESKTOP_DIR: path.join(userData, 'no-desktop'),
      ...env,
    } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1500 }).catch(() => {});
  return { app, page, userData };
}

const idle = (page: Page, timeout = 30_000) => page.locator('[data-testid="history-status"][data-state="idle"]').waitFor({ timeout });

describe('history page (fixture data)', () => {
  let home: string;
  let app: ElectronApplication;
  let page: Page;
  let userData: string;

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-home-'));
    writeFixture(home);
    writeSecondFixture(home);
    ({ app, page, userData } = await launch({ CLAUDE_VIS_HOME: home }));
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('indexes in the background and shows tiles, charts and breakdowns', async () => {
    await page.getByTestId('nav-history').click();
    await page.getByTestId('history-page').waitFor();
    await idle(page);
    await page.getByTestId('range-all').click();
    const kpi = (id: string) => page.locator(`[data-kpi="${id}"] .hist-kpi-value`);
    await page.locator('[data-kpi="sessions"] .hist-kpi-value', { hasText: '2' }).waitFor({ timeout: 10_000 });
    expect(await page.getByTestId('history-kpi').count()).toBe(5);
    expect(await kpi('sessions').innerText()).toBe('2');
    expect(await kpi('agents').innerText()).toBe('5');
    expect(await kpi('days').innerText()).toBe('2');
    expect(await kpi('cost').innerText()).toBe('$1.75');
    expect(await page.locator('[data-kpi="cost"] .hist-kpi-label').innerText()).toMatch(/reported/i);
    expect(await page.locator('[data-kpi="cost"] .hist-kpi-sub').innerText()).toContain('2 of 2 sessions');
    expect(await kpi('tokens').innerText()).toMatch(/\d/);

    // stacked bars: Claude families and the local model, labelled axes
    const chart = page.getByTestId('history-chart');
    expect(await chart.locator('rect[data-family]').count()).toBeGreaterThan(3);
    expect(await chart.locator('rect[data-family="local"]').count()).toBe(1);
    expect(await chart.locator('rect[data-family="opus"]').count()).toBeGreaterThan(0);
    expect(await chart.innerText()).toContain('tokens in + out');
    expect(await chart.innerText()).toContain('day (local time)');
    const legend = await page.getByTestId('history-legend').innerText();
    expect(legend).toContain('Opus');
    expect(legend).toContain('local models');
    expect(await page.getByTestId('history-heatmap').locator('rect.hist-cell').count()).toBe(7 * 24);

    expect(await page.getByTestId('history-projects').innerText()).toContain('app');
    expect(await page.getByTestId('history-projects').innerText()).toContain('other');
    const models = await page.getByTestId('history-models').innerText();
    expect(models).toContain('Opus 5.5');
    expect(models).toMatch(/Qwen2\.5 Coder 32B\s*local/);
    expect(await page.getByTestId('history-tools').innerText()).toContain('Bash');
    expect(await page.getByTestId('history-goals').innerText()).toContain('search');
    await page.getByTestId('with-cache').click();
    expect(await chart.innerText()).toContain('tokens incl. cache');
    await page.getByTestId('with-cache').locator('xpath=preceding-sibling::button').click();
    await page.getByTestId('history-chart').hover({ position: { x: 300, y: 100 } });
    await page.screenshot({ path: path.join(ART, 'history.png') });
  });

  it('finds text across sessions and opens the session from a hit', async () => {
    await page.getByTestId('history-search').fill('retry');
    await page.getByTestId('history-hit').first().waitFor({ timeout: 10_000 });
    expect(await page.getByTestId('history-hit').count()).toBeGreaterThan(1);
    const first = page.locator(`[data-testid="history-hit"][data-session="${SID}"]`).first();
    const text = await first.innerText();
    expect(text).toContain('Retry + docs');
    expect(text).toContain('app');
    expect(await first.locator('mark').first().innerText()).toMatch(/retry/i);
    await page.screenshot({ path: path.join(ART, 'history-search.png') });

    await first.click();
    await page.locator('[data-agent="a1"]').waitFor({ timeout: 15_000 });
    expect(await page.evaluate(() => window.api.getSelected())).toBe(SID);
    expect(await page.getByTestId('history-page').count()).toBe(0);

    // the search is gone from the session page; come back, the other session is findable too
    await page.getByTestId('nav-history').click();
    await page.getByTestId('history-search').fill('flaky login');
    await page.locator('[data-testid="history-hit"]').first().waitFor();
    expect(await page.locator('[data-testid="history-hit"]').first().innerText()).toContain('Flaky login test');
    await page.getByTestId('history-search').fill('zzzzqqq');
    await page.getByText('No matches').waitFor();
  });

  it('keeps its database in the isolated userData dir and can rebuild it', async () => {
    const db = path.join(userData, 'history.db');
    expect(fs.existsSync(db)).toBe(true);
    await page.getByTestId('history-search').fill('');
    // the fixture's dates are fixed, so how many fall in the page's default range depends on today: compare before/after instead
    const kpi = page.locator('[data-kpi="sessions"] .hist-kpi-value');
    const before = (await kpi.innerText()).trim();
    expect(Number(before)).toBeGreaterThan(0);
    await page.getByTestId('history-rebuild').click();
    await idle(page);
    await page.locator('[data-kpi="sessions"] .hist-kpi-value', { hasText: before }).waitFor({ timeout: 10_000 });
    expect(fs.existsSync(db)).toBe(true);
  });
});

describe.skipIf(!process.env.SHOT_REAL)('history page (real ~/.claude)', () => {
  it('indexes the real data and renders it', async () => {
    const { app, page, userData } = await launch({ CLAUDE_VIS_NO_HOOK_SERVER: '1' });
    try {
      const t0 = Date.now();
      await page.getByTestId('nav-history').click();
      await page.getByTestId('history-page').waitFor();
      await idle(page, 300_000);
      const ms = Date.now() - t0;
      const status = await page.evaluate(() => window.api.historyStatus());
      const size = fs.statSync(path.join(userData, 'history.db')).size;
      console.log(
        `real index: ${ms} ms until idle (worker reported ${status.lastRunMs} ms), ${status.sessions} sessions, ${status.docs} passages, history.db ${(size / 1e6).toFixed(1)} MB (+wal ${status.dbBytes - size})`,
      );
      await page.getByTestId('range-90d').click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(ART, 'history-real.png') });
      await page.getByTestId('history-search').fill('retry');
      await page.getByTestId('history-hit').first().waitFor({ timeout: 10_000 });
      await page.screenshot({ path: path.join(ART, 'history-real-search.png') });
    } finally {
      await app.close();
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });
});
