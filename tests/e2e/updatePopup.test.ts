// The "Update available" pop-up: appears on its own when the startup check finds an update, "Later" / Escape hide it for this
// window-show, it comes back when the window is opened again from the tray, and re-showing the window re-checks a stale feed.
// Uses a local generic feed (CLAUDE_VIS_UPDATE_URL). Screenshots: tests/e2e/artifacts/update-popup-*.png. Run `electron-vite build` first.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { SID, writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');

const LATEST_YML = [
  'version: 9.9.9',
  'files:',
  '  - url: Claude-Visualized-Setup-9.9.9.exe',
  `    sha512: ${Buffer.alloc(64, 1).toString('base64')}`,
  '    size: 1024',
  'path: Claude-Visualized-Setup-9.9.9.exe',
  `sha512: ${Buffer.alloc(64, 1).toString('base64')}`,
  "releaseDate: '2026-01-01T00:00:00.000Z'",
  'releaseNotes: "<p>Fake release</p><ul><li>Faster things</li><li>Shinier graph</li></ul>"',
  '',
].join('\n');

/** A feed that answers 404 until `publish()` is called, then serves latest.yml for 9.9.9. Counts .yml requests. */
async function startFeed(published: boolean) {
  const state = { published, ymlRequests: 0 };
  const server = http.createServer((req, res) => {
    if ((req.url ?? '').split('?')[0].endsWith('.yml')) {
      state.ymlRequests += 1;
      if (!state.published) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'text/yaml' });
      res.end(LATEST_YML);
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    state,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function launch(env: Record<string, string>, config?: object) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-updpop-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-updpophome-'));
  writeFixture(home);
  const fresh = JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: SID, timestamp: new Date().toISOString() }) + '\n';
  fs.appendFileSync(path.join(home, 'projects', 'C--demo-app', `${SID}.jsonl`), fresh);
  if (config) fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config));
  const app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      CLAUDE_VIS_USER_DATA: userData,
      CLAUDE_VIS_HOME: home,
      CLAUDE_VIS_NO_HOOK_SERVER: '1',
      CLAUDE_VIS_NO_TRAY: '1',
      CLAUDE_VIS_NO_EXTERNAL: '1',
      CLAUDE_VIS_NO_SYSTEM_INTEGRATION: '1',
      CLAUDE_VIS_NO_USAGE_API: '1',
      CLAUDE_VIS_SKIP_ONBOARDING: '1',
      ...env,
    } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
  return { app, page, userData, home };
}

/** What the tray does: the X hides the window (closeToTray), the tray icon shows it again. */
async function hideAndReshow(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.isVisible())
      ?.hide(),
  );
  await new Promise((r) => setTimeout(r, 300));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.showInactive());
}

describe('update pop-up', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterAll(async () => {
    for (const c of cleanup.reverse()) await c();
  });

  it('pops up when the startup check finds an update; Later / Escape hide it until the window is opened again', async () => {
    const feed = await startFeed(true);
    cleanup.push(feed.close);
    // auto-download off, so the flow stops at "available" instead of fetching the fake installer
    const { app, page, userData, home } = await launch({ CLAUDE_VIS_UPDATE_URL: feed.url, CLAUDE_VIS_UPDATE_DELAY_MS: '500' }, { autoDownloadUpdates: false });
    cleanup.push(async () => {
      await app.close();
      fs.rmSync(userData, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    });

    const pop = page.getByTestId('update-popup');
    await pop.waitFor({ timeout: 20_000 });
    expect(await page.getByTestId('update-popup-title').innerText()).toBe('Update available: v9.9.9');
    expect(await page.getByTestId('update-popup-notes').innerText()).toContain('Faster things');
    expect(await pop.getAttribute('data-stage')).toBe('found');
    expect(await pop.getByRole('button', { name: 'Update now' }).count()).toBe(1);
    // the title bar says so too, next to the version
    expect(await page.getByTestId('tb-update').innerText()).toContain('Update to v9.9.9');
    expect(await page.getByTestId('tb-update').getAttribute('data-state')).toBe('available');
    await page.waitForTimeout(1_500); // let the entrance animation settle
    fs.mkdirSync(ART, { recursive: true });
    await page.screenshot({ path: path.join(ART, 'update-popup-found.png') });
    await pop.screenshot({ path: path.join(ART, 'update-popup-card.png') });

    // Later hides it, and it stays hidden in this window-show (state updates do not bring it back)
    await page.getByTestId('update-popup-later').click();
    await pop.waitFor({ state: 'detached', timeout: 5_000 });
    await page.waitForTimeout(800);
    expect(await pop.count()).toBe(0);

    // opening the window again (tray) brings it back
    await hideAndReshow(app);
    await pop.waitFor({ timeout: 10_000 });
    expect(await page.getByTestId('update-popup-title').innerText()).toContain('9.9.9');

    // Escape = Later
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    await pop.waitFor({ state: 'detached', timeout: 5_000 });

    // turned off in Settings: re-showing the window does not bring it back
    await page.getByRole('button', { name: /hooks/ }).click();
    await page.getByTestId('updates-settings').waitFor({ timeout: 10_000 });
    const toggle = page.getByLabel(/Notify me when an update is available/);
    expect(await toggle.isChecked()).toBe(true);
    await toggle.click();
    expect(await toggle.isChecked()).toBe(false);
    await page.keyboard.press('Escape');
    await page.getByTestId('updates-settings').waitFor({ state: 'detached', timeout: 5_000 });
    await hideAndReshow(app);
    await page.waitForTimeout(1_000);
    expect(await pop.count()).toBe(0);
  });

  it('re-showing the window re-checks a stale feed and pops up what it finds', async () => {
    const feed = await startFeed(false);
    cleanup.push(feed.close);
    const { app, page, userData, home } = await launch(
      { CLAUDE_VIS_UPDATE_URL: feed.url, CLAUDE_VIS_UPDATE_DELAY_MS: '300', CLAUDE_VIS_UPDATE_RECHECK_MS: '0' },
      { autoDownloadUpdates: false },
    );
    cleanup.push(async () => {
      await app.close();
      fs.rmSync(userData, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    });
    // the startup check finds nothing (404): an error never pops up on its own, the title bar says it instead
    await expect.poll(() => feed.state.ymlRequests, { timeout: 20_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(1_000);
    expect(await page.getByTestId('update-popup').count()).toBe(0);
    expect(await page.getByTestId('tb-update').getAttribute('data-state')).toBe('error');
    const before = feed.state.ymlRequests;

    // a release goes out while the app sits in the tray; opening the window checks again
    feed.state.published = true;
    await hideAndReshow(app);
    await page.getByTestId('update-popup').waitFor({ timeout: 20_000 });
    expect(feed.state.ymlRequests).toBeGreaterThan(before);
    expect(await page.getByTestId('update-popup-title').innerText()).toBe('Update available: v9.9.9');

    // an update is already known: the next show does not check again
    const after = feed.state.ymlRequests;
    await hideAndReshow(app);
    await page.waitForTimeout(1_500);
    expect(feed.state.ymlRequests).toBe(after);
  });

  it('a failed download never leaves a pop-up up; progress and "ready" render (states pushed from main)', async () => {
    const feed = await startFeed(true);
    cleanup.push(feed.close);
    // auto-download on: in a dev build the download itself fails (no dev-app-update.yml), so the state ends in "error"
    const { app, page, userData, home } = await launch({ CLAUDE_VIS_UPDATE_URL: feed.url, CLAUDE_VIS_UPDATE_DELAY_MS: '500' });
    cleanup.push(async () => {
      await app.close();
      fs.rmSync(userData, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    });
    await expect.poll(async () => (await page.evaluate(() => window.api.getUpdates())).status, { timeout: 20_000 }).toBe('error');
    await page.waitForTimeout(500);
    expect(await page.getByTestId('update-popup').count()).toBe(0);

    // the real download needs a packaged app; push the later states the way the updater broadcasts them
    const push = (v: object) => app.evaluate(({ BrowserWindow }, view) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('updates', view)), v);
    const base = { mode: 'auto', currentVersion: '0.10.4', version: '9.9.9', releaseNotes: 'Fake release\n- Faster things\n- Shinier graph' };
    await push({ ...base, status: 'downloading', percent: 63 });
    const pop = page.getByTestId('update-popup');
    await page.locator('[data-testid="update-popup"][data-stage="downloading"]').waitFor({ timeout: 5_000 });
    expect(await page.getByTestId('update-popup-progress').getAttribute('aria-valuenow')).toBe('63');
    expect(await pop.getByRole('button').allInnerTexts()).toEqual(['Later', 'Restart when done']);
    expect(await page.getByTestId('tb-update').innerText()).toContain('Updating 63%');
    // after "Update now" there is nothing left to press but Later
    await push({ ...base, status: 'downloading', percent: 70, installWhenReady: true });
    await expect.poll(() => pop.getByRole('button').allInnerTexts(), { timeout: 5_000 }).toEqual(['Later']);
    expect(await page.getByTestId('update-popup-line').innerText()).toMatch(/restarts as soon as it is done/);
    await page.waitForTimeout(1_000);
    await pop.screenshot({ path: path.join(ART, 'update-popup-downloading.png') });

    await push({ ...base, status: 'downloaded', percent: 100 });
    await page.locator('[data-testid="update-popup"][data-stage="ready"]').waitFor({ timeout: 5_000 });
    expect(await page.getByTestId('update-popup-title').innerText()).toBe('Update ready: v9.9.9');
    expect(await pop.getByRole('button', { name: 'Restart & update' }).count()).toBe(1);
    expect(await page.getByTestId('tb-update').innerText()).toContain('Restart to update');
    await page.waitForTimeout(1_000);
    await pop.screenshot({ path: path.join(ART, 'update-popup-ready.png') });

    // manual mode (a Mac copy run from the .dmg): a Download link to the release page
    await push({ ...base, mode: 'manual', status: 'available', releaseUrl: 'https://example.invalid/tag/v9.9.9' });
    await page.locator('[data-testid="update-popup"][data-stage="found"]').waitFor({ timeout: 5_000 });
    expect(await pop.getByRole('link', { name: 'Download' }).getAttribute('href')).toBe('https://example.invalid/tag/v9.9.9');

    // an error takes it away
    await push({ ...base, status: 'error', error: 'boom' });
    await pop.waitFor({ state: 'detached', timeout: 5_000 });
  });
});

describe('update card from the title bar', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterAll(async () => {
    for (const c of cleanup.reverse()) await c();
  });

  it('the version opens the card: Check now and its result; the first run of a new version says "Updated to" once', async () => {
    const feed = await startFeed(false);
    cleanup.push(feed.close);
    // the last run was an older version, so this run is "updated"
    const { app, page, userData, home } = await launch(
      { CLAUDE_VIS_UPDATE_URL: feed.url, CLAUDE_VIS_UPDATE_DELAY_MS: '3600000' },
      { lastRunVersion: '0.0.1', autoDownloadUpdates: false },
    );
    cleanup.push(async () => {
      await app.close();
      fs.rmSync(userData, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    });
    const pop = page.locator('[data-testid="update-popup"][data-stage="updated"]');
    await pop.waitFor({ timeout: 20_000 });
    expect(await page.getByTestId('update-popup-title').innerText()).toMatch(/^Updated to v\d+\.\d+\.\d+/);
    expect(await page.getByTestId('update-popup-line').innerText()).toBe('You were on v0.0.1.');
    expect(await page.getByTestId('update-popup-whatsnew').getAttribute('href')).toMatch(/\/tag\/v\d/);
    await page.waitForTimeout(1_000);
    await page.getByTestId('update-popup').screenshot({ path: path.join(ART, 'update-popup-updated.png') });
    await page.getByTestId('update-popup-later').click();
    await pop.waitFor({ state: 'detached', timeout: 5_000 });
    // said once: opening the window again does not repeat it
    await hideAndReshow(app);
    await page.waitForTimeout(1_000);
    expect(await page.getByTestId('update-popup').count()).toBe(0);
    // the version is saved for next time
    expect(JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).lastRunVersion).toMatch(/^\d+\.\d+\.\d+/);

    // the version in the title bar opens the status card; Check now runs a check (404 here: the reason shows)
    await page.getByTestId('tb-version').click();
    await page.locator('[data-testid="update-popup"][data-stage="status"]').waitFor({ timeout: 5_000 });
    await page.getByTestId('update-popup-check').click();
    await page.locator('[data-testid="update-popup"][data-tone="error"]').waitFor({ timeout: 20_000 });
    expect(await page.getByTestId('update-popup-line').innerText()).toMatch(/could not be found/);
    await page.waitForTimeout(800);
    await page.getByTestId('titlebar').screenshot({ path: path.join(ART, 'update-titlebar-error.png') });

    // the release goes out: the error chip opens the card, Check now finds it, and the chip turns into "Update to"
    feed.state.published = true;
    await page.getByTestId('update-popup-later').click();
    await page.getByTestId('tb-update').click();
    await page.locator('[data-testid="update-popup"][data-stage="status"]').waitFor({ timeout: 5_000 });
    await page.getByTestId('update-popup-check').click();
    await page.locator('[data-testid="update-popup"][data-stage="found"]').waitFor({ timeout: 20_000 });
    await expect.poll(async () => page.getByTestId('tb-update').innerText(), { timeout: 5_000 }).toContain('Update to v9.9.9');
    await page.waitForTimeout(800);
    await page.getByTestId('titlebar').screenshot({ path: path.join(ART, 'update-titlebar-available.png') });
  });
});
