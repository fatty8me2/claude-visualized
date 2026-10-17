// End-to-end peer link: two app instances with separate userData and Claude homes. "Test Mac" shares (loopback only, so no firewall prompt),
// "Test PC" pairs with the code read from the sharer's UI, then sees the remote session grouped under the sharer's name and opens its graph.
// Run `npm run build` first. Hook ports: E2E_PORT and E2E_PORT+1; peer ports: E2E_PORT+10 and E2E_PORT+11.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_PROJECT, LOCAL_SID, PROJECT, SID, writeFixture, writeLocalFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const BASE = Number(process.env.E2E_PORT ?? 47899);
const SHARE_PORT = BASE + 10;

const freshLine = (sid: string) => JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: sid, timestamp: new Date().toISOString() }) + '\n';

async function launch(name: string, home: string, hookPort: number, peerPort: number) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-peer-ud-'));
  const app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      CLAUDE_VIS_HOME: home,
      CLAUDE_VIS_USER_DATA: userData,
      CLAUDE_VIS_PORT: String(hookPort),
      CLAUDE_VIS_PEER_PORT: String(peerPort),
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
    } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
  return { app, page, userData };
}

describe('peer link between two app instances', () => {
  let homeMac: string;
  let homePc: string;
  let mac: { app: ElectronApplication; page: Page; userData: string } | null = null;
  let pc: { app: ElectronApplication; page: Page; userData: string } | null = null;

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    homeMac = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-home-mac-'));
    homePc = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-home-pc-'));
    writeLocalFixture(homeMac);
    fs.appendFileSync(path.join(homeMac, 'projects', LOCAL_PROJECT, `${LOCAL_SID}.jsonl`), freshLine(LOCAL_SID));
    writeFixture(homePc);
    fs.appendFileSync(path.join(homePc, 'projects', PROJECT, `${SID}.jsonl`), freshLine(SID));
    mac = await launch('Test Mac', homeMac, BASE, SHARE_PORT);
    pc = await launch('Test PC', homePc, BASE + 1, BASE + 11);
  });

  afterAll(async () => {
    await pc?.app.close().catch(() => {});
    await mac?.app.close().catch(() => {});
    for (const d of [homeMac, homePc, mac?.userData, pc?.userData]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  it('runs two instances side by side (separate userData means separate single-instance locks)', async () => {
    await mac!.page.getByText('Local qwen session').first().waitFor({ timeout: 20_000 });
    await pc!.page.getByText('Retry + docs').first().waitFor({ timeout: 20_000 });
    expect(mac!.app.windows().length).toBeGreaterThan(0);
    expect(pc!.app.windows().length).toBeGreaterThan(0);
  });

  let code = '';
  it('shares from the first instance and shows a pairing code', async () => {
    const p = mac!.page;
    await p.getByTestId('nav-devices').click();
    await p.getByTestId('devices-page').waitFor();
    expect(await p.getByTestId('share-toggle').isChecked()).toBe(false);
    await p.getByTestId('share-toggle').check();
    await p.getByTestId('sharing-indicator').waitFor({ timeout: 10_000 });
    expect(await p.getByTestId('sharing-indicator').innerText()).toContain(`port ${SHARE_PORT}`);
    code = (await p.getByTestId('pair-code').innerText()).trim();
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(await p.getByTestId('pair-countdown').innerText()).toMatch(/expires in (10:00|9:\d\d)/);
    expect(await p.getByTestId('sidebar-sharing').innerText()).toContain('sharing');
    await p.screenshot({ path: path.join(ART, 'peers-sharer.png') });
  });

  it('pairs the second instance using that code', async () => {
    const p = pc!.page;
    await p.getByTestId('nav-devices').click();
    await p.getByTestId('pair-host').fill('127.0.0.1');
    await p.getByTestId('pair-port').fill(String(SHARE_PORT));
    // a wrong code first: refused, and the right code still works afterwards
    await p.getByTestId('pair-code-input').fill('ZZZZ-ZZZZ');
    await p.getByTestId('pair-submit').click();
    await p.getByText('Wrong pairing code').waitFor({ timeout: 15_000 });
    await p.getByTestId('pair-code-input').fill(code);
    await p.getByTestId('pair-submit').click();
    await p.getByText('Paired with Test Mac').waitFor({ timeout: 15_000 });
    await p.locator('[data-testid="device-row"][data-role="host"][data-online="true"]').waitFor({ timeout: 15_000 });
    await p.screenshot({ path: path.join(ART, 'peers-devices.png') });
    // the sharer lists the viewer, online
    await mac!.page.locator('[data-testid="device-row"][data-role="viewer"][data-online="true"]').waitFor({ timeout: 10_000 });
    expect(await mac!.page.getByTestId('paired-section').innerText()).toContain('Test PC');
  });

  it('groups the remote session under the other machine and opens its agent graph', async () => {
    const p = pc!.page;
    const group = p.locator('[data-testid="machine-group"][data-machine="Test Mac"]');
    await group.getByText('Local qwen session').waitFor({ timeout: 15_000 });
    expect(await group.getAttribute('data-online')).toBe('true');
    const local = p.locator('[data-testid="machine-group"][data-machine="local"]');
    expect(await local.innerText()).toContain('THIS PC');
    expect(await local.innerText()).toContain('Retry + docs');
    // remote sessions are not in the local group, and the local one is not under the Mac
    expect(await local.innerText()).not.toContain('Local qwen session');
    expect(await group.innerText()).not.toContain('Retry + docs');

    await group.getByText('Local qwen session').click();
    await p.locator('[data-agent="l1"]').waitFor({ timeout: 15_000 });
    expect(await p.locator('[data-agent="main"]').count()).toBe(1);
    expect(await p.locator('.topbar .title').first().innerText()).toContain('Test Mac');
    await p.screenshot({ path: path.join(ART, 'peers-sidebar.png') });
  });

  it('"open in Claude" on a remote session only says where it runs', async () => {
    const p = pc!.page;
    await p.getByTestId('open-in-claude').click();
    const toast = p.getByTestId('toast');
    await toast.waitFor({ timeout: 5000 });
    expect(await toast.innerText()).toBe('This session is running on Test Mac');
  });

  it('shows remote live sessions on the overview, with a machine chip', async () => {
    const p = pc!.page;
    await p.getByRole('button', { name: /all sessions/ }).click();
    const remote = p.locator(`.ov-panel[data-session^="remote:"]`);
    await remote.waitFor({ timeout: 15_000 });
    expect(await remote.locator('[data-testid="machine-chip"]').innerText()).toContain('Test Mac');
    expect(await p.locator('.ov-panel').count()).toBe(2);
    await p.screenshot({ path: path.join(ART, 'peers-overview.png') });
  });

  it('marks the machine offline when the sharer quits', async () => {
    await mac!.app.close();
    mac = { ...mac!, app: mac!.app };
    const p = pc!.page;
    const group = p.locator('[data-testid="machine-group"][data-machine="Test Mac"]');
    await p.waitForFunction(
      () => document.querySelector('[data-testid="machine-group"][data-machine="Test Mac"]')?.getAttribute('data-online') === 'false',
      null,
      {
        timeout: 15_000,
      },
    );
    expect(await group.innerText()).toMatch(/offline since|connecting/i);
  });
});
