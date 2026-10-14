// Updates: the Settings section under CLAUDE_VIS_NO_UPDATES, and the real check flow (electron-updater + a local generic feed).
// Download / install need a packaged app and a real release, so they are not exercised here (see RELEASING.md).
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type Page } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';
import { SID, writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');

async function launch(env: Record<string, string>, config?: object) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-upd-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-updhome-'));
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

async function openSettings(page: Page) {
  await page.getByRole('button', { name: /hooks/ }).click();
  await page.getByTestId('updates-settings').waitFor({ timeout: 10_000 });
}

describe('updates', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterAll(async () => {
    for (const c of cleanup.reverse()) await c();
  });

  it('settings shows the Updates section as disabled under CLAUDE_VIS_NO_UPDATES', async () => {
    const { app, page, userData, home } = await launch({ CLAUDE_VIS_NO_UPDATES: '1' });
    cleanup.push(async () => {
      await app.close();
      fs.rmSync(userData, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    });
    await openSettings(page);
    const s = page.getByTestId('updates-settings');
    expect(await s.innerText()).toContain('Updates');
    expect(await page.getByTestId('update-status').getAttribute('data-status')).toBe('disabled');
    expect(await page.getByTestId('update-current').innerText()).toMatch(/^\d+\.\d+\.\d+/);
    expect(await page.getByTestId('update-line').innerText()).toContain('CLAUDE_VIS_NO_UPDATES');
    expect(await page.getByRole('button', { name: 'Check now' }).isDisabled()).toBe(true);
    expect(await page.getByTestId('update-pill').count()).toBe(0);
  });

  it('the real check flow reaches "available" against a local update feed', async () => {
    const requested: string[] = [];
    const feed = http.createServer((req, res) => {
      requested.push(req.url ?? '');
      if ((req.url ?? '').split('?')[0].endsWith('.yml')) {
        res.writeHead(200, { 'content-type': 'text/yaml' });
        res.end(
          [
            'version: 9.9.9',
            'files:',
            '  - url: Claude-Visualized-Setup-9.9.9.exe',
            `    sha512: ${Buffer.alloc(64, 1).toString('base64')}`,
            '    size: 1024',
            'path: Claude-Visualized-Setup-9.9.9.exe',
            `sha512: ${Buffer.alloc(64, 1).toString('base64')}`,
            "releaseDate: '2026-01-01T00:00:00.000Z'",
            'releaseNotes: "<p>Fake release</p><ul><li>Faster things</li></ul>"',
            '',
          ].join('\n'),
        );
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => feed.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise<void>((r) => feed.close(() => r())));
    const url = `http://127.0.0.1:${(feed.address() as AddressInfo).port}/`;

    // auto-download off, so the flow stops at "available" instead of trying to fetch the fake installer
    const { app, page, userData, home } = await launch({ CLAUDE_VIS_UPDATE_URL: url, CLAUDE_VIS_UPDATE_DELAY_MS: '3600000' }, { autoDownloadUpdates: false });
    cleanup.push(async () => {
      await app.close();
      fs.rmSync(userData, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    });
    await openSettings(page);
    expect(await page.getByTestId('update-status').getAttribute('data-status')).toBe('idle');
    await page.getByRole('button', { name: 'Check now' }).click();
    await page.locator('[data-testid="update-status"][data-status="available"]').waitFor({ timeout: 20_000 });
    expect(await page.getByTestId('update-line').innerText()).toContain('9.9.9');
    expect(await page.getByTestId('update-notes').innerText()).toContain('Faster things');
    expect(await page.getByRole('button', { name: 'Download v9.9.9' }).count()).toBe(1);
    expect(requested.some((u) => u.includes('.yml'))).toBe(true);
    expect(await page.getByLabel(/Automatically download updates/).isChecked()).toBe(false);
  });

  it('a feed with no releases (404) is a calm "no releases" state, not an error', async () => {
    const feed = http.createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((r) => feed.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise<void>((r) => feed.close(() => r())));
    const url = `http://127.0.0.1:${(feed.address() as AddressInfo).port}/`;
    const { app, page, userData, home } = await launch({ CLAUDE_VIS_UPDATE_URL: url, CLAUDE_VIS_UPDATE_DELAY_MS: '3600000' });
    cleanup.push(async () => {
      await app.close();
      fs.rmSync(userData, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    });
    await openSettings(page);
    await page.getByRole('button', { name: 'Check now' }).click();
    await page.getByText('No releases published yet.').waitFor({ timeout: 20_000 });
    expect(await page.getByTestId('update-status').getAttribute('data-status')).toBe('idle');
  });
});
