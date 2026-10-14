import { ipcMain } from 'electron';
import type { IpcRegistrar } from './registry';

/** Auto-update: state, check now, download (when auto-download is off), restart & install. State changes are pushed on the 'updates' channel. */
export const registerUpdatesIpc: IpcRegistrar = ({ updater }) => {
  ipcMain.handle('updates:state', () => updater.state);
  ipcMain.handle('updates:check', () => updater.check());
  ipcMain.handle('updates:download', () => updater.download());
  ipcMain.handle('updates:install', () => updater.install());
};
