import fs from 'node:fs';
import { app, BrowserWindow, ipcMain } from 'electron';
import { NO_PRIORS, type EtaPriors } from '@core/eta';
import type { SearchArgs, SummaryArgs } from '@core/history';
import { HistoryService } from '../history';
import { projectsDir, testOverride } from '../paths';
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
  // test-only (unpackaged builds): fixed priors from a JSON file, so e2e estimates do not depend on the fixture history
  const fixedPriors = testOverride('CLAUDE_VIS_ETA_PRIORS');
  ipcMain.handle('history:etaPriors', async (): Promise<EtaPriors> => {
    if (fixedPriors) return JSON.parse(fs.readFileSync(fixedPriors, 'utf8')) as EtaPriors;
    try {
      return await service.etaPriors();
    } catch {
      return NO_PRIORS;
    }
  });
  ipcMain.handle('history:rebuild', () => service.rebuild());
  app.on('before-quit', () => service.stop());
  if (!process.env.CLAUDE_VIS_NO_HISTORY) service.start();
};
