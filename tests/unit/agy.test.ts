import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGY, AgyConverter, agyArg, agyPrompt, agySessionId, agyToolName } from '../../src/core/agy';
import { WINDOW_GEMINI, contextInfo } from '../../src/core/context';
import { harnessAgentId } from '../../src/core/harness';
import { tokensByProvider } from '../../src/core/localModels';
import { classifyModel, geminiEffort } from '../../src/core/models';
import { estimateAgents, estimateCostUSD } from '../../src/core/pricing';
import { foldEvents } from '../../src/core/reducer';
import { MAIN } from '../../src/core/state';
import { modelFamily, modelLabel } from '../../src/core/summarize';
import { weightOf } from '../../src/core/usageEstimate';
import { AgySource, agyDataDirs } from '../../src/main/agy';
import { HarnessSource } from '../../src/main/harness';
import { AGY_DELEGATE, KILN_AGY_TRANSCRIPT, agyArgs, agyResponse, agyResult, agySteps, agyUser, writeAgyTranscript } from '../fixtures/agy';
import { FakeHarness, SYSTEM, asst, delegateResult, userMsg } from '../fixtures/harness';

const SID = agySessionId('99b6d6c5-6b47-40d9-95ce-850adc2bfa21');
const fold = (lines: string[], cwd: string | null = '/Users/demo/code/notes') => {
  const conv = new AgyConverter(SID, cwd);
  const events = conv.pushLines(lines);
  return { conv, events, s: foldEvents(SID, events) };
};

describe('Gemini models', () => {
  it('get their own family and a readable label, apart from Claude, local and other models', () => {
    expect(classifyModel('gemini-4-neon-high')).toEqual({ provider: 'google', family: 'gemini', label: 'Gemini 4 Neon' });
    expect(classifyModel('Gemini 4 Neon (High)').label).toBe('Gemini 4 Neon');
    expect(classifyModel('gemini-2.5-pro').label).toBe('Gemini 2.5 Pro');
    expect(classifyModel('google/gemini-3-flash').provider).toBe('google');
    expect(modelFamily('gemini-4-neon-high')).toBe('gemini');
    expect(modelLabel('gemini-4-neon-high')).toBe('Gemini 4 Neon');
    expect(geminiEffort('gemini-4-neon-high')).toBe('high');
    expect(geminiEffort('Gemini 4 Neon (High)')).toBe('high');
    expect(geminiEffort('gemini-2.5-pro')).toBeNull();
    // Gemma is an open model run locally, Claude stays Claude
    expect(modelFamily('gemma3:27b')).toBe('local');
    expect(modelFamily('claude-opus-5-5')).toBe('opus');
  });

  it('never count as Claude usage, and have no made-up price', () => {
    const u = { in: 10_000, out: 1000, cacheRead: 50_000, cacheWrite: 0 };
    expect(weightOf('gemini-4-neon-high', u)).toBe(0);
    expect(weightOf('claude-sonnet-5-5', u)).toBeGreaterThan(0);
    expect(estimateCostUSD(u, 'gemini-4-neon-high')).toBeNull();
    const { s } = fold(KILN_AGY_TRANSCRIPT);
    expect(estimateAgents(s.agents)).toEqual({ usd: 0, unpriced: ['gemini-4-neon-high'] });
    const split = tokensByProvider(s.agents, s.totals);
    expect(split.claude).toEqual({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
    expect(split.geminiAgents).toBe(1);
    expect(split.gemini.out).toBe(357 + 242 + 82 + 10);
  });

  it('have the window Antigravity reports', () => {
    const c = contextInfo({ model: 'gemini-4-neon-high', contextTokens: 104_857, contextPeak: 104_857 })!;
    expect(c).toMatchObject({ size: WINDOW_GEMINI, windowKnown: true, pct: 10 });
  });
});

describe('an Antigravity transcript (Kiln’s agy fixture)', () => {
  it('becomes a session like a Claude one: prompt, Gemini main agent, tools, plan, tokens, turn end', () => {
    const { s } = fold(KILN_AGY_TRANSCRIPT);
    const main = s.agents[MAIN];
    expect(s.entrypoint).toBe(AGY);
    expect(s.cwd).toBe('/Users/demo/code/notes');
    expect(s.title).toMatch(/^Track two steps with update_steps/);
    expect(main.model).toBe('gemini-4-neon-high');
    expect(main.effort).toBe('high');
    expect(main.prompt).not.toContain('USER_REQUEST');
    expect(main.prompt).not.toContain('Model Selection');
    // update_steps -> the plan, run_command -> Bash, read_file -> Read
    expect(s.todos.map((t) => [t.text, t.status])).toEqual([
      ['List workspace files', 'completed'],
      ['Read a.txt', 'completed'],
    ]);
    const tools = s.log.filter((l) => l.kind === 'tool').map((l) => l.text);
    expect(tools.some((t) => /ls -la|List workspace files/.test(t))).toBe(true);
    expect(tools.some((t) => /a\.txt/.test(t))).toBe(true);
    expect(main.recent.map((r) => r.name)).toEqual(expect.arrayContaining(['Bash', 'Read', 'TodoWrite']));
    expect(main.recent.every((r) => r.ok === true)).toBe(true);
    expect(main.currentTool).toBeNull();
    expect(main.errorCount).toBe(0);
    expect(main.tokens.out).toBe(357 + 242 + 82 + 10);
    expect(main.tokens.in).toBe(9735 + 2716 + 2462 + 2212);
    expect(main.tokens.cacheRead).toBe(7678 + 8345 + 8758);
    expect(main.lastText).toBe('done');
    expect(main.status).toBe('idle');
  });

  it('reads a step only once, and a step split over two reads', () => {
    const conv = new AgyConverter(SID, null);
    const a = conv.pushLines(KILN_AGY_TRANSCRIPT.slice(0, 5));
    const again = conv.pushLines(KILN_AGY_TRANSCRIPT.slice(0, 5));
    const rest = conv.pushLines(KILN_AGY_TRANSCRIPT.slice(5));
    expect(again).toEqual([]);
    const all = foldEvents(SID, [...a, ...rest]);
    expect(all.agents[MAIN].tokens.out).toBe(357 + 242 + 82 + 10);
  });

  it('ends a call at its result: a failing command fails, a call that never returns is ended after a long silence', () => {
    const t = Date.parse('2026-11-24T19:00:00Z');
    const lines = [
      agyUser(0, t, 'Run the tests'),
      agyResponse(1, t + 1000, { calls: [['run_command', agyArgs({ CommandLine: 'npm test', Cwd: '/Users/demo/code/shop' })]] }),
      agyResult(2, t + 5000, 'Command exited with code 1.\n\nCommand output:\n1 failing', t + 6000),
      agyResponse(3, t + 7000, { calls: [['run_command', agyArgs({ CommandLine: 'npm run build' })]] }),
    ];
    const conv = new AgyConverter(SID, null);
    const events = conv.pushLines(lines);
    let s = foldEvents(SID, events);
    // no folder from Kiln: the command's Cwd says where it works
    expect(s.cwd).toBe('/Users/demo/code/shop');
    expect(s.agents[MAIN].errorCount).toBe(1);
    expect(s.agents[MAIN].currentTool?.name).toBe('Bash');
    s = foldEvents(SID, [...events, ...conv.flushStale(t + 60 * 60_000)]);
    expect(s.agents[MAIN].currentTool).toBeNull();
  });

  it('shows a subagent call as a Gemini child agent while it runs', () => {
    const t = Date.parse('2026-11-24T19:00:00Z');
    const conv = new AgyConverter(SID, '/Users/demo/code/shop');
    const start = conv.pushLines([
      agyUser(0, t, 'Check the page'),
      agyResponse(1, t + 1000, { calls: [['browser_subagent', agyArgs({ TaskName: 'Open the checkout page', Task: 'Open /checkout and report errors.' })]] }),
    ]);
    let s = foldEvents(SID, start);
    const child = Object.values(s.agents).find((a) => a.parentId === MAIN)!;
    expect(child).toMatchObject({ status: 'running', model: 'gemini-4-neon-high', description: 'Open the checkout page' });
    s = foldEvents(SID, [...start, ...conv.pushLines([agyResult(2, t + 9000, 'No errors.')])]);
    expect(s.agents[child.id].status).toBe('done');
  });

  it('unwraps agy’s JSON-encoded arguments and its prompt wrapper', () => {
    expect(agyArg('"ls -la"')).toBe('ls -la');
    expect(agyArg('plain')).toBe('plain');
    expect(agyArg('[1,2]')).toEqual([1, 2]);
    expect(agyPrompt('<USER_REQUEST>\nFix it\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>')).toBe('Fix it');
    const plan = agySteps([['a', 'done']]);
    expect(typeof plan.steps).toBe('string');
  });

  it('knows Kiln’s harness tools under the names agy gives them', () => {
    for (const n of [
      AGY_DELEGATE,
      'kiln-harness_harness/delegate_task',
      'mcp__kiln-harness_harness__delegate_task',
      'harness_delegate_task',
      'delegate_task',
    ]) {
      expect(agyToolName(n), n).toBe('mcp__harness__delegate_task');
    }
    expect(agyToolName('mcp_kiln-harness_harness_task_result')).toBe('mcp__harness__task_result');
    expect(agyToolName('call_mcp_tool', { ServerName: 'kiln-harness_harness', ToolName: 'delegate_task' })).toBe('mcp__harness__delegate_task');
    // someone else's delegate tool is not Kiln's
    expect(agyToolName('mcp_other_delegate_task')).toBe('mcp_other_delegate_task');
    expect(agyToolName('run_command')).toBe('Bash');
    expect(agyToolName('replace_file_content')).toBe('Edit');
  });
});

describe('Antigravity sessions on disk, with Kiln’s workers', () => {
  const dirs: string[] = [];
  const keep = { db: process.env.CLAUDE_VIS_HARNESS_DB, agy: process.env.CLAUDE_VIS_AGY_DIR };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    for (const [k, v] of [
      ['CLAUDE_VIS_HARNESS_DB', keep.db],
      ['CLAUDE_VIS_AGY_DIR', keep.agy],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('finds agy’s data where it writes it, and never the real one under a test home', () => {
    expect(agyDataDirs({}, '/Users/demo')).toEqual([
      path.join('/Users/demo', '.gemini', 'antigravity-cli'),
      path.join('/Users/demo', '.gemini', 'antigravity'),
    ]);
    expect(agyDataDirs({ CLAUDE_VIS_HOME: '/tmp/home' }, '/Users/demo')).toEqual([]);
    expect(agyDataDirs({ CLAUDE_VIS_HOME: '/tmp/home', CLAUDE_VIS_AGY_DIR: '/tmp/agy' }, '/Users/demo')).toEqual(['/tmp/agy']);
  });

  it('lists the conversation with Kiln’s folder, and hangs the workers its delegate_task calls made under the Gemini lead', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-agy-'));
    dirs.push(d);
    const CWD = '/Users/demo/code/shop';
    const CONV = '0d6a8c1e-2b3f-4e5a-9c7d-1f2e3d4c5b6a';
    const now = Date.now();
    const T1 = 'task_a1a1a1a1a1a1';
    const T2 = 'task_b2b2b2b2b2b2';
    const lines = [
      agyUser(0, now - 300_000, 'Clean up checkout; hand the routine parts to the local workers.'),
      agyResponse(1, now - 290_000, {
        calls: [
          ['update_steps', agySteps([['Delegate the tests', 'in_progress']])],
          [AGY_DELEGATE, agyArgs({ title: 'Write cart tests', brief: 'Write unit tests for src/cart.ts.', tier: 'local', toolSummary: 'Delegate the tests' })],
          [AGY_DELEGATE, agyArgs({ title: 'Document tax.ts', brief: 'Add JSDoc to src/tax.ts.', tier: 'local' })],
        ],
      }),
      agyResult(2, now - 289_000, 'OK'),
      agyResult(3, now - 288_000, delegateResult(T1)),
    ];
    const file = writeAgyTranscript(d, CONV, lines);
    const h = new FakeHarness(path.join(d, 'harness.db'));
    h.project('prj_shop', CWD, now - 600_000);
    h.leadSession({ kind: 'agy', nativeId: CONV, project: 'prj_shop', ts: now - 301_000, transcript: file });
    for (const [id, title, brief, ts] of [
      [T1, 'Write cart tests', 'Write unit tests for src/cart.ts.', now - 288_500],
      [T2, 'Document tax.ts', 'Add JSDoc to src/tax.ts.', now - 287_500],
    ] as const) {
      h.task({ id, project: 'prj_shop', title, brief, state: 'implementing', ts });
      h.message({ task: id }, SYSTEM, ts + 10);
      h.message({ task: id }, userMsg(brief), ts + 10);
      h.message({ task: id }, asst('Reading.', [['c1', 'read_file', { path: 'src/cart.ts' }]]), ts + 20);
    }
    process.env.CLAUDE_VIS_HARNESS_DB = h.file;
    process.env.CLAUDE_VIS_AGY_DIR = d;
    const hx = new HarnessSource();
    hx.setConfig({ enabled: true });
    expect(hx.poll()).toBe(true);
    expect(hx.agyRoot(CONV)).toBe(CWD);

    const src = new AgySource();
    src.cwdOf = (id) => hx.agyRoot(id);
    const rows = await src.scan();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: agySessionId(CONV), source: AGY, entrypoint: AGY, cwd: CWD, project: 'shop', live: true });
    expect(rows[0].title).toMatch(/^Clean up checkout/);

    const w = src.watcher(rows[0].id, rows[0].file);
    expect(await w.poll()).toBe(true);
    expect(w.state.cwd).toBe(CWD);
    expect(w.state.agents[MAIN].model).toBe('gemini-4-neon-high');
    // the first call's result names its task; the second is still waiting and is matched by title and brief
    expect(hx.link(w)).toBe(true);
    for (const id of [T1, T2]) {
      const a = w.state.agents[harnessAgentId(id)];
      expect(a, id).toBeDefined();
      expect(a.parentId).toBe(MAIN);
      expect(modelFamily(a.model)).toBe('local');
    }
    expect(hx.claimedBy(T1)).toBe(rows[0].id);
    expect(hx.claimedBy(T2)).toBe(rows[0].id);
    // nothing is listed twice: the claimed tasks get no rows of their own
    expect(hx.scan(rows, () => true)).toEqual([]);

    // live: the second result and the turn's end arrive
    fs.appendFileSync(file, [agyResult(4, Date.now(), delegateResult(T2)), agyResponse(5, Date.now(), { content: 'Both handed off.' })].join('\n') + '\n');
    expect(await w.poll()).toBe(true);
    expect(w.state.agents[MAIN].status).toBe('idle');
    expect(w.state.agents[MAIN].lastText).toBe('Both handed off.');

    // replay: the lead's events plus its workers
    const replay = hx.withTasks(await w.collectAllEvents(), w.sessionId);
    const r = foldEvents(w.sessionId, replay);
    expect(r.agents[harnessAgentId(T1)]?.parentId).toBe(MAIN);
    expect(r.agents[harnessAgentId(T2)]?.parentId).toBe(MAIN);
    hx.close();
    h.close();
  });

  it('a task an agy lead in the same folder has not claimed yet is not listed as unclaimed', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-agy-'));
    dirs.push(d);
    const h = new FakeHarness(path.join(d, 'harness.db'));
    const now = Date.now();
    h.project('prj_shop', '/Users/demo/code/shop', now - 600_000);
    h.task({ id: 'task_c3c3c3c3c3c3', project: 'prj_shop', title: 'Rename', brief: 'Rename x.', state: 'implementing', ts: now - 5000 });
    h.message({ task: 'task_c3c3c3c3c3c3' }, SYSTEM, now - 4000);
    process.env.CLAUDE_VIS_HARNESS_DB = h.file;
    const hx = new HarnessSource();
    hx.setConfig({ enabled: true });
    hx.poll();
    const lead = {
      id: agySessionId('c'),
      file: 'agy:x',
      projectDir: '/Users/demo/code/shop',
      project: 'shop',
      cwd: '/Users/demo/code/shop',
      title: null,
      mtime: now,
      size: 1,
      live: true,
      entrypoint: AGY,
      source: AGY,
    };
    expect(hx.scan([], () => false).map((r) => r.id)).toHaveLength(1);
    expect(hx.scan([lead], () => false)).toEqual([]);
    hx.close();
    h.close();
  });
});
