// Visual check of the command deck (title bar, usage gauges, status strip) in a few states; screenshots go to tests/e2e/artifacts/vis-chrome-*.png.
// Windows stay off-screen (vitest.e2e.config.ts). Run `npx electron-vite build` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT, SID, writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 47899);
const post = (url: string, body: object) => fetch(`http://127.0.0.1:${PORT}${url}`, { method: 'POST', body: JSON.stringify(body) });
const usage = (five: number, week: number) => {
  const resets = Math.floor(Date.now() / 1000) + 2 * 3600 + 14 * 60;
  return post('/statusline', { session_id: SID, rate_limits: { five_hour: { used_percentage: five, resets_at: resets }, seven_day: { used_percentage: week, resets_at: resets + 3 * 86400 } } });
};

describe('command deck visuals (fixture data)', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-chrome-home-'));
    writeFixture(home);
    fs.appendFileSync(path.join(home, 'projects', PROJECT, `${SID}.jsonl`), JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: SID, timestamp: new Date().toISOString() }) + '\n');
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-chrome-ud-'));
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
    await page.locator('[data-agent="a1"]').waitFor({ timeout: 20_000 });
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  const shoot = async (name: string) => {
    await page.screenshot({ path: path.join(ART, `vis-chrome-${name}-top.png`), clip: { x: 0, y: 0, width: 1440, height: 90 } });
    await page.screenshot({ path: path.join(ART, `vis-chrome-${name}-bottom.png`), clip: { x: 0, y: 880, width: 1440, height: 40 } });
  };

  it('renders calm, warning and critical gauges, the live heartbeat and the status strip', async () => {
    await usage(24, 61);
    await page.locator('.titlebar .meter.ok .m-pct', { hasText: '24%' }).waitFor({ timeout: 5000 });
    await page.locator('.titlebar .meter.warn .m-pct', { hasText: '61%' }).waitFor({ timeout: 5000 });
    expect(await page.getByTestId('statusbar').innerText()).toContain('tokens');
    await page.waitForTimeout(1500);
    await shoot('calm');

    await usage(92, 87);
    await page.locator('.titlebar .meter.hot .m-pct', { hasText: '92%' }).waitFor({ timeout: 5000 });
    await post('/hook?src=claude-visualized', { session_id: SID, hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
    await page.locator('[data-agent="main"].waiting').waitFor({ timeout: 5000 });
    await page.waitForTimeout(700);
    await shoot('hot');

    await page.locator('.titlebar .meter').first().hover();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(ART, 'vis-chrome-hover-top.png'), clip: { x: 0, y: 0, width: 1440, height: 220 } });
    expect(await page.locator('.titlebar .meter').first().locator('.m-pop').innerText()).toContain('live from a terminal session');
    expect(await page.getByTestId('tb-live').count()).toBe(1);
  });
});
