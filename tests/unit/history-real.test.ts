// Indexes the real ~/.claude (read-only) into a temp database and reports time and size. Run: HIST_REAL=1 npx vitest run tests/unit/history-real.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HistoryDb } from '../../src/main/historyDb';
import { runIndex } from '../../src/main/historyIndex';

describe.skipIf(!process.env.HIST_REAL)('real data index', () => {
  it('indexes everything, then re-runs cheaply', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-hist-real-'));
    const projects = path.join(process.env.CLAUDE_VIS_HOME ?? path.join(os.homedir(), '.claude'), 'projects');
    const db = new HistoryDb(path.join(tmp, 'history.db'));
    try {
      let last = 0;
      const r = await runIndex(db, {
        projectsDir: projects,
        onProgress: (p) => {
          if (p.phase === 'sessions' && Date.now() - last > 5000) {
            last = Date.now();
            console.log(`indexing ${p.done}/${p.total}`);
          }
        },
      });
      const again = await runIndex(db, { projectsDir: projects });
      const c = db.counts();
      console.log(
        `full index: ${r.ms} ms, ${r.indexed}/${r.scanned} sessions, ${(r.bytesRead / 1e6).toFixed(0)} MB read, ${c.docs} docs, db ${(db.dbBytes() / 1e6).toFixed(1)} MB; re-run ${again.ms} ms (${again.indexed} sessions)`,
      );
      const t = Date.now();
      const s = db.summary({ range: 'all', groupBy: 'day' });
      const q = db.search({ q: 'retry' });
      console.log(`summary+search ${Date.now() - t} ms; ${s.kpis.sessions} sessions, ${q.hits.length} hits`);
      expect(c.sessions).toBeGreaterThan(0);
    } finally {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 600_000);
});
