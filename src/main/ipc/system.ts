import fs from 'node:fs';
import { ipcMain, shell } from 'electron';
import { projectsDir } from '../paths';
import type { IpcRegistrar } from './registry';

/** OS integration and window plumbing: login item / hotkey info, mini window, tray-requested settings, first-run setup status. */
export const registerSystemIpc: IpcRegistrar = ({ manager, systemInfo, applyHotkey, takePendingOpenSettings, toggleMini, showMain }) => {
  ipcMain.handle('system:info', () => systemInfo());
  ipcMain.handle('hotkey:apply', (_e, acc: string) => applyHotkey(String(acc ?? '')));
  ipcMain.handle('ui:takeOpenSettings', () => takePendingOpenSettings());
  ipcMain.handle('mini:toggle', () => toggleMini());
  ipcMain.handle('main:show', () => showMain());
  ipcMain.handle('setup:status', () => ({
    projectsDir: projectsDir(),
    projectsDirExists: fs.existsSync(projectsDir()),
    sessionCount: manager.getSummaries().length,
    skipOnboarding: !!process.env.CLAUDE_VIS_SKIP_ONBOARDING,
  }));
  ipcMain.handle('path:open', (_e, p: string) => {
    shell.showItemInFolder(p);
  });
};
