// Visual pass over the left mode panel and plan rail: screenshots in plan mode, build mode and with a nearly full context.
// Run `npx electron-vite build` first. Windows stay off-screen (vitest.e2e.config.ts). Screenshots land in tests/e2e/artifacts (gitignored).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT, SID, writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 47899);

describe('mode panel visuals', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;
  const shoot = async (name: string) => {
    await page.waitForTimeout(1300);
    await page.locator('.modepanel').screenshot({ path: path.join(ART, `vis-mode-${name}.png`) });
    await page.screenshot({ path: path.join(ART, `vis-mode-${name}-full.png`) });
  };

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-vm-home-'));
    writeFixture(home);
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-vm-ud-'));
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
    await page.setViewportSize({ width: 1440, height: 1500 }).catch(() => {});
    await page.locator('[data-agent="a1"]').waitFor({ timeout: 20_000 });
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('plan mode: badge, circuit checklist, gauge, insights', async () => {
    expect(await page.locator('.modebox.plan').count()).toBe(1);
    expect(await page.getByTestId('ctx-gauge').count()).toBe(1);
    await shoot('plan');
    const rail = page.getByTestId('plan-rail');
    if (await rail.count()) await rail.screenshot({ path: path.join(ART, 'vis-mode-rail.png') });
  });

  it('build mode: the badge flips', async () => {
    await fetch(`http://127.0.0.1:${PORT}/hook?src=claude-visualized`, {
      method: 'POST',
      body: JSON.stringify({
        session_id: SID,
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_use_id: 'toolu_vm1',
        tool_input: { file_path: 'C:\\demo\\app\\README.md' },
        permission_mode: 'acceptEdits',
      }),
    });
    await page.locator('.modebox.build').waitFor({ timeout: 5000 });
    await page.waitForTimeout(250);
    await page.locator('.modebox').screenshot({ path: path.join(ART, 'vis-mode-flip-mid.png') });
    await shoot('build');
  });

  it('high context: the gauge turns hot', async () => {
    const line = {
      type: 'assistant',
      isSidechain: false,
      effort: 'high',
      message: {
        id: 'msg_hot',
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'working' }],
        stop_reason: null,
        usage: { input_tokens: 5000, output_tokens: 900, cache_read_input_tokens: 176000, cache_creation_input_tokens: 4000 },
      },
      sessionId: SID,
      cwd: 'C:\\demo\\app',
      version: '2.1.295',
      entrypoint: 'cli',
      gitBranch: 'main',
      timestamp: new Date().toISOString(),
      userType: 'external',
    };
    fs.appendFileSync(path.join(home, 'projects', PROJECT, `${SID}.jsonl`), JSON.stringify(line) + '\n');
    await page.locator('.ctxgauge.hot').waitFor({ timeout: 15_000 });
    await shoot('hot');
  });
});
