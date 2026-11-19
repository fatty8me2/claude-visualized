import fs from 'node:fs';
import { ipcMain } from 'electron';
import type { KilnStatusView } from '@core/api';
import { kilnTitle, runEnded } from '@core/kiln';
import { kilnSessionId } from '../kiln';
import type { IpcRegistrar } from './registry';

/** Local model servers (Ollama, LM Studio, OpenAI-compatible). */
export const registerLocalIpc: IpcRegistrar = ({ getLocalMonitor, manager }) => {
  ipcMain.handle('kiln:status', (): KilnStatusView => {
    const k = manager.kiln;
    const runs = k.runs();
    const r = runs[0];
    const c = k.log.status;
    return {
      enabled: k.enabled,
      file: k.file,
      found: !!k.file && fs.existsSync(k.file),
      check: c ? { ts: c.ts, profile: c.profile, model: c.model, baseUrl: c.baseUrl, reachable: c.reachable, detail: c.detail } : null,
      runs: runs.length,
      running: runs.filter((x) => !runEnded(x)).length,
      last: r
        ? {
            title: kilnTitle(r.task),
            at: r.lastAt,
            ok: r.lost ? false : r.ok,
            model: r.model,
            seconds: r.seconds,
            tokensPerSec: r.tokensPerSec,
            sessionId: k.claimedBy(r.id) ?? (manager.getSummaries().some((s) => s.id === kilnSessionId(r.id)) ? kilnSessionId(r.id) : null),
          }
        : null,
    };
  });
  ipcMain.handle('local:get', () => getLocalMonitor().view());
  ipcMain.handle('local:refresh', () => getLocalMonitor().refreshNow());
};
