import { describe, expect, it } from 'vitest';
import { deriveInbox, groupBySession, noticeItem, snapshotOf, TOOL_ERROR_MIN, type InboxItem } from '@core/inbox';
import { apply } from '@core/reducer';
import { MAIN, newSession, toView, type SessionView } from '@core/state';
import { emptyUsage, type UsageView } from '@core/usage';
import type { AgentEvent } from '@core/events';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const MIN = 60_000;
const SID = 's1';
type Ev = AgentEvent;
const ref = (agentId: string | null = null) => ({ sessionId: SID, agentId });

function fold(events: Ev[], sid = SID): SessionView {
  let s = newSession(sid);
  for (const e of events) s = apply(s, e);
  return toView(s);
}

const prompt = (ts: number, text = 'do it'): Ev => ({ k: 'prompt', ts, src: 'transcript', ref: ref(), text });
const text = (ts: number): Ev => ({ k: 'text', ts, src: 'transcript', ref: ref(), role: 'assistant', preview: 'All done.', endTurn: true });
const turnEnd = (ts: number): Ev => ({ k: 'turn.end', ts, src: 'transcript', ref: ref() });
const attention = (ts: number, kind: 'permission' | 'notification' | 'error', detail: string, agent: string | null = null): Ev => ({
  k: 'attention',
  ts,
  src: 'hook',
  ref: ref(agent),
  kind,
  detail,
});
const toolStart = (ts: number, id: string, name = 'Bash', agent: string | null = null): Ev => ({
  k: 'tool.start',
  ts,
  src: 'transcript',
  ref: ref(agent),
  toolUseId: id,
  name,
  input: {},
});
const toolEnd = (ts: number, id: string, ok: boolean, agent: string | null = null): Ev => ({
  k: 'tool.end',
  ts,
  src: 'transcript',
  ref: ref(agent),
  toolUseId: id,
  ok,
  name: 'Bash',
});

const derive = (views: SessionView[], prev: InboxItem[] = [], usage: UsageView | null = null, dismissed = new Set<string>(), now = NOW) =>
  deriveInbox(prev, views, usage, now, dismissed);

describe('inbox derivation', () => {
  it('raises a permission prompt and resolves it when the agent resumes', () => {
    const t = NOW - 2 * MIN;
    const waiting = fold([prompt(t - MIN), toolStart(t - 1000, 'a'), attention(t, 'permission', 'Permission needed: Bash')]);
    const items = derive([waiting]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'permission', severity: 'critical', resolved: false, sessionId: SID, count: 1 });
    expect(items[0].detail).toContain('Permission needed');

    const resumed = fold([prompt(t - MIN), toolStart(t - 1000, 'a'), attention(t, 'permission', 'Permission needed: Bash'), toolEnd(t + 5000, 'a', true)]);
    const after = derive([resumed], items);
    expect(after[0].id).toBe(items[0].id);
    expect(after[0].resolved).toBe(true);
    expect(after[0].resolvedAt).toBe(NOW);
  });

  it('raises a notification as "needs input" and a newer prompt resolves it', () => {
    const t = NOW - MIN;
    const v = fold([prompt(t - MIN), attention(t, 'notification', 'Claude needs your input')]);
    const items = derive([v]);
    expect(items[0]).toMatchObject({ kind: 'input', severity: 'critical', resolved: false });
    const answered = fold([prompt(t - MIN), attention(t, 'notification', 'Claude needs your input'), prompt(t + 1000, 'yes go')]);
    expect(derive([answered], items)[0].resolved).toBe(true);
  });

  it('only the newest prompt per agent can be open', () => {
    const v = fold([
      prompt(NOW - 9 * MIN),
      attention(NOW - 5 * MIN, 'permission', 'Permission needed: Bash'),
      attention(NOW - MIN, 'permission', 'Permission needed: Edit'),
    ]);
    const items = derive([v]);
    expect(items).toHaveLength(1);
    expect(items[0].detail).toContain('Edit');
  });

  it('raises "awaiting reply" when the main agent went idle, resolved by a newer prompt', () => {
    const t = NOW - 3 * MIN;
    const idle = fold([prompt(t - MIN), toolStart(t - 30_000, 'a'), toolEnd(t - 20_000, 'a', true), text(t), turnEnd(t)]);
    expect(idle.agents[MAIN].status).toBe('idle');
    const items = derive([idle]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'reply', severity: 'info', resolved: false, agentId: MAIN });

    const replied = fold([prompt(t - MIN), toolStart(t - 30_000, 'a'), toolEnd(t - 20_000, 'a', true), text(t), turnEnd(t), prompt(NOW - 5000, 'next')]);
    const after = derive([replied], items);
    expect(after).toHaveLength(1);
    expect(after[0].resolved).toBe(true);
  });

  it('does not create items for history that is already resolved, or older than a day', () => {
    const old = NOW - 30 * 3_600_000;
    expect(derive([fold([prompt(old - MIN), text(old), turnEnd(old)])])).toHaveLength(0);
    const t = NOW - 10 * MIN;
    const answered = fold([prompt(t - MIN), attention(t, 'permission', 'Permission needed: Bash'), prompt(t + 1000)]);
    expect(derive([answered])).toHaveLength(0);
  });

  it('does not flag a reply while a background agent is still running', () => {
    const t = NOW - MIN;
    const v = fold([
      prompt(t - MIN),
      { k: 'agent.spawn', ts: t - 5000, src: 'transcript', ref: ref(), spawn: { childId: 'a1', agentType: 'Explore', description: 'look' } },
      text(t),
      turnEnd(t),
    ]);
    expect(derive([v]).filter((i) => i.kind === 'reply')).toHaveLength(0);
  });

  it('groups failed agents into one item per burst', () => {
    const t = NOW - 20 * MIN;
    const evs: Ev[] = [prompt(t - MIN)];
    for (const [i, id] of ['a1', 'a2', 'a3'].entries()) {
      evs.push({ k: 'agent.spawn', ts: t + i * 1000, src: 'transcript', ref: ref(), spawn: { childId: id, agentType: 'Explore', description: `job ${id}` } });
      evs.push({ k: 'agent.stop', ts: t + 60_000 + i * 1000, src: 'transcript', ref: ref(), childId: id, status: 'error', detail: 'boom' });
    }
    const items = derive([fold(evs)]);
    const failed = items.filter((i) => i.kind === 'agent-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ count: 3, severity: 'warn', title: '3 agents failed' });
  });

  it('groups tool error bursts, with a minimum size', () => {
    const t = NOW - 15 * MIN;
    const burst = (n: number): Ev[] => {
      const out: Ev[] = [prompt(t - MIN)];
      for (let i = 0; i < n; i++) out.push(toolStart(t + i * 2000, `t${i}`), toolEnd(t + i * 2000 + 500, `t${i}`, false));
      return out;
    };
    expect(derive([fold(burst(TOOL_ERROR_MIN - 1))]).filter((i) => i.kind === 'tool-errors')).toHaveLength(0);
    const items = derive([fold(burst(10))]).filter((i) => i.kind === 'tool-errors');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ count: 10, severity: 'warn' });
    // a later prompt resolves the burst
    const after = derive([fold([...burst(10), prompt(NOW - 1000)])], items);
    expect(after.find((i) => i.kind === 'tool-errors')?.resolved).toBe(true);
  });

  it('flags an API error until the session does something else', () => {
    const t = NOW - 2 * MIN;
    const ended = fold([prompt(t - MIN), attention(t, 'error', 'API error'), { k: 'session.end', ts: t + 1000, src: 'hook', ref: ref(), detail: 'other' }]);
    const items = derive([ended]);
    expect(items[0]).toMatchObject({ kind: 'api-error', severity: 'warn', title: 'Session ended with an API error' });
    const recovered = fold([
      prompt(t - MIN),
      attention(t, 'error', 'API error (retry 1)'),
      toolStart(t + 3000, 'x'),
      toolEnd(t + 4000, 'x', true),
      text(t + 5000),
    ]);
    expect(derive([recovered]).filter((i) => i.kind === 'api-error')).toHaveLength(0);
  });

  describe('usage limits', () => {
    const usage = (five: number | null, seven: number | null): UsageView => ({
      ...emptyUsage(),
      fiveHour: five === null ? null : { pct: five, resetsAt: NOW + 60 * MIN, at: NOW, source: 'statusline' },
      sevenDay: seven === null ? null : { pct: seven, resetsAt: NOW + 3 * 24 * 60 * MIN, at: NOW, source: 'statusline' },
    });

    it('raises at 90% and above, not below', () => {
      expect(derive([], [], usage(89, 50))).toHaveLength(0);
      const items = derive([], [], usage(90, 100));
      expect(items.map((i) => [i.kind, i.severity, i.sessionId])).toEqual([
        ['usage', 'critical', null],
        ['usage', 'warn', null],
      ]);
      expect(items.find((i) => i.severity === 'warn')?.title).toBe('5-hour usage at 90%');
      expect(items.find((i) => i.severity === 'critical')?.title).toBe('weekly usage limit reached');
    });

    it('resolves when the percentage drops or the window resets', () => {
      const items = derive([], [], usage(95, null));
      const dropped = derive([], items, usage(10, null));
      expect(dropped[0].resolved).toBe(true);
      const reset = derive([], items, usage(95, null), new Set(), NOW + 2 * 60 * MIN);
      expect(reset[0].resolved).toBe(true);
    });

    it('raises for a session quota the transcript recorded as rejected, once (same id as the usage meter)', () => {
      const v = fold([
        prompt(NOW - 5 * MIN),
        { k: 'quota', ts: NOW - MIN, src: 'transcript', ref: ref(), limitType: 'five_hour', status: 'rejected', resetsAt: NOW + 60 * MIN },
      ]);
      const u = { ...emptyUsage(), fiveHour: { pct: 100, resetsAt: NOW + 60 * MIN, at: NOW - MIN, source: 'transcript' as const } };
      const items = derive([v], [], u).filter((i) => i.kind === 'usage');
      expect(items).toHaveLength(1);
      expect(items[0].severity).toBe('critical');
    });
  });

  it('dismissed ids never come back, and survive being re-derived', () => {
    const t = NOW - MIN;
    const v = fold([prompt(t - MIN), attention(t, 'permission', 'Permission needed: Bash')]);
    const [item] = derive([v]);
    expect(derive([v], [item], null, new Set([item.id]))).toHaveLength(0);
    expect(derive([v], [], null, new Set([item.id]))).toHaveLength(0);
  });

  it('keeps unresolved items of sessions that are not watched, and drops long-resolved ones', () => {
    const t = NOW - MIN;
    const [item] = derive([fold([prompt(t - MIN), attention(t, 'permission', 'Permission needed: Bash')])]);
    expect(derive([], [item])[0].resolved).toBe(false);
    const later = derive([], [item], null, new Set(), NOW + 2 * 24 * 3_600_000);
    expect(later[0].resolved).toBe(true);
    expect(derive([], later, null, new Set(), NOW + 3 * 24 * 3_600_000)).toHaveLength(0);
  });

  it('orders by open first, severity, then recency; groups by session', () => {
    const a = fold([prompt(NOW - 9 * MIN), attention(NOW - 8 * MIN, 'permission', 'Permission needed: Bash')], 'sA');
    const idleT = NOW - MIN;
    const b = fold([prompt(idleT - MIN), text(idleT), turnEnd(idleT)], 'sB');
    const items = derive([b, a]);
    expect(items.map((i) => i.kind)).toEqual(['permission', 'reply']);
    const groups = groupBySession(items);
    expect(groups.map((g) => g.sessionId)).toEqual(['sA', 'sB']);
    expect(snapshotOf(items).count).toBe(2);
  });

  it('notices from OS notifications stay until dismissed', () => {
    const n = noticeItem({ sessionId: SID, sessionTitle: 'x', title: 'Explore finished', body: 'look' }, NOW);
    const kept = derive([], [n], null, new Set(), NOW + 3_600_000);
    expect(kept).toHaveLength(1);
    expect(kept[0].resolved).toBe(false);
    expect(derive([], [n], null, new Set([n.id]))).toHaveLength(0);
  });
});
