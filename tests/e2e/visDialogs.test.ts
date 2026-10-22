// Visual check of the Devices page, the Local models page, the Settings dialog and the onboarding tour (0.6 polish). Screenshots go to
// tests/e2e/artifacts/vis-dialogs-*.png. Run `electron-vite build` first. Hook port: E2E_PORT+2; peer port: E2E_PORT+12.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_MAIN_MODEL, LOCAL_PROJECT, LOCAL_SID, SID, writeFixture, writeLocalFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const BASE = Number(process.env.E2E_PORT ?? 47899);

const freshLine = (sid: string) => JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: sid, timestamp: new Date().toISOString() }) + '\n';

async function launch(env: Record<string, string>, userData: string) {
  const app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      CLAUDE_VIS_USER_DATA: userData,
      CLAUDE_VIS_PORT: String(BASE + 2),
      CLAUDE_VIS_PEER_PORT: String(BASE + 12),
      CLAUDE_VIS_PEER_BIND: '127.0.0.1',
      CLAUDE_VIS_NO_DISCOVERY: '1',
      CLAUDE_VIS_DEVICE_NAME: 'Visual Check',
      CLAUDE_VIS_NO_TRAY: '1',
      CLAUDE_VIS_NO_EXTERNAL: '1',
      CLAUDE_VIS_NO_SYSTEM_INTEGRATION: '1',
      CLAUDE_VIS_NO_USAGE_API: '1',
      CLAUDE_VIS_SKIP_ONBOARDING: '1',
      CLAUDE_VIS_NO_UPDATES: '1',
      CLAUDE_VIS_DESKTOP_DIR: path.join(userData, 'no-desktop'),
      ...env,
    } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
  return { app, page };
}

/** A tiny fake Ollama with one loaded model (only the routes the local page reads). */
function startFakeOllama(): Promise<{ server: http.Server; url: string }> {
  const GB = 1024 ** 3;
  const size = Math.round(18.2 * GB);
  const routes: Record<string, unknown> = {
    '/api/version': { version: '0.12.3' },
    '/api/ps': {
      models: [
        {
          name: LOCAL_MAIN_MODEL,
          model: LOCAL_MAIN_MODEL,
          size,
          size_vram: size,
          digest: 'a'.repeat(64),
          details: { parent_model: '', format: 'gguf', family: 'qwen2', families: ['qwen2'], parameter_size: '32.8B', quantization_level: 'Q4_K_M' },
          expires_at: new Date(Date.now() + 4 * 60_000).toISOString(),
          context_length: 32768,
        },
      ],
    },
    '/api/tags': {
      models: [
        { name: LOCAL_MAIN_MODEL, model: LOCAL_MAIN_MODEL, size, details: { family: 'qwen2', parameter_size: '32.8B', quantization_level: 'Q4_K_M' } },
        { name: 'llama3.2:latest', model: 'llama3.2:latest', size: 2_019_393_189, details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' } },
      ],
    },
    '/api/show': { model_info: { 'qwen2.context_length': 32768 }, capabilities: ['completion', 'tools'] },
  };
  const server = http.createServer((req, res) => {
    const body = routes[req.url ?? ''];
    if (body === undefined) {
      res.writeHead(404).end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

describe('visual check: devices, local models, settings and the tour', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;
  let fake: { server: http.Server; url: string };

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    fake = await startFakeOllama();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-vis-home-'));
    writeLocalFixture(home);
    writeFixture(home);
    fs.appendFileSync(path.join(home, 'projects', LOCAL_PROJECT, `${LOCAL_SID}.jsonl`), freshLine(LOCAL_SID));
    fs.appendFileSync(path.join(home, 'projects', 'C--demo-app', `${SID}.jsonl`), freshLine(SID));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-vis-ud-'));
    ({ app, page } = await launch({ CLAUDE_VIS_HOME: home, CLAUDE_VIS_OLLAMA_URL: fake.url, CLAUDE_VIS_LMSTUDIO_URL: 'off' }, userData));
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
    fake?.server.closeAllConnections();
    fake?.server.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('devices: a glowing pairing code with a countdown ring', async () => {
    await page.getByTestId('nav-devices').click();
    await page.getByTestId('devices-page').waitFor();
    await page.getByTestId('share-toggle').check();
    await page.getByTestId('pair-code').waitFor({ timeout: 15_000 });
    expect(await page.locator('.pair-ring').count()).toBe(1);
    expect(await page.getByTestId('pair-countdown').innerText()).toMatch(/expires in (10:00|9:\d\d)/);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(ART, 'vis-dialogs-devices.png') });
  });

  it('local models: server tiles with a breathing light and model chips', async () => {
    await page.getByTestId('nav-local').click();
    await page.getByTestId('local-page').waitFor();
    await page.getByTestId('local-server').waitFor({ timeout: 15_000 });
    expect(await page.getByTestId('loaded-model').count()).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(ART, 'vis-dialogs-local.png') });
  });

  it('settings: a glass modal with section headers and glowing switches; Escape closes it with a fade', async () => {
    await page.getByRole('button', { name: /hooks/ }).click();
    await page.getByTestId('updates-settings').waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(ART, 'vis-dialogs-settings.png') });
    expect(await page.locator('.dialog .dlg-sec').count()).toBeGreaterThanOrEqual(3);
    await page.keyboard.press('Escape');
    await page.locator('.dialog').first().waitFor({ state: 'detached', timeout: 5_000 });
  });

  it('onboarding: the tour spotlight', async () => {
    await app.close();
    const tourUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-vis-tour-'));
    try {
      ({ app, page } = await launch({ CLAUDE_VIS_HOME: home, CLAUDE_VIS_SKIP_ONBOARDING: '' }, tourUserData));
      await page.getByTestId('setup-wizard').waitFor({ timeout: 20_000 });
      for (let i = 0; i < 4; i++) await page.getByTestId('setup-next').click();
      await page.getByTestId('setup-tour').click();
      await page.getByTestId('tour').waitFor();
      await page.locator('.tour-spot').waitFor({ timeout: 10_000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(ART, 'vis-dialogs-tour.png') });
      await page.getByTestId('tour-next').click();
      await page.getByTestId('tour-next').click();
      expect((await page.getByTestId('tour-count').textContent())?.toLowerCase()).toContain('step 3 of');
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(ART, 'vis-dialogs-tour-2.png') });
    } finally {
      await app.close().catch(() => {});
      fs.rmSync(tourUserData, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
