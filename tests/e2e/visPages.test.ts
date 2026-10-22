// Visual check for the Inbox and History pages: opens both against fixture data, asserts the glass cards and
// stat tiles render, and saves screenshots to tests/e2e/artifacts for a human look.
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

const freshLine = (sid: string) => JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: sid, timestamp: new Date().toISOString() }) + '\n';

describe('inbox and history pages (visual)', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;
  const post = (body: object) => fetch(`http://127.0.0.1:${PORT}/hook?src=claude-visualized`, { method: 'POST', body: JSON.stringify(body) });

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-vis-home-'));
    writeFixture(home);
    writeSecondFixture(home);
    fs.appendFileSync(path.join(home, 'projects', 'C--demo-app', `${SID}.jsonl`), freshLine(SID));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-vis-ud-'));
    app = await electron.launch({
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
        CLAUDE_VIS_NO_UPDATES: '1',
        CLAUDE_VIS_DESKTOP_DIR: path.join(userData, 'no-desktop'),
        CLAUDE_VIS_HOME: home,
      } as Record<string, string>,
    });
    page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('shows the inbox empty state, then glass items with a kind-coloured edge', async () => {
    await page.getByText('Retry + docs').first().waitFor({ timeout: 20_000 });
    await page.getByTestId('nav-inbox').click();
    await page.getByTestId('inbox-empty').waitFor();
    expect(await page.getByTestId('inbox-empty').innerText()).toContain('All clear');
    await page.screenshot({ path: path.join(ART, 'vis-pages-inbox-empty.png') });

    // one attention item per session: a later event in the same session replaces the earlier one
    await post({ session_id: SID, hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
    const perm = page.locator('[data-testid="inbox-item"][data-kind="permission"]');
    await perm.waitFor({ timeout: 10_000 });
    expect(await perm.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe('3px');
    expect(await perm.evaluate((el) => getComputedStyle(el).borderLeftColor)).not.toBe('rgba(0, 0, 0, 0)');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(ART, 'vis-pages-inbox.png') });

    await post({ session_id: SID, hook_event_name: 'Notification', message: 'Claude needs your input' });
    await page.locator('[data-testid="inbox-item"][data-kind="input"]').waitFor({ timeout: 10_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(ART, 'vis-pages-inbox-input.png') });
  });

  it('renders history with glass stat tiles, charts and highlighted search results', async () => {
    await page.getByTestId('nav-history').click();
    await page.getByTestId('history-page').waitFor();
    await page.locator('[data-testid="history-status"][data-state="idle"]').waitFor({ timeout: 30_000 });
    await page.getByTestId('range-all').click();
    await page.locator('[data-kpi="sessions"] .hist-kpi-value', { hasText: '2' }).waitFor({ timeout: 10_000 });
    expect(await page.getByTestId('history-kpi').count()).toBe(5);
    await page.getByTestId('history-chart').waitFor();
    // let the draw-in finish before the screenshot
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(ART, 'vis-pages-history.png') });

    await page.getByTestId('history-search').click();
    await page.getByTestId('history-search').fill('retry');
    await page.getByTestId('history-hit').first().waitFor({ timeout: 10_000 });
    expect(await page.locator('[data-testid="history-hit"] mark').count()).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(ART, 'vis-pages-history-search.png') });
  });
});
