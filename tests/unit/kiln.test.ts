import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/core/events';
import { searchKilnRuns, isKilnDelegate, kilnAgentId, kilnDurations, KilnLog, kilnModelId, kilnRunEvents, matchKilnRun, parseKilnLine, sameTask, withKilnRuns } from '../../src/core/kiln';
import { apply } from '../../src/core/reducer';
import { MAIN, newSession } from '../../src/core/state';
import { classifyModel } from '../../src/core/models';
import { tokensByProvider } from '../../src/core/localModels';
import { shellCall } from '../../src/core/cmdEta';
import { KilnSource, kilnEventsPath, kilnSessionId } from '../../src/main/kiln';
import { KILN_STATUS_LINE, kilnRunLines, type KilnRunSpec } from '../fixtures/kiln';

const CWD = '/home/me/proj';
const T0 = 1_760_000_000; // unix seconds
const BRIEF = 'Add a --verbose flag to cli.py.\nFiles: cli.py, tests/test_cli.py. Verify with pytest -q tests/test_cli.py.';

const spec = (over: Partial<KilnRunSpec> = {}): KilnRunSpec => ({
  id: 'abc123',
  task: BRIEF,
  cwd: CWD,
  start: T0 + 2,
  steps: [
    ['read_file', 'cli.py', true],
    ['edit_file', 'cli.py', true],
    ['bash', 'pytest -q tests/test_cli.py', false],
  ],
  text: 'Added the flag.',
  finish: { ok: true, answer: 'Added --verbose and a test.', files: ['cli.py', 'tests/test_cli.py'] },
  ...over,
});

const logOf = (...runs: KilnRunSpec[]) => {
  const log = new KilnLog();
  for (const r of runs) for (const l of kilnRunLines(r)) log.add(parseKilnLine(l)!);
  return log;
};

/** a Claude session whose main agent calls delegate_task at T0 */
function claudeSession(task = BRIEF, name = 'mcp__kiln__delegate_task', t0 = T0) {
  const s = newSession('S');
  const ref = { sessionId: 'S', agentId: null };
  apply(s, { ts: t0 * 1000 - 5000, src: 'transcript', ref, k: 'session.meta', cwd: CWD });
  apply(s, { ts: t0 * 1000, src: 'transcript', ref, k: 'tool.start', toolUseId: 'tu1', name, input: { task: task.slice(0, 300), cwd: CWD, effort: 'medium' } });
  return s;
}

describe('kiln events file', () => {
  it('folds a run: brief, steps, result, tokens', () => {
    const log = logOf(spec());
    const r = log.runs.get('abc123')!;
    expect(r.task).toBe(BRIEF);
    expect(r.cwd).toBe(CWD);
    expect(r.model).toBe('qwen3:30b');
    expect(r.startedAt).toBe((T0 + 2) * 1000);
    expect(r.steps.map((s) => s.kind)).toEqual(['call', 'result', 'call', 'result', 'call', 'result', 'text']);
    expect(r.ok).toBe(true);
    expect(r.filesChanged).toEqual(['cli.py', 'tests/test_cli.py']);
    expect(r.promptTokens).toBe(41000);
    expect(r.tokensPerSec).toBe(38.5);
  });

  it('ignores a line read twice (rotation) and junk lines', () => {
    const log = new KilnLog();
    const lines = kilnRunLines(spec());
    for (const l of [...lines, ...lines, 'not json', '{"no":"kind"}', '']) {
      const e = parseKilnLine(l);
      if (e) log.add(e);
    }
    expect(log.runs.get('abc123')!.steps).toHaveLength(7);
  });

  it('keeps the newest status check', () => {
    const log = new KilnLog();
    log.add(parseKilnLine(KILN_STATUS_LINE(T0 + 10, false))!);
    log.add(parseKilnLine(KILN_STATUS_LINE(T0, true))!);
    expect(log.status).toMatchObject({ reachable: false, model: 'qwen3:30b', baseUrl: 'http://localhost:11434/v1' });
  });

  it('finds the file where Kiln writes it', () => {
    const home = path.join('/', 'home', 'me');
    expect(kilnEventsPath('', {}, home)).toBe(path.join(home, '.config', 'kiln', 'events.jsonl'));
    expect(kilnEventsPath('', { XDG_CONFIG_HOME: '/x' }, home)).toBe(path.join('/x', 'kiln', 'events.jsonl'));
    expect(kilnEventsPath('', { KILN_EVENTS_PATH: '/y/e.jsonl' }, home)).toBe('/y/e.jsonl');
    expect(kilnEventsPath('/z.jsonl', { KILN_EVENTS_PATH: '/y/e.jsonl' }, home)).toBe('/z.jsonl');
    // test runs on a fixture never read this machine's real file
    expect(kilnEventsPath('', { CLAUDE_VIS_HOME: '/fixture' }, home)).toBeNull();
  });
});

describe('matching a run to its delegate_task call', () => {
  it('knows the tool under both registrations', () => {
    expect(isKilnDelegate('mcp__kiln__delegate_task')).toBe(true);
    expect(isKilnDelegate('mcp__plugin_kiln_kiln__delegate_task')).toBe(true);
    expect(isKilnDelegate('mcp__kiln__local_model_status')).toBe(false);
    expect(isKilnDelegate('Bash')).toBe(false);
  });

  it('compares clipped briefs', () => {
    expect(sameTask(BRIEF.slice(0, 40), BRIEF)).toBe(true);
    expect(sameTask('Add a   --verbose flag', 'Add a --verbose flag to cli.py')).toBe(true);
    expect(sameTask('Add a --quiet flag', 'Add a --verbose flag')).toBe(false);
  });

  it('takes the run with the same brief that started just after the call, in the same folder', () => {
    const log = logOf(
      spec({ id: 'early', start: T0 - 600 }),
      spec({ id: 'other-dir', cwd: '/elsewhere', start: T0 + 1 }),
      spec({ id: 'right', start: T0 + 3 }),
      spec({ id: 'other-task', task: 'Write docs', start: T0 + 2 }),
    );
    const call = { toolUseId: 'tu1', agentId: MAIN, ts: T0 * 1000, task: BRIEF.slice(0, 300), cwd: CWD };
    expect(matchKilnRun(call, log.runs.values(), () => false)!.id).toBe('right');
    expect(matchKilnRun(call, log.runs.values(), (id) => id === 'right')!.id).toBe('other-dir');
  });

  it('matches hand-offs queued behind each other (Claude Code runs MCP tools one at a time)', () => {
    // Claude hands three tasks to Kiln in one message; each run starts only when the previous call returns
    const briefs = ['Write tests for parser.py', 'Write tests for lexer.py', 'Write tests for emitter.py'];
    const s = newSession('S');
    const ref = { sessionId: 'S', agentId: null };
    apply(s, { ts: T0 * 1000 - 5000, src: 'transcript', ref, k: 'session.meta', cwd: CWD });
    briefs.forEach((task, i) =>
      apply(s, { ts: T0 * 1000 + i, src: 'transcript', ref, k: 'tool.start', toolUseId: `tu${i}`, name: 'mcp__kiln__delegate_task', input: { task, cwd: CWD } }),
    );
    // runs at +1 s, +8 min, +16 min, each 8 minutes long
    const log = logOf(...briefs.map((task, i) => spec({ id: `w${i}`, task, start: T0 + 1 + i * 480, finish: { ok: true, seconds: 470 } })));
    const call = (i: number) => ({ ...s.internal.kilnCalls![`tu${i}`], toolUseId: `tu${i}` });
    expect(briefs.map((_, i) => matchKilnRun(call(i), log.runs.values(), () => false)?.id)).toEqual(['w0', 'w1', 'w2']);
    // the first returned at +8 min: the reducer records that, and a later run with its brief is not its
    apply(s, { ts: (T0 + 475) * 1000, src: 'transcript', ref, k: 'tool.end', toolUseId: 'tu0', ok: true });
    expect(s.internal.kilnCalls!.tu0.endTs).toBe((T0 + 475) * 1000);
    // replay pairs them the same way
    const evs: AgentEvent[] = [
      { ts: T0 * 1000 - 5000, src: 'transcript', ref, k: 'session.meta', cwd: CWD },
      ...briefs.map((task, i): AgentEvent => ({ ts: T0 * 1000 + i, src: 'transcript', ref, k: 'tool.start', toolUseId: `tu${i}`, name: 'mcp__kiln__delegate_task', input: { task, cwd: CWD } })),
    ];
    const spawned = withKilnRuns(evs, [...log.runs.values()], 'S').filter((e) => e.k === 'agent.spawn');
    expect(spawned.map((e) => e.ref.agentId)).toEqual(['kiln-w0', 'kiln-w1', 'kiln-w2']);
  });

  it('gives a retried brief the run that started before each call returned', () => {
    const log = logOf(spec({ id: 'first', start: T0 + 2, finish: { ok: false, error: 'boom', seconds: 60 } }), spec({ id: 'retry', start: T0 + 302 }));
    const first = { toolUseId: 'tu1', agentId: MAIN, ts: T0 * 1000, task: BRIEF.slice(0, 300), cwd: CWD, endTs: (T0 + 63) * 1000 };
    const second = { toolUseId: 'tu2', agentId: MAIN, ts: (T0 + 300) * 1000, task: BRIEF.slice(0, 300), cwd: CWD };
    expect(matchKilnRun(first, log.runs.values(), () => false)!.id).toBe('first');
    // the retry's run started after the first call had returned: never the first call's
    expect(matchKilnRun(first, log.runs.values(), (id) => id === 'first')).toBeNull();
    expect(matchKilnRun(second, log.runs.values(), (id) => id === 'first')!.id).toBe('retry');
  });

  it('matches a brief Kiln clipped with an ellipsis', () => {
    expect(sameTask('Rename foo to bar everywhere in src', 'Rename foo to bar…')).toBe(true);
    expect(sameTask('Rename foo to baz everywhere in src', 'Rename foo to bar…')).toBe(false);
  });
});

describe('a run as agent events', () => {
  it('becomes a finished local-model child of the calling agent', () => {
    const s = claudeSession();
    const log = logOf(spec());
    for (const e of kilnRunEvents(log.runs.get('abc123')!, 'S', 'tu1')) apply(s, e);
    const k = s.agents[kilnAgentId('abc123')];
    expect(k.parentId).toBe(MAIN);
    expect(k.agentType).toBe('kiln');
    expect(k.description).toBe('Add a --verbose flag to cli.py.');
    expect(classifyModel(k.model).provider).toBe('local');
    expect(k.effort).toBe('medium');
    expect(k.status).toBe('done');
    expect(k.toolCount).toBe(3);
    expect(k.errorCount).toBe(1);
    expect(k.files).toContain('cli.py');
    expect(k.commands).toEqual(['pytest -q tests/test_cli.py']);
    expect(k.kiln).toMatchObject({ ok: true, finished: true, steps: 3, filesChanged: ['cli.py', 'tests/test_cli.py'], completionTokens: 3200 });
    // the local model's tokens count as local, not as Claude usage, and are not a context size
    const split = tokensByProvider(s.agents, s.totals);
    expect(split.local).toMatchObject({ in: 41000, out: 3200 });
    expect(split.claude.out).toBe(0);
    expect(k.contextTokens).toBe(0);
  });

  it('is running while Kiln works, and grows only at the end', () => {
    const going = logOf(spec({ finish: undefined, text: undefined })).runs.get('abc123')!;
    const a = kilnRunEvents(going, 'S', 'tu1');
    const done = logOf(spec()).runs.get('abc123')!;
    const b = kilnRunEvents(done, 'S', 'tu1');
    expect(b.slice(0, a.length).map((e) => e.k)).toEqual(a.map((e) => e.k));
    const s = claudeSession();
    for (const e of a) apply(s, e);
    expect(s.agents[kilnAgentId('abc123')].status).toBe('running');
    for (const e of b.slice(a.length)) apply(s, e);
    expect(s.agents[kilnAgentId('abc123')].status).toBe('done');
  });

  it('a failed or lost run ends in error', () => {
    const failed = logOf(spec({ finish: { ok: false, error: 'local model server not reachable' } })).runs.get('abc123')!;
    const s = claudeSession();
    for (const e of kilnRunEvents(failed, 'S', 'tu1')) apply(s, e);
    expect(s.agents[kilnAgentId('abc123')].status).toBe('error');
    expect(s.agents[kilnAgentId('abc123')].kiln?.error).toMatch(/not reachable/);

    const lost = logOf(spec({ finish: undefined })).runs.get('abc123')!;
    lost.lost = true;
    const s2 = claudeSession();
    for (const e of kilnRunEvents(lost, 'S', 'tu1')) apply(s2, e);
    expect(s2.agents[kilnAgentId('abc123')].status).toBe('error');
    expect(s2.agents[kilnAgentId('abc123')].kiln?.error).toMatch(/stopped before/);
  });

  it('an unclaimed run is a session of its own', () => {
    const r = logOf(spec()).runs.get('abc123')!;
    const s = newSession('kiln-abc123');
    for (const e of kilnRunEvents(r, s.id, null)) apply(s, e);
    expect(s.title).toBe('Add a --verbose flag to cli.py.');
    expect(s.cwd).toBe(CWD);
    expect(s.mode).toBe('bypassPermissions');
    expect(s.agents[MAIN].kiln?.ok).toBe(true);
    expect(s.agents[MAIN].toolCount).toBe(3);
    expect(Object.keys(s.agents)).toEqual([MAIN]);
  });

  it('replay adds the runs a session handed off', () => {
    const r = logOf(spec()).runs.get('abc123')!;
    const ref = { sessionId: 'S', agentId: null };
    const evs: AgentEvent[] = [
      { ts: T0 * 1000, src: 'transcript', ref, k: 'tool.start', toolUseId: 'tu1', name: 'mcp__kiln__delegate_task', input: { task: BRIEF, cwd: CWD } },
      { ts: T0 * 1000 + 60_000, src: 'transcript', ref, k: 'tool.end', toolUseId: 'tu1', ok: true },
    ];
    const out = withKilnRuns(evs, [r], 'S');
    expect(out.some((e) => e.k === 'agent.spawn' && e.spawn.childId === kilnAgentId('abc123'))).toBe(true);
    expect(out.map((e) => e.ts)).toEqual([...out.map((e) => e.ts)].sort((a, b) => a - b));
    expect(withKilnRuns(evs, [], 'S')).toBe(evs);
  });

  it('labels hosted-looking ids as local', () => {
    expect(classifyModel(kilnModelId('Qwen/Qwen3-Coder-30B-A3B-Instruct')).provider).toBe('local');
    expect(kilnModelId('qwen3:30b')).toBe('qwen3:30b');
  });
});

describe('History search', () => {
  it('finds runs by brief, answer or message, every word required, with the words marked', () => {
    const runs = logOf(spec(), spec({ id: 'other', task: 'Write docs for the API', finish: { ok: true, answer: 'Wrote docs/api.md.' } })).list();
    const h = searchKilnRuns(runs, 'verbose test');
    expect(h.map((x) => x.run.id)).toEqual(['abc123']);
    expect(h[0].field).toBe('task');
    expect(h[0].snippet.filter((p) => p.hit).map((p) => p.text.toLowerCase())).toEqual(expect.arrayContaining(['verbose', 'test']));
    expect(searchKilnRuns(runs, 'docs/api.md')[0]).toMatchObject({ field: 'answer' });
    expect(searchKilnRuns(runs, 'verbose nowhere')).toEqual([]);
    expect(searchKilnRuns(runs, ' ')).toEqual([]);
  });
});

describe('hand-off countdown', () => {
  it('times delegate_task calls by effort, from past runs', () => {
    const log = logOf(spec({ id: 'a', finish: { ok: true, seconds: 90 } }), spec({ id: 'b', finish: { ok: false, seconds: 5 } }));
    expect(kilnDurations(log.runs.values())).toEqual([{ key: 'Kiln hand-off (medium)', project: 'proj', ms: 90_000 }]);
    expect(shellCall('mcp__kiln__delegate_task', { task: 'x', effort: 'high' })).toEqual({ key: 'Kiln hand-off (high)', timeoutMs: null });
    expect(shellCall('mcp__kiln__delegate_task', { task: 'x', readonly: true })).toEqual({ key: 'Kiln hand-off (medium, read-only)', timeoutMs: null });
  });
});

describe('KilnSource', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const setup = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-kiln-'));
    dirs.push(d);
    const file = path.join(d, 'events.jsonl');
    const src = new KilnSource();
    const prev = process.env.CLAUDE_VIS_KILN_EVENTS;
    process.env.CLAUDE_VIS_KILN_EVENTS = file;
    src.setConfig({ enabled: true, file: '' });
    if (prev === undefined) delete process.env.CLAUDE_VIS_KILN_EVENTS;
    else process.env.CLAUDE_VIS_KILN_EVENTS = prev;
    return { file, src };
  };

  it('tails the file, links runs into a watched session as they grow, and reads the rotation', async () => {
    const { file, src } = setup();
    // a run going on right now, in a process that is alive (this one)
    const now = Math.floor(Date.now() / 1000) - 30;
    const lines = kilnRunLines(spec({ start: now + 2, pid: process.pid }));
    fs.writeFileSync(file + '.1', lines.slice(0, 2).join('\n') + '\n');
    fs.writeFileSync(file, lines.slice(2, 4).join('\n') + '\n');
    expect(await src.poll()).toBe(true);
    const w = { sessionId: 'S', state: claudeSession(BRIEF, 'mcp__kiln__delegate_task', now), primed: true, ingest(evs: AgentEvent[]) { for (const e of evs) apply(this.state, e); } };
    expect(src.link(w)).toBe(true);
    const id = kilnAgentId('abc123');
    expect(w.state.agents[id].status).toBe('running');
    expect(w.state.agents[id].toolCount).toBe(2);
    expect(src.link(w)).toBe(false);
    fs.appendFileSync(file, lines.slice(4).join('\n') + '\n');
    expect(await src.poll()).toBe(true);
    expect(src.link(w)).toBe(true);
    expect(w.state.agents[id].status).toBe('done');
    expect(w.state.agents[id].toolCount).toBe(3);
    expect(src.claimedBy('abc123')).toBe('S');
  });

  it('lists a run no Claude session in its folder can claim', async () => {
    const { file, src } = setup();
    fs.writeFileSync(file, kilnRunLines(spec()).join('\n') + '\n');
    await src.poll();
    const rows = src.scan([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: kilnSessionId('abc123'), source: 'kiln', cwd: CWD, title: 'Add a --verbose flag to cli.py.' });
    // a Claude session active in that folder since the run started will show it instead
    const claude = { id: 'S', file: 'x', projectDir: '', project: 'proj', cwd: CWD, title: null, mtime: (T0 + 30) * 1000, size: 0, live: false, entrypoint: 'cli' };
    expect(src.scan([claude])).toHaveLength(0);
    // ... unless that session is followed and still has not claimed it: then it is not that session's, so it gets its row
    expect(src.scan([claude], (id) => id === 'S')).toHaveLength(1);
    const w = src.watcher(kilnSessionId('abc123'));
    expect(await w.poll()).toBe(true);
    expect(w.state.agents[MAIN].kiln?.ok).toBe(true);
    expect(await w.poll()).toBe(false);
  });

  it('marks a run whose Kiln process is gone as lost', async () => {
    const { file, src } = setup();
    const start = Math.floor(Date.now() / 1000) - 120;
    fs.writeFileSync(file, kilnRunLines(spec({ start, finish: undefined, pid: 999_999_9 })).join('\n') + '\n');
    await src.poll();
    expect(src.log.runs.get('abc123')!.lost).toBe(true);
  });
});
