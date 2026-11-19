import fs from 'node:fs';
import { app, BrowserWindow, ipcMain } from 'electron';
import { NO_PRIORS, type EtaPriors } from '@core/eta';
import { buildCmdPriors, NO_CMD_PRIORS, type CmdPriors } from '@core/cmdEta';
import { kilnAgentId, kilnDurations, kilnTitle, sameDir, searchKilnRuns } from '@core/kiln';
import { kilnSessionId } from '../kiln';
import { projectName, type SearchArgs, type SearchHit, type SearchResult, type SummaryArgs } from '@core/history';
import { HistoryService } from '../history';
import { projectsDir, testOverride } from '../paths';
import type { IpcRegistrar } from './registry';

/** History and analytics: a local SQLite index of every transcript, built by a worker thread (see src/main/history.ts). */
export const registerHistoryIpc: IpcRegistrar = ({ manager }) => {
  const service = new HistoryService(app.getPath('userData'), projectsDir());
  service.on('status', (s) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('history', s);
  });
  ipcMain.handle('history:status', () => service.status());
  ipcMain.handle('history:summary', (_e, a: SummaryArgs) => service.summary(a));
  ipcMain.handle('history:search', async (_e, a: SearchArgs) => {
    const res = await service.search(a);
    try {
      return withKilnHits(res, a);
    } catch {
      return res;
    }
  });
  // Kiln runs (the local model's briefs, answers and messages) are not in the transcript index: search them in memory and open
  // the session that shows the run (the Claude session that handed it off, or the run's own)
  const withKilnHits = (res: SearchResult, a: SearchArgs): SearchResult => {
    if (res.empty || !manager.kiln.enabled) return res;
    const sums = manager.getSummaries();
    const hits: SearchHit[] = [];
    for (const h of searchKilnRuns(manager.kiln.runs(), a.q, 10)) {
      const r = h.run;
      const own = kilnSessionId(r.id);
      const claimed = manager.kiln.claimedBy(r.id);
      const sid =
        claimed ??
        (sums.some((s) => s.id === own)
          ? own
          : sums
              .filter((s) => !s.source && s.cwd && sameDir(s.cwd, r.cwd) && s.mtime >= r.startedAt)
              .sort((x, y) => x.mtime - y.mtime)[0]?.id);
      if (!sid) continue;
      const project = projectName(r.cwd || null, 'kiln');
      if (a.project && a.project !== project) continue;
      const title = sums.find((s) => s.id === sid)?.title ?? kilnTitle(r.task);
      hits.push({ sessionId: sid, title, project, ts: r.startedAt, kind: h.field === 'task' ? 'prompt' : 'assistant', agentId: sid === own ? 'main' : kilnAgentId(r.id), agent: 'Kiln (local model)', snippet: h.snippet });
    }
    return hits.length ? { ...res, hits: [...hits, ...res.hits].slice(0, Math.max(a.limit ?? 40, hits.length)) } : res;
  };
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
  // the same for running shell commands (src/core/cmdEta.ts)
  const fixedCmdPriors = testOverride('CLAUDE_VIS_CMD_PRIORS');
  ipcMain.handle('history:cmdPriors', async (): Promise<CmdPriors> => {
    if (fixedCmdPriors) return withKiln(JSON.parse(fs.readFileSync(fixedCmdPriors, 'utf8')) as CmdPriors);
    try {
      return withKiln(await service.cmdPriors());
    } catch {
      return withKiln(NO_CMD_PRIORS);
    }
  });
  // past Kiln hand-offs (its events file, src/main/kiln.ts) time a running delegate_task call like a command
  const withKiln = (p: CmdPriors): CmdPriors => {
    const k = buildCmdPriors(kilnDurations(manager.kiln.runs()), p.at || Date.now());
    if (!Object.keys(k.all).length) return p;
    const byProject = { ...p.byProject };
    for (const [proj, keys] of Object.entries(k.byProject)) byProject[proj] = { ...byProject[proj], ...keys };
    return { at: p.at || k.at, all: { ...p.all, ...k.all }, byProject };
  };
  ipcMain.handle('history:rebuild', () => service.rebuild());
  app.on('before-quit', () => service.stop());
  if (!process.env.CLAUDE_VIS_NO_HISTORY) service.start();
};
