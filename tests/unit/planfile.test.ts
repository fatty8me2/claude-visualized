import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBacklogInProcess, SessionWatcher, type BacklogLoader } from '../../src/main/watcher';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-plan-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const cloning: BacklogLoader = async (...a) => structuredClone(await loadBacklogInProcess(...a));
const SID = '33333333-3333-4333-8333-333333333333';

function setup(planBody: string) {
  const planFile = path.join(home, 'plans', 'my-plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, planBody);
  const main = path.join(home, 'projects', 'p', `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(main), { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(
    main,
    JSON.stringify({
      type: 'attachment',
      sessionId: SID,
      timestamp: ts,
      attachment: { type: 'plan_mode', isSubAgent: false, planFilePath: planFile, planExists: true },
    }) + '\n',
  );
  return { planFile, main };
}

describe('plan file', () => {
  it.each([
    ['in-process', undefined],
    ['via the worker boundary', cloning],
  ])('is read when the transcript names it, and re-read only when it changes (%s)', async (_n, loader) => {
    const { planFile, main } = setup('## Steps\n1. first\n2. second\n');
    const w = new SessionWatcher(SID, main, loader);
    await w.poll();
    expect(w.state.plan?.source).toBe('file');
    expect(w.state.plan?.text).toContain('second');
    const at = w.state.plan!.at;

    // unchanged mtime: not re-read
    await w.poll();
    expect(w.state.plan!.at).toBe(at);

    // Claude edits the plan file: picked up by the next poll
    fs.writeFileSync(planFile, '## Steps\n1. first\n2. second\n3. third\n');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(planFile, future, future);
    await w.poll();
    expect(w.state.plan?.text).toContain('third');
    expect(w.state.plan!.at).toBeGreaterThan(at);
  });

  it('keeps the transcript copy when the file is missing or not markdown', async () => {
    const { planFile, main } = setup('## Steps\n1. a\n');
    fs.appendFileSync(
      main,
      JSON.stringify({
        type: 'assistant',
        sessionId: SID,
        timestamp: new Date().toISOString(),
        message: {
          id: 'm',
          model: 'claude-opus-5-5',
          content: [{ type: 'tool_use', id: 't', name: 'ExitPlanMode', input: { plan: '## Steps\n1. from transcript\n', planFilePath: planFile } }],
        },
      }) + '\n',
    );
    fs.rmSync(planFile);
    const w = new SessionWatcher(SID, main);
    await w.poll();
    expect(w.state.plan?.source).toBe('exit');
    expect(w.state.plan?.text).toContain('from transcript');
  });
});
