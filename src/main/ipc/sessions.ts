import { ipcMain, shell } from 'electron';
import { isRemoteId } from '@core/remote';
import type { OpenInClaudeResult } from '@core/api';
import type { IpcRegistrar } from './registry';

/** webContents ids currently showing the overview page */
const overviewWatchers = new Set<number>();
/** webContents ids that already have a 'destroyed' listener */
const hookedSenders = new Set<number>();

/** Sessions: list, selection, live state, replay, overview and "open in Claude". */
export const registerSessionsIpc: IpcRegistrar = ({ manager, updateConfig, peers }) => {
  ipcMain.handle('session:openInClaude', async (_e, id: string): Promise<OpenInClaudeResult> => {
    // another computer's session: never open anything here (the peer link is read-only)
    if (isRemoteId(id)) {
      const machine = peers.machineOf(id) ?? 'another computer';
      return { ok: false, machine, error: `This session is running on ${machine}` };
    }
    const url = manager.deepLink(id);
    // tests must not launch the real Claude app
    if (process.env.CLAUDE_VIS_NO_EXTERNAL) return { ok: true, url };
    try {
      await shell.openExternal(url);
      return { ok: true, url };
    } catch (err) {
      return { ok: false, url, error: (err as Error).message };
    }
  });
  ipcMain.handle('overview:get', () => manager.snapshotOverview());
  ipcMain.handle('overview:watch', (e, on: boolean) => {
    const id = e.sender.id;
    if (on) {
      // one 'destroyed' listener per window, however often the overview page is opened
      if (!hookedSenders.has(id)) {
        hookedSenders.add(id);
        e.sender.once('destroyed', () => {
          hookedSenders.delete(id);
          overviewWatchers.delete(id);
          manager.overviewViewers = overviewWatchers.size;
        });
      }
      overviewWatchers.add(id);
      manager.markOverviewDirty();
    } else overviewWatchers.delete(id);
    manager.overviewViewers = overviewWatchers.size;
  });
  ipcMain.handle('sessions:get', () => manager.getSummaries());
  ipcMain.handle('state:get', () => manager.snapshotState());
  ipcMain.handle('selected:get', () => manager.selected);
  // selecting turns follow off; the manager emits 'follow' and index.ts saves it
  ipcMain.handle('session:select', (_e, id: string | null) => manager.select(id));
  ipcMain.handle('follow:set', (_e, on: boolean) => {
    updateConfig({ followActive: on });
  });
  ipcMain.handle('replay:events', (_e, id: string) => manager.replayEvents(id));
};
