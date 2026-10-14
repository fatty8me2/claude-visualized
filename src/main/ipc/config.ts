import path from 'node:path';
import { app, ipcMain } from 'electron';
import type { AppConfig } from '../config';
import { applyHooks, getHookState, previewHooks } from '../installer';
import type { IpcRegistrar } from './registry';

/** App config, the hook receiver's status, and installing / previewing the Claude Code hooks. */
export const registerConfigIpc: IpcRegistrar = ({ hookServer, getConfig, updateConfig }) => {
  ipcMain.handle('config:get', () => getConfig());
  ipcMain.handle('config:set', (_e, patch: Partial<AppConfig>) => updateConfig(patch));
  ipcMain.handle('hookserver:status', () => hookServer.status);
  ipcMain.handle('hooks:state', () => getHookState(getConfig().port));
  ipcMain.handle('hooks:preview', (_e, action: 'install' | 'uninstall') => previewHooks(action, getConfig().port));
  ipcMain.handle('hooks:apply', async (_e, action: 'install' | 'uninstall') => {
    try {
      const r = await applyHooks(action, getConfig().port, path.join(app.getPath('userData'), 'backups'));
      return { ok: true, backup: r.backup };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
};
