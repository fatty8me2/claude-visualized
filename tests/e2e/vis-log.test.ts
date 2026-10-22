// Visual check of the session log and timeline: stream, fresh-line animation, error accent, hover card, heat strip.
// Screenshots go to tests/e2e/artifacts/vis-log-*.png.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SID, writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 47899) + 6;
const ts = () => new Date().toISOString();

describe('session log + timeline visuals (fixture data)', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;
  let main: string;

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-lghome-'));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-lgud-'));
    writeFixture(home);
    main = path.join(home, 'projects', 'C--demo-app', `${SID}.jsonl`);
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
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1800, 1000));
    await page.setViewportSize({ width: 1800, height: 1000 }).catch(() => {});
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('renders the log stream and timeline', async () => {
    await page.locator('[data-agent="a1"]').waitFor({ timeout: 20_000 });
    const log = page.locator('.log').first();
    await log.waitFor();
    await page.waitForTimeout(1200);
    await log.screenshot({ path: path.join(ART, 'vis-log-idle.png') });

    // a burst of new lines: a long failing tool call, then a read
    const line = (id: string, name: string, input: unknown) =>
      JSON.stringify({
        type: 'assistant',
        isSidechain: false,
        sessionId: SID,
        timestamp: ts(),
        message: { id: `m${id}`, model: 'claude-opus-4-5', content: [{ type: 'tool_use', id: `toolu_${id}`, name, input }] },
      }) + '\n';
    fs.appendFileSync(main, line('x1', 'Bash', { command: 'npm run build && node scripts/with-a-very-long-command-line-that-needs-the-hover-card --flag-one --flag-two --flag-three' }));
    fs.appendFileSync(
      main,
      JSON.stringify({
        type: 'user',
        isSidechain: false,
        sessionId: SID,
        timestamp: ts(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x1', is_error: true, content: 'boom' }] },
      }) + '\n',
    );
    fs.appendFileSync(main, line('x2', 'Read', { file_path: 'C:/demo/app/src/index.ts' }));
    await page.locator('.log-row.fresh').first().waitFor({ timeout: 8000 });
    await page.waitForTimeout(250);
    await log.screenshot({ path: path.join(ART, 'vis-log-fresh.png') });

    // the fixture has no long lines: promote a row the way the component would, to see the hover card
    await page.evaluate(() => {
      const el = document.querySelectorAll('.log-row')[6] as HTMLElement | undefined;
      el?.classList.add('long');
      el?.setAttribute('data-full', 'npm run build && node scripts/with-a-very-long-command-line-that-needs-the-hover-card --flag-one --flag-two --flag-three --and-more-flags-so-it-wraps-onto-a-second-line');
    });
    await page.locator('.log-row.long').first().hover();
    await page.waitForTimeout(900);
    await log.screenshot({ path: path.join(ART, 'vis-log-hover.png') });

    await page.locator('.graph-views button', { hasText: 'timeline' }).click();
    await page.getByTestId('timeline').waitFor();
    await page.waitForTimeout(600);
    expect(await page.getByTestId('tl-heat').count()).toBe(1);
    await page.getByTestId('timeline').screenshot({ path: path.join(ART, 'vis-log-timeline.png') });
  });
});
