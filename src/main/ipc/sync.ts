import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { detectSyncFolders, type DetectFs, type SyncChoice, type SyncDetectView } from '@core/settingsSync';
import { testOverride } from '../paths';
import type { IpcRegistrar } from './registry';

/** a slow or disconnected drive letter must not stall the settings dialog */
const within = <T>(p: Promise<T>, fallback: T, ms = 1500): Promise<T> => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

const realFs: DetectFs = {
  isDir: (p) =>
    within(
      fs.promises.stat(p).then(
        (s) => s.isDirectory(),
        () => false,
      ),
      false,
    ),
  listDir: (p) => within(fs.promises.readdir(p).catch(() => [] as string[]), []),
};

async function detect(): Promise<SyncDetectView> {
  // CLAUDE_VIS_SYNC_ROOTS (tests only, ignored in an installed build): folders standing in for "My Drive"
  const roots = testOverride('CLAUDE_VIS_SYNC_ROOTS');
  const folders = await detectSyncFolders({
    platform: process.platform,
    home: os.homedir(),
    fs: realFs,
    join: path.join,
    testRoots: roots ? roots.split(path.delimiter).filter(Boolean) : undefined,
  });
  return { folders, driveFound: folders.some((f) => f.kind === 'google') };
}

/** Settings sync: status, folder detection, turning it on / off, and the renderer's localStorage values going in and out. */
export const registerSyncIpc: IpcRegistrar = ({ sync }) => {
  ipcMain.handle('sync:status', () => sync.status());
  ipcMain.handle('sync:detect', () => detect());
  ipcMain.handle('sync:pick', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { title: 'Choose a synced folder', properties: ['openDirectory' as const] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  ipcMain.handle('sync:enable', (_e, root: string, choice?: SyncChoice) =>
    sync.enable(String(root ?? ''), choice === 'drive' || choice === 'local' || choice === 'merge' ? choice : undefined),
  );
  ipcMain.handle('sync:disable', () => sync.disable());
  ipcMain.handle('sync:now', async () => {
    await sync.syncNow();
    return sync.status();
  });
  ipcMain.handle('sync:openFolder', () => {
    const s = sync.status();
    if (s.folder) void shell.openPath(fs.existsSync(s.folder) ? s.folder : (s.root ?? s.folder));
  });
  ipcMain.handle('sync:report', (_e, values: Record<string, string | null>, all: boolean) => {
    if (values && typeof values === 'object') sync.report(values, all === true);
  });
};
