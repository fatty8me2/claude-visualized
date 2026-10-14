import { ipcMain } from 'electron';
import type { IpcRegistrar } from './registry';

/** Local model servers (Ollama, LM Studio, OpenAI-compatible). */
export const registerLocalIpc: IpcRegistrar = ({ getLocalMonitor }) => {
  ipcMain.handle('local:get', () => getLocalMonitor().view());
  ipcMain.handle('local:refresh', () => getLocalMonitor().refreshNow());
};
