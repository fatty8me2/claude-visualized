import { ipcMain, shell } from 'electron';
import { CLAUDE_CODE_URL } from '@core/setupWizard';
import { detectSetup, findFreePort, openTerminalInHome } from '../setup';
import type { IpcRegistrar } from './registry';

/**
 * First-run setup wizard: what Claude Code looks like on this computer (folder, command, desktop app, signed-in account), a terminal
 * in the home folder for `claude /login`, and the download page. No channel here ever carries a token.
 */
export const registerSetupIpc: IpcRegistrar = ({ manager, getConfig }) => {
  ipcMain.handle('setup:detect', () => detectSetup(manager.getSummaries().length));
  ipcMain.handle('setup:freePort', () => findFreePort(getConfig().port));
  ipcMain.handle('setup:openTerminal', () => openTerminalInHome());
  ipcMain.handle('setup:openDownload', async () => {
    // tests must not open a real browser
    if (process.env.CLAUDE_VIS_NO_EXTERNAL) return { ok: true, url: CLAUDE_CODE_URL };
    try {
      await shell.openExternal(CLAUDE_CODE_URL);
      return { ok: true, url: CLAUDE_CODE_URL };
    } catch (e) {
      return { ok: false, url: CLAUDE_CODE_URL, error: (e as Error).message };
    }
  });
};
