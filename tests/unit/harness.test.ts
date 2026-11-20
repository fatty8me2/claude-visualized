import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/core/events';
import {
  freshItems,
  harnessAgentId,
  harnessConversationItems,
  harnessModelId,
  harnessSessionId,
  harnessTaskIdOf,
  harnessTaskItems,
  isHarnessDelegate,
  matchHarnessTask,
  parseHxMessage,
  type HxData,
  type HxTask,
} from '../../src/core/harness';
import { isKilnDelegate } from '../../src/core/kiln';
import { classifyModel } from '../../src/core/models';
import { normalizeLine } from '../../src/core/normalize';
import { apply, foldEvents } from '../../src/core/reducer';
import { MAIN, newSession } from '../../src/core/state';
import { HarnessSource, harnessDbCandidates } from '../../src/main/harness';
import { FakeHarness, SYSTEM, asst, delegateResult, subTrace, toolMsg, userMsg } from '../fixtures/harness';

const CWD = '/Users/demo/code/shop';
const T0 = 1_760_000_000_000;
const TASK = 'task_0123456789ab';
const BRIEF = 'Add JSDoc to every export in src/tax.ts.\nKeep the public API.';

const task = (over: Partial<HxTask> = {}): HxTask => ({
  id: TASK,
  title: 'Document tax.ts',
  brief: BRIEF,
  role: 'writer',
  state: 'implementing',
  model: { provider: 'openai-compat', model: 'local/qwen3.8-27b-q6' },
  tier: 'local',
  summary: '',
  stateReason: '',
  attempt: 1,
  createdAt: T0 + 1000,
  updatedAt: T0 + 1000,
  root: CWD,
  messages: 4,
  ...over,
});

const msg = (id: string, ts: number, m: object) => parseHxMessage(id, ts, m)!;

/** a worker that read a file, ran a sub-agent, and is running `npm test` */
const workerData = (): HxData => ({
  messages: [
    msg('m1', T0 + 1000, SYSTEM),
    msg('m2', T0 + 1001, userMsg(BRIEF)),
    msg('m3', T0 + 2000, asst('Reading the file.', [['c1', 'read_file', { path: 'src/tax.ts' }]])),
    msg('m4', T0 + 3000, toolMsg('c1', 'read_file', 'export function tax() {}')),
    msg('m5', T0 + 4000, asst('', [['c2', 'task', { description: 'Find the tax helpers', prompt: 'Where are tax helpers used?', subagent_type: 'explore' }]])),
    msg(
      'm6',
      T0 + 30_000,
      toolMsg('c2', 'task', 'Used in cart.ts.\n\n[explore sub-agent: 4 model calls, 2 tool calls, 18k tokens in / 900 out, 20 s]', {
        subagent: subTrace([
          ['grep', 'grep "taxOf"', true],
          ['read_file', 'read_file src/cart.ts', true],
        ]),
      }),
    ),
    msg('m7', T0 + 31_000, asst('Running the tests.', [['c3', 'run_command', { command: 'npm test' }]])),
  ],
  usage: [
    { id: 'u1', ts: T0 + 1900, provider: 'openai-compat', model: 'local/qwen3.8-27b-q6', in: 9000, out: 120, source: 'local', tps: 40 },
    { id: 'u2', ts: T0 + 3900, provider: 'openai-compat', model: 'local/qwen3.8-27b-q6', in: 9500, out: 80, source: 'local', tps: 44 },
  ],
});

/** a Claude session whose main agent called delegate_task (and, when `result`, got its answer) */
function leadSession(result = true) {
  const s = newSession('S');
  const ref = { sessionId: 'S', agentId: null };
  apply(s, { ts: T0 - 5000, src: 'transcript', ref, k: 'session.meta', cwd: CWD });
  apply(s, {
    ts: T0,
    src: 'transcript',
    ref,
    k: 'tool.start',
    toolUseId: 'tu1',
    name: 'mcp__harness__delegate_task',
    input: { title: 'Document tax.ts', brief: BRIEF },
  });
  if (result) apply(s, { ts: T0 + 1500, src: 'transcript', ref, k: 'tool.end', toolUseId: 'tu1', ok: true, harnessTaskId: TASK });
  return s;
}

describe('delegate_task results', () => {
  it('knows the hand-off tool, and keeps it apart from the Python Kiln one', () => {
    expect(isHarnessDelegate('mcp__harness__delegate_task')).toBe(true);
    expect(isHarnessDelegate('mcp__plugin_kiln_harness__delegate_task')).toBe(true);
    expect(isHarnessDelegate('mcp__kiln__delegate_task')).toBe(false);
    expect(isKilnDelegate('mcp__harness__delegate_task')).toBe(false);
  });

  it('reads the taskId from the pretty-printed JSON, as a string or text blocks', () => {
    expect(harnessTaskIdOf(delegateResult(TASK))).toBe(TASK);
    expect(harnessTaskIdOf([{ type: 'text', text: delegateResult(TASK) }])).toBe(TASK);
    expect(harnessTaskIdOf('{"taskId":"task_00aa11bb22cc"}')).toBe('task_00aa11bb22cc');
    expect(harnessTaskIdOf('Error: Cannot tell which project')).toBeNull();
    expect(harnessTaskIdOf({ taskId: TASK })).toBeNull();
  });

  it('normalize carries it on tool.end, and the reducer keeps it only for a delegate_task call', () => {
    const line = (o: object) => JSON.stringify({ sessionId: 'S', timestamp: new Date(T0).toISOString(), cwd: CWD, ...o });
    const evs = [
      ...normalizeLine(
        line({
          type: 'assistant',
          message: {
            id: 'a1',
            model: 'claude-opus-5-5',
            content: [
              { type: 'tool_use', id: 'tu1', name: 'mcp__harness__delegate_task', input: { title: 'Document tax.ts', brief: BRIEF, acceptance: 'ok' } },
            ],
          },
        }),
        { sessionId: 'S', agentId: null },
      ),
      ...normalizeLine(
        line({
          type: 'assistant',
          message: { id: 'a2', content: [{ type: 'tool_use', id: 'tu2', name: 'mcp__harness__task_result', input: { taskId: TASK } }] },
        }),
        { sessionId: 'S', agentId: null },
      ),
      ...normalizeLine(
        line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: delegateResult(TASK) }] }] } }),
        { sessionId: 'S', agentId: null },
      ),
      ...normalizeLine(
        line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: delegateResult('task_ffffffffffff') }] } }),
        { sessionId: 'S', agentId: null },
      ),
    ];
    const end = evs.find((e) => e.k === 'tool.end' && e.toolUseId === 'tu1');
    expect(end && end.k === 'tool.end' && end.harnessTaskId).toBe(TASK);
    const s = foldEvents('S', evs);
    expect(Object.keys(s.internal.harnessCalls!)).toEqual(['tu1']);
    expect(s.internal.harnessCalls!.tu1).toMatchObject({ agentId: MAIN, title: 'Document tax.ts', taskId: TASK, cwd: CWD });
    expect(s.internal.kilnCalls).toBeUndefined();
  });
});

describe('models', () => {
  it('classifies the ids qwen workers run on as local', () => {
    for (const id of ['local/qwen3.8-27b-q6', 'qwen3.8:27b', 'unsloth/Qwen3.8-27B-GGUF', 'openai-compat:local/qwen3.8-27b-q6']) {
      expect(classifyModel(id).provider, id).toBe('local');
    }
    expect(harnessModelId({ provider: 'ollama', model: 'my-coder' })).toBe('local/my-coder');
    expect(classifyModel(harnessModelId({ provider: 'openai-compat', model: 'splash-27b' })).provider).toBe('local');
    expect(harnessModelId({ provider: 'claude-code', model: 'sonnet' })).toBe('claude-sonnet');
    expect(harnessModelId({ provider: 'anthropic', model: 'claude-sonnet-5-5' })).toBe('claude-sonnet-5-5');
  });
});

describe('a task as agent events', () => {
  it('becomes a running local child of the calling agent, with its tools, sub-agent and tokens', () => {
    const s = leadSession();
    for (const e of harnessTaskItems(task(), workerData(), 'S', 'tu1').map((i) => i.e)) apply(s, e);
    const w = s.agents[harnessAgentId(TASK)];
    expect(w.parentId).toBe(MAIN);
    expect(w.agentType).toBe('kiln-worker');
    expect(w.description).toBe('Document tax.ts');
    expect(classifyModel(w.model).provider).toBe('local');
    expect(w.prompt).toContain('Add JSDoc');
    expect(w.status).toBe('running');
    expect(w.currentTool?.name).toBe('Bash');
    expect(w.files).toContain('src/tax.ts');
    expect(w.tokens).toMatchObject({ in: 18_500, out: 200 });
    // one model call's prompt is a real context size
    expect(w.contextTokens).toBe(9500);
    expect(w.kiln).toMatchObject({ runId: TASK, source: 'harness', finished: false });
    // the sub-agent is a grandchild under the worker, done, with its steps and tokens
    const sub = Object.values(s.agents).find((a) => a.parentId === w.id)!;
    expect(sub.agentType).toBe('explore');
    expect(sub.description).toBe('Find the tax helpers');
    expect(sub.status).toBe('done');
    expect(sub.toolCount).toBe(2);
    expect(sub.recent.map((r) => r.name)).toEqual(['Grep', 'Read']);
    expect(sub.tokens).toMatchObject({ in: 18_000, out: 900 });
    expect(classifyModel(sub.model).provider).toBe('local');
  });

  it('only adds events as rows arrive, and ends when the task does', () => {
    const data = workerData();
    const sent = new Set<string>();
    const s = leadSession();
    const step = (t: HxTask, d: HxData) => {
      const evs = freshItems(harnessTaskItems(t, d, 'S', 'tu1'), sent);
      for (const e of evs) apply(s, e);
      return evs;
    };
    const first = step(task(), data);
    expect(first.length).toBeGreaterThan(10);
    expect(step(task(), data)).toEqual([]);
    // the command returns, the worker finishes; a usage record of the earlier call lands late
    data.messages.push(msg('m8', T0 + 40_000, toolMsg('c3', 'run_command', 'exit 1: 2 failing', { isError: true })));
    data.messages.push(msg('m9', T0 + 41_000, asst('', [['c4', 'finish', { summary: 'Documented 6 exports.' }]])));
    data.usage.push({ id: 'u3', ts: T0 + 30_500, provider: 'openai-compat', model: 'local/qwen3.8-27b-q6', in: 12_000, out: 300, source: 'local', tps: 41 });
    const more = step(task(), data);
    expect(more.map((e) => e.k)).toEqual(['usage', 'tool.end', 'tool.start']);
    const w = s.agents[harnessAgentId(TASK)];
    expect(w.errorCount).toBe(1);
    expect(w.status).toBe('running');
    // accepted: the open call is closed, the worker is done, with its summary in the drawer
    const done = task({ state: 'accepted', summary: 'Documented 6 exports.', updatedAt: T0 + 60_000 });
    const end = step(done, data);
    expect(end.map((e) => e.k)).toEqual(['tool.end', 'kiln', 'agent.stop']);
    expect(w.status).toBe('done');
    expect(w.kiln).toMatchObject({ finished: true, ok: true, answer: 'Documented 6 exports.', state: 'accepted', steps: 4 });
    expect(step(done, data)).toEqual([]);
  });

  it('a failed or escalated task ends in error with the reason', () => {
    const s = leadSession();
    const t = task({ state: 'escalated', stateReason: 'repairs exhausted', tier: 'sonnet', model: { provider: 'claude-code', model: 'sonnet' } });
    for (const e of harnessTaskItems(t, workerData(), 'S', 'tu1').map((i) => i.e)) apply(s, e);
    const w = s.agents[harnessAgentId(TASK)];
    expect(w.status).toBe('error');
    expect(w.kiln?.error).toBe('escalated: repairs exhausted');
    // the local run's model, not the Claude tier it moved up to
    expect(classifyModel(w.model).provider).toBe('local');
  });

  it('a task no session claims is a session of its own', () => {
    const t = task({ state: 'accepted', summary: 'Documented.', updatedAt: T0 + 60_000 });
    const s = foldEvents(
      harnessSessionId(TASK),
      harnessTaskItems(t, workerData(), harnessSessionId(TASK), null).map((i) => i.e),
    );
    expect(s.cwd).toBe(CWD);
    expect(s.entrypoint).toBe('kiln-harness');
    expect(s.title).toBe('Document tax.ts');
    expect(classifyModel(s.agents[MAIN].model).provider).toBe('local');
    expect(s.agents[MAIN].status).toBe('idle');
    expect(Object.values(s.agents).filter((a) => a.parentId === MAIN)).toHaveLength(1);
  });
});

describe('matching a task to its call before the result is in', () => {
  const call = { toolUseId: 'tu1', agentId: MAIN, ts: T0, title: 'Document tax.ts', brief: BRIEF.slice(0, 30), cwd: CWD };
  it('takes the task with the same title and brief, created just after the call', () => {
    const other = task({ id: 'task_aaaaaaaaaaaa', title: 'Other' });
    const late = task({ id: 'task_bbbbbbbbbbbb', createdAt: T0 + 20 * 60_000 });
    expect(matchHarnessTask(call, [other, late, task()], () => false)?.id).toBe(TASK);
    expect(matchHarnessTask(call, [task()], (id) => id === TASK)).toBeNull();
    expect(matchHarnessTask({ ...call, endTs: T0 + 500 }, [task({ createdAt: T0 + 60_000 })], () => false)).toBeNull();
  });
});

describe('a local Agent conversation', () => {
  it('is a session on its model, in its project, with todos and sub-agents', () => {
    const data: HxData = {
      messages: [
        msg('c1', T0, SYSTEM),
        msg('c2', T0 + 10, userMsg('Explain the cart totals.')),
        msg('c3', T0 + 1000, asst('', [['k1', 'task', { description: 'Map the cart', prompt: 'Map cart.ts', subagent_type: 'explore' }]])),
        msg('c4', T0 + 9000, toolMsg('k1', 'task', 'cart.ts sums lines.', { subagent: subTrace([['glob', 'glob src/**/*.ts', true]]) })),
        msg('c5', T0 + 10_000, asst('Totals are summed per line.')),
      ],
      usage: [{ id: 'cu1', ts: T0 + 900, provider: 'ollama', model: 'qwen3.8:27b', in: 4000, out: 50, source: 'local', tps: 0 }],
      todos: { items: [{ content: 'Read cart.ts', status: 'completed' }], updatedAt: T0 + 5000 },
    };
    const cv = {
      id: 'conv_1',
      title: 'Cart totals',
      model: { provider: 'ollama', model: 'qwen3.8:27b' },
      status: 'idle',
      mode: 'bypass',
      createdAt: T0,
      updatedAt: T0 + 10_000,
      root: CWD,
      messages: 5,
    };
    const sid = harnessSessionId('conv_1');
    const s = foldEvents(
      sid,
      harnessConversationItems(cv, data, sid).map((i) => i.e),
    );
    expect(s.cwd).toBe(CWD);
    expect(s.title).toBe('Cart totals');
    expect(s.mode).toBe('bypassPermissions');
    expect(s.agents[MAIN].model).toBe('qwen3.8:27b');
    expect(classifyModel(s.agents[MAIN].model).provider).toBe('local');
    expect(s.agents[MAIN].status).toBe('idle');
    expect(s.agents[MAIN].lastText).toContain('summed per line');
    expect(s.todos.map((t) => t.text)).toEqual(['Read cart.ts']);
    const sub = Object.values(s.agents).find((a) => a.parentId === MAIN)!;
    expect(sub).toMatchObject({ agentType: 'explore', description: 'Map the cart', status: 'done' });
  });
});

describe('HarnessSource (a real SQLite file)', () => {
  const dirs: string[] = [];
  const envKeep = { db: process.env.CLAUDE_VIS_HARNESS_DB };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    if (envKeep.db === undefined) delete process.env.CLAUDE_VIS_HARNESS_DB;
    else process.env.CLAUDE_VIS_HARNESS_DB = envKeep.db;
  });
  const setup = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-harness-'));
    dirs.push(d);
    const file = path.join(d, 'harness.db');
    const h = new FakeHarness(file);
    process.env.CLAUDE_VIS_HARNESS_DB = file;
    const src = new HarnessSource();
    src.setConfig({ enabled: true });
    return { h, src, file };
  };

  it('finds the database where Kiln keeps it, and never the real one under a test home', () => {
    expect(harnessDbCandidates({ CLAUDE_VIS_HARNESS_DB: '/tmp/x.db' }, '/Users/demo', 'darwin')).toEqual(['/tmp/x.db']);
    expect(harnessDbCandidates({ CLAUDE_VIS_HOME: '/tmp/home' }, '/Users/demo', 'darwin')).toEqual([]);
    expect(harnessDbCandidates({}, '/Users/demo', 'darwin')[0]).toBe(path.join('/Users/demo', 'Library', 'Application Support', 'Kiln', 'harness.db'));
    expect(harnessDbCandidates({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me', 'win32')[0]).toBe(
      path.join('C:\\Users\\me\\AppData\\Roaming', 'Kiln', 'harness.db'),
    );
    expect(harnessDbCandidates({ HARNESS_PROFILE_DIR: '/tmp/p' }, '/Users/demo', 'linux')[0]).toBe(path.join('/tmp/p', 'harness.db'));
  });

  it('links a delegated task into the session live, and lists conversations and unclaimed tasks', async () => {
    const { h, src } = setup();
    const now = Date.now();
    h.project('prj_1', CWD, now - 600_000);
    h.task({ id: TASK, project: 'prj_1', title: 'Document tax.ts', brief: BRIEF, state: 'implementing', ts: now - 60_000 });
    h.message({ task: TASK }, SYSTEM, now - 59_000);
    h.message({ task: TASK }, userMsg(BRIEF), now - 59_000);
    h.message({ task: TASK }, asst('Reading.', [['c1', 'read_file', { path: 'src/tax.ts' }]]), now - 58_000);
    h.usage({ task: TASK }, { in: 8000, out: 100, ts: now - 58_000 });
    // another task nobody delegated from a followed session, and a conversation in the Kiln app
    h.task({ id: 'task_00000000beef', project: 'prj_1', title: 'Orphan work', brief: 'Fix the README.', state: 'accepted', ts: now - 120_000 });
    h.message({ task: 'task_00000000beef' }, SYSTEM, now - 119_000);
    h.conversation({ id: 'conv_1', project: 'prj_1', title: 'Cart totals', ts: now - 30_000, status: 'running' });
    h.message({ conversation: 'conv_1' }, SYSTEM, now - 29_000);
    h.message({ conversation: 'conv_1' }, userMsg('Explain the cart totals.'), now - 29_000);
    expect(src.poll()).toBe(true);
    const state = newSession('S');
    const ref = { sessionId: 'S', agentId: null };
    apply(state, { ts: now - 70_000, src: 'transcript', ref, k: 'session.meta', cwd: CWD });
    apply(state, {
      ts: now - 61_000,
      src: 'transcript',
      ref,
      k: 'tool.start',
      toolUseId: 'tu1',
      name: 'mcp__harness__delegate_task',
      input: { title: 'Document tax.ts', brief: BRIEF },
    });
    apply(state, { ts: now - 59_500, src: 'transcript', ref, k: 'tool.end', toolUseId: 'tu1', ok: true, harnessTaskId: TASK });
    const w = {
      sessionId: 'S',
      state,
      primed: true,
      ingest(evs: AgentEvent[]) {
        for (const e of evs) apply(this.state, e);
      },
    };
    expect(src.link(w)).toBe(true);
    const id = harnessAgentId(TASK);
    expect(w.state.agents[id].currentTool?.name).toBe('Read');
    expect(w.state.agents[id].tokens.in).toBe(8000);
    expect(src.link(w)).toBe(false);
    expect(src.claimedBy(TASK)).toBe('S');

    // the sidebar: the conversation and the unclaimed task, not the claimed one
    const rows = src.scan([]);
    expect(rows.map((r) => r.id).sort()).toEqual([harnessSessionId('conv_1'), harnessSessionId('task_00000000beef')].sort());
    expect(rows.find((r) => r.id === harnessSessionId('conv_1'))).toMatchObject({ source: 'kiln-harness', cwd: CWD, title: 'Cart totals', live: true });

    // rows appended while the app watches
    h.message({ task: TASK }, toolMsg('c1', 'read_file', 'export const tax = 1'), Date.now());
    h.message({ task: TASK }, asst('', [['c2', 'run_command', { command: 'npm test' }]]), Date.now());
    expect(src.poll()).toBe(true);
    expect(src.link(w)).toBe(true);
    expect(w.state.agents[id].currentTool?.name).toBe('Bash');
    h.setTask(TASK, { state: 'review', summary: 'Documented.' }, Date.now());
    expect(src.poll()).toBe(true);
    expect(src.link(w)).toBe(true);
    expect(w.state.agents[id].status).toBe('done');

    // the conversation's own watcher
    const cw = src.watcher(harnessSessionId('conv_1'), `kiln-harness:conversation:conv_1`);
    expect(await cw.poll()).toBe(true);
    expect(cw.state.agents[MAIN].model).toBe('qwen3.8:27b');
    expect(cw.state.agents[MAIN].prompt).toContain('cart totals');
    expect(await cw.poll()).toBe(false);
    h.message({ conversation: 'conv_1' }, asst('Totals are summed per line.'), Date.now());
    h.setConversation('conv_1', 'idle', Date.now());
    src.poll();
    expect(await cw.poll()).toBe(true);
    expect(cw.state.agents[MAIN].status).toBe('idle');

    // replay of the lead session includes the worker
    const replay = src.withTasks(
      [
        {
          ts: now - 61_000,
          src: 'transcript',
          ref,
          k: 'tool.start',
          toolUseId: 'tu1',
          name: 'mcp__harness__delegate_task',
          input: { title: 'Document tax.ts', brief: BRIEF },
        },
        { ts: now - 59_500, src: 'transcript', ref, k: 'tool.end', toolUseId: 'tu1', ok: true, harnessTaskId: TASK },
      ],
      'S',
    );
    expect(foldEvents('S', replay).agents[id].status).toBe('done');

    src.close();
    h.close();
  });

  it('a reader alone never changes the file', () => {
    const { h, src, file } = setup();
    const now = Date.now();
    h.project('prj_1', CWD, now);
    h.task({ id: TASK, project: 'prj_1', title: 'T', brief: BRIEF, state: 'implementing', ts: now });
    h.message({ task: TASK }, SYSTEM, now);
    h.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const hash = () => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
    const before = hash();
    src.poll();
    src.scan([]);
    src.owner('task', TASK);
    src.close();
    expect(hash()).toBe(before);
    h.close();
  });

  it('exposes the worker\u2019s own model server from the harness settings (read-only)', async () => {
    const { h, src, file } = setup();
    h.db.exec(`create table settings (key text primary key, value text not null);`);
    const setSetting = h.db.prepare(`insert into settings (key, value) values (?, ?);`);
    setSetting.run('openaiCompatBaseUrl', '"http://127.0.0.1:8000/v1"');
    setSetting.run('ollamaBaseUrl', '"http://127.0.0.1:9000"');
    h.project('prj_1', CWD, Date.now());
    h.task({ id: TASK, project: 'prj_1', title: 'T', brief: BRIEF, state: 'implementing', ts: Date.now() });
    const hash = () => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
    const before = hash();
    expect(src.poll()).toBe(true);
    expect([...src.endpoints()].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'kiln-ollama', name: 'Kiln worker (Ollama)', url: 'http://127.0.0.1:9000' },
      { id: 'kiln-openai', name: 'Kiln worker', url: 'http://127.0.0.1:8000' },
    ]);
    src.setConfig({ enabled: false });
    expect(src.endpoints()).toEqual([]);
    expect(hash()).toBe(before);
    src.close();
    h.close();
  });

  it('reports no endpoints when the DB has no settings table, and still reads tasks', () => {
    const { h, src } = setup();
    const now = Date.now();
    h.project('prj_1', CWD, now);
    h.task({ id: TASK, project: 'prj_1', title: 'T', brief: BRIEF, state: 'implementing', ts: now });
    expect(src.poll()).toBe(true);
    expect(src.scan([]).map((r) => r.id)).toEqual([harnessSessionId(TASK)]);
    expect(src.endpoints()).toEqual([]);
    src.close();
    h.close();
  });

  it('starts a conversation over when rows went away (a rewind)', async () => {
    const { h, src } = setup();
    const now = Date.now() - 10_000;
    h.project('prj_1', CWD, now);
    h.conversation({ id: 'conv_1', project: 'prj_1', title: 'Rewind me', ts: now });
    h.message({ conversation: 'conv_1' }, userMsg('First idea'), now);
    const gone = h.message({ conversation: 'conv_1' }, asst('A long answer'), now + 1);
    src.poll();
    const cw = src.watcher(harnessSessionId('conv_1'), 'kiln-harness:conversation:conv_1');
    await cw.poll();
    expect(cw.state.agents[MAIN].lastText).toBe('A long answer');
    h.db.prepare('DELETE FROM messages WHERE id = ?').run(gone);
    h.event('conversation.rewound', now + 2);
    h.message({ conversation: 'conv_1' }, asst('A short answer'), now + 3);
    src.poll();
    await cw.poll();
    expect(cw.state.log.filter((l) => l.kind === 'text').map((l) => l.text)).toEqual(['A short answer']);
    src.close();
    h.close();
  });
});
