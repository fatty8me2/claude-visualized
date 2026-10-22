// Screenshots of the agent detail drawer (running, finished, failed agent) and the context menu, for judging the dossier look by eye
// (tests/e2e/artifacts/vis-drawer-*.png). Windows stay off-screen (vitest.e2e.config.ts). Run `npx electron-vite build` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT, SID, writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 47899);
const hook = (body: object) => fetch(`http://127.0.0.1:${PORT}/hook?src=claude-visualized`, { method: 'POST', body: JSON.stringify(body) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** a main-transcript tail with a sub-agent whose launch failed, stamped "now" so the session stays fresh */
function failedAgentLines(): string {
  const base = { sessionId: SID, cwd: 'C:\\demo\\app', version: '2.1.295', entrypoint: 'cli', gitBranch: 'main', userType: 'external', isSidechain: false };
  const ts = () => new Date().toISOString();
  const lines = [
    {
      ...base,
      type: 'assistant',
      timestamp: ts(),
      message: {
        id: 'msg_fail',
        model: 'claude-opus-5-5',
        role: 'assistant',
        stop_reason: null,
        usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 },
        content: [{ type: 'tool_use', id: 'toolu_E1', name: 'Agent', input: { description: 'fix lint errors', subagent_type: 'general-purpose', prompt: 'Fix every lint error in src/ and re-run the linter until it is clean.' } }],
      },
    },
    {
      ...base,
      type: 'user',
      timestamp: ts(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_E1', content: 'agent crashed', is_error: true }] },
      toolUseResult: { status: 'failed', agentId: 'a9', description: 'fix lint errors', resolvedModel: 'claude-sonnet-5-5' },
    },
    { type: 'system', subtype: 'turn_duration', sessionId: SID, timestamp: ts() },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('agent drawer visuals (fixture data)', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;

  const shot = async (name: string) => {
    await sleep(500);
    await page.screenshot({ path: path.join(ART, name) });
    const box = await page.getByTestId('drawer').boundingBox();
    if (box) await page.screenshot({ path: path.join(ART, name.replace('.png', '-crop.png')), clip: { x: box.x - 10, y: box.y - 10, width: box.width + 20, height: box.height + 20 } });
  };

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-drawer-home-'));
    writeFixture(home);
    fs.appendFileSync(path.join(home, 'projects', PROJECT, `${SID}.jsonl`), failedAgentLines());
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-drawer-ud-'));
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
        CLAUDE_VIS_BACKGROUND_WINDOWS: '1',
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

  it('shows a running agent as a live dossier', async () => {
    await hook({ session_id: SID, hook_event_name: 'PreToolUse', tool_use_id: 'toolu_r1', tool_name: 'Edit', tool_input: { file_path: 'C:\\demo\\app\\src\\client.ts' } });
    await hook({ session_id: SID, hook_event_name: 'PreToolUse', tool_use_id: 'toolu_f1', tool_name: 'Bash', tool_input: { command: 'npm run lint' } });
    await hook({ session_id: SID, hook_event_name: 'PostToolUseFailure', tool_use_id: 'toolu_f1', tool_name: 'Bash', error: 'exit code 1: ENOENT lint config' });
    await hook({ session_id: SID, hook_event_name: 'PreToolUse', tool_use_id: 'toolu_r2', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    await page.locator('[data-agent="main"]').click();
    const drawer = page.getByTestId('drawer');
    await drawer.waitFor();
    await page.getByTestId('tool-error').waitFor({ timeout: 10_000 });
    expect(await drawer.locator('.d-tile').count()).toBeGreaterThanOrEqual(2);
    expect(await drawer.locator('.d-orbit').count()).toBe(1);
    await shot('vis-drawer-running.png');
    await drawer.locator('.d-scroll').evaluate((el) => el.scrollTo(0, 560));
    await shot('vis-drawer-running-stream.png');
  });

  it('shows a finished agent', async () => {
    await page.keyboard.press('Escape');
    await page.locator('[data-agent="a1"]').click();
    await page.locator('.drawer .hd b').first().waitFor();
    expect(await page.getByTestId('drawer-now').innerText()).toContain('finished');
    await shot('vis-drawer-done.png');
  });

  it('shows a failed agent', async () => {
    const card = page.locator('[data-agent="a9"]');
    await card.waitFor({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await card.click();
    await page.locator('.drawer.d-error').waitFor();
    await shot('vis-drawer-error.png');
  });

  it('shows the context menu', async () => {
    await page.keyboard.press('Escape');
    const row = page.locator(`[data-session="${SID}"]`);
    await row.waitFor();
    await row.click({ button: 'right' });
    await page.getByTestId('context-menu').waitFor();
    await page.keyboard.press('ArrowDown');
    await sleep(300);
    const box = (await page.getByTestId('context-menu').boundingBox())!;
    await page.screenshot({ path: path.join(ART, 'vis-drawer-menu.png'), clip: { x: Math.max(0, box.x - 40), y: Math.max(0, box.y - 40), width: box.width + 80, height: box.height + 80 } });
    await page.keyboard.press('Escape');
  });
});
