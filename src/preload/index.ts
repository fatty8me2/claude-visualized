import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { VisApi } from '@core/api';

function on<T>(channel: string, cb: (v: T) => void): () => void {
  const fn = (_e: IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

const api: VisApi = {
  platform: process.platform,
  isMini: process.argv.includes('--vis-mini'),
  getSessions: () => ipcRenderer.invoke('sessions:get'),
  getState: () => ipcRenderer.invoke('state:get'),
  getSelected: () => ipcRenderer.invoke('selected:get'),
  select: (id) => ipcRenderer.invoke('session:select', id),
  setFollow: (on) => ipcRenderer.invoke('follow:set', on),
  onSessions: (cb) => on('sessions', cb),
  onState: (cb) => on('state', cb),
  onSelected: (cb) => on('selected', cb),
  replayEvents: (id) => ipcRenderer.invoke('replay:events', id),
  getOverview: () => ipcRenderer.invoke('overview:get'),
  watchOverview: (on) => ipcRenderer.invoke('overview:watch', on),
  onOverview: (cb) => on('overview', cb),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  onConfig: (cb) => on('config', cb),
  hookServerStatus: () => ipcRenderer.invoke('hookserver:status'),
  onHookServerStatus: (cb) => on('hookserver', cb),
  hookState: () => ipcRenderer.invoke('hooks:state'),
  hookPreview: (action) => ipcRenderer.invoke('hooks:preview', action),
  hookApply: (action) => ipcRenderer.invoke('hooks:apply', action),
  getUsage: () => ipcRenderer.invoke('usage:get'),
  refreshUsage: () => ipcRenderer.invoke('usage:refresh'),
  onUsage: (cb) => on('usage', cb),
  openInClaude: (id) => ipcRenderer.invoke('session:openInClaude', id),
  toggleMini: () => ipcRenderer.invoke('mini:toggle'),
  showMain: () => ipcRenderer.invoke('main:show'),
  openPath: (p) => ipcRenderer.invoke('path:open', p),
};

contextBridge.exposeInMainWorld('api', api);
