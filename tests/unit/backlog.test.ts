import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeHook } from '@core/normalize';
import { loadBacklogInProcess, SessionWatcher, type BacklogLoader } from '../../src/main/watcher';
import { SID, writeFixture } from '../fixtures/build';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

// structuredClone mimics the worker boundary
const cloning: BacklogLoader = async (...a) => structuredClone(await loadBacklogInProcess(...a));

const asstLine = (agentId: string | null, id: string, tool: string, ts: number) =>
  JSON.stringify({ type: 'assistant', isSidechain: !!agentId, ...(agentId ? { agentId } : {}), sessionId: SID, timestamp: new Date(ts).toISOString(), message: { id, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `toolu_${id}`, name: tool, input: { command: 'echo' } }], usage: { input_tokens: 7, output_tokens: 3 } } }) + '\n';

const mainBash = (w: SessionWatcher) => w.state.log.filter((l) => l.text.startsWith('Bash') && l.agentId === 'main').length;

describe('off-thread backlog load', () => {
  it('matches the synchronous load and continues tailing exactly once', async () => {
    const { mainFile, sessionDir } = writeFixture(home, { truncatedTail: true });
    const sync = new SessionWatcher(SID, mainFile);
    const viaLoader = new SessionWatcher(SID, mainFile, cloning);
    await sync.poll();
    await viaLoader.poll();
    expect(viaLoader.primed).toBe(true);
    expect(viaLoader.state).toEqual(sync.state);

    // complete the half-written main line, then append whole lines to main, a subagent and a workflow agent
    const t = Date.now();
    fs.appendFileSync(mainFile, 'ne"}}\n');
    fs.appendFileSync(mainFile, asstLine(null, 'mx', 'Bash', t));
    fs.appendFileSync(path.join(sessionDir, 'subagents', 'agent-a2.jsonl'), asstLine('a2', 'm_a2x', 'Grep', t + 1));
    fs.appendFileSync(path.join(sessionDir, 'subagents', 'workflows', 'wf_x', 'agent-w2.jsonl'), asstLine('w2', 'm_w2x', 'Read', t + 2));
    fs.appendFileSync(path.join(sessionDir, 'subagents', 'workflows', 'wf_x', 'journal.jsonl'), '{"type":"result","agentId":"w2"}\n');
    const before = viaLoader.state.eventCount;
    const bashBefore = mainBash(viaLoader);
    await sync.poll();
    await viaLoader.poll();
    expect(viaLoader.state.eventCount).toBeGreaterThan(before);
    expect(viaLoader.state.eventCount).toBe(sync.state.eventCount);
    expect(mainBash(viaLoader)).toBe(bashBefore + 1);
    expect(viaLoader.state.agents.w2.status).toBe('done');
    expect(viaLoader.state).toEqual(sync.state);

    // a further poll with nothing new changes nothing
    expect(await viaLoader.poll()).toBe(false);
  });

  it('queues events ingested while the load runs and applies them afterwards', async () => {
    const { mainFile } = writeFixture(home);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: BacklogLoader = async (...a) => {
      const snap = await cloning(...a);
      await gate;
      return snap;
    };
    const w = new SessionWatcher(SID, mainFile, slow);
    const p = w.poll();
    await new Promise((r) => setTimeout(r, 20));
    const before = w.state.eventCount;
    w.ingest(normalizeHook({ session_id: SID, hook_event_name: 'Notification', message: 'queued while loading' }, Date.now()));
    expect(w.state.eventCount).toBe(before);
    release();
    await p;
    expect(w.primed).toBe(true);
    expect(w.state.eventCount).toBeGreaterThan(before);
    expect(Object.keys(w.state.agents)).toContain('a1');
  });

  it('falls back to an in-process load when the loader fails', async () => {
    const { mainFile } = writeFixture(home);
    const w = new SessionWatcher(SID, mainFile, async () => {
      throw new Error('no worker');
    });
    const err = console.error;
    console.error = () => {};
    try {
      await w.poll();
    } finally {
      console.error = err;
    }
    expect(w.primed).toBe(true);
    expect(Object.keys(w.state.agents)).toContain('a1');
  });

  it('hands replay events over with the snapshot', async () => {
    const { mainFile } = writeFixture(home);
    const events = await new SessionWatcher(SID, mainFile, cloning).collectAllEvents();
    const expected = await new SessionWatcher(SID, mainFile).collectAllEvents();
    expect(events).toEqual(expected);
    expect(events.length).toBeGreaterThan(10);
  });
});
