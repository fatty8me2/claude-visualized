// Adaptive overview panels: each panel picks its content from its measured size and the density (core/panelContent.ts).
// Two live sessions on a 1920x1080 window fill with the rail, feed, plan strip and table; four sessions start small and gain
// content as a panel is resized or maximized. Screenshots -> tests/e2e/artifacts/overview-adaptive-*.png.
// Windows stay off-screen (vitest.e2e.config.ts). Run `npx electron-vite build` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PROJECT, SID, writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const SIDS = [SID, '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
const TITLES = ['Retry + docs', 'Docs site rebuild', 'Billing export', 'Search index'];

/** stretch the fixture's 60 s into 20 minutes ending a minute ago, and make the token counts session-sized */
function rewrite(file: string, now: number, tokenK: number) {
  const out = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      try {
        const o = JSON.parse(line);
        if (typeof o.timestamp === 'string') o.timestamp = new Date(now - 21 * 60_000 + (Date.parse(o.timestamp) - T0) * 20).toISOString();
        const u = o.message?.usage;
        if (u) {
          u.input_tokens *= tokenK;
          u.output_tokens *= tokenK / 3;
          u.cache_read_input_tokens *= tokenK;
        }
        return JSON.stringify(o);
      } catch {
        return line;
      }
    })
    .join('\n');
  fs.writeFileSync(file, out);
}
function walk(dir: string, f: (p: string) => void) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, f);
    else if (e.name.endsWith('.jsonl') && e.name !== 'journal.jsonl') f(p);
  }
}
const freshLine = (sid: string) => JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: sid, timestamp: new Date().toISOString() }) + '\n';

interface Run {
  app: ElectronApplication;
  page: Page;
  dirs: string[];
}

async function launch(n: number, port: number): Promise<Run> {
  fs.mkdirSync(ART, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-ad-home-'));
  const now = Date.now();
  writeFixture(home);
  const p1 = path.join(home, 'projects', PROJECT);
  const src = fs.readFileSync(path.join(p1, `${SID}.jsonl`), 'utf8');
  const dirs = [p1];
  for (let i = 1; i < n; i++) {
    const dir = path.join(home, 'projects', `C--other-proj-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SIDS[i]}.jsonl`), src.replaceAll(SID, SIDS[i]).replaceAll('Retry + docs', TITLES[i]).replaceAll('C:\\\\demo\\\\app', `C:\\\\other\\\\proj${i}`));
    fs.cpSync(path.join(p1, SID), path.join(dir, SIDS[i]), { recursive: true });
    dirs.push(dir);
  }
  dirs.forEach((d, i) => walk(d, (f) => rewrite(f, now, [150, 55, 90, 30][i])));
  dirs.forEach((d, i) => fs.appendFileSync(path.join(d, `${SIDS[i]}.jsonl`), freshLine(SIDS[i])));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-ad-ud-'));
  const app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      CLAUDE_VIS_HOME: home,
      CLAUDE_VIS_USER_DATA: userData,
      CLAUDE_VIS_PORT: String(port),
      CLAUDE_VIS_NO_EXTERNAL: '1',
      CLAUDE_VIS_NO_SYSTEM_INTEGRATION: '1',
      CLAUDE_VIS_NO_USAGE_API: '1',
      CLAUDE_VIS_SKIP_ONBOARDING: '1',
      CLAUDE_VIS_NO_UPDATES: '1',
      CLAUDE_VIS_DESKTOP_DIR: path.join(userData, 'no-desktop'),
    } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1920, 1080));
  await page.setViewportSize({ width: 1920, height: 1080 }).catch(() => {});
  await page.locator('[data-agent="a1"]').first().waitFor({ timeout: 20_000 });
  // something in flight in every session, so the panels look alive
  for (let i = 0; i < n; i++) {
    await fetch(`http://127.0.0.1:${port}/hook?src=claude-visualized`, {
      method: 'POST',
      body: JSON.stringify({ session_id: SIDS[i], hook_event_name: 'PreToolUse', tool_use_id: `toolu_live_${i}`, tool_name: 'Edit', tool_input: { file_path: 'C:\\demo\\app\\src\\api.ts' } }),
    }).catch(() => {});
  }
  await page.getByRole('button', { name: /all sessions/ }).click();
  await vi.waitFor(async () => expect(await page.locator('.ov-panel').count()).toBe(n), { timeout: 15_000 });
  await page.waitForTimeout(900);
  return { app, page, dirs: [home, userData] };
}
async function close(r: Run | undefined) {
  await r?.app?.close();
  r?.dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
}

const tierOf = (page: Page, sid: string) => page.locator(`.ov-panel[data-session="${sid}"]`).getAttribute('data-tier');
const has = (page: Page, sid: string, sel: string) => page.locator(`.ov-panel[data-session="${sid}"] ${sel}`).count();

describe('adaptive overview: two live sessions on 1920x1080', () => {
  let r: Run;
  afterAll(() => close(r));

  it('fills each panel with the rail, feed, plan strip and agent table', async () => {
    r = await launch(2, Number(process.env.E2E_PORT ?? 47970));
    const { page } = r;
    for (const sid of SIDS.slice(0, 2)) {
      expect(await tierOf(page, sid)).toBe('large');
      expect(await has(page, sid, '[data-testid="px-rail"]')).toBe(1);
      expect(await has(page, sid, '[data-testid="px-feed"]')).toBe(1);
      expect(await has(page, sid, '[data-testid="px-plan"]')).toBe(1);
      expect(await has(page, sid, '[data-testid="px-table"]')).toBe(1);
      expect(await has(page, sid, '.ov-log')).toBe(0);
    }
    // the rail shows the forecast line and agent counts
    const rail = page.locator('.ov-panel').first().locator('[data-testid="px-rail"]');
    expect(await rail.innerText()).toMatch(/running/i);
    expect(await page.locator('.ov-panel').first().getByTestId('px-compact').innerText()).toMatch(/auto-compact|forecast/);
    // the feed has lines and the table lists the main agent
    expect(await page.locator('.ov-panel').first().locator('.px-feed .ln').count()).toBeGreaterThan(3);
    expect(await page.locator('.ov-panel').first().locator('.px-table .trow').count()).toBeGreaterThan(3);
    // clicking the panel header still opens the session
    await page.screenshot({ path: path.join(ART, 'overview-adaptive-2-sessions.png') });
    await page.locator('.ov-panel').first().locator('.ov-head').click({ position: { x: 80, y: 14 } });
    await page.locator('.modebox').waitFor({ timeout: 5000 });
  });
});

describe('adaptive overview: four sessions, resize and maximize', () => {
  let r: Run;
  afterAll(() => close(r));

  it('starts small, grows with the panel size and shows the plan strip when large', async () => {
    r = await launch(4, Number(process.env.E2E_PORT ?? 47970) + 7);
    const { page } = r;
    const first = (await page.locator('.ov-panel').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.session)))[0] as string;
    const panel = page.locator(`.ov-panel[data-session="${first}"]`);
    const settle = () => page.waitForTimeout(900);

    // default 2x2 grid of 1x1 panels: graph and a 2-line log
    expect(await tierOf(page, first)).toBe('small');
    expect(await has(page, first, '[data-testid="px-rail"]')).toBe(0);
    expect(await has(page, first, '.ov-log')).toBe(1);
    expect(await panel.locator('.ov-log > div').count()).toBeLessThanOrEqual(2);
    await page.screenshot({ path: path.join(ART, 'overview-adaptive-4-sessions.png') });

    // a tall 1x2 panel spans two grid rows: the rail appears (and the feed too once it is tall enough)
    await panel.getByTestId('size-1×2').click();
    await settle();
    await page.screenshot({ path: path.join(ART, 'overview-adaptive-4-sessions-1x2.png') });
    const t12 = await tierOf(page, first);
    expect(['medium', 'large']).toContain(t12);
    expect(await has(page, first, '[data-testid="px-rail"]')).toBe(1);

    // back to 1x1: small again
    await panel.getByTestId('size-1×1').click();
    await settle();
    expect(await tierOf(page, first)).toBe('small');
    expect(await has(page, first, '[data-testid="px-rail"]')).toBe(0);

    // maximized: large
    await panel.getByTestId('ov-max').click();
    await settle();
    expect(await tierOf(page, first)).toBe('large');
    expect(await has(page, first, '[data-testid="px-feed"]')).toBe(1);
    expect(await has(page, first, '[data-testid="px-plan"]')).toBe(1);
    await page.screenshot({ path: path.join(ART, 'overview-adaptive-maximized.png') });
    await page.keyboard.press('Escape');
    await settle();
    expect(await tierOf(page, first)).toBe('small');

    // compact density keeps every panel small whatever its size
    await panel.getByTestId('size-1×2').click();
    await page.getByTestId('density-compact').click();
    await settle();
    expect(await page.locator('.ov-panel:not([data-tier="small"])').count()).toBe(0);
    expect(await page.locator('.px-rail').count()).toBe(0);
    await page.getByTestId('density-comfortable').click();
    await settle();
    expect(await tierOf(page, first)).toBe(t12);
  });
});
