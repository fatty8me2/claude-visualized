import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyModel } from '../../src/core/models';
import { mapToolInput, mapToolName, openCodeModelId, STALE_TOOL_MS, OpenCodeConverter, type OcPart, type OcSession } from '../../src/core/opencode';
import { detectOpenCodeDir, JsonStore, OpenCodeSource, SqliteStore, newCursor } from '../../src/main/opencode';
import { MAIN as MAIN_AGENT } from '../../src/core/state';
import { addRunningBash, CHILD, finishBash, MAIN, OC_PROJECT, seedDb, writeLegacyStorage } from '../fixtures/opencode/build';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-oc-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const mkSession = (id: string, parentId: string | null = null): OcSession => ({
  id,
  parentId,
  directory: '/srv/x',
  title: 'T',
  version: '1',
  agent: null,
  timeCreated: 1000,
  timeUpdated: 2000,
  archived: false,
});
const mkPart = (id: string, sessionId: string, data: Record<string, unknown>, t = 1000): OcPart => ({
  id,
  messageId: 'm1',
  sessionId,
  timeCreated: t,
  timeUpdated: t,
  data,
});

describe('OpenCode adapter (pure)', () => {
  it('maps tool names and inputs to the ones the reducer knows', () => {
    expect(mapToolName('bash')).toBe('Bash');
    expect(mapToolName('task')).toBe('Agent');
    expect(mapToolName('some_mcp_tool')).toBe('some_mcp_tool');
    expect(mapToolInput('read', { filePath: '/a/b.ts', junk: 1 })).toEqual({ file_path: '/a/b.ts' });
    expect(mapToolInput('edit', { filePath: '/a/b.ts', oldString: 'x'.repeat(5000), newString: 'y' })).toEqual({ file_path: '/a/b.ts' });
    expect(mapToolInput('bash', { command: 'ls' }).command).toBe('ls');
  });

  it('builds a model id that keeps the provider, so local servers are recognised', () => {
    expect(openCodeModelId('lmstudio', 'qwen3-27b-q6_k')).toBe('lmstudio/qwen3-27b-q6_k');
    expect(classifyModel(openCodeModelId('lmstudio', 'qwen3-27b-q6_k')).provider).toBe('local');
    expect(classifyModel(openCodeModelId('ollama', 'qwen3:27b')).provider).toBe('local');
    expect(classifyModel(openCodeModelId('openrouter', 'deepseek/deepseek-v4.1-flash')).provider).toBe('other');
    expect(classifyModel(openCodeModelId('anthropic', 'claude-sonnet-4-5')).provider).toBe('anthropic');
  });

  it('is idempotent and ignores unknown part types and fields', () => {
    const c = new OpenCodeConverter('s1');
    const parts = [
      mkPart('p1', 's1', { type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'ls' }, time: { start: 1500 }, futureField: 1 } }),
      mkPart('p2', 's1', { type: 'hologram', whatever: true }),
      mkPart('p3', 's1', { type: 'tool' }), // no tool name
      mkPart('p4', 's1', null as never),
    ];
    const first = c.feed([mkSession('s1')], [], parts, null);
    expect(first.filter((e) => e.k === 'tool.start')).toHaveLength(1);
    expect(c.feed([mkSession('s1')], [], parts, null)).toEqual([]);
  });

  it('ends a running tool left behind by a dead OpenCode', () => {
    const c = new OpenCodeConverter('s1');
    const p = mkPart('p1', 's1', { type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'sleep 9' }, time: { start: 1500 } } }, 1500);
    const evs = c.feed([mkSession('s1')], [], [p], null, 1500 + STALE_TOOL_MS + 10);
    expect(evs.some((e) => e.k === 'tool.end' && !e.ok)).toBe(true);
  });
});

describe('OpenCode SQLite storage', () => {
  it('shows the session, its subagent, the running tool, tokens, todos and a local model', async () => {
    const dir = tmp();
    const db = seedDb(dir);
    addRunningBash(db, Date.now() - 1000);
    const src = new OpenCodeSource();
    src.setConfig({ enabled: true, dir });
    const rows = src.scan();
    expect(rows).toHaveLength(1); // the child session is not a row of its own
    expect(rows[0]).toMatchObject({ id: MAIN, source: 'opencode', entrypoint: 'opencode', cwd: OC_PROJECT, project: 'demo-app', live: true });

    const w = src.watcher(MAIN);
    await w.poll();
    expect(w.primed).toBe(true);
    const s = w.state;
    expect(s.title).toBe('Add retry to the API client');
    expect(s.entrypoint).toBe('opencode');
    const main = s.agents[MAIN_AGENT];
    expect(main.model).toBe('lmstudio/qwen3-27b-q6_k');
    expect(classifyModel(main.model).provider).toBe('local');
    expect(main.currentTool?.name).toBe('Bash');
    expect(main.currentTool?.summary).toContain('Run the tests');
    expect(main.status).toBe('running');
    expect(main.toolCount).toBe(4); // read, todowrite, task, bash
    expect(s.totals.in).toBe(2000);
    expect(s.totals.out).toBe(150);
    expect(s.totals.cacheRead).toBe(400);
    expect(s.todos.map((t) => t.status)).toEqual(['completed', 'in_progress', 'pending']);
    const child = s.agents[CHILD];
    expect(child).toBeTruthy();
    expect(child.parentId).toBe(MAIN_AGENT);
    expect(child.agentType).toBe('explore');
    expect(child.status).toBe('done');
    expect(child.toolCount).toBe(1);
    expect(child.model).toBe('lmstudio/qwen3-27b-q6_k');
    expect(s.log.some((l) => l.kind === 'prompt' && l.text.includes('retry with backoff'))).toBe(true);
    src.close();
    db.close();
  });

  it('picks up new parts on the next poll and finishes the tool', async () => {
    const dir = tmp();
    const db = seedDb(dir);
    const src = new OpenCodeSource();
    src.setConfig({ enabled: true, dir });
    src.scan();
    const w = src.watcher(MAIN);
    await w.poll();
    expect(w.state.agents[MAIN_AGENT].currentTool).toBeNull();
    expect(await w.poll()).toBe(false); // nothing changed: cheap no-op
    addRunningBash(db, Date.now());
    expect(await w.poll()).toBe(true);
    expect(w.state.agents[MAIN_AGENT].currentTool?.name).toBe('Bash');
    finishBash(db, Date.now() + 1500);
    expect(await w.poll()).toBe(true);
    const a = w.state.agents[MAIN_AGENT];
    expect(a.currentTool).toBeNull();
    expect(a.toolCount).toBe(4);
    expect(a.recent[a.recent.length - 1]).toMatchObject({ name: 'Bash', ok: true });
    src.close();
    db.close();
  });

  it('a late child session is attached on a later poll', async () => {
    const dir = tmp();
    const db = seedDb(dir);
    const src = new OpenCodeSource();
    src.setConfig({ enabled: true, dir });
    const w = src.watcher(MAIN);
    await w.poll();
    expect(Object.keys(w.state.agents)).toEqual([MAIN_AGENT, CHILD]);
    const { putSession, putMessage, putPart, toolPart } = await import('../fixtures/opencode/build');
    const now = Date.now();
    putSession(db, { id: 'ses_demo_child_0003', parent: MAIN, title: 'Second (@general subagent)', agent: 'general', created: now, updated: now });
    putMessage(db, 'msg_d01', 'ses_demo_child_0003', now, { role: 'user', time: { created: now } });
    putPart(db, 'prt_d01', 'msg_d01', 'ses_demo_child_0003', now, toolPart('bash', 'running', { command: 'make' }, now));
    expect(await w.poll()).toBe(true);
    expect(w.state.agents['ses_demo_child_0003'].currentTool?.name).toBe('Bash');
    expect(w.state.agents['ses_demo_child_0003'].agentType).toBe('general');
    src.close();
    db.close();
  });

  it('survives garbage rows and a missing database', async () => {
    const dir = tmp();
    const db = seedDb(dir);
    db.prepare("insert into part values ('prt_bad','msg_003',?,?,?,'not json {')").run(MAIN, Date.now(), Date.now());
    db.prepare("insert into message values ('msg_bad',?,?,?,'[1,2]')").run(MAIN, Date.now(), Date.now());
    const src = new OpenCodeSource();
    src.setConfig({ enabled: true, dir });
    const w = src.watcher(MAIN);
    await expect(w.poll()).resolves.toBe(true);
    const empty = new OpenCodeSource();
    empty.setConfig({ enabled: true, dir: path.join(dir, 'nope') });
    expect(empty.scan()).toEqual([]);
    const off = new OpenCodeSource();
    off.setConfig({ enabled: false, dir });
    expect(off.scan()).toEqual([]);
    src.close();
    db.close();
  });

  it('opens read-only: the database is never modified', async () => {
    const dir = tmp();
    const db = seedDb(dir);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const store = new SqliteStore(path.join(dir, 'opencode.db'));
    expect(store.sessions()).toHaveLength(2);
    expect(() => (store as unknown as { db: { exec(s: string): void } }).db.exec('delete from part')).toThrow();
    store.close();
    db.close();
  });
});

describe('OpenCode JSON storage (older versions)', () => {
  it('reads sessions, a subagent and a running tool from storage/ files', async () => {
    const dir = tmp();
    writeLegacyStorage(dir);
    const src = new OpenCodeSource();
    src.setConfig({ enabled: true, dir });
    expect(src.scan().map((r) => r.id)).toEqual([MAIN]);
    const w = src.watcher(MAIN);
    await w.poll();
    const s = w.state;
    expect(s.agents[CHILD].parentId).toBe(MAIN_AGENT);
    expect(s.agents[CHILD].currentTool?.name).toBe('Grep');
    expect(s.agents[MAIN_AGENT].model).toBe('lmstudio/qwen3-27b-q6_k');
    expect(s.totals.in).toBe(2000);
    expect(s.todos).toHaveLength(1);
    // a rewritten part file is noticed without re-reading the rest
    const f = path.join(dir, 'storage', 'part', 'msg_c02', 'prt_c02.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    j.state = { status: 'completed', input: j.state.input, output: 'x', time: { start: 1, end: 2 } };
    fs.writeFileSync(f, JSON.stringify(j));
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    await w.poll();
    expect(s.agents[CHILD].currentTool).toBeNull();
    const store = new JsonStore(path.join(dir, 'storage'));
    expect(store.changes([MAIN], newCursor()).parts.length).toBeGreaterThan(0);
    src.close();
  });
});

describe('OpenCode data dir detection', () => {
  it('prefers the override, finds both formats, and stays off when tests point at a fixture Claude home', () => {
    const a = tmp();
    seedDb(a).close();
    expect(detectOpenCodeDir(a, {})).toBe(a);
    const b = tmp();
    writeLegacyStorage(b);
    expect(detectOpenCodeDir('', { CLAUDE_VIS_OPENCODE_HOME: b })).toBe(b);
    expect(detectOpenCodeDir('', { CLAUDE_VIS_HOME: '/fixture' }, tmp())).toBeNull();
    expect(detectOpenCodeDir('', { XDG_DATA_HOME: path.dirname(a) }, tmp(), 'linux')).toBeNull(); // dir name must be "opencode"
    expect(detectOpenCodeDir(path.join(a, 'missing'), {})).toBeNull();
  });
});
