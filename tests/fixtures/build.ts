// Builds a synthetic ~/.claude tree that exercises the transcript shapes seen in real sessions:
// multi-line messages sharing message.id, Agent spawns (sync, background, nested), a workflow
// with a journal, TaskCreate/TaskUpdate, plan mode, task notifications, an unknown line type
// and a truncated final line.
import fs from 'node:fs';
import path from 'node:path';

export const SID = '11111111-1111-4111-8111-111111111111';
export const PROJECT = 'C--demo-app';
const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const base = (s: number) => ({ sessionId: SID, cwd: 'C:\\demo\\app', version: '2.1.295', entrypoint: 'cli', gitBranch: 'main', timestamp: at(s), userType: 'external' });
const usage = (i: number, o: number) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 });

function user(s: number, content: unknown, extra: Record<string, unknown> = {}) {
  return { type: 'user', isSidechain: false, permissionMode: 'default', message: { role: 'user', content }, ...base(s), ...extra };
}
function asst(s: number, msgId: string, block: unknown, extra: Record<string, unknown> = {}, model = 'claude-opus-5-5', stop: string | null = null) {
  return { type: 'assistant', isSidechain: false, effort: 'high', message: { id: msgId, model, role: 'assistant', content: [block], stop_reason: stop, usage: usage(1000, 50) }, ...base(s), ...extra };
}
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const toolResult = (id: string, isError = false) => ({ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError });
export const PLAN_PATH = 'C:\\demo\\plans\\retry-plan.md';
export const PLAN_TEXT = `# Plan: retry in the api client

## Context
- The client has no retry today.

## Steps
1. Map the repo and find the api client
2. Search the repo for existing retry code
3. Run the tests as a baseline
4. Add retry with backoff
5. Design the docs update
`;

const notif = (taskId: string, status: string) => `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n<summary>Agent "x" finished</summary>\n</task-notification>`;

export function mainLines(): string[] {
  const L: unknown[] = [
    user(0, 'Add retry to the api client and update the docs'),
    { type: 'attachment', attachment: { type: 'model', identity: { modelId: 'claude-opus-5-5' } }, ...base(0) },
    { type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: ['X'] }, ...base(0) },
    asst(1, 'msg_1', { type: 'thinking', thinking: 'hmm' }),
    asst(1, 'msg_1', toolUse('toolu_T1', 'TaskCreate', { subject: 'Map the repo', description: 'find the api client' })),
    user(2, [toolResult('toolu_T1')], { toolUseResult: { task: { id: '1', subject: 'Map the repo' } } }),
    asst(2, 'msg_1', toolUse('toolu_PL', 'ExitPlanMode', { plan: PLAN_TEXT, planFilePath: PLAN_PATH })),
    user(2, [toolResult('toolu_PL')]),
    asst(3, 'msg_2', toolUse('toolu_A1', 'Agent', { description: 'search repo', subagent_type: 'Explore', prompt: 'find it' })),
    asst(3, 'msg_2', toolUse('toolu_A2', 'Agent', { description: 'run tests', subagent_type: 'general-purpose', prompt: 'run', run_in_background: true })),
    user(4, [toolResult('toolu_A2')], { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a2', description: 'run tests', resolvedModel: 'claude-sonnet-5-5' } }),
    user(30, [toolResult('toolu_A1')], { toolUseResult: { status: 'completed', agentId: 'a1', resolvedModel: 'claude-haiku-5-5' } }),
    asst(31, 'msg_3', toolUse('toolu_W', 'Workflow', { script: "export const meta = { name: 'review', description: 'r' }" })),
    user(32, [toolResult('toolu_W')], { toolUseResult: { status: 'async_launched', taskId: 'wtask1', taskType: 'local_workflow', workflowName: 'review', runId: 'wf_x', summary: 'Review all the things' } }),
    { type: 'attachment', attachment: { type: 'plan_mode', isSubAgent: false }, ...base(40) },
    user(41, 'now plan the docs update', { permissionMode: 'plan' }),
    { type: 'queue-operation', operation: 'enqueue', timestamp: at(50), sessionId: SID, content: notif('a2', 'completed') },
    user(50, notif('a2', 'completed'), { permissionMode: 'plan' }),
    asst(51, 'msg_4', toolUse('toolu_T2', 'TaskUpdate', { taskId: '1', status: 'completed' })),
    user(52, [toolResult('toolu_T2')], { permissionMode: 'plan', toolUseResult: { success: true, taskId: '1', statusChange: { from: 'pending', to: 'completed' } } }),
    asst(53, 'msg_5', toolUse('toolu_B1', 'Bash', { command: 'npm test', description: 'Run the test suite' })),
    user(54, [toolResult('toolu_B1', true)], { permissionMode: 'plan' }),
    { type: 'weird-new-thing', foo: 1 },
    { type: 'custom-title', customTitle: 'Retry + docs', sessionId: SID },
    { type: 'cost-state', sessionId: SID, totalCostUSD: 1.25, modelUsage: { 'claude-opus-5-5': { costUSD: 1.0 }, 'claude-haiku-5-5': { costUSD: 0.25 } } },
    asst(60, 'msg_6', { type: 'text', text: 'All done: retry added.' }, {}, 'claude-opus-5-5', 'end_turn'),
  ];
  return L.map((o) => JSON.stringify(o));
}

function sideLines(agentId: string, _model: string, steps: { s: number; o: unknown }[]): string[] {
  return steps.map(({ s, o }) => JSON.stringify({ ...(o as object), isSidechain: true, agentId, ...base(s) }));
}

export function writeFixture(home: string, opts: { truncatedTail?: boolean } = {}) {
  const pdir = path.join(home, 'projects', PROJECT);
  const sdir = path.join(pdir, SID);
  const sub = path.join(sdir, 'subagents');
  const wf = path.join(sub, 'workflows', 'wf_x');
  fs.mkdirSync(wf, { recursive: true });

  let main = mainLines().join('\n') + '\n';
  if (opts.truncatedTail) main += '{"type":"user","message":{"content":"half a li';
  fs.writeFileSync(path.join(pdir, `${SID}.jsonl`), main);

  // a1: sync Explore agent that spawns a nested a3
  fs.writeFileSync(path.join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'search repo', toolUseId: 'toolu_A1', spawnDepth: 1, requestShape: 'foreground' }));
  fs.writeFileSync(
    path.join(sub, 'agent-a1.jsonl'),
    sideLines('a1', 'claude-haiku-5-5', [
      { s: 5, o: { type: 'user', message: { role: 'user', content: 'find it' } } },
      { s: 6, o: { type: 'assistant', message: { id: 'm_a1_1', model: 'claude-haiku-5-5', content: [toolUse('toolu_G1', 'Grep', { pattern: 'retry', path: 'src' })], usage: usage(500, 20) } } },
      { s: 7, o: { type: 'user', message: { role: 'user', content: [toolResult('toolu_G1')] } } },
      { s: 8, o: { type: 'assistant', message: { id: 'm_a1_2', model: 'claude-haiku-5-5', content: [toolUse('toolu_N1', 'Agent', { description: 'deep dive', subagent_type: 'Explore' })], usage: usage(600, 20) } } },
      { s: 28, o: { type: 'user', message: { role: 'user', content: [toolResult('toolu_N1')] }, toolUseResult: { status: 'completed', agentId: 'a3' } } },
      { s: 29, o: { type: 'assistant', message: { id: 'm_a1_3', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Found it in src/api.ts' }], stop_reason: 'end_turn', usage: usage(700, 30) } } },
    ]).join('\n') + '\n',
  );
  // a3: nested under a1
  fs.writeFileSync(path.join(sub, 'agent-a3.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'deep dive', toolUseId: 'toolu_N1', spawnDepth: 2, requestShape: 'foreground' }));
  fs.writeFileSync(
    path.join(sub, 'agent-a3.jsonl'),
    sideLines('a3', 'claude-haiku-5-5', [{ s: 9, o: { type: 'assistant', message: { id: 'm_a3_1', model: 'claude-haiku-5-5', content: [toolUse('toolu_R1', 'Read', { file_path: 'C:\\demo\\app\\src\\api.ts' })], usage: usage(100, 5) } } }]).join('\n') + '\n',
  );
  // a2: background agent, finished via task-notification in the main transcript
  fs.writeFileSync(path.join(sub, 'agent-a2.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'run tests', toolUseId: 'toolu_A2', spawnDepth: 1, requestShape: 'background' }));
  fs.writeFileSync(
    path.join(sub, 'agent-a2.jsonl'),
    sideLines('a2', 'claude-sonnet-5-5', [{ s: 10, o: { type: 'assistant', message: { id: 'm_a2_1', model: 'claude-sonnet-5-5', content: [toolUse('toolu_X1', 'Bash', { command: 'npm test' })], usage: usage(200, 10) } } }]).join('\n') + '\n',
  );
  // workflow agents: w1 finished per journal, w2 still running
  for (const id of ['w1', 'w2']) {
    fs.writeFileSync(path.join(wf, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'workflow-subagent', description: `review:${id}`, workflowPhase: 'Review', spawnDepth: 1, requestShape: 'foreground' }));
    fs.writeFileSync(
      path.join(wf, `agent-${id}.jsonl`),
      sideLines(id, 'claude-sonnet-5-5', [{ s: 35, o: { type: 'assistant', message: { id: `m_${id}`, model: 'claude-sonnet-5-5', content: [toolUse(`toolu_${id}`, 'Read', { file_path: 'a.ts' })], usage: usage(50, 5) } } }]).join('\n') + '\n',
    );
  }
  fs.writeFileSync(path.join(wf, 'journal.jsonl'), ['{"type":"launched"}', '{"type":"started","agentId":"w1"}', '{"type":"started","agentId":"w2"}', '{"type":"result","agentId":"w1"}'].join('\n') + '\n');
  return { mainFile: path.join(pdir, `${SID}.jsonl`), sessionDir: sdir };
}

// ---- a session running on local models (Claude Code pointed at a gateway/proxy) ----
export const LOCAL_SID = '33333333-3333-4333-8333-333333333333';
export const LOCAL_PROJECT = 'C--local-llm';
export const LOCAL_MAIN_MODEL = 'qwen2.5-coder:32b';
export const LOCAL_SUB_MODEL = 'llama3.1:8b';

export function writeLocalFixture(home: string) {
  const pdir = path.join(home, 'projects', LOCAL_PROJECT);
  const sub = path.join(pdir, LOCAL_SID, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const b = (s: number) => ({ sessionId: LOCAL_SID, cwd: 'C:\\demo\\local', version: '2.1.295', entrypoint: 'cli', gitBranch: 'main', timestamp: at(s), userType: 'external' });
  const u = (i: number, o: number) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  const am = (s: number, id: string, model: string, block: unknown, stop: string | null = null, side?: string) => ({
    type: 'assistant',
    isSidechain: !!side,
    ...(side ? { agentId: side } : {}),
    requestedModel: model,
    message: { id, model, role: 'assistant', content: [block], stop_reason: stop, usage: u(14_000 + s, 120) },
    ...b(s),
  });
  const lines = [
    { type: 'user', isSidechain: false, permissionMode: 'default', message: { role: 'user', content: 'Summarize the repo layout' }, ...b(0) },
    am(1, 'lm_1', LOCAL_MAIN_MODEL, toolUse('toolu_L1', 'Agent', { description: 'list source files', subagent_type: 'Explore', prompt: 'list the files in src' })),
    { type: 'user', isSidechain: false, message: { role: 'user', content: [toolResult('toolu_L1')] }, toolUseResult: { status: 'async_launched', agentId: 'l1', description: 'list source files', resolvedModel: LOCAL_SUB_MODEL }, ...b(2) },
    am(3, 'lm_2', LOCAL_MAIN_MODEL, toolUse('toolu_L2', 'Read', { file_path: 'C:\\demo\\local\\README.md' })),
    { type: 'custom-title', customTitle: 'Local qwen session', sessionId: LOCAL_SID },
  ];
  fs.writeFileSync(path.join(pdir, `${LOCAL_SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(sub, 'agent-l1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'list source files', toolUseId: 'toolu_L1', spawnDepth: 1, requestShape: 'background' }));
  const sideLines = [
    { type: 'user', isSidechain: true, agentId: 'l1', message: { role: 'user', content: 'list the files in src' }, ...b(4) },
    am(5, 'lm_s1', LOCAL_SUB_MODEL, toolUse('toolu_L3', 'Glob', { pattern: 'src/**/*.ts' }), null, 'l1'),
  ];
  fs.writeFileSync(path.join(sub, 'agent-l1.jsonl'), sideLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { mainFile: path.join(pdir, `${LOCAL_SID}.jsonl`) };
}
