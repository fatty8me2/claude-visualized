// End-to-end settings sync: two app instances (separate userData) point at the same temp folder standing in for Google Drive.
// A turns sync on and changes the overview density; B turns sync on, takes Drive's settings and shows the same density; then the other way round.
// Run `npm run build` first. Hook ports: E2E_PORT and E2E_PORT+1, peer ports +10/+11. Screenshots go to tests/e2e/artifacts/sync-*.png.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const BASE = Number(process.env.E2E_PORT ?? 47899);

interface Inst {
  app: ElectronApplication;
  page: Page;
  userData: string;
  home: string;
}

async function launch(name: string, hookPort: number, roots: string): Promise<Inst> {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-sync-ud-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-sync-home-'));
  writeFixture(home);
  const app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      CLAUDE_VIS_HOME: home,
      CLAUDE_VIS_USER_DATA: userData,
      CLAUDE_VIS_PORT: String(hookPort),
      CLAUDE_VIS_PEER_PORT: String(hookPort + 10),
      CLAUDE_VIS_PEER_BIND: '127.0.0.1',
      CLAUDE_VIS_NO_DISCOVERY: '1',
      CLAUDE_VIS_DEVICE_NAME: name,
      CLAUDE_VIS_NO_TRAY: '1',
      CLAUDE_VIS_NO_EXTERNAL: '1',
      CLAUDE_VIS_NO_SYSTEM_INTEGRATION: '1',
      CLAUDE_VIS_NO_USAGE_API: '1',
      CLAUDE_VIS_SKIP_ONBOARDING: '1',
      CLAUDE_VIS_NO_UPDATES: '1',
      CLAUDE_VIS_DESKTOP_DIR: path.join(userData, 'no-desktop'),
      CLAUDE_VIS_SYNC_ROOTS: roots,
      CLAUDE_VIS_SYNC_POLL_MS: '400',
      CLAUDE_VIS_SYNC_DEBOUNCE_MS: '150',
    } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1100 }).catch(() => {});
  await page.locator('.app').waitFor({ timeout: 30_000 });
  return { app, page, userData, home };
}

const openSettings = async (p: Page) => {
  await p.getByRole('button', { name: /hooks/ }).click();
  await p.getByTestId('sync-settings').waitFor({ timeout: 10_000 });
  await p.getByTestId('sync-settings').scrollIntoViewIfNeeded();
  await p.waitForTimeout(400);
};
const shot = async (p: Page, name: string) => {
  await p.getByTestId('sync-settings').scrollIntoViewIfNeeded();
  await p.waitForTimeout(250);
  await p.screenshot({ path: path.join(ART, name) });
};
const density = (p: Page) =>
  p.evaluate(() => {
    try {
      return (JSON.parse(localStorage.getItem('cvis.overview.v1') ?? 'null') as { density?: string } | null)?.density ?? null;
    } catch {
      return null;
    }
  });
const setDensity = (p: Page, d: string) =>
  p.evaluate((dd) => localStorage.setItem('cvis.overview.v1', JSON.stringify({ density: dd, colFr: {}, rowFr: [], sizes: {}, order: [], pinned: [], hidden: [] })), d);

describe('settings sync between two app instances', () => {
  let drive: string;
  let a: Inst | null = null;
  let b: Inst | null = null;
  const all: Inst[] = [];

  beforeAll(() => {
    fs.mkdirSync(ART, { recursive: true });
    drive = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-fake-drive-'));
  });
  afterAll(async () => {
    for (const i of [a, b, ...all]) await i?.app.close().catch(() => {});
    for (const d of [drive, ...[a, b, ...all].flatMap((i) => (i ? [i.userData, i.home] : []))]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('without Google Drive it offers the installer and "Check again"', async () => {
    const c = await launch('No Drive', BASE + 4, path.join(drive, 'does-not-exist'));
    all.push(c);
    await openSettings(c.page);
    await c.page.getByTestId('sync-install').waitFor();
    expect(await c.page.getByTestId('sync-install-link').getAttribute('href')).toBe('https://www.google.com/drive/download/');
    await c.page.getByTestId('sync-check').click();
    await c.page.getByTestId('sync-install').waitFor();
    await shot(c.page, 'sync-install.png');
    await c.app.close();
  });

  it('A detects the folder, turns sync on, and its density lands in Drive', async () => {
    a = await launch('Test PC', BASE, drive);
    await setDensity(a.page, 'compact');
    await a.page.waitForTimeout(2000); // the bridge polls localStorage every 1.5 s
    await openSettings(a.page);
    await a.page.getByTestId('sync-folders').waitFor();
    await shot(a.page, 'sync-off.png');
    await a.page.getByTestId('sync-on').click();
    await a.page.getByTestId('sync-card').waitFor();
    await a.page.getByTestId('sync-state').filter({ hasText: 'synced' }).waitFor({ timeout: 10_000 });
    const dir = path.join(drive, 'Claude Visualized');
    await expect.poll(() => fs.existsSync(dir) && fs.readdirSync(dir).length).toBe(2);
    const files = fs.readdirSync(dir);
    expect(files).toContain('settings.json');
    const text = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    expect(text).toContain('compact');
    expect(text).not.toMatch(/peers|priv|"port"|token/i);
    expect(fs.readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('B finds settings in Drive, asks, takes them, and shows the same density', async () => {
    b = await launch('Test Mac', BASE + 1, drive);
    expect(await density(b.page)).toBeNull();
    await openSettings(b.page);
    await b.page.getByTestId('sync-on').click();
    await b.page.getByTestId('sync-ask').waitFor();
    await shot(b.page, 'sync-ask.png');
    await b.page.getByTestId('sync-choice-drive').click();
    // the window reloads once it has written Drive's values
    await expect.poll(() => density(b!.page), { timeout: 15_000 }).toBe('compact');
    await b.page.locator('.app').waitFor({ timeout: 15_000 });
  });

  it('a change on B reaches A, and both list each other as machines', async () => {
    await setDensity(b!.page, 'spacious');
    await expect.poll(() => density(a!.page), { timeout: 20_000 }).toBe('spacious');
    await a!.page.locator('.app').waitFor({ timeout: 15_000 });
    await openSettings(a!.page);
    await expect.poll(() => a!.page.getByTestId('sync-machine').count(), { timeout: 15_000 }).toBe(2);
    const names = await a!.page.getByTestId('sync-machine').allInnerTexts();
    expect(names.join(' ')).toContain('Test Mac');
    expect(names.join(' ')).toContain('Test PC');
    await shot(a!.page, 'sync-on.png');
  });

  it('a config toggle syncs too, and machine-specific settings stay put', async () => {
    await b!.page.evaluate(() => window.api.setConfig({ notifyAgentDone: true, port: 47999 }));
    await expect.poll(() => a!.page.evaluate(async () => (await window.api.getConfig()).notifyAgentDone), { timeout: 20_000 }).toBe(true);
    expect(await a!.page.evaluate(async () => (await window.api.getConfig()).port)).toBe(BASE);
  });

  it('turning sync off keeps the files in Drive', async () => {
    await a!.page.getByTestId('sync-off').click();
    await a!.page.getByTestId('sync-on').waitFor();
    expect(fs.readdirSync(path.join(drive, 'Claude Visualized')).length).toBe(3);
  });
});
