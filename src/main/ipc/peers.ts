import { ipcMain } from 'electron';
import type { IpcRegistrar } from './registry';

/** webContents ids with the Devices page open (LAN discovery listens only while one is) */
const discovering = new Set<number>();

/** Peer link (docs/PEER-LINK.md): sharing, pairing codes, discovery, pairing and un-pairing. Status is pushed on the 'peers' channel. */
export const registerPeersIpc: IpcRegistrar = ({ peers, setSharing, setPeerPort }) => {
  ipcMain.handle('peers:status', () => peers.status());
  ipcMain.handle('peers:share', async (_e, on: unknown) => {
    await setSharing(on === true);
    return peers.status();
  });
  ipcMain.handle('peers:newCode', () => {
    if (peers.isSharing) peers.newCode();
    return peers.status();
  });
  ipcMain.handle('peers:discover', (e, on: unknown) => {
    const id = e.sender.id;
    if (on === true) {
      if (!discovering.has(id))
        e.sender.once('destroyed', () => {
          discovering.delete(id);
          peers.setDiscovering(discovering.size > 0);
        });
      discovering.add(id);
    } else discovering.delete(id);
    peers.setDiscovering(discovering.size > 0);
  });
  ipcMain.handle('peers:pair', (_e, a: { host?: unknown; port?: unknown; code?: unknown }) => {
    if (!a || typeof a.host !== 'string' || typeof a.code !== 'string') return { ok: false, error: 'Enter a host and a code.' };
    return peers.pair(a.host, Number(a.port), a.code);
  });
  ipcMain.handle('peers:unpair', (_e, key: unknown) => {
    if (typeof key === 'string') peers.unpair(key);
    return peers.status();
  });
  ipcMain.handle('peers:port', async (_e, port: unknown) => {
    await setPeerPort(Number(port));
    return peers.status();
  });
};
