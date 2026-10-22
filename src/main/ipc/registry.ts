import type { AppConfig } from '../config';
import type { HookServer } from '../hookServer';
import type { InboxService } from '../inbox';
import type { LocalMonitor } from '../localMonitor';
import type { SessionManager } from '../manager';
import type { PeerService } from '../peer/service';
import type { SettingsSync } from '../settingsSync';
import type { SystemInfoView } from '@core/api';
import type { Updater } from '../updater';
import type { UsageView } from '@core/usage';
import { registerConfigIpc } from './config';
import { registerInboxIpc } from './inbox';
import { registerHistoryIpc } from './history';
import { registerLocalIpc } from './local';
import { registerPeersIpc } from './peers';
import { registerSessionsIpc } from './sessions';
import { registerSyncIpc } from './sync';
import { registerSystemIpc } from './system';
import { registerUpdatesIpc } from './updates';
import { registerUsageIpc } from './usage';

/**
 * What IPC handlers can reach. src/main/index.ts owns the mutable app state (config, usage, windows ...) and exposes it here through
 * getters/functions, so handler modules never import index.ts. Add a member when a new area needs something that only index.ts has.
 */
export interface IpcContext {
  manager: SessionManager;
  hookServer: HookServer;
  inbox: InboxService;
  getLocalMonitor: () => LocalMonitor;
  getConfig: () => AppConfig;
  updateConfig: (patch: Partial<AppConfig>) => AppConfig;
  getUsage: () => UsageView;
  pollUsageApi: () => Promise<{ ran: boolean; nextAllowedAt: number | null }>;
  systemInfo: () => SystemInfoView;
  applyHotkey: (accelerator: string) => { ok: boolean; error?: string; accelerator?: string };
  toggleMini: () => void;
  showMain: () => void;
  /** main window on the inbox page */
  showInbox: () => void;
  /** true once if the tray asked for the settings dialog while the window was still loading */
  takePendingOpenSettings: () => boolean;
  updater: Updater;
  peers: PeerService;
  sync: SettingsSync;
  /** turn "Share with my other computers" on or off (persisted) */
  setSharing: (on: boolean) => Promise<void>;
  setPeerPort: (port: number) => Promise<void>;
}

/** One module per area, each exporting a function that registers that area's `ipcMain.handle` channels. */
export type IpcRegistrar = (ctx: IpcContext) => void;

/**
 * Registry of IPC areas. To add IPC (inbox, history, updates ...): create src/main/ipc/<area>.ts exporting an IpcRegistrar
 * (`export const registerInboxIpc: IpcRegistrar = (ctx) => { ipcMain.handle('inbox:get', ...) }`), then add ONE line to this array.
 * Channel names are `<area>:<verb>`; the renderer-facing method goes in src/core/api.ts (VisApi) and src/preload/index.ts.
 */
export const IPC_AREAS: readonly IpcRegistrar[] = [
  registerSessionsIpc,
  registerUsageIpc,
  registerConfigIpc,
  registerSystemIpc,
  registerLocalIpc,
  registerInboxIpc,
  registerUpdatesIpc,
  registerHistoryIpc,
  registerPeersIpc,
  registerSyncIpc,
];

export function registerAllIpc(ctx: IpcContext): void {
  for (const register of IPC_AREAS) register(ctx);
}
