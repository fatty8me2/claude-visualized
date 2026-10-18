// End-to-end checks for the 0.4 polish round: title bar, sidebar groups and pinning, graph zoom and compact cards, the drawer
// (Esc, click-away, failed-call output, parent link) and estimated cost. Windows stay off-screen (vitest.e2e.config.ts).
// Run `npx electron-vite build` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT, SID, writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 47899);
const OLD_SID = '44444444-4444-4444-8444-444444444444';
const OLD_SID2 = '55555555-5555-4555-8555-555555555555';

const freshLine = (sid: string) => JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: sid, timestamp: new Date().toISOString() }) + '\n';
const hook = (body: object) => fetch(`http://127.0.0.1:${PORT}/hook?src=claude-visualized`, { method: 'POST', body: JSON.stringify(body) });

/** an old, finished session in its own project, with token usage but no reported cost */
function writeOldSession(home: string, sid: string, project: string, title: string, day: string) {
  const dir = path.join(home, 'projects', `C--old-${project}`);
  fs.mkdirSync(dir, { recursive: true });
  const base = { sessionId: sid, cwd: `C:\\old\\${project}`, gitBranch: 'feature/zoom', version: '2.1.299', entrypoint: 'cli' };
  const lines = [
    { ...base, type: 'user', timestamp: `${day}T10:00:00Z`, message: { role: 'user', content: title } },
    {
      ...base,
      type: 'assistant',
      timestamp: `${day}T10:00:05Z`,
      message: {
        id: `m_${sid}`,
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 200_000, output_tokens: 50_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
  ];
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const t = new Date(`${day}T10:00:05Z`);
  fs.utimesSync(path.join(dir, `${sid}.jsonl`), t, t);
}

describe('0.4 polish (fixture data)', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-polish-home-'));
    writeFixture(home);
    fs.appendFileSync(path.join(home, 'projects', PROJECT, `${SID}.jsonl`), freshLine(SID));
    writeOldSession(home, OLD_SID, 'alpha', 'Tune the zoom', '2026-09-01');
    writeOldSession(home, OLD_SID2, 'beta', 'Write the docs', '2026-09-02');
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-polish-ud-'));
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

  it('draws its own title bar as a drag region, with the meters in it', async () => {
    const bar = page.getByTestId('titlebar');
    expect(await bar.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('drag');
    expect(await bar.locator('.usage').count()).toBe(1);
    expect(
      await bar
        .locator('button')
        .first()
        .evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region')),
    ).toBe('no-drag');
    // the session page no longer has its own meters
    expect(await page.locator('.topbar .usage').count()).toBe(0);
  });

  it('groups recent sessions by project, pins one and hides another', async () => {
    await page.locator('.proj-group[data-project="alpha"]').waitFor({ timeout: 15_000 });
    expect(await page.locator('.proj-head').count()).toBeGreaterThanOrEqual(2);
    // collapse a group
    await page.locator('.proj-group[data-project="alpha"] .proj-head').click();
    expect(await page.locator(`[data-session="${OLD_SID}"]`).count()).toBe(0);
    await page.locator('.proj-group[data-project="alpha"] .proj-head').click();
    // pin through the context menu
    await page.locator(`[data-session="${OLD_SID}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Pin/ }).click();
    await page.locator('.group-label.pinned').waitFor();
    await page.screenshot({ path: path.join(ART, 'polish-sidebar.png') });
    // hide through the "…" button
    await page.locator(`[data-session="${OLD_SID2}"]`).hover();
    await page.locator(`[data-session="${OLD_SID2}"] .row-more`).click();
    await page.getByRole('menuitem', { name: /Hide/ }).click();
    expect(await page.locator(`[data-session="${OLD_SID2}"]`).count()).toBe(0);
    expect(await page.getByTestId('hidden-toggle').innerText()).toContain('1 hidden');
    // both survive a reload
    await page.reload();
    await page.locator('.group-label.pinned').waitFor({ timeout: 15_000 });
    expect(await page.locator(`[data-session="${OLD_SID2}"]`).count()).toBe(0);
    // search matches the branch, and the clear button appears only with text
    expect(await page.getByRole('button', { name: 'Clear search' }).count()).toBe(0);
    await page.getByPlaceholder('search sessions…').fill('feature/zoom');
    await page.getByRole('button', { name: 'Clear search' }).waitFor();
    expect(await page.locator(`[data-session="${OLD_SID}"]`).count()).toBe(1);
    expect(await page.locator(`[data-session="${SID}"]`).count()).toBe(0);
    await page.getByRole('button', { name: 'Clear search' }).click();
  });

  it('shows an estimated cost when Claude Code reported none', async () => {
    await page.locator(`[data-session="${OLD_SID}"]`).click();
    await page.locator('.topbar .title', { hasText: 'Tune the zoom' }).waitFor({ timeout: 15_000 });
    const cost = page.locator('.modepanel [data-testid="cost"]');
    await cost.waitFor();
    // 200k in at $4/M + 50k out at $20/M = $1.80
    expect(await cost.innerText()).toBe('~$1.80');
    expect(await page.locator('.statusbar').innerText()).toContain('cost est.');
    await page.locator(`[data-session="${SID}"]`).click();
    await page.locator('[data-agent="a1"]').waitFor({ timeout: 15_000 });
    expect(await page.locator('.modepanel [data-testid="cost"]').innerText()).toBe('$1.25'); // reported wins
  });

  it('keeps cards readable in a narrow panel and zooms with the toolbar and ctrl+wheel', async () => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.locator('.node.compact').first().waitFor({ timeout: 10_000 });
    const pct = async () => Number((await page.getByTestId('zoom-pct').innerText()).replace('%', ''));
    expect(await pct()).toBeGreaterThanOrEqual(85);
    await page.screenshot({ path: path.join(ART, 'polish-compact.png') });
    await page.getByRole('button', { name: 'zoom in' }).click();
    await page.getByRole('button', { name: 'zoom in' }).click();
    await page.waitForFunction(() => !document.querySelector('.node.compact'));
    const before = await pct();
    const box = (await page.locator('.graph-wrap').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 300);
    await page.keyboard.up('Control');
    await page.waitForFunction((b) => Number(document.querySelector('[data-testid="zoom-pct"]')!.textContent!.replace('%', '')) < b, before);
    await page.getByRole('button', { name: 'fit' }).click();
    await page.setViewportSize({ width: 1440, height: 920 });
  });

  it('closes the drawer with Escape and by clicking empty space, and links to the parent', async () => {
    await page.locator('[data-agent="a1"]').click();
    const drawer = page.getByTestId('drawer');
    await drawer.waitFor();
    await page.getByTestId('drawer-parent').click();
    await page.locator('.drawer .hd b', { hasText: 'main' }).waitFor();
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached' });
    await page.locator('[data-agent="a1"]').click();
    await drawer.waitFor();
    const wrap = (await page.locator('.graph-wrap').boundingBox())!;
    await page.mouse.click(wrap.x + 20, wrap.y + wrap.height - 20);
    await drawer.waitFor({ state: 'detached' });
  });

  it("shows a failed call's output in the drawer", async () => {
    await hook({ session_id: SID, hook_event_name: 'PreToolUse', tool_use_id: 'toolu_fail', tool_name: 'Bash', tool_input: { command: 'npm run lint' } });
    await hook({
      session_id: SID,
      hook_event_name: 'PostToolUseFailure',
      tool_use_id: 'toolu_fail',
      tool_name: 'Bash',
      error: 'exit code 1: ENOENT lint config',
    });
    await page.locator('[data-agent="main"]').click();
    // the newest failure opens by itself
    const err = page.getByTestId('tool-error').filter({ hasText: 'ENOENT lint config' });
    await err.waitFor({ timeout: 10_000 });
    await page.screenshot({ path: path.join(ART, 'polish-drawer.png') });
    await page.keyboard.press('Escape');
  });

  it('folds an expanded group of finished agents back into its chip', async () => {
    await page.getByTestId('drawer').waitFor({ state: 'detached' });
    await page.screenshot({ path: path.join(ART, 'polish-before-fold.png') });
    await page.getByRole('button', { name: 'hide finished' }).click();
    const chip = page.locator('.node.collapsed').first();
    await chip.waitFor();
    await chip.click();
    const fold = page.getByRole('button', { name: 'Fold finished children' }).first();
    await fold.waitFor();
    await fold.click();
    await page.locator('.node.collapsed').first().waitFor();
    await page
      .getByRole('button', { name: 'show finished' })
      .click()
      .catch(() => {});
  });
});
