// F11 toggles fullscreen for the main window, whatever has focus in the page (src/main/index.ts, before-input-event).
// Run `npx electron-vite build` first. The window stays off-screen (vitest.e2e.config.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.E2E_PORT ?? 47899);

describe('F11 fullscreen', () => {
  let app: ElectronApplication;
  let page: Page;
  let userData: string;
  let home: string;

  beforeAll(async () => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-fs-ud-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-fs-home-'));
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
    await page.getByTestId('titlebar').waitFor({ timeout: 20_000 });
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  const isFullScreen = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen());
  const hasClass = () => page.evaluate(() => document.documentElement.classList.contains('is-fullscreen'));

  // Playwright's keyboard reaches the page but not Electron's before-input-event on this unfocused, off-screen window
  // (verified), so F11 is delivered with webContents.sendInputEvent, which goes through the same browser-side input path.
  const pressF11 = () =>
    app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'F11' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'F11' });
    });

  it('F11 enters and leaves fullscreen, and the renderer follows', async () => {
    await pressF11();
    await expect.poll(isFullScreen, { timeout: 10_000 }).toBe(true);
    await expect.poll(hasClass, { timeout: 10_000 }).toBe(true);

    await pressF11();
    await expect.poll(isFullScreen, { timeout: 10_000 }).toBe(false);
    await expect.poll(hasClass, { timeout: 10_000 }).toBe(false);
  });

  it('Escape does not leave fullscreen (dialogs own Escape)', async () => {
    await pressF11();
    await expect.poll(isFullScreen, { timeout: 10_000 }).toBe(true);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    expect(await isFullScreen()).toBe(true);
    await pressF11();
    await expect.poll(isFullScreen, { timeout: 10_000 }).toBe(false);
  });
});
