// End-to-end: a fresh install with no Claude Code transcripts shows the friendly empty state in the
// session list and in the main view. Run `npm run build` first (test:e2e does it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 47899);

async function launch(env: Record<string, string>, existingUserData?: string) {
  const userData = existingUserData ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-ud-'));
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
      CLAUDE_VIS_NO_UPDATES: '1',
      CLAUDE_VIS_DESKTOP_DIR: path.join(userData, 'no-desktop'),
      ...env,
    } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
  return { app, page, userData };
}

describe('empty state (fresh install, no transcripts)', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-empty-home-'));
    ({ app, page, userData } = await launch({ CLAUDE_VIS_HOME: home }));
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('shows the glass card in the main view and in the session list', async () => {
    const main = page.getByTestId('empty-state');
    await main.waitFor({ timeout: 20_000 });
    expect(await main.innerText()).toContain('No Claude Code sessions yet');
    expect(await main.innerText()).toContain('claude');
    expect(await main.getByRole('button', { name: 'open the welcome guide' }).count()).toBe(1);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(ART, 'empty-main.png') });

    const list = page.getByTestId('sessions-empty');
    await list.waitFor({ timeout: 10_000 });
    expect(await list.innerText()).toContain('No Claude Code sessions yet');
    expect(await page.locator('.session-row').count()).toBe(0);
    await list.screenshot({ path: path.join(ART, 'empty-sidebar.png') });
  });

  it('keeps the recent group out of the way while the list is empty', async () => {
    expect(await page.locator('.group-label', { hasText: 'recent' }).count()).toBe(0);
    expect(await page.getByText('nothing yet').count()).toBe(0);
  });
});
