// End-to-end: the real usage poller against a fake usage server (CLAUDE_VIS_USAGE_URL), with every interval shrunk 20x
// (CLAUDE_VIS_USAGE_TIME_SCALE=0.05: active 3 s, idle 15 s, minimum gap 0.75 s). Checks the active cadence, that a status-line
// reading shows at once, that a 429 with Retry-After is honoured, and that the renderer's meter text follows. Run `npx electron-vite build` first.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_PORT ?? 47899);
const RESET = Date.now() + 3 * 3600_000;

describe('usage poller (fake usage server)', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;
  let server: http.Server;
  const hits: { at: number; status: number }[] = [];
  let limitNext = false;
  let util = 10;

  const meter = () => page.locator('[data-tour="usage"] .meter').first().locator('.m-pct');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (f: () => boolean, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!f()) {
      if (Date.now() > end) throw new Error('timed out');
      await sleep(100);
    }
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer fake-access-token') {
        res.writeHead(401).end();
        return;
      }
      if (limitNext) {
        limitNext = false;
        hits.push({ at: Date.now(), status: 429 });
        res.writeHead(429, { 'retry-after': '2' }).end('{}');
        return;
      }
      util += 1;
      hits.push({ at: Date.now(), status: 200 });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ five_hour: { utilization: util, resets_at: new Date(RESET).toISOString() }, seven_day: { utilization: 5, resets_at: new Date(RESET + 86400_000).toISOString() } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/oauth/usage`;

    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-usage-home-'));
    writeFixture(home);
    fs.writeFileSync(
      path.join(home, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token', expiresAt: Date.now() + 8 * 3600_000 } }),
    );
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-usage-ud-'));
    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ usagePing: false })); // this file tests the old usage-endpoint poller
    app = await electron.launch({
      args: [ROOT],
      cwd: ROOT,
      env: {
        ...process.env,
        CLAUDE_VIS_USER_DATA: userData,
        CLAUDE_VIS_HOME: home,
        CLAUDE_VIS_PORT: String(PORT),
        CLAUDE_VIS_NO_EXTERNAL: '1',
        CLAUDE_VIS_NO_SYSTEM_INTEGRATION: '1',
        CLAUDE_VIS_NO_USAGE_API: '',
        CLAUDE_VIS_USAGE_URL: url,
        CLAUDE_VIS_USAGE_TIME_SCALE: '0.05',
        CLAUDE_VIS_OAUTH_TOKEN_URL: 'http://127.0.0.1:1/never',
        CLAUDE_VIS_SKIP_ONBOARDING: '1',
        CLAUDE_VIS_NO_UPDATES: '1',
        CLAUDE_VIS_NO_DISCOVERY: '1',
        CLAUDE_VIS_BACKGROUND_WINDOWS: '1',
        CLAUDE_VIS_DESKTOP_DIR: path.join(userData, 'no-desktop'),
      } as Record<string, string>,
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((r) => server?.close(r));
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('reads once at startup and the meter shows it', async () => {
    await until(() => hits.length >= 1);
    await expect.poll(async () => meter().innerText(), { timeout: 10_000 }).toBe('11%');
  });

  it('switches to the active cadence once the app sees activity, and the meter text follows each reading', async () => {
    const before = hits.length;
    await fetch(`http://127.0.0.1:${PORT}/statusline`, { method: 'POST', body: JSON.stringify({ model: { id: 'x' } }) });
    await until(() => hits.length >= before + 4, 40_000);
    const mine = hits.slice(before - 1, before + 4).map((h) => h.at);
    const gaps = mine.slice(1).map((t, i) => t - mine[i]);
    // idle would be 15 s apart; active is 3 s (+0-10% jitter); the first one waits for the 0.75 s minimum gap
    for (const g of gaps) expect(g).toBeLessThan(5_000);
    expect(gaps.slice(1).every((g) => g >= 2_500)).toBe(true);
    await expect.poll(async () => meter().innerText(), { timeout: 8_000 }).toBe(`${util}%`);
  });

  it('shows a status-line reading immediately, without waiting for a poll', async () => {
    const n = hits.length;
    await fetch(`http://127.0.0.1:${PORT}/statusline`, {
      method: 'POST',
      body: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 77, resets_at: Math.floor(RESET / 1000) } } }),
    });
    await expect.poll(async () => meter().innerText(), { timeout: 1_500 }).toBe('77%');
    expect(hits.length).toBe(n);
  });

  it('honours a 429 Retry-After: no request until it has passed, then polling resumes', async () => {
    limitNext = true;
    await until(() => hits.some((h) => h.status === 429), 15_000);
    const limited = hits.find((h) => h.status === 429)!;
    const idx = hits.indexOf(limited);
    await until(() => hits.length > idx + 1, 30_000);
    expect(hits[idx + 1].at - limited.at).toBeGreaterThanOrEqual(2_000);
    expect(hits[idx + 1].status).toBe(200);
    // the last good number stayed on screen through the 429
    await expect.poll(async () => meter().innerText(), { timeout: 5_000 }).toMatch(/%$/);
  });
});
