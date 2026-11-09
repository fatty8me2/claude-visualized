// The time estimates in the app: the prompt's progress strip, the agent cards and drawer, the overview line, and the strip
// following commit -> push -> release -> publish as hooks report them. Fixed priors (CLAUDE_VIS_ETA_PRIORS) keep the
// numbers independent of the fixture history. Screenshots -> tests/e2e/artifacts/eta-*.png.
// Windows stay off-screen (vitest.e2e.config.ts). Run `npx electron-vite build` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ETA_SID, etaFixturePriors, writeEtaFixture } from '../fixtures/eta';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 48460);

describe('time estimates', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;
  const shot = (name: string, el?: string) =>
    el
      ? page
          .locator(el)
          .first()
          .screenshot({ path: path.join(ART, `eta-${name}.png`) })
      : page.screenshot({ path: path.join(ART, `eta-${name}.png`) });
  const hook = (body: Record<string, unknown>) =>
    fetch(`http://127.0.0.1:${PORT}/hook?src=claude-visualized`, { method: 'POST', body: JSON.stringify({ session_id: ETA_SID, ...body }) });
  const bash = async (id: string, command: string, end = true) => {
    await hook({ hook_event_name: 'PreToolUse', tool_use_id: id, tool_name: 'Bash', tool_input: { command } });
    if (end) await hook({ hook_event_name: 'PostToolUse', tool_use_id: id, tool_name: 'Bash' });
  };

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-eta-home-'));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-eta-ud-'));
    const now = Date.now();
    writeEtaFixture(home, now);
    const priorsFile = path.join(userData, 'eta-priors.json');
    fs.writeFileSync(priorsFile, JSON.stringify(etaFixturePriors(now)));
    app = await electron.launch({
      args: [ROOT],
      cwd: ROOT,
      env: {
        ...process.env,
        CLAUDE_VIS_HOME: home,
        CLAUDE_VIS_USER_DATA: userData,
        CLAUDE_VIS_PORT: String(PORT),
        CLAUDE_VIS_ETA_PRIORS: priorsFile,
        CLAUDE_VIS_NO_EXTERNAL: '1',
        CLAUDE_VIS_NO_SYSTEM_INTEGRATION: '1',
        CLAUDE_VIS_NO_USAGE_API: '1',
        CLAUDE_VIS_SKIP_ONBOARDING: '1',
        CLAUDE_VIS_NO_UPDATES: '1',
        CLAUDE_VIS_DESKTOP_DIR: path.join(userData, 'no-desktop'),
      } as Record<string, string>,
    });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 1000));
    await page.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
    await page.locator('[data-agent="a1"]').first().waitFor({ timeout: 20_000 });
  });

  afterAll(async () => {
    await app?.close();
    for (const d of [home, userData]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  it('shows the prompt strip with the task list pace, the running agents and the planned release', async () => {
    const strip = page.getByTestId('prompt-progress');
    await strip.waitFor({ timeout: 10_000 });
    await vi.waitFor(async () => expect(await page.getByTestId('pp-phase').textContent()).toContain('step 3 of 4'), { timeout: 10_000 });
    expect(await page.getByTestId('pp-phase').textContent()).toContain('2 agents running');
    expect(await page.getByTestId('pp-read').textContent()).toMatch(/~\d+ min/);
    expect(await page.getByTestId('pp-line').textContent()).toMatch(/ready for updates ≈/);
    expect(await page.getByTestId('pp-agent').count()).toBe(3);
    for (const k of ['commit', 'push', 'release']) expect(await page.getByTestId(`pp-stage-${k}`).count()).toBe(1);
    await page.mouse.move(5, 500);
    await page.waitForTimeout(400);
    await shot('session');
    await shot('strip', '[data-testid="prompt-progress"]');
  });

  it('explains the estimate on hover', async () => {
    await page.getByTestId('prompt-progress').hover({ position: { x: 300, y: 10 } });
    await vi.waitFor(async () => expect(await page.getByTestId('pp-pop').evaluate((e) => getComputedStyle(e).opacity)).toBe('1'), { timeout: 3000 });
    const text = await page.getByTestId('pp-pop').textContent();
    expect(text).toContain('2 of 4 steps done');
    expect(text).toContain('then commit → push → release');
    await shot('popover');
    await page.mouse.move(5, 900);
  });

  it('puts the estimate on the agent cards and in the drawer', async () => {
    const bar = page.locator('[data-agent="a1"] [data-testid="eta-bar"]');
    await bar.waitFor({ timeout: 10_000 });
    expect(await bar.textContent()).toMatch(/~\d+ min left|<1 min left/);
    await shot('card', '[data-agent="a1"]');
    await page.locator('[data-agent="a1"]').first().click();
    const d = page.getByTestId('drawer-eta');
    await d.waitFor({ timeout: 5000 });
    expect(await d.textContent()).toMatch(/similar runs/);
    await shot('drawer', '.drawer');
    await page.keyboard.press('Escape');
    await page.locator('[data-agent="main"]').first().click();
    await vi.waitFor(async () => expect(await page.getByTestId('drawer-eta').textContent()).toContain('prompt wraps up'), { timeout: 5000 });
    await shot('drawer-main', '.drawer');
    await page.keyboard.press('Escape');
  });

  it('shows a line per session on the overview', async () => {
    await page.getByRole('button', { name: /all sessions/ }).click();
    const line = page.getByTestId('eta-line').first();
    await line.waitFor({ timeout: 15_000 });
    expect(await line.textContent()).toMatch(/~\d+ min|estimating|<1 min/);
    await shot('overview');
  });

  it('shows the estimate in the mini view', async () => {
    const [mini] = await Promise.all([app.waitForEvent('window'), page.getByRole('button', { name: /mini/ }).click()]);
    await mini.locator('.mini-main').waitFor({ timeout: 10_000 });
    const line = mini.getByTestId('eta-line');
    await line.waitFor({ timeout: 10_000 });
    expect(await line.textContent()).toMatch(/prompt ~\d+ min · release ≈/);
    await mini.screenshot({ path: path.join(ART, 'eta-mini.png') });
    await mini.close();
  });

  it('follows the shipping as it happens', async () => {
    await page.getByRole('button', { name: /one session/ }).click();
    await page.getByTestId('prompt-progress').waitFor({ timeout: 10_000 });
    // the agents finish, then the main agent commits, pushes and starts the release build
    for (const id of ['a1', 'a2']) await hook({ hook_event_name: 'SubagentStop', agent_id: id });
    await bash('toolu_ship_1', 'git add -A && git commit -qm "Time estimates" && git push origin master');
    await bash('toolu_ship_2', 'npm version minor && git push origin master --follow-tags');
    await bash('toolu_ship_3', 'npm run release:win', false);
    await vi.waitFor(async () => expect(await page.getByTestId('pp-phase').textContent()).toContain('release: building'), { timeout: 10_000 });
    expect(await page.getByTestId('pp-stage-commit').getAttribute('class')).toContain('done');
    expect(await page.getByTestId('pp-stage-push').getAttribute('class')).toContain('done');
    expect(await page.getByTestId('pp-stage-release').getAttribute('class')).toContain('active');
    await page.mouse.move(5, 900);
    await shot('releasing', '[data-testid="prompt-progress"]');
    // the build finishes, the draft is published, the turn ends
    await hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_ship_3', tool_name: 'Bash' });
    await bash('toolu_ship_4', 'gh release edit v0.9.0 --draft=false');
    // the read the fixture left open ends, the turn is wrapped up (which checks the task list off) and stops
    await hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_R2', tool_name: 'Read' });
    await hook({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_wrap', tool_name: 'mcp__ccd_turn__wrap_up', tool_input: { recap: 'Released 0.9.0' } });
    await hook({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_wrap', tool_name: 'mcp__ccd_turn__wrap_up' });
    await hook({ hook_event_name: 'Stop' });
    await vi.waitFor(async () => expect(await page.getByTestId('pp-line').textContent()).toMatch(/ready for updates \d/), { timeout: 10_000 });
    expect(await page.getByTestId('pp-phase').textContent()).toMatch(/done · took/);
    expect(await page.getByTestId('pp-stage-release').getAttribute('class')).toContain('done');
    await shot('released', '[data-testid="prompt-progress"]');
  });
});
