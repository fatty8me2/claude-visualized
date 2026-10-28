// OpenCode sessions end to end: a fake OpenCode data folder (SQLite, as OpenCode 1.x writes it) is pointed at by "Test Mac", which shares over the
// peer link with "Test PC". Checks the sidebar row and badge, the graph (main + subagent), the local-model tag, the current tool, that a tool
// written to the database shows on screen within ~1 s, and that the PC sees the same session and the same live update.
// Run `npx electron-vite build` first. Ports: E2E_PORT, E2E_PORT+1 (hooks), +10/+11 (peer link).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addRunningBash, CHILD, finishBash, MAIN, OC_TITLE, seedDb } from '../fixtures/opencode/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const BASE = Number(process.env.E2E_PORT ?? 47899);
const SHARE_PORT = BASE + 10;

async function launch(name: string, claudeHome: string, ocDir: string | null, hookPort: number, peerPort: number) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-oc-ud-'));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_VIS_HOME: claudeHome,
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
  };
  if (ocDir) env.CLAUDE_VIS_OPENCODE_HOME = ocDir;
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
  return { app, page, userData };
}

/** ms until `text` is on screen after `write()` ran */
async function visibleAfter(page: Page, write: () => void, text: string, timeout = 8000): Promise<number> {
  const t0 = Date.now();
  write();
  await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout, polling: 25 });
  return Date.now() - t0;
}

describe('OpenCode sessions (fake data folder)', () => {
  let homeMac: string;
  let homePc: string;
  let ocDir: string;
  let mac: Awaited<ReturnType<typeof launch>>;
  let pc: Awaited<ReturnType<typeof launch>>;
  let db: ReturnType<typeof seedDb>;
  const latencies: Record<string, number> = {};

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    homeMac = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-oc-mac-'));
    homePc = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-oc-pc-'));
    ocDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-oc-data-'));
    for (const h of [homeMac, homePc]) fs.mkdirSync(path.join(h, 'projects'), { recursive: true });
    db = seedDb(ocDir);
    mac = await launch('Test Mac', homeMac, ocDir, BASE, SHARE_PORT);
    pc = await launch('Test PC', homePc, null, BASE + 1, BASE + 11);
  });

  afterAll(async () => {
    await pc?.app.close().catch(() => {});
    await mac?.app.close().catch(() => {});
    db?.close();
    for (const d of [homeMac, homePc, ocDir, mac?.userData, pc?.userData]) if (d) fs.rmSync(d, { recursive: true, force: true });
    fs.writeFileSync(path.join(ART, 'opencode-latency.json'), JSON.stringify(latencies));
  });

  it('lists the session in the sidebar with an OpenCode badge, and not the subagent session', async () => {
    const p = mac.page;
    const row = p.locator(`[data-session="${MAIN}"]`);
    await row.waitFor({ timeout: 20_000 });
    expect(await row.innerText()).toContain(OC_TITLE);
    expect(await row.getByTestId('oc-badge').count()).toBe(1);
    expect(await p.locator(`[data-session="${CHILD}"]`).count()).toBe(0);
  });

  it('draws the main agent and its subagent, tagged as a local model', async () => {
    const p = mac.page;
    await p.locator(`[data-session="${MAIN}"]`).click();
    await p.locator('[data-agent="main"]').waitFor({ timeout: 15_000 });
    await p.locator(`[data-agent="${CHILD}"]`).waitFor({ timeout: 15_000 });
    expect(await p.locator('[data-agent="main"]').getByTestId('local-tag').count()).toBe(1);
    expect(await p.locator('[data-agent="main"]').innerText()).toMatch(/qwen/i);
    expect(await p.locator(`[data-agent="${CHILD}"]`).innerText()).toMatch(/explore/i);
  });

  it('shows a tool written to the database on screen within about a second', async () => {
    const p = mac.page;
    const ms = await visibleAfter(p, () => addRunningBash(db, Date.now(), 'prt_live1', 'npm run build:prod'), 'npm run build:prod');
    latencies.macLocal = ms;
    expect(ms).toBeLessThan(1500);
    expect(await p.locator('[data-agent="main"]').innerText()).toMatch(/Run the tests|npm run build:prod/);
    await p.screenshot({ path: path.join(ART, 'opencode-graph.png') });
  });

  it('lists the OpenCode session on the overview', async () => {
    const p = mac.page;
    await p.getByRole('button', { name: /all sessions/ }).click();
    const panel = p.locator(`.ov-panel[data-session="${MAIN}"]`);
    await panel.waitFor({ timeout: 10_000 });
    expect(await panel.innerText()).toContain('OpenCode');
    await p.screenshot({ path: path.join(ART, 'opencode-overview.png') });
  });

  let code = '';
  it('shares the session over the peer link', async () => {
    const m = mac.page;
    await m.getByTestId('nav-devices').click();
    await m.getByTestId('share-toggle').check();
    await m.getByTestId('sharing-indicator').waitFor({ timeout: 10_000 });
    code = (await m.getByTestId('pair-code').innerText()).trim();
    const p = pc.page;
    await p.getByTestId('nav-devices').click();
    await p.getByTestId('pair-host').fill('127.0.0.1');
    await p.getByTestId('pair-port').fill(String(SHARE_PORT));
    await p.getByTestId('pair-code-input').fill(code);
    await p.getByTestId('pair-submit').click();
    await p.getByText('Paired with Test Mac').waitFor({ timeout: 15_000 });
    const group = p.locator('[data-testid="machine-group"][data-machine="Test Mac"]');
    await group.getByText(OC_TITLE).waitFor({ timeout: 15_000 });
    await group.getByText(OC_TITLE).click();
    await p.locator(`[data-agent="${CHILD}"]`).waitFor({ timeout: 15_000 });
    expect(await p.locator('[data-agent="main"]').getByTestId('local-tag').count()).toBe(1);
  });

  it('the PC sees a new tool from the Mac live', async () => {
    const p = pc.page;
    finishBash(db, Date.now(), 'prt_live1', 'npm run build:prod');
    const ms2 = await visibleAfter(p, () => addRunningBash(db, Date.now() + 1000, 'prt_live2', 'cargo test --release'), 'cargo test --release');
    latencies.pcRemote = ms2;
    expect(ms2).toBeLessThan(2500);
    await p.waitForTimeout(600);
    await p.screenshot({ path: path.join(ART, 'opencode-peer-pc.png') });
  });
});
