import { ipcMain } from 'electron';
import type { IpcRegistrar } from './registry';

/** SSH remotes (docs/SSH-REMOTES.md): add and remove computers watched without the app on them. Status is pushed on the 'ssh' channel. */
export const registerSshIpc: IpcRegistrar = ({ ssh }) => {
  ipcMain.handle('ssh:status', () => ssh.status());
  ipcMain.handle('ssh:add', (_e, a: { target?: unknown; port?: unknown; label?: unknown }) => {
    if (!a || typeof a.target !== 'string') return { ok: false, error: 'Enter the other computer as user@host.' };
    const port = a.port === undefined || a.port === null || a.port === '' ? null : Number(a.port);
    return ssh.add(a.target, port, typeof a.label === 'string' ? a.label : undefined);
  });
  ipcMain.handle('ssh:remove', (_e, id: unknown) => {
    if (typeof id === 'string') ssh.remove(id);
    return ssh.status();
  });
};
