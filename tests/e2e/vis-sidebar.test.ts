// Screenshots of the left sidebar in a few states (tests/e2e/artifacts/vis-sidebar-*.png, gitignored) plus checks that the
// new sidebar hooks render. Windows stay off-screen (vitest.e2e.config.ts). Run `npx electron-vite build` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT, SID, writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 47899);
const OLD = ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666'];
const freshLine = (sid: string) => JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: sid, timestamp: new Date().toISOString() }) + '\n';

function writeOld(home: string, sid: string, project: string, title: string, day: string) {
  const dir = path.join(home, 'projects', `C--old-${project}`);
  fs.mkdirSync(dir, { recursive: true });
  const base = { sessionId: sid, cwd: `C:\\old\\${project}`, gitBranch: 'feature/zoom', version: '2.1.299', entrypoint: 'cli' };
  const lines = [
    { ...base, type: 'user', timestamp: `${day}T10:00:00Z`, message: { role: 'user', content: title } },
    {
      ...base,
      type: 'assistant',
      timestamp: `${day}T10:00:05Z`,
      message: { id: `m_${sid}`, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 2000, output_tokens: 500 } },
    },
  ];
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const t = new Date(`${day}T10:00:05Z`);
  fs.utimesSync(path.join(dir, `${sid}.jsonl`), t, t);
}

describe('sidebar visuals (fixture data)', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;
  const shot = (name: string) => page.locator('.sidebar').screenshot({ path: path.join(ART, `vis-sidebar-${name}.png`) });

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-sb-home-'));
    writeFixture(home);
    fs.appendFileSync(path.join(home, 'projects', PROJECT, `${SID}.jsonl`), freshLine(SID));
    writeOld(home, OLD[0], 'alpha', 'Tune the zoom', '2026-09-01');
    writeOld(home, OLD[1], 'alpha', 'Refactor the reducer', '2026-09-03');
    writeOld(home, OLD[2], 'beta', 'Write the docs', '2026-09-02');
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-sb-ud-'));
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
    await page.locator('.session-row').first().waitFor({ timeout: 20_000 });
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('renders count badges, the energy edge and the selected reticle', async () => {
    await page.locator(`[data-session="${SID}"]`).click();
    await page.locator(`[data-session="${SID}"] .brk`).waitFor();
    expect(await page.locator('.group-label .gl-n').count()).toBeGreaterThanOrEqual(2);
    expect(await page.locator('.session-row .edge').count()).toBeGreaterThanOrEqual(3);
    await page.waitForTimeout(500);
    await shot('selected');
  });

  it('pins, hovers and searches', async () => {
    await page.locator(`[data-session="${OLD[0]}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Pin/ }).click();
    await page.locator('.group-label.pinned').waitFor();
    await page.locator(`[data-session="${OLD[1]}"]`).hover();
    await page.waitForTimeout(900);
    await shot('hover-pinned');
    await page.getByPlaceholder('search sessions…').focus();
    await page.getByPlaceholder('search sessions…').fill('docs');
    await page.waitForTimeout(500);
    await shot('search');
    await page.getByPlaceholder('search sessions…').fill('zzzz-nothing');
    await page.waitForTimeout(400);
    await shot('empty');
    await page.getByRole('button', { name: 'Clear search' }).click();
  });

  it('shows the collapsed rail', async () => {
    await page.getByRole('button', { name: 'collapse sidebar' }).click();
    await page.locator('.sidebar.collapsed').waitFor();
    await shot('collapsed');
    await page.getByRole('button', { name: 'show sessions' }).click();
    await page.locator('.sidebar:not(.collapsed)').waitFor();
  });
});
