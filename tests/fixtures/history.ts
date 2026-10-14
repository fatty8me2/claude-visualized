// A second synthetic session on another day (3 days before the main fixture) in another project, plus a local-model message,
// so the daily rollups, project split and model families have something to tell apart.
import fs from 'node:fs';
import path from 'node:path';

export const SID2 = '22222222-2222-4222-8222-222222222222';
export const PROJECT2 = 'C--demo-other';
const T0 = Date.parse('2026-09-28T09:15:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const base = (s: number) => ({
  sessionId: SID2,
  cwd: 'C:\\demo\\other',
  version: '2.1.295',
  entrypoint: 'cli',
  gitBranch: 'main',
  timestamp: at(s),
  userType: 'external',
});
const usage = (i: number, o: number) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: 200, cache_creation_input_tokens: 20 });

export function secondLines(): string[] {
  const asst = (s: number, id: string, model: string, block: unknown, stop: string | null = null, u = usage(2000, 100)) => ({
    type: 'assistant',
    isSidechain: false,
    message: { id, model, role: 'assistant', content: [block], stop_reason: stop, usage: u },
    ...base(s),
  });
  return [
    { type: 'user', isSidechain: false, message: { role: 'user', content: 'Fix the flaky login test, it times out on CI' }, ...base(0) },
    asst(1, 'o_1', 'claude-sonnet-5-5', { type: 'text', text: 'Looking at the login spec and the timeout handling.' }),
    // the same message id on a second line (a multi-block message): must count once
    asst(1, 'o_1', 'claude-sonnet-5-5', {
      type: 'tool_use',
      id: 'toolu_O1',
      name: 'Bash',
      input: { command: 'npx vitest run login', description: 'Run the login spec' },
    }),
    {
      type: 'user',
      isSidechain: false,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_O1', content: 'FAIL timeout', is_error: true }] },
      ...base(2),
    },
    asst(3, 'o_2', 'claude-sonnet-5-5', {
      type: 'tool_use',
      id: 'toolu_O2',
      name: 'Edit',
      input: { file_path: 'C:\\demo\\other\\login.spec.ts', old_string: 'a', new_string: 'b' },
    }),
    asst(
      4,
      'o_3',
      'qwen2.5-coder:32b',
      { type: 'text', text: 'Raised the timeout and added a wait for the network idle state.' },
      'end_turn',
      usage(5000, 300),
    ),
    { type: 'custom-title', customTitle: 'Flaky login test', sessionId: SID2 },
    { type: 'cost-state', sessionId: SID2, totalCostUSD: 0.5, modelUsage: { 'claude-sonnet-5-5': { costUSD: 0.5 } } },
  ].map((o) => JSON.stringify(o));
}

export function writeSecondFixture(home: string) {
  const pdir = path.join(home, 'projects', PROJECT2);
  fs.mkdirSync(pdir, { recursive: true });
  const file = path.join(pdir, `${SID2}.jsonl`);
  fs.writeFileSync(file, secondLines().join('\n') + '\n');
  return { mainFile: file };
}
