import { describe, expect, it } from 'vitest';
import {
  activeTimes,
  agentEta,
  agentEtas,
  buildEtaPriors,
  isShipStep,
  NO_PRIORS,
  priorKeys,
  promptEta,
  quantile,
  remainingAfter,
  STAGE_MS,
  STEP_PRIOR_MS,
  turnTimes,
  type EtaPriors,
  type PriorRun,
} from '@core/eta';
import type { AgentEvent } from '@core/events';
import { normalizeHook, normalizeLine } from '@core/normalize';
import { apply, foldEvents } from '@core/reducer';
import { desktopTodoOp, shipKinds } from '@core/ship';
import { newAgent, newSession, type SessionState } from '@core/state';

const MIN = 60_000;
const T = Date.UTC(2026, 10, 9, 14, 0, 0);
const ctx = { sessionId: 's1', agentId: null };

// ---------- shipping commands ----------

describe('shipKinds', () => {
  it('finds commits, pushes, PRs, releases and publishing in pipeline order', () => {
    expect(shipKinds('git add -A && git commit -m "fix" && git push origin master')).toEqual(['commit', 'push']);
    expect(shipKinds('git -C /repo commit -qm wip')).toEqual(['commit']);
    expect(shipKinds('npm version minor && git push origin master --follow-tags')).toEqual(['commit', 'push']);
    expect(shipKinds('npm version patch --no-git-tag-version')).toEqual([]);
    expect(shipKinds('gh pr create --fill')).toEqual(['pr']);
    expect(shipKinds('$env:GH_TOKEN = $t; npm run release:win')).toEqual(['release']);
    expect(shipKinds('npx electron-builder --win --publish always')).toEqual(['release']);
    expect(shipKinds('gh release create v1.2.0 --draft --notes x')).toEqual(['release']);
    expect(shipKinds('gh release edit v0.8.0 --draft=false')).toEqual(['publish']);
    expect(shipKinds('gh release create v1.2.0 --notes "first"')).toEqual(['publish']);
    expect(shipKinds('npm publish --access public')).toEqual(['publish']);
  });

  it('ignores look-alikes: messages, dry runs, reads', () => {
    expect(shipKinds('git log --oneline | head')).toEqual([]);
    expect(shipKinds('git status && git diff')).toEqual([]);
    expect(shipKinds('git push --dry-run origin master')).toEqual([]);
    expect(shipKinds('npm publish --dry-run')).toEqual([]);
    expect(shipKinds('echo "remember to git push later"')).toEqual([]);
    expect(shipKinds('gh release view v0.8.0 --json assets')).toEqual([]);
    // a heredoc commit message that talks about pushing is still just a commit
    expect(shipKinds(`git commit -m "$(cat <<'EOF'\nRelease: git push and gh release edit --draft=false\nEOF\n)"`)).toEqual(['commit']);
    expect(shipKinds(`git commit -F - <<'EOF'\nnpm publish happens later\nEOF`)).toEqual(['commit']);
  });
});

// ---------- the desktop app's task list ----------

describe('desktopTodoOp', () => {
  it('reads the task-list tool and the wrap-up', () => {
    expect(
      desktopTodoOp('mcp__ccd_turn__update_plan', {
        items: [
          { content: 'Look around', status: 'in_progress' },
          { content: 'Build it', status: 'pending' },
        ],
        scope: 'first_task',
      }),
    ).toEqual({
      replace: [
        { id: 'p1', text: 'Look around', status: 'in_progress' },
        { id: 'p2', text: 'Build it', status: 'pending' },
      ],
    });
    expect(desktopTodoOp('mcp__ccd_turn__update_plan', { advance: true })).toEqual({ advance: true });
    expect(desktopTodoOp('mcp__ccd_turn__update_plan', { done: [2], start: 4 })).toEqual({ done: [2], start: 4 });
    expect(desktopTodoOp('mcp__ccd_turn__wrap_up', { recap: 'x' })).toEqual({ finish: true });
    expect(desktopTodoOp('mcp__ccd_turn__update_plan', {})).toBeNull();
    expect(desktopTodoOp('TodoWrite', { todos: [] })).toBeNull();
  });
});

// ---------- the reducer: turns, task-list times, shipping ----------

const user = (text: string, ts: number) => JSON.stringify({ type: 'user', timestamp: new Date(ts).toISOString(), message: { role: 'user', content: text } });
const toolUse = (id: string, name: string, input: unknown, ts: number) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(ts).toISOString(),
    message: { id: `m_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
const toolResult = (id: string, ts: number, isError = false) =>
  JSON.stringify({
    type: 'user',
    timestamp: new Date(ts).toISOString(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }] },
  });
const endTurn = (ts: number) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(ts).toISOString(),
    message: { id: `m_end_${ts}`, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
  });

function fold(lines: string[]): SessionState {
  const events: AgentEvent[] = lines.flatMap((l) => normalizeLine(l, ctx, 0));
  return foldEvents('s1', events);
}

describe('reducer: turns, desktop task list and shipping', () => {
  it('starts a turn on each prompt and keeps step times through advance and wrap-up', () => {
    const s = fold([
      user('Add a progress bar', T),
      toolUse(
        'u1',
        'mcp__ccd_turn__update_plan',
        {
          items: [
            { content: 'Look around', status: 'in_progress' },
            { content: 'Build it', status: 'pending' },
            { content: 'Test it', status: 'pending' },
          ],
        },
        T + 1000,
      ),
      toolResult('u1', T + 1500),
      toolUse('u2', 'mcp__ccd_turn__update_plan', { advance: true }, T + 4 * MIN),
      toolResult('u2', T + 4 * MIN + 500),
      toolUse('u3', 'mcp__ccd_turn__update_plan', { done: [2], start: 3 }, T + 10 * MIN),
      toolResult('u3', T + 10 * MIN + 500),
    ]);
    expect(s.turnStartedAt).toBe(T);
    expect(s.todos.map((t) => [t.text, t.status])).toEqual([
      ['Look around', 'completed'],
      ['Build it', 'completed'],
      ['Test it', 'in_progress'],
    ]);
    expect(s.todos[0]).toMatchObject({ startedAt: T + 1000, doneAt: T + 4 * MIN });
    expect(s.todos[1]).toMatchObject({ startedAt: T + 4 * MIN, doneAt: T + 10 * MIN });
    expect(s.todos[2]).toMatchObject({ startedAt: T + 10 * MIN });

    // a new list keeps the times of the steps it repeats; the wrap-up checks everything off
    const more = [
      toolUse(
        'u4',
        'mcp__ccd_turn__update_plan',
        {
          items: [
            { content: 'Look around', status: 'completed' },
            { content: 'Ship it', status: 'in_progress' },
          ],
        },
        T + 12 * MIN,
      ),
      toolUse('u5', 'mcp__ccd_turn__wrap_up', { recap: 'done' }, T + 13 * MIN),
      endTurn(T + 13 * MIN + 1000),
      user('Thanks, now release it', T + 20 * MIN),
    ];
    for (const l of more) for (const e of normalizeLine(l, ctx, 0)) apply(s, e);
    expect(s.todos.map((t) => t.status)).toEqual(['completed', 'completed']);
    expect(s.todos[0]).toMatchObject({ startedAt: T + 1000, doneAt: T + 4 * MIN });
    expect(s.todos[1]).toMatchObject({ startedAt: T + 12 * MIN, doneAt: T + 13 * MIN });
    expect(s.turnStartedAt).toBe(T + 20 * MIN);
  });

  it('records the main agent shipping, with end and outcome; subagents do not count', () => {
    const s = fold([
      user('Commit and push', T),
      toolUse('b1', 'Bash', { command: 'git commit -qm "x" && git push' }, T + MIN),
      toolResult('b1', T + MIN + 4000),
      toolUse('b2', 'Bash', { command: 'gh release edit v1.0.0 --draft=false' }, T + 2 * MIN),
      toolResult('b2', T + 2 * MIN + 2000, true),
    ]);
    expect(s.ship.map((e) => [e.kind, e.at, e.endAt, e.ok])).toEqual([
      ['commit', T + MIN, T + MIN + 4000, true],
      ['push', T + MIN, T + MIN + 4000, true],
      ['publish', T + 2 * MIN, T + 2 * MIN + 2000, false],
    ]);
    const sub = newSession('s2');
    for (const e of normalizeLine(toolUse('b3', 'Bash', { command: 'git commit -m wip' }, T), { sessionId: 's2', agentId: 'a1' }, 0)) apply(sub, e);
    expect(sub.ship).toEqual([]);
  });

  it('applies a task-list change once when the hook and the transcript both report the call', () => {
    const s = fold([
      user('go', T),
      toolUse(
        'u1',
        'mcp__ccd_turn__update_plan',
        {
          items: [
            { content: 'A', status: 'in_progress' },
            { content: 'B', status: 'pending' },
            { content: 'C', status: 'pending' },
          ],
        },
        T + 1000,
      ),
    ]);
    const hook = normalizeHook(
      { session_id: 's1', hook_event_name: 'PreToolUse', tool_use_id: 'u2', tool_name: 'mcp__ccd_turn__update_plan', tool_input: { advance: true } },
      T + 2 * MIN,
    );
    for (const e of hook) apply(s, e);
    for (const e of normalizeLine(toolUse('u2', 'mcp__ccd_turn__update_plan', { advance: true }, T + 2 * MIN), ctx, 0)) apply(s, e);
    expect(s.todos.map((t) => t.status)).toEqual(['completed', 'in_progress', 'pending']);
  });
});

// ---------- priors and order statistics ----------

const runs = (type: string, family: string, goal: string, minutes: number[]): PriorRun[] =>
  minutes.map((m) => ({ type, family, goal, activeMs: m * MIN, tools: m * 3 }));

describe('priors', () => {
  it('quantiles and the remaining time of runs that outlasted a point', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(xs, 0)).toBe(1);
    expect(quantile(xs, 0.5)).toBeCloseTo(5.5);
    expect(quantile(xs, 1)).toBe(10);
    expect(quantile(xs, 0.5, 5)).toBe(8);
    expect(remainingAfter(xs, 6, [0.5])!.q[0]).toBe(2.5); // 7..10 left, median 8.5, minus 6
    expect(remainingAfter(xs, 9, [0.5])).toBeNull(); // only one run went longer
  });

  it('groups runs from specific to broad and drops thin groups', () => {
    const p = buildEtaPriors([...runs('Explore', 'opus', 'search', [2, 3, 3, 4, 5, 6, 8]), ...runs('Plan', 'opus', 'plan', [1, 2])], [], T);
    expect(Object.keys(p.agents).sort()).toEqual(['*', 'g:search', 't:Explore', 'tf:Explore|opus', 'tfg:Explore|opus|search', 'tg:Explore|search'].sort());
    expect(p.agents['tf:Explore|opus'].dur).toEqual([2, 3, 3, 4, 5, 6, 8].map((m) => m * MIN));
    expect(priorKeys('Explore', 'opus', 'search')[0].specific).toBe(true);
  });

  it('active time leaves out long pauses; turns run from a prompt to the last message before the next', () => {
    const act = activeTimes([
      { s: 'a', a: 'x', ts: 0 },
      { s: 'a', a: 'x', ts: MIN },
      { s: 'a', a: 'x', ts: 61 * MIN }, // resumed an hour later: counts as 5 minutes
      { s: 'a', a: 'y', ts: 0 },
    ]);
    expect(act.get('a\tx')).toBe(6 * MIN);
    expect(act.get('a\ty')).toBe(0);
    const turns = turnTimes(
      [
        { s: 'a', ts: 0 },
        { s: 'a', ts: 30 * MIN },
      ],
      [1, 2, 10, 31, 32, 33, 40].map((m) => ({ s: 'a', ts: m * MIN })),
      () => 'proj',
    );
    expect(turns.map((t) => t.ms)).toEqual([10 * MIN, 10 * MIN]);
  });
});

// ---------- one agent ----------

const priors: EtaPriors = buildEtaPriors(runs('Explore', 'opus', 'search', [2, 3, 3, 4, 4, 5, 6, 6, 8, 10, 12, 15]), [], T);

function agent(over: Partial<ReturnType<typeof newAgent>> = {}) {
  return { ...newAgent('a1', 'agent', T, 'main'), agentType: 'Explore', model: 'claude-opus-5-5', description: 'Find the plan rail code', ...over };
}

describe('agentEta', () => {
  it('compares with similar runs, given how long it has run', () => {
    const a = agent();
    const e = agentEta(a, T + MIN, priors)!;
    expect(e.group).toBe('Explore · opus · search');
    expect(e.runs).toBe(12);
    // runs longer than 1 min: all 12, median 5.5 min, so about 4.5 min left
    expect(e.remaining).toBeCloseTo(4.5 * MIN, -3);
    expect(e.at).toBe(T + MIN + e.remaining);
    expect(e.low).toBeLessThan(e.at);
    expect(e.high).toBeGreaterThan(e.at);
    expect(e.fraction).toBeGreaterThan(0.1);
    expect(e.overdue).toBe(false);
    // later on, only the longer runs are left to compare with
    const later = agentEta(a, T + 7 * MIN, priors)!;
    expect(later.remaining).toBeGreaterThan(MIN);
    expect(later.fraction).toBeGreaterThan(e.fraction);
  });

  it('says when an agent has outrun nearly every similar run', () => {
    const e = agentEta(agent(), T + 40 * MIN, priors)!;
    expect(e.overdue).toBe(true);
    expect(e.confidence).toBe('low');
    expect(e.remaining).toBe(10 * MIN);
  });

  it('gives nothing without history, for finished agents and for the main agent', () => {
    expect(agentEta(agent(), T + MIN, NO_PRIORS)).toBeNull();
    expect(agentEta(agent({ status: 'done', endedAt: T + MIN }), T + 2 * MIN, priors)).toBeNull();
    expect(agentEta({ ...agent(), kind: 'main', id: 'main' }, T + MIN, priors)).toBeNull();
    expect(agentEta(agent({ status: 'waiting' }), T + MIN, priors)!.paused).toBe(true);
  });

  it('agentEtas covers every running subagent', () => {
    const m = agentEtas({ a1: agent(), a2: agent({ id: 'a2', status: 'done', endedAt: T + MIN }), a3: agent({ id: 'a3' }) }, T + MIN, priors);
    expect([...m.keys()].sort()).toEqual(['a1', 'a3']);
  });
});

// ---------- the prompt ----------

function session(): SessionState {
  const s = newSession('s1');
  s.turnStartedAt = T;
  s.agents.main.status = 'running';
  s.agents.main.startedAt = T;
  s.agents.main.prompt = 'Add the progress bar';
  return s;
}

const todo = (id: string, text: string, status: string, startedAt?: number, doneAt?: number) => ({ id, text, status, owner: 'main', startedAt, doneAt });

describe('promptEta', () => {
  it('paces the task list by its finished steps', () => {
    const s = session();
    s.todos = [
      todo('1', 'Look around', 'completed', T, T + 6 * MIN),
      todo('2', 'Build it', 'completed', T + 6 * MIN, T + 12 * MIN),
      todo('3', 'Test it', 'in_progress', T + 12 * MIN),
      todo('4', 'Write the docs', 'pending'),
    ];
    const now = T + 14 * MIN;
    const p = promptEta(s, now, NO_PRIORS)!;
    expect(p.state).toBe('running');
    expect(p.finishLine).toBe('turn');
    // 6 min a step from 2 steps, pulled toward the 5 min prior: (2*6 + 1.5*5) / 3.5
    const perStep = (2 * 6 * MIN + 1.5 * STEP_PRIOR_MS) / 3.5;
    expect(p.steps).toEqual({ done: 2, active: 1, total: 4, perStep });
    expect(p.finishAt).toBeCloseTo(now + (perStep - 2 * MIN) + perStep, -3);
    expect(p.confidence).toBe('medium');
    expect(p.fraction).toBeCloseTo((now - T) / (p.finishAt! - T));
    expect(p.low!).toBeLessThan(p.finishAt!);
    expect(p.high!).toBeGreaterThan(p.finishAt!);
  });

  it('never ends before the slowest running agent, plus time to read its result', () => {
    const s = session();
    s.todos = [todo('1', 'Build it with agents', 'in_progress', T)];
    s.agents.a1 = agent({ startedAt: T + MIN });
    const now = T + 2 * MIN;
    const p = promptEta(s, now, priors)!;
    const a = agentEta(s.agents.a1, now, priors)!;
    expect(p.agents.map((m) => [m.id, m.state])).toEqual([['a1', 'running']]);
    expect(p.finishAt).toBeGreaterThanOrEqual(a.at + 90_000);
  });

  it('counts shipping on the task list in the prompt, and shipping only asked for after it', () => {
    const s = session();
    s.todos = [todo('1', 'Build it', 'in_progress', T), todo('2', 'Commit and push to GitHub', 'pending')];
    const now = T + MIN;
    const p = promptEta(s, now, NO_PRIORS)!;
    expect(p.finishLine).toBe('push');
    expect(p.stages.map((x) => [x.key, x.state, x.plan])).toEqual([
      ['work', 'active', 'turn'],
      ['commit', 'pending', 'turn'],
      ['push', 'pending', 'turn'],
    ]);
    expect(p.finishAt).toBe(p.workAt! + STAGE_MS.commit + STAGE_MS.push);
    expect(p.shipAt).toBe(p.finishAt);

    // a release asked for in the prompt but not planned: after the turn, once the user says go
    s.agents.main.prompt = 'Fix it, then commit and release a new version';
    s.todos = [todo('1', 'Fix it', 'in_progress', T)];
    const q = promptEta(s, now, NO_PRIORS)!;
    expect(q.finishLine).toBe('release');
    expect(q.stages.filter((x) => x.plan === 'later').map((x) => x.key)).toEqual(['commit', 'push', 'release']);
    expect(q.finishAt).toBe(q.workAt);
    expect(q.shipAt).toBe(q.finishAt! + STAGE_MS.commit + STAGE_MS.push + STAGE_MS.release);
  });

  it('follows shipping as it happens: a release build counts down, publishing finishes it', () => {
    const s = session();
    s.todos = [todo('1', 'Build it', 'completed', T, T + 10 * MIN), todo('2', 'Commit and release', 'in_progress', T + 10 * MIN)];
    s.ship = [
      { kind: 'commit', toolUseId: 'b1', at: T + 11 * MIN, endAt: T + 11 * MIN + 2000, ok: true },
      { kind: 'push', toolUseId: 'b2', at: T + 11.5 * MIN, endAt: T + 11.5 * MIN + 3000, ok: true },
      { kind: 'release', toolUseId: 'b3', at: T + 12 * MIN, endAt: null, ok: null },
    ];
    const now = T + 14 * MIN;
    const p = promptEta(s, now, NO_PRIORS)!;
    expect(p.stages.map((x) => [x.key, x.state, x.note])).toEqual([
      ['work', 'done', '1 of 1 steps'],
      ['commit', 'done', 'committed'],
      ['push', 'done', 'on GitHub'],
      ['release', 'active', 'building'],
    ]);
    expect(p.finishAt).toBe(now + STAGE_MS.release - 2 * MIN);

    s.ship[2] = { ...s.ship[2], endAt: T + 17 * MIN, ok: true };
    s.ship.push({ kind: 'publish', toolUseId: 'b4', at: T + 18 * MIN, endAt: T + 18 * MIN + 1500, ok: true });
    s.agents.main.status = 'idle';
    s.agents.main.endedAt = T + 19 * MIN;
    const done = promptEta(s, T + 20 * MIN, NO_PRIORS)!;
    expect(done.state).toBe('done');
    expect(done.fraction).toBe(1);
    expect(done.finishAt).toBe(T + 19 * MIN);
    expect(done.stages.find((x) => x.key === 'release')).toMatchObject({ state: 'done', note: 'published', at: T + 18 * MIN + 1500 });
  });

  it('a task list from an earlier turn that is finished does not count; past prompts stand in', () => {
    const s = session();
    s.todos = [todo('1', 'Old step', 'completed', T - 60 * MIN, T - 50 * MIN)];
    const past = buildEtaPriors(
      [],
      [5, 10, 12, 15, 20, 25, 30, 40, 60].map((m) => ({ project: 'proj', ms: m * MIN })),
      T,
    );
    const p = promptEta({ ...s, project: 'proj' }, T + 11 * MIN, past)!;
    expect(p.steps).toBeNull();
    // prompts that ran past 11 min: 12, 15, 20, 25, 30, 40, 60, median 25 min, so about 14 min left
    expect(p.finishAt).toBeCloseTo(T + 25 * MIN, -3);
    expect(p.confidence).toBe('low');
    expect(promptEta(s, T + 11 * MIN, NO_PRIORS)!.finishAt).toBeNull();
  });

  it('is waiting while the main agent waits for the user, and needs a turn', () => {
    const s = session();
    s.agents.main.status = 'waiting';
    expect(promptEta(s, T + MIN, NO_PRIORS)!.state).toBe('waiting');
    const none = newSession('x');
    expect(promptEta(none, T, NO_PRIORS)).toBeNull();
  });
});

describe('isShipStep', () => {
  it('tells shipping steps from work', () => {
    expect(isShipStep('Commit and release 0.9.0')).toBe(true);
    expect(isShipStep('Push to GitHub')).toBe(true);
    expect(isShipStep('Release the installer')).toBe(true);
    expect(isShipStep('commit, push and publish')).toBe(true);
    expect(isShipStep('Fix the release script')).toBe(false);
    expect(isShipStep('Build the progress bar UI')).toBe(false);
    expect(isShipStep('Verify in the app off-screen')).toBe(false);
  });
});
