import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@core/events';
import { agentGoal } from '@core/insight';
import { foldEvents } from '@core/reducer';
import { COMMANDS_CAP, FILES_CAP, PROMPT_CAP, RECENT_CAP } from '@core/state';
import { SessionWatcher } from '../../src/main/watcher';
import { SID, writeFixture } from '../fixtures/build';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const ref = { sessionId: 's', agentId: 'ag' };
const ev = (ts: number, e: any): AgentEvent => ({ ts, src: 'transcript', ref, ...e });
const start = (ts: number, id: string, name: string, input: unknown): AgentEvent => ev(ts, { k: 'tool.start', toolUseId: id, name, input });
const end = (ts: number, id: string, ok = true): AgentEvent => ev(ts, { k: 'tool.end', toolUseId: id, ok });

describe('per-agent insight fields in the reducer', () => {
  it('tracks tool mix, recent calls with ok/failed, files and commands', () => {
    const s = foldEvents('s', [
      start(1, 't1', 'Grep', { pattern: 'retry' }),
      end(2, 't1'),
      start(3, 't2', 'Read', { file_path: 'C:\\app\\src\\api.ts' }),
      end(4, 't2'),
      start(5, 't3', 'Edit', { file_path: 'C:\\app\\src\\api.ts' }),
      end(6, 't3', false),
      start(7, 't4', 'Bash', { command: 'npm test' }),
      start(8, 't5', 'Bash', { command: 'git status' }),
    ]);
    const a = s.agents.ag;
    expect(a.toolMix).toEqual({ search: 1, read: 1, edit: 1, test: 1, run: 1 });
    expect(a.recent.map((r) => [r.name, r.ok])).toEqual([
      ['Grep', true],
      ['Read', true],
      ['Edit', false],
      ['Bash', null],
      ['Bash', null],
    ]);
    expect(a.files).toEqual(['C:\\app\\src\\api.ts']); // deduped
    expect(a.commands).toEqual(['npm test', 'git status']);
    expect(a.currentTool?.input).toEqual({ command: 'git status' });
  });

  it('caps recent calls, files and commands', () => {
    const evs: AgentEvent[] = [];
    for (let i = 0; i < 50; i++) {
      evs.push(start(i, `r${i}`, 'Read', { file_path: `/f/${i}.ts` }), end(i, `r${i}`));
      evs.push(start(i, `b${i}`, 'Bash', { command: `echo ${i}` }), end(i, `b${i}`));
    }
    const a = foldEvents('s', evs).agents.ag;
    expect(a.recent).toHaveLength(RECENT_CAP);
    expect(a.files).toHaveLength(FILES_CAP);
    expect(a.files[a.files.length - 1]).toBe('/f/49.ts');
    expect(a.commands).toHaveLength(COMMANDS_CAP);
    expect(a.commands[a.commands.length - 1]).toBe('echo 49');
    expect(a.toolMix.read).toBe(50);
  });

  it('keeps a subagent first prompt but the main agent latest prompt', () => {
    const long = 'x'.repeat(2000);
    const s = foldEvents('s', [
      ev(1, { k: 'prompt', text: long }),
      ev(2, { k: 'prompt', text: 'second' }),
      { ts: 3, src: 'transcript', ref: { sessionId: 's', agentId: null }, k: 'prompt', text: 'first main' } as AgentEvent,
      { ts: 4, src: 'transcript', ref: { sessionId: 's', agentId: null }, k: 'prompt', text: 'latest main' } as AgentEvent,
    ]);
    expect(s.agents.ag.prompt).toHaveLength(PROMPT_CAP);
    expect(s.agents.main.prompt).toBe('latest main');
  });

  it('records when the agent last wrote text', () => {
    const s = foldEvents('s', [ev(5000, { k: 'text', role: 'assistant', preview: 'hello', endTurn: false })]);
    expect(s.agents.ag.lastTextAt).toBe(5000);
  });
});

describe('fixture session', () => {
  async function load() {
    const { mainFile } = writeFixture(home);
    const w = new SessionWatcher(SID, mainFile);
    await w.poll();
    return w.state;
  }

  it('gives subagents their task, mix and a sensible goal', async () => {
    const { agents } = await load();
    expect(agents.a1.prompt).toBe('find it');
    expect(agents.a1.toolMix.search).toBe(1);
    expect(agents.a1.recent[0]).toMatchObject({ name: 'Grep', ok: true });
    expect(agents.a2.toolMix.test).toBe(1);
    expect(agents.a2.commands).toEqual(['npm test']);
    expect(agents.a3.files[0]).toContain('api.ts');
    expect(agentGoal(agents.a1).goal).toBe('search');
    expect(agentGoal(agents.a2).goal).toBe('test');
    expect(agentGoal(agents['wf:wf_x']).goal).toBe('workflow');
    expect(agentGoal(agents.main, true).goal).toBe('plan');
  });
});
