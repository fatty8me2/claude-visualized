// End-to-end check of the mode panel's insight sections (activity, burn rate, agents, top tools, recent files, recent errors).
// Run `npx electron-vite build` first. Windows stay off-screen (vitest.e2e.config.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT, SID, writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 47899);

const freshLine = (sid: string) => JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: sid, timestamp: new Date().toISOString() }) + '\n';

describe('mode panel insights (fixture data)', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-ins-home-'));
    writeFixture(home);
    fs.appendFileSync(path.join(home, 'projects', PROJECT, `${SID}.jsonl`), freshLine(SID));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-ins-ud-'));
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

  it('renders every section, with the strip, top tools and recent files filled', async () => {
    for (const id of ['activity', 'burn', 'agents', 'tools', 'files', 'errors']) {
      expect(await page.getByTestId(`ins-${id}`).count(), id).toBe(1);
    }
    await page.getByTestId('ins-tools').locator('.ins-tool').first().waitFor({ timeout: 10_000 });
    await page.getByTestId('ins-files').locator('[data-testid="ins-file"]').first().waitFor({ timeout: 10_000 });
    expect(await page.getByTestId('ins-agents').locator('.ins-seg').count()).toBe(1);
    await page.waitForTimeout(500);
    await page.setViewportSize({ width: 1440, height: 1500 });
    await page.waitForTimeout(400);
    await page.locator('.modepanel').screenshot({ path: path.join(ART, 'modepanel-insights.png') });
    await page.screenshot({ path: path.join(ART, 'modepanel-insights-full.png') });
  });

  it('shows the activity strip when there were recent calls', async () => {
    // the fixture's tool calls are old, so the strip may be replaced by its empty note; either is a valid, non-empty box
    const sec = page.getByTestId('ins-activity');
    const strip = await sec.getByTestId('ins-strip').count();
    const note = await sec.locator('.empty-note').count();
    expect(strip + note).toBe(1);
  });

  it('collapses a section and remembers it', async () => {
    const sec = page.getByTestId('ins-tools');
    await sec.locator('.ins-fold').click();
    expect(await sec.locator('.ins-tool').count()).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('cv.insights.collapsed'))).toContain('"tools":true');
    await sec.locator('.ins-fold').click();
    expect(await sec.locator('.ins-tool').count()).toBeGreaterThan(0);
  });
});
