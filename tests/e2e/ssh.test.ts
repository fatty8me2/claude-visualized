// End-to-end SSH remote: one app instance watches a second Claude home through a local `sh` standing in for `ssh host sh`
// (CLAUDE_VIS_SSH_CMD, a test-only override). The session of the "other computer" shows under its name and opens its graph.
// Run `npm run build` first. Skipped where no POSIX shell is available.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_PROJECT, LOCAL_SID, PROJECT, SID, writeFixture, writeLocalFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const BASE = Number(process.env.E2E_PORT ?? 47899);
const GIT_BIN = 'C:\\Program Files\\Git\\usr\\bin';
const sh = process.platform === 'win32' ? path.join(GIT_BIN, 'sh.exe') : 'sh';
const hasSh = process.platform === 'win32' ? fs.existsSync(sh) : spawnSync('sh', ['-c', 'true']).status === 0;

const freshLine = (sid: string) => JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: sid, timestamp: new Date().toISOString() }) + '\n';

describe.skipIf(!hasSh)('ssh remote in the app', () => {
  let home: string;
  let remoteHome: string;
  let userData: string;
  let app: ElectronApplication | null = null;
  let page: Page;

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-ssh-home-'));
    remoteHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-ssh-remote-'));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-ssh-ud-'));
    writeFixture(home);
    fs.appendFileSync(path.join(home, 'projects', PROJECT, `${SID}.jsonl`), freshLine(SID));
    writeLocalFixture(remoteHome);
    fs.appendFileSync(path.join(remoteHome, 'projects', LOCAL_PROJECT, `${LOCAL_SID}.jsonl`), freshLine(LOCAL_SID));
    app = await electron.launch({
      args: [ROOT],
      cwd: ROOT,
      env: {
        // Windows env names are case-insensitive: replace the one path variable rather than adding a second
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => process.platform !== 'win32' || k.toLowerCase() !== 'path')),
        ...(process.platform === 'win32' ? { PATH: `${GIT_BIN};${process.env.PATH ?? ''}` } : {}),
        CLAUDE_VIS_HOME: home,
        // what the stand-in shell (the "other computer") reads; this instance itself uses CLAUDE_VIS_HOME
        CLAUDE_CONFIG_DIR: remoteHome.replace(/\\/g, '/'),
        CLAUDE_VIS_SSH_CMD: sh,
        CLAUDE_VIS_USER_DATA: userData,
        CLAUDE_VIS_PORT: String(BASE + 20),
        CLAUDE_VIS_PEER_PORT: String(BASE + 21),
        CLAUDE_VIS_NO_DISCOVERY: '1',
        CLAUDE_VIS_DEVICE_NAME: 'Test PC',
        CLAUDE_VIS_NO_TRAY: '1',
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
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
    for (const d of [home, remoteHome, userData]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  it('refuses a target that is not a plain user@host', async () => {
    await page.getByText('Retry + docs').first().waitFor({ timeout: 20_000 });
    await page.getByTestId('nav-devices').click();
    await page.getByTestId('ssh-section').waitFor();
    await page.getByTestId('ssh-target').fill('-oProxyCommand=calc');
    await page.getByTestId('ssh-add').click();
    await page.getByTestId('ssh-add-error').waitFor({ timeout: 5000 });
    expect(await page.getByTestId('ssh-host').count()).toBe(0);
  });

  it('adds a computer and shows it online', async () => {
    await page.getByTestId('ssh-target').fill('me@test-mac');
    await page.getByLabel('name').fill('Test Mac');
    await page.getByTestId('ssh-add').click();
    await page.locator('[data-testid="ssh-host"][data-state="online"]').waitFor({ timeout: 20_000 });
    expect(await page.getByTestId('ssh-host').innerText()).toContain('Test Mac');
    await page.screenshot({ path: path.join(ART, 'ssh-devices.png') });
  });

  it('groups its session under its name and opens the agent graph', async () => {
    const group = page.locator('[data-testid="machine-group"][data-machine="Test Mac"]');
    await group.getByText('Local qwen session').waitFor({ timeout: 20_000 });
    expect(await group.getAttribute('data-online')).toBe('true');
    await group.getByText('Local qwen session').click();
    await page.locator('[data-agent="l1"]').waitFor({ timeout: 20_000 });
    expect(await page.locator('.topbar .title').first().innerText()).toContain('Test Mac');
    await page.screenshot({ path: path.join(ART, 'ssh-session.png') });
  });

  it('removing it takes its sessions away and deletes the copy', async () => {
    await page.getByTestId('nav-devices').click();
    const row = page.getByTestId('ssh-host');
    await row.getByRole('button', { name: 'remove' }).click();
    await row.getByRole('button', { name: /remove Test Mac/ }).click();
    await page.getByTestId('ssh-host').waitFor({ state: 'detached', timeout: 10_000 });
    await page.locator('[data-testid="machine-group"][data-machine="Test Mac"]').waitFor({ state: 'detached', timeout: 10_000 });
    const mirror = path.join(userData, 'ssh-mirror');
    await expect.poll(() => (fs.existsSync(mirror) ? fs.readdirSync(mirror).length : 0), { timeout: 10_000 }).toBe(0);
  });
});
