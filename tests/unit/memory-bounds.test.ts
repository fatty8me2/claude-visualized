import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply } from '@core/reducer';
import { ACTIVITY_CAP, COMMANDS_CAP, FILES_CAP, LOG_CAP, MAIN, RECENT_CAP, SEEN_TOOLS_CAP, USAGE_MSGS_CAP, newSession, toView } from '@core/state';
import { SessionWatcher } from '../../src/main/watcher';
import { LARGE_SID, writeLargeSession } from '../fixtures/large';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-mem-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** everything the renderer receives and everything the main process keeps per session stays bounded however long the session runs */
describe('memory bounds over a long session', () => {
  it('per-agent arrays and the log are capped, and bookkeeping does not grow with each repeated tool call', async () => {
    const big = writeLargeSession(home, { agents: 40, toolCalls: 8000, running: 10 });
    const w = new SessionWatcher(LARGE_SID, big.mainFile);
    await w.poll();
    const snapshot = () => {
      const v = toView(w.state);
      for (const a of Object.values(v.agents)) {
        expect(a.activity.length).toBeLessThanOrEqual(ACTIVITY_CAP);
        expect(a.recent.length).toBeLessThanOrEqual(RECENT_CAP);
        expect(a.files.length).toBeLessThanOrEqual(FILES_CAP);
        expect(a.commands.length).toBeLessThanOrEqual(COMMANDS_CAP);
      }
      expect(v.log.length).toBeLessThanOrEqual(LOG_CAP * 1.2 + 1);
      return { log: v.log.length, view: JSON.stringify(v).length, pending: Object.keys(w.state.internal.pending).length };
    };
    const before = snapshot();
    // a simulated "hour" of appends: 40 batches of 100 calls
    for (let i = 0; i < 40; i++) {
      big.append(100);
      await w.poll();
    }
    const after = snapshot();
    // the pushed view does not grow with the number of tool calls (only new agents or longer titles could add to it)
    expect(after.view).toBeLessThan(before.view * 1.15);
    // no leak of in-flight tool calls: every call in the generator is answered
    expect(after.pending).toBeLessThanOrEqual(before.pending + 2);
    expect(w.state.eventCount).toBeGreaterThan(8000);
  });

  it('reducer bookkeeping (seen tool ids, per-message usage) stops growing past its caps, without losing the totals', () => {
    const s = newSession('long');
    const ref = { sessionId: 'long', agentId: null };
    const n = SEEN_TOOLS_CAP + 12_000;
    for (let i = 0; i < n; i++) {
      const ts = 1_000 + i;
      apply(s, { ts, src: 'transcript', ref, k: 'tool.start', toolUseId: `t${i}`, name: 'Read', input: { file_path: `f${i % 40}.ts` } });
      apply(s, { ts: ts + 1, src: 'transcript', ref, k: 'tool.end', toolUseId: `t${i}`, ok: true });
      apply(s, { ts: ts + 1, src: 'transcript', ref, k: 'usage', msgId: `m${i}`, usage: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 } });
    }
    expect(Object.keys(s.internal.seenTools).length).toBeLessThanOrEqual(SEEN_TOOLS_CAP);
    expect(Object.keys(s.internal.usage[MAIN]).length).toBeLessThanOrEqual(USAGE_MSGS_CAP * 1.5 + 1);
    expect(Object.keys(s.internal.pending).length).toBe(0);
    expect(s.agents[MAIN].toolCount).toBe(n);
    expect(s.totals.in).toBe(n);
    // a repeated copy of a recent call is still ignored
    apply(s, { ts: 9e9, src: 'hook', ref, k: 'tool.start', toolUseId: `t${n - 1}`, name: 'Read', input: {} });
    expect(s.agents[MAIN].toolCount).toBe(n);
  });
});
