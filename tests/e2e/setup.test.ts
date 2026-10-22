// End-to-end: the first-run setup wizard. Always against a temp fake Claude home (CLAUDE_VIS_HOME) with fake credentials and a fake usage server;
// the real ~/.claude is never read or written. Screenshots go to tests/e2e/artifacts/setup-*.png. Run `electron-vite build` first.
// Hook port: E2E_PORT+3.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const BASE = Number(process.env.E2E_PORT ?? 47899);
const RESET = Date.now() + 3 * 3600_000;

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d: string) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });

async function launch(env: Record<string, string>, userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      CLAUDE_VIS_USER_DATA: userData,
      CLAUDE_VIS_PORT: String(BASE + 3),
      CLAUDE_VIS_NO_DISCOVERY: '1',
      CLAUDE_VIS_NO_TRAY: '1',
      CLAUDE_VIS_NO_EXTERNAL: '1',
      CLAUDE_VIS_NO_SYSTEM_INTEGRATION: '1',
      CLAUDE_VIS_NO_USAGE_API: '1',
      CLAUDE_VIS_SKIP_ONBOARDING: '',
      CLAUDE_VIS_OAUTH_TOKEN_URL: 'http://127.0.0.1:1/never',
      CLAUDE_VIS_NO_UPDATES: '1',
      CLAUDE_VIS_DESKTOP_DIR: path.join(userData, 'no-desktop'),
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      ...env,
    } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
  return { app, page };
}

const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(ART, `setup-${name}.png`) });
};
const wizard = (page: Page) => page.getByTestId('setup-wizard');
const rail = (page: Page) => page.locator('.setup .rail li.cur').getAttribute('data-rail');

describe('setup wizard: a computer without Claude Code', () => {
  let userData: string;
  let empty: string;
  let home: string;
  const env = () => ({ CLAUDE_VIS_HOME: home, CLAUDE_VIS_SETUP_PATH: empty });

  beforeAll(() => {
    fs.mkdirSync(ART, { recursive: true });
    userData = tmp('cvis-setup-ud-');
    empty = tmp('cvis-setup-bin-');
    home = path.join(empty, 'no-claude-here');
  });
  afterAll(() => {
    rm(userData);
    rm(empty);
  });

  it('shows friendly install instructions, no sign-in, and skip is remembered and resumable', async () => {
    const { app, page } = await launch(env(), userData);
    try {
      await wizard(page).waitFor({ timeout: 25_000 });
      await page.getByTestId('setup-step-welcome').waitFor();
      expect(await page.getByTestId('setup-step-welcome').innerText()).toMatch(/stays on your computer/i);
      await shot(page, '1-welcome');

      await page.getByTestId('setup-next').click();
      await page.getByTestId('setup-install-help').waitFor({ timeout: 10_000 });
      expect(await page.getByTestId('setup-open-download').count()).toBe(1);
      expect(await page.getByTestId('setup-recheck').count()).toBe(1);
      expect(await page.getByTestId('setup-next').innerText()).toMatch(/Continue anyway/);
      // Open download page works (the test run opens no browser) and "Check again" settles back
      await page.getByTestId('setup-open-download').click();
      await page.getByTestId('setup-recheck').click();
      await page.getByTestId('setup-recheck').filter({ hasText: 'Check again' }).waitFor();
      await shot(page, '2-detect-missing');

      await page.getByTestId('setup-next').click();
      await page.getByTestId('setup-login-help').waitFor();
      expect(await page.getByTestId('setup-account').count()).toBe(0);
      expect(await page.getByTestId('setup-login-help').innerText()).toContain('/login');
      expect(await page.getByTestId('setup-open-terminal').count()).toBe(1);
      await page.getByTestId('setup-open-terminal').click(); // CLAUDE_VIS_NO_EXTERNAL: opens nothing
      await shot(page, '3-account-signed-out');

      // skip from here: not shown again at the next start
      await page.getByTestId('setup-skip').click();
      await wizard(page).waitFor({ state: 'detached' });
    } finally {
      await app.close();
    }

    const again = await launch(env(), userData);
    try {
      const page = again.page;
      await page.getByRole('button', { name: /help/ }).first().waitFor({ timeout: 25_000 });
      await page.waitForTimeout(1500);
      expect(await wizard(page).count()).toBe(0);
      // the help button resumes where they left off: the account step
      await page.getByRole('button', { name: /help/ }).first().click();
      await wizard(page).waitFor();
      expect(await rail(page)).toBe('account');
      await page.getByTestId('setup-skip').click();
      await wizard(page).waitFor({ state: 'detached' });
    } finally {
      await again.app.close();
    }
  });
});

describe('setup wizard: signed in, fake usage server, hooks install', () => {
  let userData: string;
  let home: string;
  let bin: string;
  let server: http.Server;
  let usageUrl: string;
  let app: ElectronApplication;
  let page: Page;
  const settingsFile = () => path.join(home, 'settings.json');

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer fake-access-token') return void res.writeHead(401).end();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          five_hour: { utilization: 37, resets_at: new Date(RESET).toISOString() },
          seven_day: { utilization: 12, resets_at: new Date(RESET + 86400_000 * 3).toISOString() },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    usageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/oauth/usage`;

    userData = tmp('cvis-setup2-ud-');
    bin = tmp('cvis-setup2-bin-');
    home = tmp('cvis-setup2-home-');
    writeFixture(home);
    fs.writeFileSync(
      path.join(home, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'fake-access-token',
          refreshToken: 'fake-refresh-token',
          expiresAt: Date.now() + 8 * 3600_000,
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_5x',
        },
      }),
    );
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'ada@example.test', organizationName: 'Analytical Engines' } }),
    );
    fs.writeFileSync(settingsFile(), JSON.stringify({ model: 'sonnet', permissions: { allow: ['Bash(ls)'] } }, null, 2));
    fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude'), '');
    ({ app, page } = await launch(
      { CLAUDE_VIS_HOME: home, CLAUDE_VIS_SETUP_PATH: bin, CLAUDE_VIS_NO_USAGE_API: '', CLAUDE_VIS_USAGE_URL: usageUrl },
      userData,
    ));
  });
  afterAll(async () => {
    await app?.close();
    await new Promise((r) => server?.close(r));
    rm(userData);
    rm(bin);
    rm(home);
  });

  it('finds Claude Code and shows who is signed in with the live 5-hour and weekly numbers', async () => {
    await wizard(page).waitFor({ timeout: 25_000 });
    await page.getByTestId('setup-next').click();
    await page.locator('[data-row="home"].ok').waitFor({ timeout: 10_000 });
    await page.locator('[data-row="cli"].ok').waitFor();
    expect(await page.getByTestId('setup-install-help').count()).toBe(0);
    expect(await page.locator('[data-row="sessions"]').innerText()).toMatch(/found/i);
    await shot(page, '4-detect-found');

    await page.getByTestId('setup-next').click();
    await page.getByTestId('setup-account').waitFor();
    expect(await page.getByTestId('setup-who').innerText()).toBe('ada@example.test (Analytical Engines)');
    expect(await page.getByTestId('setup-plan').innerText()).toBe('Claude Max 5x');
    await page.getByTestId('setup-usage-state').filter({ hasText: 'connected' }).waitFor({ timeout: 15_000 });
    await expect.poll(() => page.getByTestId('setup-usage-5h').innerText(), { timeout: 15_000 }).toContain('37% used');
    expect(await page.getByTestId('setup-usage-week').innerText()).toContain('12% used');
    // no token text anywhere in the page
    expect(await page.locator('body').innerText()).not.toMatch(/fake-(access|refresh)-token/);
    await shot(page, '5-account-signed-in');
  });

  it('installs hooks into the FAKE home with a backup, after showing the exact change', async () => {
    const before = fs.readFileSync(settingsFile(), 'utf8');
    await page.getByTestId('setup-next').click();
    await page.getByTestId('setup-hooks-card').waitFor();
    await page.getByTestId('setup-preview').locator('summary').click();
    expect(await page.getByTestId('setup-preview').innerText()).toContain('PreToolUse');
    expect(await page.getByTestId('setup-hooks-state').innerText()).toBe('not installed');
    await shot(page, '6-live-preview');
    // nothing is written until the click
    expect(fs.readFileSync(settingsFile(), 'utf8')).toBe(before);

    await page.getByTestId('setup-install').click();
    await page.getByTestId('setup-install-result').waitFor({ timeout: 15_000 });
    expect(await page.getByTestId('setup-install-result').innerText()).toMatch(/^Done/);
    await page.getByTestId('setup-hooks-state').filter({ hasText: 'installed' }).waitFor();

    const after = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    expect(after.model).toBe('sonnet'); // untouched
    expect(after.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(Object.keys(after.hooks).length).toBeGreaterThanOrEqual(10);
    expect(JSON.stringify(after.hooks)).toContain(`127.0.0.1:${BASE + 3}`);
    expect(after.statusLine.command).toContain('claude-visualized-statusline.mjs');
    expect(fs.existsSync(path.join(home, 'claude-visualized-statusline.mjs'))).toBe(true);
    const backups = fs.readdirSync(path.join(userData, 'backups'));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(path.join(userData, 'backups', backups[0]), 'utf8')).toBe(before);
    await shot(page, '7-live-installed');
  });

  it('finishes with a summary, then Finish closes it for good', async () => {
    await page.getByTestId('setup-next').click();
    await page.getByTestId('setup-summary').waitFor();
    const text = await page.getByTestId('setup-summary').innerText();
    expect(text).toContain('ada@example.test');
    expect(text).toMatch(/Live updates\s*\n?\s*Installed/);
    await shot(page, '8-done');
    await page.getByTestId('setup-finish').click();
    await wizard(page).waitFor({ state: 'detached' });
    const cfg = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
    expect(cfg.setupVersion).toBe(1);
    expect(cfg.setupStep).toBe(0);
  });
});

describe('setup wizard: honours CLAUDE_VIS_SKIP_ONBOARDING and re-opens from Settings', () => {
  it('stays away when skipped by env, and "Run setup again" opens it at the welcome step', async () => {
    const userData = tmp('cvis-setup3-ud-');
    const home = tmp('cvis-setup3-home-');
    writeFixture(home);
    const { app, page } = await launch({ CLAUDE_VIS_HOME: home, CLAUDE_VIS_SETUP_PATH: home, CLAUDE_VIS_SKIP_ONBOARDING: '1' }, userData);
    try {
      await page.locator('.session-row').first().waitFor({ timeout: 25_000 });
      await page.waitForTimeout(1500);
      expect(await wizard(page).count()).toBe(0);
      await page.getByRole('button', { name: /hooks/ }).click();
      await page.getByTestId('settings-run-setup').click();
      await wizard(page).waitFor();
      expect(await rail(page)).toBe('welcome');
      await shot(page, '9-from-settings');
      await page.keyboard.press('Escape'); // Escape = skip for now
      await wizard(page).waitFor({ state: 'detached' });
    } finally {
      await app.close();
      rm(userData);
      rm(home);
    }
  });
});

describe('setup wizard: the hook port is taken', () => {
  it('says so and moves to a free port, and the hooks are written for it', async () => {
    const blocker = http.createServer((_q, r) => r.end('busy'));
    const busy = BASE + 5;
    await new Promise<void>((r) => blocker.listen(busy, '127.0.0.1', r));
    const userData = tmp('cvis-setup4-ud-');
    const home = tmp('cvis-setup4-home-');
    writeFixture(home);
    const { app, page } = await launch({ CLAUDE_VIS_HOME: home, CLAUDE_VIS_SETUP_PATH: home, CLAUDE_VIS_PORT: String(busy) }, userData);
    try {
      await wizard(page).waitFor({ timeout: 25_000 });
      for (let i = 0; i < 3; i++) await page.getByTestId('setup-next').click();
      await page.getByTestId('setup-port-busy').waitFor({ timeout: 15_000 });
      expect(await page.getByTestId('setup-port-busy').innerText()).toContain(`Port ${busy} is already in use`);
      await shot(page, '10-port-busy');
      await page.getByTestId('setup-use-port').click();
      await page.getByTestId('setup-port-busy').waitFor({ state: 'detached', timeout: 10_000 });
      const cfg = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
      expect(cfg.port).not.toBe(busy);
      await page.getByTestId('setup-install').click();
      await page.getByTestId('setup-install-result').waitFor({ timeout: 15_000 });
      expect(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).toContain(`127.0.0.1:${cfg.port}`);
    } finally {
      await app.close();
      await new Promise((r) => blocker.close(r));
      rm(userData);
      rm(home);
    }
  });
});
