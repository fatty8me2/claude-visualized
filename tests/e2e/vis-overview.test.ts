// Visual pass over the all-sessions overview: 2, 4 and 6 sessions (mixed models, some idle), maximized, compact, a wide short panel.
// Screenshots -> tests/e2e/artifacts/vis-overview-*.png.
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
const SIDS = [
  SID,
  ...[2, 3, 4, 5, 6].map((k) => `${String(k).repeat(8)}-${String(k).repeat(4)}-4${String(k).repeat(3)}-8${String(k).repeat(3)}-${String(k).repeat(12)}`),
];
const TITLES = ['Retry + docs', 'Docs site rebuild', 'Billing export', 'Search index', 'Auth refactor', 'Release notes'];
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];

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

async function launch(n: number, port: number, idle = 1): Promise<Run> {
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
    fs.writeFileSync(
      path.join(dir, `${SIDS[i]}.jsonl`),
      src
        .replaceAll(SID, SIDS[i])
        .replaceAll('Retry + docs', TITLES[i])
        .replaceAll('claude-opus-5-5', MODELS[i])
        .replaceAll('C:\\\\demo\\\\app', `C:\\\\other\\\\proj${i}`),
    );
    fs.cpSync(path.join(p1, SID), path.join(dir, SIDS[i]), { recursive: true });
    dirs.push(dir);
  }
  dirs.forEach((d, i) => walk(d, (f) => rewrite(f, now, [150, 55, 90, 30, 70, 20][i])));
  dirs.forEach((d, i) => i < n - idle && fs.appendFileSync(path.join(d, `${SIDS[i]}.jsonl`), freshLine(SIDS[i])));
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
  for (let i = 0; i < n - idle; i++) {
    await fetch(`http://127.0.0.1:${port}/hook?src=claude-visualized`, {
      method: 'POST',
      body: JSON.stringify({
        session_id: SIDS[i],
        hook_event_name: 'PreToolUse',
        tool_use_id: `toolu_live_${i}`,
        tool_name: 'Edit',
        tool_input: { file_path: 'C:\\demo\\app\\src\\api.ts' },
      }),
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

const shot = (r: Run, name: string) => r.page.screenshot({ path: path.join(ART, `vis-overview-${name}.png`) });
const PORT = Number(process.env.E2E_PORT ?? 48400);

describe('visual overview', () => {
  let r: Run | undefined;
  afterAll(() => close(r));
  for (const [k, n] of [
    [0, 2],
    [1, 4],
    [2, 6],
  ] as const) {
    it(`${n} sessions`, async () => {
      await close(r);
      r = await launch(n, PORT + k * 7, 1);
      await shot(r, `${n}`);
      if (n === 4) {
        const { page } = r;
        await page.getByTestId('density-compact').click();
        await page.waitForTimeout(900);
        await shot(r, 'compact');
        await page.getByTestId('density-comfortable').click();
        await page.waitForTimeout(500);
        await page.locator('.ov-panel').first().getByTestId('ov-max').click();
        await page.waitForTimeout(150);
        await shot(r, 'max-animating');
        await page.waitForTimeout(900);
        await shot(r, 'maximized');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(900);
        // a short wide panel: span 2x1
        await page.locator('.ov-panel').nth(1).getByTestId('size-2×1').click();
        await page.waitForTimeout(900);
        await shot(r, 'wide');
        const h = page.locator('[data-testid="ov-rz-col-0"]');
        await h.hover();
        await page.waitForTimeout(300);
        await shot(r, 'handle-hover');
      }
    });
  }
});
