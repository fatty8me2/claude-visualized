import { describe, expect, it } from 'vitest';
import { computeStepStatus, matchScore, parsePlan, planProgress, resolvePlan, stem, todosToPlan, tokens, type PlanAgent } from '@core/plan';
import { normalizeHook, normalizeLine } from '@core/normalize';
import { apply, foldEvents } from '@core/reducer';
import { newSession } from '@core/state';

const ctx = { sessionId: 's1', agentId: null };
const line = (o: unknown) => JSON.stringify(o);

describe('parsePlan', () => {
  it('reads numbered steps under headings, skipping context sections', () => {
    const p = parsePlan(`# Plan: Ship retries

## Context
- The api client has no retry.
- Users complain.

## Implementation
1. Add retry to the api client
2. Update the docs
3. Run the test suite

## Verification
- npm test passes
`);
    expect(p.title).toBe('Ship retries');
    // Implementation names the work, so Verification is reference material
    expect(p.sections.map((s) => s.title)).toEqual(['Implementation']);
    expect(p.steps.map((s) => s.title)).toEqual(['Add retry to the api client', 'Update the docs', 'Run the test suite']);
    expect(p.steps.map((s) => s.section)).toEqual([0, 0, 0]);
  });

  it('reads checkboxes with their state and nesting', () => {
    const p = parsePlan(`## Tasks
- [x] Write the parser
- [ ] Wire the UI
  - [ ] Rail component
  - [x] Styles
  - a loose note about the rail
- [ ] Ship
`);
    expect(p.steps.map((s) => [s.title, s.checked, s.depth])).toEqual([
      ['Write the parser', true, 0],
      ['Wire the UI', false, 0],
      ['Rail component', false, 1],
      ['Styles', true, 1],
      ['Ship', false, 0],
    ]);
    expect(p.steps[1].detail).toContain('loose note');
  });

  it('uses only numbered items when a section mixes facts and actions', () => {
    const p = parsePlan(`## Step 0: finish extras
- The suite passed.
- The bot runs cut off at level 2.
1. Re-run levels 2-14
2. Merge to main
`);
    expect(p.steps.map((s) => s.title)).toEqual(['Re-run levels 2-14', 'Merge to main']);
  });

  it('takes the bold lead of an item as its title and strips markdown', () => {
    const p = parsePlan('## Work\n- **Groundwork (lead):** placeholders, `Game.LEVELS` and the [brief](http://x)\n');
    expect(p.steps[0].title).toBe('Groundwork (lead)');
    expect(p.steps[0].text).toBe('Groundwork (lead): placeholders, Game.LEVELS and the brief');
  });

  it('ignores items inside code fences and before the first heading', () => {
    const p = parsePlan('- preamble item\n\n## Build\n```\n1. not a step\n```\n1. real step\n');
    expect(p.steps.map((s) => s.title)).toEqual(['real step']);
  });

  it('falls back to the ## headings when there are no list items', () => {
    const p = parsePlan('# Free form\n\n## Context\nwhy\n\n## Rewrite the parser\nWe replace the tokenizer.\n\n## Add the rail\nA new panel.\n');
    expect(p.steps.map((s) => s.title)).toEqual(['Rewrite the parser', 'Add the rail']);
    expect(p.steps[0].detail).toContain('tokenizer');
    expect(p.sections).toEqual([]);
  });

  it('survives garbage and empty input', () => {
    expect(parsePlan('').steps).toEqual([]);
    expect(parsePlan('just words\nno structure').steps).toEqual([]);
    expect(parsePlan('\u0000\u0001 ### \n- \n1.').steps.length).toBeLessThanOrEqual(1);
  });

  it('caps very long plans', () => {
    const md = '## Many\n' + Array.from({ length: 200 }, (_, i) => `${i + 1}. step number ${i}`).join('\n');
    expect(parsePlan(md).steps.length).toBe(80);
  });

  it('handles CRLF and tab-indented children', () => {
    const p = parsePlan('## A\r\n1. one\r\n\t1. nested one\r\n2. two\r\n');
    expect(p.steps.map((s) => [s.title, s.depth])).toEqual([['one', 0], ['nested one', 1], ['two', 0]]);
  });
});

describe('matching', () => {
  it('stems simple inflections', () => {
    expect(stem('tests')).toBe(stem('testing'));
    expect(stem('running')).toBe(stem('run'));
    expect(stem('queries')).toBe(stem('query'));
  });

  it('drops stopwords and splits identifiers', () => {
    expect([...tokens('Update the AgentGraph and add a test')].sort()).toEqual(['graph', 'test']);
  });

  it('needs two shared tokens or a Jaccard of 0.3', () => {
    expect(matchScore(tokens('search the repo for retry logic'), tokens('search repo')).ok).toBe(true);
    expect(matchScore(tokens('write the parser for plans'), tokens('plan the docs update')).ok).toBe(false);
    expect(matchScore(tokens('map repo'), tokens('search repo')).ok).toBe(true); // 1 of 3 shared
    expect(matchScore(tokens('implement the tray icon with menu and notifications'), tokens('repo')).ok).toBe(false);
  });
});

const agent = (id: string, description: string, status: string, extra: Partial<PlanAgent> = {}): PlanAgent => ({ id, agentType: 'general-purpose', description, status, ...extra });

describe('computeStepStatus', () => {
  const plan = parsePlan(`## Steps
1. Search the repo for the api client
2. Add retry with backoff
3. Run the tests
4. Update the docs
`);

  it('is pending with no evidence', () => {
    const st = computeStepStatus(plan.steps, [], []);
    expect(st.every((s) => s.status === 'pending' && s.linkedAgents.length === 0)).toBe(true);
  });

  it('a checked box is done', () => {
    const p = parsePlan('## T\n- [x] Write it\n- [ ] Ship it\n');
    const st = computeStepStatus(p.steps, [], []);
    expect(st.map((s) => s.status)).toEqual(['done', 'pending']);
    expect(st[0].reasons[0]).toMatch(/checked/);
  });

  it('a matching todo gives its status and the reason', () => {
    const st = computeStepStatus(plan.steps, [{ id: '1', text: 'Add retry with exponential backoff', status: 'in_progress' }, { id: '2', text: 'Update docs', status: 'completed' }], []);
    expect(st[1].status).toBe('in_progress');
    expect(st[1].reasons[0]).toBe("todo 'Add retry with exponential backoff' in progress");
    expect(st[3].status).toBe('done');
    expect(st[0].status).toBe('pending');
  });

  it('a running matching agent is in progress; all finished is done', () => {
    const run = computeStepStatus(plan.steps, [], [agent('a1', 'search repo', 'running', { agentType: 'Explore' })]);
    expect(run[0].status).toBe('in_progress');
    expect(run[0].linkedAgents).toEqual(['a1']);
    expect(run[0].reasons).toContain("agent Explore: 'search repo' running");

    const two = computeStepStatus(plan.steps, [], [agent('a1', 'search repo', 'done'), agent('a2', 'search api client', 'running')]);
    expect(two[0].status).toBe('in_progress');
    const fin = computeStepStatus(plan.steps, [], [agent('a1', 'search repo', 'done'), agent('a2', 'search api client', 'done')]);
    expect(fin[0].status).toBe('done');
    expect(fin[0].linkedAgents).toEqual(['a1', 'a2']);
  });

  it('a failed agent does not complete a step', () => {
    const st = computeStepStatus(plan.steps, [], [agent('a1', 'run tests', 'error')]);
    expect(st[2].status).toBe('pending');
    expect(st[2].linkedAgents).toEqual(['a1']);
  });

  it('todo evidence beats agent evidence, pending todo keeps a finished agent from completing it', () => {
    const st = computeStepStatus(plan.steps, [{ id: '1', text: 'Run the tests', status: 'pending' }], [agent('a1', 'run tests', 'done')]);
    expect(st[2].status).toBe('pending');
    const st2 = computeStepStatus(plan.steps, [{ id: '1', text: 'Run the tests', status: 'completed' }], [agent('a1', 'run tests', 'running')]);
    expect(st2[2].status).toBe('done');
  });

  it('links an agent to its best step only', () => {
    const st = computeStepStatus(plan.steps, [], [agent('a1', 'run the tests', 'running')]);
    expect(st.map((s) => s.linkedAgents.length)).toEqual([0, 0, 1, 0]);
  });

  it('ignores the main agent, and agents that started before the plan was submitted', () => {
    const st = computeStepStatus(plan.steps, [], [agent('main', 'run the tests', 'running', { kind: 'main' }), agent('a1', 'run the tests', 'running', { startedAt: 1000 })], { since: 50_000 });
    expect(st[2].linkedAgents).toEqual([]);
    const later = computeStepStatus(plan.steps, [], [agent('a1', 'run the tests', 'running', { startedAt: 60_000 })], { since: 50_000 });
    expect(later[2].linkedAgents).toEqual(['a1']);
  });

  it('uses the prompt only when the description says nothing', () => {
    const st = computeStepStatus(plan.steps, [], [agent('a1', 'x', 'running', { prompt: 'Please search the repo and find the api client implementation' })]);
    expect(st[0].linkedAgents).toEqual(['a1']);
    const noisy = computeStepStatus(plan.steps, [], [agent('a2', 'build the thing', 'running', { prompt: 'search the repo api client' })]);
    expect(noisy.every((s) => s.linkedAgents.length === 0)).toBe(true);
  });

  it('does not match unrelated agents', () => {
    const st = computeStepStatus(plan.steps, [], [agent('a1', 'Research Codex and Ollama', 'running')]);
    expect(st.every((s) => s.linkedAgents.length === 0)).toBe(true);
  });

  it('progress counts', () => {
    const p = planProgress([{ status: 'done', linkedAgents: [], reasons: [] }, { status: 'in_progress', linkedAgents: [], reasons: [] }, { status: 'pending', linkedAgents: [], reasons: [] }]);
    expect(p).toEqual({ done: 1, active: 1, total: 3 });
  });
});

describe('plan source', () => {
  it('uses the todo list when there is no plan', () => {
    const r = resolvePlan(null, [{ id: '1', text: 'Map the repo', status: 'completed' }, { id: '2', text: 'Add retry', status: 'in_progress' }]);
    expect(r?.origin).toBe('todos');
    const st = computeStepStatus(r!.parsed.steps, [{ id: '1', text: 'Map the repo', status: 'completed' }, { id: '2', text: 'Add retry', status: 'in_progress' }], []);
    expect(st.map((s) => s.status)).toEqual(['done', 'in_progress']);
  });

  it('is null with nothing to show', () => {
    expect(resolvePlan(null, [])).toBeNull();
    expect(resolvePlan({ text: 'no steps here', source: 'exit', approved: null }, [])).toBeNull();
    expect(todosToPlan([{ id: '1', text: '  ', status: 'pending' }]).steps).toEqual([]);
  });

  it('labels where the plan came from', () => {
    const text = '## Do\n1. one\n';
    expect(resolvePlan({ text, source: 'file', approved: null }, [])?.origin).toBe('file');
    expect(resolvePlan({ text, source: 'exit', approved: true }, [])?.origin).toBe('approved');
    expect(resolvePlan({ text, source: 'exit', approved: null }, [])?.origin).toBe('approved');
    expect(resolvePlan({ text, source: 'exit', approved: false }, [])?.origin).toBe('proposed');
  });
});

describe('plan events', () => {
  const att = (a: object, ts = '2026-10-01T10:00:00Z') => line({ type: 'attachment', timestamp: ts, attachment: a });
  const exit = (plan: string, id = 'toolu_X', ts = '2026-10-01T10:05:00Z') =>
    line({ type: 'assistant', timestamp: ts, message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'ExitPlanMode', input: { plan, planFilePath: 'C:\\p\\plan.md' } }] } });

  it('plan_mode attachments reveal the plan file path', () => {
    const evs = normalizeLine(att({ type: 'plan_mode', isSubAgent: false, planFilePath: 'C:\\p\\plan.md', planExists: false }), ctx);
    expect(evs.find((e) => e.k === 'plan')).toMatchObject({ source: 'path', path: 'C:\\p\\plan.md' });
    const s = foldEvents('s1', evs);
    expect(s.plan).toMatchObject({ path: 'C:\\p\\plan.md', text: null });
  });

  it('plan_mode_exit and plan_file_reference carry path and content', () => {
    expect(normalizeLine(att({ type: 'plan_mode_exit', planFilePath: 'C:\\p\\a.md' }), ctx).some((e) => e.k === 'plan' && e.path === 'C:\\p\\a.md')).toBe(true);
    const ref = normalizeLine(att({ type: 'plan_file_reference', planFilePath: 'C:\\p\\a.md', planContent: '## A\n1. x' }), ctx).find((e) => e.k === 'plan');
    expect(ref).toMatchObject({ text: '## A\n1. x', source: 'reference' });
  });

  it('ExitPlanMode keeps the whole plan text, capped at 40k', () => {
    const big = '## Steps\n' + '1. a step\n'.repeat(6000);
    const evs = normalizeLine(exit(big), ctx);
    const pe = evs.find((e) => e.k === 'plan');
    expect(pe && pe.k === 'plan' && pe.text!.length).toBe(40_000);
    expect(pe).toMatchObject({ source: 'exit', path: 'C:\\p\\plan.md', toolUseId: 'toolu_X' });
    // the tool.start input stays compact
    const start = evs.find((e) => e.k === 'tool.start');
    expect(start && start.k === 'tool.start' && (start.input as { plan: string }).plan.length).toBe(300);
  });

  it('records approval from the tool result, and ignores subagent plan events', () => {
    const evs = [
      ...normalizeLine(exit('## A\n1. x'), ctx),
      ...normalizeLine(line({ type: 'user', timestamp: '2026-10-01T10:06:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_X', is_error: true }] } }), ctx),
    ];
    const s = foldEvents('s1', evs);
    expect(s.plan?.approved).toBe(false);
    const sub = newSession('s1');
    apply(sub, { ts: 1, src: 'transcript', ref: { sessionId: 's1', agentId: 'a1' }, k: 'plan', text: 'sub plan', source: 'exit' });
    expect(sub.plan).toBeNull();
  });

  it('the newest text wins, a file read replaces an older exit copy, and a new plan file clears the old text', () => {
    const s = foldEvents('s1', normalizeLine(exit('## A\n1. old', 'toolu_1', '2026-10-01T10:05:00Z'), ctx));
    const t = Date.parse('2026-10-01T10:10:00Z');
    apply(s, { ts: t, src: 'transcript', ref: { sessionId: 's1', agentId: null }, k: 'plan', text: '## A\n1. edited', path: 'C:\\p\\plan.md', source: 'file' });
    expect(s.plan?.text).toContain('edited');
    expect(s.plan?.source).toBe('file');
    // an older exit copy arriving late does not overwrite the file
    apply(s, { ts: t - 5000, src: 'transcript', ref: { sessionId: 's1', agentId: null }, k: 'plan', text: '## A\n1. stale', source: 'exit' });
    expect(s.plan?.text).toContain('edited');
    apply(s, { ts: t + 1, src: 'transcript', ref: { sessionId: 's1', agentId: null }, k: 'plan', path: 'C:\\p\\other.md', source: 'path' });
    expect(s.plan?.text).toBeNull();
    expect(s.plan?.path).toBe('C:\\p\\other.md');
  });

  it('hooks: ExitPlanMode PreToolUse yields a plan', () => {
    const evs = normalizeHook({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_use_id: 'toolu_H', tool_input: { plan: '## A\n1. x' } }, 1000);
    expect(evs.find((e) => e.k === 'plan')).toMatchObject({ text: '## A\n1. x', source: 'exit' });
  });

  it('Agent tool_use input gives the spawned agent its prompt', () => {
    const evs = [
      ...normalizeLine(line({ type: 'assistant', timestamp: '2026-10-01T10:00:00Z', message: { id: 'm', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_A', name: 'Agent', input: { description: 'run tests', prompt: 'please run the unit tests' } }] } }), ctx),
      ...normalizeLine(line({ type: 'user', timestamp: '2026-10-01T10:00:05Z', toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a2', description: 'run tests' }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_A' }] } }), ctx),
    ];
    expect(foldEvents('s1', evs).agents.a2.prompt).toBe('please run the unit tests');
  });
});

describe('plan sections that hold the work', () => {
  it('uses only Milestones/Steps sections when the plan has them, and skips file-path items', async () => {
    const { parsePlan } = await import('@core/plan');
    const md = [
      '# Agent Visualizer plan',
      '## Architecture',
      '- **Live session:** transcript modified recently',
      '- **Which source wins:** hooks for timing',
      '## Key files',
      '- `src/shared/events.ts`: unified event union',
      '- `src/main/{indexer,tailer}.ts`',
      '## Milestones',
      '**M0 – Scaffold:** electron-vite app.',
      '- **M0 – Scaffold:** electron-vite React-TS app',
      '- **M1 – MVP:** live view',
      '  - Session picker.',
      '- **M2 – Hooks:** hook server',
      '## Risks',
      '- Unstable transcript format',
    ].join('\n');
    const p = parsePlan(md);
    expect(p.steps.map((s) => s.title)).toEqual(['M0 – Scaffold', 'M1 – MVP', 'M2 – Hooks']);
  });

  it('without work sections, file-path bullets still are not steps', async () => {
    const { parsePlan } = await import('@core/plan');
    const p = parsePlan(['# P', '## Changes', '- `src/a/b.ts`', '- Add retry to the api client', '- src/x/{y,z}.tsx'].join('\n'));
    expect(p.steps.map((s) => s.title)).toEqual(['Add retry to the api client']);
  });
});
