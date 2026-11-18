import { describe, expect, it } from 'vitest';
import { buildCmdPriors, cmdEta, cmdResultInfo, cmdSamples, commandKey, cwdProject, NO_CMD_PRIORS, shellCall, type CmdRun } from '@core/cmdEta';

const MIN = 60_000;
const S = 1000;

describe('commandKey', () => {
  it.each([
    ['npm run test:e2e', 'npm run test:e2e'],
    ['cd /c/Users/me/app && npm run test:e2e 2>&1 | tail -30', 'npm run test:e2e'],
    ['npm test', 'npm test'],
    ['npm t', 'npm test'],
    ['npm i', 'npm install'],
    ['npm ci --no-audit', 'npm ci'],
    ['pnpm --filter web run build', 'pnpm run build'],
    ['yarn build', 'yarn build'],
    ['npx vitest run tests/unit', 'npx vitest run …'],
    ['npx vitest run', 'npx vitest run'],
    ['npx tsc --noEmit -p tsconfig.json', 'npx tsc'],
    ['CLAUDE_VIS_BACKGROUND_WINDOWS=1 npx vitest run --config vitest.e2e.config.ts tests/e2e/eta.test.ts', 'npx vitest run --config vitest.e2e.config.ts …'],
    [
      'npx electron-vite build && CLAUDE_VIS_BACKGROUND_WINDOWS=1 npx vitest run --config vitest.e2e.config.ts',
      'npx electron-vite build && npx vitest run --config vitest.e2e.config.ts',
    ],
    ['gh run watch 1234567 --exit-status', 'gh run watch'],
    ['gh pr create --title "Fix it" --body "long text"', 'gh pr create'],
    ['git -C /c/repo status', 'git status'],
    ['git add -A && git commit -m "Release 0.10.4" && git push origin master', 'git add && git commit && git push'],
    ['cargo test --release', 'cargo test'],
    ['cargo build', 'cargo build'],
    ['docker build -t app:latest .', 'docker build …'],
    ['docker compose up -d', 'docker compose up'],
    ['python -m pytest tests/ -x', 'python -m pytest …'],
    ['pytest -q', 'pytest'],
    ['python3 scripts/bench.py --n 4', 'python bench.py'],
    ['go test ./...', 'go test …'],
    ['make -j8 all', 'make all'],
    ['sudo timeout 600 ./gradlew build', 'gradlew build'],
    ['C:\\tools\\node.exe build.js', 'node build.js'],
    ['npm.cmd run release:win', 'npm run release:win'],
    ['$env:FOO = "1"; npm run build', 'npm run build'],
    ['if npm test; then echo ok; fi', 'npm test'],
    ['for f in a b; do npx eslint "$f"; done', 'npx eslint'],
    ['powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1 -Release', 'powershell build.ps1'],
  ])('%s -> %s', (cmd, key) => {
    expect(commandKey(cmd)).toBe(key);
  });

  it('ignores quoted text and here-docs, also when the 300-character cut leaves one open', () => {
    const msg = "git commit -F - <<'EOF'\nFix the thing; npm run build && rm -rf /\n\nCo-Authored-By: someone\nEOF";
    expect(commandKey(msg)).toBe('git commit');
    expect(commandKey(`git commit -m "${'word '.repeat(80)}" && git push`)).toBe('git commit');
    expect(commandKey('git commit -m "line one\nline two; npm test\n" && git push')).toBe('git commit && git push');
  });

  it('returns null for trivial or empty commands', () => {
    expect(commandKey('')).toBeNull();
    expect(commandKey('cd src && ls -la | grep foo')).toBeNull();
    expect(commandKey('Get-ChildItem -Recurse | Select-Object -First 5')).toBeNull();
    expect(commandKey('echo hi')).toBeNull();
    expect(commandKey('until grep -q done out.log; do sleep 5; done')).toBeNull();
    expect(commandKey('bash -c "npm test"')).toBeNull();
  });

  it('drops the word the 300-character cut ends in', () => {
    // 297 characters, then "grep x": the live state keeps "...gre"
    const cmd = `${'echo hi && '.repeat(27)}grep x`;
    expect(cmd.slice(0, 300).endsWith('gre')).toBe(true);
    expect(commandKey(cmd)).toBeNull();
  });

  it('keeps at most three parts', () => {
    expect(commandKey('npm run a && npm run b && npm run c && npm run d')).toBe('npm run a && npm run b && npm run c');
  });
});

describe('shellCall', () => {
  it('times foreground shell calls only', () => {
    expect(shellCall('Bash', { command: 'npm test', timeout: 600000 })).toEqual({ key: 'npm test', timeoutMs: 600000 });
    expect(shellCall('PowerShell', { command: 'npm test' })).toEqual({ key: 'npm test', timeoutMs: null });
    expect(shellCall('Bash', { command: 'npm test', run_in_background: true })).toBeNull();
    expect(shellCall('Read', { command: 'npm test' })).toBeNull();
  });
});

describe('cwdProject', () => {
  it('is the last folder of the working directory', () => {
    expect(cwdProject('C:\\Users\\me\\ClaudeVisualized')).toBe('ClaudeVisualized');
    expect(cwdProject('/home/me/app/')).toBe('app');
    expect(cwdProject(null)).toBe('');
  });
});

const runs = (key: string, project: string, secs: number[]): CmdRun[] => secs.map((s) => ({ key, project, ms: s * S }));

describe('buildCmdPriors', () => {
  it('groups by key and project, needs enough runs and drops instant commands', () => {
    const p = buildCmdPriors(
      [
        ...runs('npm run test:e2e', 'app', [200, 180, 240, 210, 260, 190]),
        ...runs('npm run test:e2e', 'other', [60, 70]),
        ...runs('git status', 'app', [0.3, 0.4, 0.5, 0.3, 0.3, 0.2]),
        ...runs('npm run lint', 'app', [20, 21]),
      ],
      1,
    );
    expect(p.all['npm run test:e2e']).toEqual([60, 70, 180, 190, 200, 210, 240, 260].map((s) => s * S));
    expect(p.byProject.app['npm run test:e2e']).toHaveLength(6);
    expect(p.byProject.other).toBeUndefined();
    expect(p.all['git status']).toBeUndefined();
    expect(p.all['npm run lint']).toBeUndefined();
  });

  it('prefers the project when it has enough runs', () => {
    const p = buildCmdPriors([...runs('npm test', 'a', [100, 110, 120, 130, 140]), ...runs('npm test', 'b', [10, 11, 12, 13, 14])], 1);
    expect(cmdSamples('npm test', 'a', p)?.scope).toBe('project');
    expect(cmdSamples('npm test', 'zzz', p)?.scope).toBe('all');
    expect(cmdSamples('npm run nope', 'a', p)).toBeNull();
  });
});

describe('cmdEta', () => {
  const now = 10_000_000;
  const priors = buildCmdPriors(runs('npm run test:e2e', 'app', [150, 170, 180, 190, 200, 210, 220, 240, 260, 300]), 1);
  const call = (command: string, startedAgo: number, extra: Record<string, unknown> = {}) => ({
    name: 'Bash',
    input: { command, ...extra },
    since: now - startedAgo,
    project: 'app',
  });

  it('counts down from past runs of the same command', () => {
    const e = cmdEta(call('npm run test:e2e 2>&1 | tail -40', 60 * S), now, priors)!;
    expect(e.key).toBe('npm run test:e2e');
    expect(e.scope).toBe('project');
    expect(e.runs).toBe(10);
    expect(e.overdue).toBe(false);
    // median of the runs is ~205 s, and all of them outlasted 60 s: ~145 s left
    expect(e.remaining).toBeGreaterThan(130 * S);
    expect(e.remaining).toBeLessThan(160 * S);
    expect(e.low).toBeLessThanOrEqual(e.at);
    expect(e.high).toBeGreaterThanOrEqual(e.at);
    expect(e.fraction).toBeGreaterThan(0.2);
    expect(e.fraction).toBeLessThan(0.4);
  });

  it('conditions on the time already spent', () => {
    const e = cmdEta(call('npm run test:e2e', 230 * S), now, priors)!;
    expect(e.overdue).toBe(false);
    expect(e.remaining).toBeLessThan(60 * S);
  });

  it('is running long once past nearly every run', () => {
    const e = cmdEta(call('npm run test:e2e', 8 * MIN), now, priors)!;
    expect(e.overdue).toBe(true);
    expect(e.fraction).toBeGreaterThan(0.9);
  });

  it('never expects the end after the call times out', () => {
    const e = cmdEta(call('npm run test:e2e', 60 * S, { timeout: 120_000 }), now, priors)!;
    expect(e.timeoutAt).toBe(now + 60 * S);
    expect(e.at).toBeLessThanOrEqual(now + 60 * S);
    expect(e.high).toBeLessThanOrEqual(now + 60 * S);
  });

  it('says nothing without history, for background calls and for quick commands', () => {
    expect(cmdEta(call('npm run build', 60 * S), now, priors)).toBeNull();
    expect(cmdEta(call('npm run test:e2e', 60 * S, { run_in_background: true }), now, priors)).toBeNull();
    expect(cmdEta(call('npm run test:e2e', 60 * S), now, NO_CMD_PRIORS)).toBeNull();
    const quick = buildCmdPriors(runs('npm run lint', 'app', [5, 6, 6, 7, 8, 9, 10]), 1);
    expect(cmdEta(call('npm run lint', 3 * S), now, quick)).toBeNull();
    // ...until one hangs
    const hung = cmdEta(call('npm run lint', 40 * S), now, quick)!;
    expect(hung.overdue).toBe(true);
  });
});

describe('cmdResultInfo', () => {
  it('skips interrupted, backgrounded and user-approved calls', () => {
    const block = { type: 'tool_result', tool_use_id: 'x', content: 'ok', is_error: false };
    expect(cmdResultInfo({ toolUseResult: { interrupted: false } }, block)).toEqual({ error: false, skip: false });
    expect(cmdResultInfo({ toolUseResult: { interrupted: true } }, block).skip).toBe(true);
    expect(cmdResultInfo({ toolUseResult: { backgroundTaskId: 'b1' } }, block).skip).toBe(true);
    expect(cmdResultInfo({ toolUseResult: {}, permissionDecision: { source: 'user_temporary' } }, block).skip).toBe(true);
    expect(cmdResultInfo({ toolUseResult: {}, permissionDecision: { source: 'config' } }, block).skip).toBe(false);
    expect(cmdResultInfo({}, { ...block, is_error: true, content: 'Exit code 1' })).toEqual({ error: true, skip: false });
  });
});
