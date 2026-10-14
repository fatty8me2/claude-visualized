// Opt-in smoke test against the real ~/.claude transcripts on this machine (read-only).
// Run with: REAL_DATA=1 npx vitest run tests/unit/real-data.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { layoutAgents } from '@core/layout';
import { SessionWatcher } from '../../src/main/watcher';

const root = path.join(process.env.CLAUDE_VIS_HOME ?? path.join(os.homedir(), '.claude'), 'projects');

describe.skipIf(!process.env.REAL_DATA)('real transcripts', () => {
  it('folds every session without throwing', async () => {
    const rows: string[] = [];
    let sessions = 0;
    let maxMs = 0;
    for (const p of fs.readdirSync(root)) {
      for (const f of fs.readdirSync(path.join(root, p)).filter((x) => x.endsWith('.jsonl'))) {
        const t = performance.now();
        const w = new SessionWatcher(f.slice(0, -6), path.join(root, p, f));
        await w.poll();
        const ms = performance.now() - t;
        maxMs = Math.max(maxMs, ms);
        sessions++;
        const s = w.state;
        const agents = Object.values(s.agents);
        const orphans = agents.filter((a) => a.kind === 'agent' && a.parentId === 'main' && a.parentToolUseId && !s.internal.seenTools[a.parentToolUseId]);
        const stillRunning = agents.filter((a) => a.kind !== 'main' && a.status === 'running');
        layoutAgents(s.agents);
        if (agents.length > 1 || s.warnings)
          rows.push(
            `${(s.title ?? '').slice(0, 34).padEnd(34)} agents=${String(agents.length - 1).padStart(3)} running=${stillRunning.length} orphans=${orphans.length} todos=${s.todos.length} warn=${s.warnings} mode=${s.mode} tok=${s.totals.in + s.totals.out} ${ms.toFixed(0)}ms`,
          );
        expect(s.eventCount).toBeGreaterThanOrEqual(0);
      }
    }
    console.log(`${sessions} sessions, slowest ${maxMs.toFixed(0)}ms\n` + rows.join('\n'));
  }, 120_000);
});
