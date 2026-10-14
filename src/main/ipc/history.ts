import { app, BrowserWindow, ipcMain } from 'electron';
import type { SearchArgs, SummaryArgs } from '@core/history';
import { HistoryService } from '../history';
import { projectsDir } from '../paths';
import type { IpcRegistrar } from './registry';

/** History and analytics: a local SQLite index of every transcript, built by a worker thread (see src/main/history.ts). */
export const registerHistoryIpc: IpcRegistrar = () => {
  const service = new HistoryService(app.getPath('userData'), projectsDir());
  service.on('status', (s) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('history', s);
  });
  ipcMain.handle('history:status', () => service.status());
  ipcMain.handle('history:summary', (_e, a: SummaryArgs) => service.summary(a));
  ipcMain.handle('history:search', (_e, a: SearchArgs) => service.search(a));
  ipcMain.handle('history:rebuild', () => service.rebuild());
  app.on('before-quit', () => service.stop());
  if (!process.env.CLAUDE_VIS_NO_HISTORY) service.start();
};
