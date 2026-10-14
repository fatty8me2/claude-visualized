import fs from 'node:fs';
import { ipcMain } from 'electron';
import { settingsPath } from '../paths';
import type { IpcRegistrar } from './registry';

/** Plan usage meters, and the model set in Claude's own settings.json. */
export const registerUsageIpc: IpcRegistrar = ({ getUsage, pollUsageApi }) => {
  ipcMain.handle('usage:get', () => getUsage());
  ipcMain.handle('claude:model', () => {
    try {
      const m = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))?.model;
      return typeof m === 'string' ? m : null;
    } catch {
      return null;
    }
  });
  ipcMain.handle('usage:refresh', () => pollUsageApi());
};
