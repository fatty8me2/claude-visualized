// End-to-end: the live estimate between readings. A fake usage server answers slowly (time scale 1: idle 5 min, active 60 s); transcript
// lines with token usage are appended to a watched session and the meter must advance (with a ~ prefix) within ~2 s, then snap to the
// next real reading. Run `npx electron-vite build` first.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT, SID, writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_PORT ?? 47899);
const RESET = Date.now() + 3 * 3600_000;

describe('live usage estimate (fake usage server)', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;
  let server: http.Server;
  let util = 10;
  let hits = 0;

  const pct = () => page.locator('[data-tour="usage"] .meter').first().locator('.m-pct');
  const num = async () => Number((await pct().innerText()).replace(/[^0-9.]/g, ''));

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer fake-access-token') {
        res.writeHead(401).end();
        return;
      }
      hits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ five_hour: { utilization: util, resets_at: new Date(RESET).toISOString() }, seven_day: { utilization: 5, resets_at: new Date(RESET + 86400_000).toISOString() } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/oauth/usage`;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-live-home-'));
    writeFixture(home);
    fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token', expiresAt: Date.now() + 8 * 3600_000 } }));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-live-ud-'));
    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ usagePing: false })); // this file tests the usage-endpoint poller
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
        // 0.2: debounce after a burst 1.4 s, minimum gap 3 s, active 12 s
        CLAUDE_VIS_USAGE_TIME_SCALE: '0.2',
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

  it('advances within ~2 s of new transcript tokens (marked ~), then snaps to the next reading', async () => {
    await expect.poll(async () => pct().innerText(), { timeout: 15_000 }).toBe('10%');
    // let the startup grace (10 s, scaled by nothing) and the first backlog settle, so appended lines are "live"
    await new Promise((r) => setTimeout(r, 11_000));
    const hitsBefore = hits;
    const file = path.join(home, 'projects', PROJECT, `${SID}.jsonl`);
    const line = {
      type: 'assistant',
      isSidechain: false,
      sessionId: SID,
      cwd: 'C:/demo/app',
      version: '2.1.295',
      timestamp: new Date().toISOString(),
      message: {
        id: 'msg_live_1',
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'working' }],
        stop_reason: null,
        // 600k input tokens = 2.4 USD at list price: about +4.8 points at the default rate
        usage: { input_tokens: 600_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    };
    const t0 = Date.now();
    fs.appendFileSync(file, JSON.stringify(line) + '\n');
    await expect.poll(async () => pct().innerText(), { timeout: 2_500 }).toMatch(/^~\d+%$/);
    expect(Date.now() - t0).toBeLessThan(2_600);
    const est = await num();
    expect(est).toBeGreaterThan(10);
    expect(est).toBeLessThan(30);
    // the debounced read after the burst still says 10 (the API lags): the estimate keeps the fresh tokens instead of falling back
    await expect.poll(() => hits, { timeout: 8_000 }).toBeGreaterThan(hitsBefore); // the burst read (may already have happened)
    await new Promise((r) => setTimeout(r, 500));
    expect(await num()).toBeGreaterThan(10);
    // the next real reading (30) replaces the estimate (about 15)
    util = 30;
    await expect.poll(async () => pct().innerText(), { timeout: 50_000 }).toBe('30%');
  });
});
