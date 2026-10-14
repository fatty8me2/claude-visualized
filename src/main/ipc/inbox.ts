import { ipcMain } from 'electron';
import type { IpcRegistrar } from './registry';

/** Attention inbox: items derived in InboxService, pushed to renderers on the 'inbox' channel (wired in index.ts). */
export const registerInboxIpc: IpcRegistrar = ({ inbox, showInbox }) => {
  ipcMain.handle('inbox:get', () => inbox.snapshot());
  ipcMain.handle('inbox:dismiss', (_e, id: string) => {
    if (typeof id === 'string') inbox.dismiss(id);
  });
  ipcMain.handle('inbox:clear', () => inbox.clearResolved());
  ipcMain.handle('inbox:show', () => showInbox());
};
