// A live session for the time-estimate UI (tests/e2e/eta.test.ts), built relative to "now": a prompt 16 minutes in,
// a desktop-app task list (two steps done, one in progress, "Commit and release" planned), two builder agents running
// in the background, a finished Explore agent, and the main agent reading a file. Plus fixed priors to compare with.
import fs from 'node:fs';
import path from 'node:path';
import { buildEtaPriors, type EtaPriors, type PriorRun } from '@core/eta';

export const ETA_SID = '77777777-7777-4777-8777-777777777777';
export const ETA_PROJECT = 'C--demo-ship';
const MIN = 60_000;

const usage = (i: number, o: number) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 4000, cache_creation_input_tokens: 200 });
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const toolResult = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false });

export function writeEtaFixture(home: string, now: number): { mainFile: string } {
  const at = (minAgo: number) => new Date(now - minAgo * MIN).toISOString();
  const base = (minAgo: number) => ({
    sessionId: ETA_SID,
    cwd: 'C:\\demo\\ship',
    version: '2.1.300',
    entrypoint: 'claude-desktop',
    gitBranch: 'master',
    timestamp: at(minAgo),
  });
  let n = 0;
  const user = (minAgo: number, content: unknown, extra: Record<string, unknown> = {}) => ({
    type: 'user',
    isSidechain: false,
    permissionMode: 'acceptEdits',
    message: { role: 'user', content },
    ...base(minAgo),
    ...extra,
  });
  const asst = (minAgo: number, block: unknown, model = 'claude-opus-5-5') => ({
    type: 'assistant',
    isSidechain: false,
    message: { id: `m_main_${++n}`, model, role: 'assistant', content: [block], stop_reason: null, usage: usage(3000, 120) },
    ...base(minAgo),
  });
  const plan = (minAgo: number, id: string, input: unknown) => [
    asst(minAgo, toolUse(id, 'mcp__ccd_turn__update_plan', input)),
    user(minAgo - 0.01, [toolResult(id)]),
  ];
  const spawn = (minAgo: number, id: string, agentId: string, description: string, type: string, model: string) => [
    asst(minAgo, toolUse(id, 'Agent', { description, subagent_type: type, prompt: `${description}. Report back when done.`, run_in_background: true })),
    user(minAgo - 0.01, [toolResult(id)], { toolUseResult: { isAsync: true, status: 'async_launched', agentId, description, resolvedModel: model } }),
  ];
  const lines: unknown[] = [
    user(16, 'Add a progress bar with time estimates for the agents and the prompt, then commit and release a new version so people can check for updates'),
    { type: 'attachment', attachment: { type: 'model', identity: { modelId: 'claude-opus-5-5' } }, ...base(16) },
    ...plan(15.9, 'toolu_P1', {
      items: [
        { content: 'Look at how sessions are shown', status: 'in_progress' },
        { content: 'Design the estimate model', status: 'pending' },
        { content: 'Build the bar and the agent estimates', status: 'pending' },
        { content: 'Verify in the app off-screen', status: 'pending' },
        { content: 'Commit and release 0.9.0', status: 'pending' },
      ],
      scope: 'first_task',
    }),
    asst(15, toolUse('toolu_R1', 'Read', { file_path: 'C:\\demo\\ship\\src\\core\\state.ts' })),
    user(14.9, [toolResult('toolu_R1')]),
    ...plan(11, 'toolu_P2', { advance: true }),
    asst(10, toolUse('toolu_W1', 'Write', { file_path: 'C:\\demo\\ship\\src\\core\\eta.ts' })),
    user(9.9, [toolResult('toolu_W1')]),
    ...plan(7, 'toolu_P3', { advance: true }),
    ...spawn(6.5, 'toolu_A1', 'a1', 'Build the agent card time bars', 'general-purpose', 'claude-sonnet-5-5'),
    ...spawn(6.4, 'toolu_A2', 'a2', 'Build the overview estimate line', 'general-purpose', 'claude-sonnet-5-5'),
    ...spawn(6.3, 'toolu_A3', 'a3', 'Find where the mini view gets its data', 'Explore', 'claude-haiku-5-5'),
    user(
      3.5,
      `<task-notification>\n<task-id>a3</task-id>\n<status>completed</status>\n<summary>Agent "Find where the mini view gets its data" finished</summary>\n</task-notification>`,
    ),
    asst(0.4, toolUse('toolu_R2', 'Read', { file_path: 'C:\\demo\\ship\\src\\renderer\\views\\SessionView.tsx' })),
  ];
  const pdir = path.join(home, 'projects', ETA_PROJECT);
  const sub = path.join(pdir, ETA_SID, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const mainFile = path.join(pdir, `${ETA_SID}.jsonl`);
  fs.writeFileSync(mainFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const side = (agentId: string, steps: [number, unknown][]) =>
    steps
      .map(([minAgo, o]) =>
        JSON.stringify({
          ...(o as object),
          isSidechain: true,
          agentId,
          sessionId: ETA_SID,
          cwd: 'C:\\demo\\ship',
          timestamp: at(minAgo),
          version: '2.1.300',
          entrypoint: 'claude-desktop',
        }),
      )
      .join('\n') + '\n';
  const work = (agentId: string, model: string, start: number, end: number, done: boolean, file: string) => {
    const steps: [number, unknown][] = [[start, { type: 'user', message: { role: 'user', content: `Task for ${agentId}` } }]];
    let k = 0;
    for (let t = start - 0.3; t > end; t -= 0.45) {
      const id = `toolu_${agentId}_${++k}`;
      const name = k % 3 === 0 ? 'Bash' : k % 3 === 1 ? 'Read' : 'Edit';
      const input = name === 'Bash' ? { command: 'npx tsc --noEmit' } : { file_path: `C:\\demo\\ship\\src\\renderer\\${file}` };
      steps.push([
        t,
        { type: 'assistant', message: { id: `m_${agentId}_${k}`, model, role: 'assistant', content: [toolUse(id, name, input)], usage: usage(2000, 90) } },
      ]);
      if (t - 0.2 > end || done) steps.push([t - 0.2, { type: 'user', message: { role: 'user', content: [toolResult(id)] } }]);
    }
    if (done)
      steps.push([
        end,
        {
          type: 'assistant',
          message: {
            id: `m_${agentId}_end`,
            model,
            role: 'assistant',
            content: [{ type: 'text', text: 'Found it: the mini view reads the full live session.' }],
            stop_reason: 'end_turn',
            usage: usage(2000, 60),
          },
        },
      ]);
    return side(agentId, steps);
  };
  const meta = (id: string, agentType: string, description: string, toolUseId: string) =>
    fs.writeFileSync(path.join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType, description, toolUseId, spawnDepth: 1, requestShape: 'background' }));
  meta('a1', 'general-purpose', 'Build the agent card time bars', 'toolu_A1');
  fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), work('a1', 'claude-sonnet-5-5', 6.5, 0.1, false, 'components\\AgentGraph.tsx'));
  meta('a2', 'general-purpose', 'Build the overview estimate line', 'toolu_A2');
  fs.writeFileSync(path.join(sub, 'agent-a2.jsonl'), work('a2', 'claude-sonnet-5-5', 6.4, 0.2, false, 'components\\Overview.tsx'));
  meta('a3', 'Explore', 'Find where the mini view gets its data', 'toolu_A3');
  fs.writeFileSync(path.join(sub, 'agent-a3.jsonl'), work('a3', 'claude-haiku-5-5', 6.3, 3.6, true, 'components\\MiniView.tsx'));
  return { mainFile };
}

/** What the estimates compare with in the test: builders that take 6-25 minutes, quick explorers, past prompts of 10-60 minutes. */
export function etaFixturePriors(now: number): EtaPriors {
  const runs = (type: string, family: string, goal: string, minutes: number[]): PriorRun[] =>
    minutes.map((m) => ({ type, family, goal, activeMs: m * MIN, tools: Math.round(m * 2.5) }));
  return buildEtaPriors(
    [
      ...runs('general-purpose', 'sonnet', 'build', [6, 8, 9, 10, 11, 12, 13, 14, 15, 18, 22, 25]),
      ...runs('Explore', 'haiku', 'search', [1, 2, 2, 3, 3, 4, 5, 6]),
    ],
    [10, 14, 18, 22, 25, 30, 35, 40, 48, 60].map((m) => ({ project: 'ship', ms: m * MIN })),
    now,
  );
}
