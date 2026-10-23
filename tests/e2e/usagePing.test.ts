// End-to-end: the usage ping (POST /v1/messages, unified rate-limit headers) against a fake server (CLAUDE_VIS_PING_URL), with every interval shrunk 20x
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

describe('usage ping (fake messages server)', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;
  let server: http.Server;
  const hits: { at: number; status: number }[] = [];
  let limitNext = false;
  let util = 28;
  const models: string[] = [];

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
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.method !== 'POST' || req.headers.authorization !== 'Bearer fake-access-token') {
          res.writeHead(401).end();
          return;
        }
        models.push(JSON.parse(body).model);
        if (limitNext) {
          limitNext = false;
          hits.push({ at: Date.now(), status: 429 });
          res.writeHead(429, { 'retry-after': '2' }).end('{}');
          return;
        }
        util += 1;
        hits.push({ at: Date.now(), status: 200 });
        res.writeHead(200, {
          'content-type': 'application/json',
          'anthropic-ratelimit-unified-5h-utilization': String(util / 100),
          'anthropic-ratelimit-unified-5h-reset': String(Math.floor(RESET / 1000)),
          'anthropic-ratelimit-unified-5h-status': 'allowed',
          'anthropic-ratelimit-unified-7d-utilization': '0.05',
          'anthropic-ratelimit-unified-7d-reset': String(Math.floor(RESET / 1000) + 86400),
          'anthropic-ratelimit-unified-7d-status': 'allowed',
        });
        res.end(JSON.stringify({ model: 'claude-haiku-5-5', usage: { input_tokens: 40, output_tokens: 1 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`;

    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-usage-home-'));
    writeFixture(home);
    fs.writeFileSync(
      path.join(home, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token', expiresAt: Date.now() + 8 * 3600_000 } }),
    );
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-usage-ud-'));
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
        CLAUDE_VIS_PING_URL: url,
        CLAUDE_VIS_USAGE_URL: 'http://127.0.0.1:1/never', // the secondary usage endpoint fails; its errors must stay hidden while pings are fresh
        CLAUDE_VIS_USAGE_TIME_SCALE: '0.02',
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

  // keeps the app "active" (status-line posts count as session activity)
  let busy: ReturnType<typeof setInterval> | null = null;
  const work = () => {
    const post = () => void fetch(`http://127.0.0.1:${PORT}/statusline`, { method: 'POST', body: JSON.stringify({ model: { id: 'x' } }) }).catch(() => {});
    post();
    busy = setInterval(post, 1_500);
  };
  afterAll(() => {
    if (busy) clearInterval(busy);
  });

  it('does not ping while no session is active', async () => {
    await sleep(4_000);
    expect(hits.length).toBe(0);
  });

  it('pings as soon as a session is active, with a Haiku model, and the meter shows the exact figure (no ~)', async () => {
    work();
    await until(() => hits.length >= 1);
    expect(models.every((m) => /haiku/i.test(m))).toBe(true);
    await expect.poll(async () => meter().innerText(), { timeout: 10_000 }).toBe('29%');
    await page.locator('[data-tour="usage"] .meter').first().hover();
    expect(await page.locator('[data-tour="usage"] .meter').first().getAttribute('data-src')).toBe('ping');
    expect(await page.locator('[data-tour="usage"] .meter').first().locator('.m-pop-h em').innerText()).toBe('exact (ping)');
    expect(await page.locator('[data-tour="usage"]').innerText()).not.toMatch(/problem|login needed/i);
  });

  it('pings again only after the interval (10 min x 0.02 = 12 s) and the figure updates; a 429 is waited out', async () => {
    const first = hits[0].at;
    await until(() => hits.length >= 2, 30_000);
    expect(hits[1].at - first).toBeGreaterThanOrEqual(11_000);
    await expect.poll(async () => meter().innerText(), { timeout: 8_000 }).toBe(`${util}%`);
    limitNext = true;
    await until(() => hits.some((h) => h.status === 429), 40_000);
    const limited = hits.find((h) => h.status === 429)!;
    const idx = hits.indexOf(limited);
    await until(() => hits.length > idx + 1, 40_000);
    expect(hits[idx + 1].at - limited.at).toBeGreaterThanOrEqual(2_000);
    // the last good number stayed through the 429
    await expect.poll(async () => meter().innerText(), { timeout: 5_000 }).toMatch(/%$/);
  });

  it('Settings shows what the pings cost, and the counter resets', async () => {
    await page.locator('[data-tour="hooks"]').click();
    const all = page.getByTestId('ping-cost-all');
    await all.waitFor({ timeout: 10_000 });
    const n = hits.filter((h) => h.status === 200).length;
    await expect.poll(async () => all.innerText(), { timeout: 8_000 }).toContain(`${n} pings, ${n * 40} in / ${n} out tokens, est. $`);
    await page.getByTestId('ping-cost-reset').click();
    await expect.poll(async () => all.innerText(), { timeout: 8_000 }).toContain('0 pings');
  });
});
