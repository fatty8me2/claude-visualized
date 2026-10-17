// Merge rules for another computer's sessions, inbox and usage (core/remote.ts).
import { describe, expect, it } from 'vitest';
import type { InboxItem } from '@core/inbox';
import {
  isRemoteId,
  mergeInbox,
  mergeSummaries,
  mergeUsage,
  namespaceView,
  parseRemoteId,
  remoteId,
  shareableSummaries,
  SHARED_RECENT,
  type RemoteHostData,
} from '@core/remote';
import { newSession, toView, type SessionSummary } from '@core/state';
import { emptyUsage, type UsageView, type UsageWindow } from '@core/usage';

const sum = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  file: `C:\\Users\\me\\.claude\\projects\\p\\${id}.jsonl`,
  projectDir: 'p',
  project: 'proj',
  cwd: 'C:\\proj',
  title: `t-${id}`,
  mtime: 1000,
  size: 10,
  live: false,
  entrypoint: 'cli',
  desktopId: 'local_123',
  ...over,
});

const item = (id: string, over: Partial<InboxItem> = {}): InboxItem => ({
  id,
  sessionId: 's1',
  sessionTitle: 'title',
  kind: 'permission',
  severity: 'critical',
  title: 'Permission needed',
  detail: 'Bash',
  firstSeen: 1,
  lastSeen: 1,
  count: 1,
  agentId: 'main',
  agentName: 'main',
  resolved: false,
  resolvedAt: null,
  ...over,
});

const win = (pct: number, at: number, source: UsageWindow['source'] = 'statusline'): UsageWindow => ({ pct, resetsAt: at + 3_600_000, at, source });

describe('remote ids', () => {
  it('namespace and parse', () => {
    const id = remoteId('abcd1234', '11111111-1111-4111-8111-111111111111');
    expect(id).toBe('remote:abcd1234:11111111-1111-4111-8111-111111111111');
    expect(isRemoteId(id)).toBe(true);
    expect(isRemoteId('11111111-1111')).toBe(false);
    expect(isRemoteId(null)).toBe(false);
    expect(parseRemoteId(id)).toEqual({ deviceId: 'abcd1234', id: '11111111-1111-4111-8111-111111111111' });
    expect(parseRemoteId('remote:nope')).toBeNull();
    expect(parseRemoteId('local')).toBeNull();
  });
});

describe('summaries', () => {
  it('shares live sessions plus the most recent, without local paths or desktop ids', () => {
    const local = [sum('live1', { live: true }), ...Array.from({ length: SHARED_RECENT + 10 }, (_, i) => sum(`old${i}`, { mtime: i }))];
    const out = shareableSummaries(local);
    expect(out.length).toBe(1 + SHARED_RECENT);
    expect(out[0].id).toBe('live1');
    expect(out[1].id).toBe(`old${SHARED_RECENT + 9}`); // newest first
    expect(out.every((s) => s.file === '' && s.desktopId === null)).toBe(true);
    expect(local[0].file).not.toBe(''); // the input is untouched
  });

  it('merges hosts after local sessions, namespaced and labelled, without id clashes', () => {
    const local = [sum('same', { live: true })];
    const host: RemoteHostData = { deviceId: 'dev1', machine: 'Mac', offlineSince: null, summaries: [sum('same', { live: true, running: 2, file: '' })] };
    const out = mergeSummaries(local, [host]);
    expect(out.map((s) => s.id)).toEqual(['same', 'remote:dev1:same']);
    expect(out[0].machine).toBeUndefined();
    expect(out[1]).toMatchObject({ machine: 'Mac', deviceId: 'dev1', offlineSince: null, live: true, running: 2 });
  });

  it('shows an offline host’s sessions as not live, with when it went offline', () => {
    const host: RemoteHostData = { deviceId: 'dev1', machine: 'Mac', offlineSince: 5000, summaries: [sum('a', { live: true, running: 3, waiting: true })] };
    const [s] = mergeSummaries([], [host]);
    expect(s).toMatchObject({ live: false, running: 0, waiting: false, offlineSince: 5000, machine: 'Mac' });
  });

  it('namespaces views', () => {
    const v = namespaceView(toView(newSession('abc')), 'dev1', 'Mac');
    expect(v.id).toBe('remote:dev1:abc');
    expect(v.machine).toBe('Mac');
  });
});

describe('inbox merge', () => {
  it('adds remote items namespaced and labelled by machine, skipping usage items and dismissed ids', () => {
    const local = [item('s1:reply:1', { kind: 'reply', severity: 'info', sessionId: 's1' })];
    const remote = [
      {
        deviceId: 'dev1',
        machine: 'Mac',
        items: [
          item('s9:permission:main:5', { sessionId: 's9', lastSeen: 5 }),
          item('usage:five_hour:1', { kind: 'usage', sessionId: null }),
          item('s9:tool-errors:3', { kind: 'tool-errors', severity: 'warn', sessionId: 's9' }),
        ],
      },
    ];
    const out = mergeInbox(local, remote, new Set(['remote:dev1:s9:tool-errors:3']));
    expect(out.map((i) => i.id)).toEqual(['remote:dev1:s9:permission:main:5', 's1:reply:1']); // critical first
    expect(out[0]).toMatchObject({ sessionId: 'remote:dev1:s9', machine: 'Mac' });
    expect(out[1].machine).toBeUndefined();
  });

  it('is just the local list with no remotes', () => {
    const local = [item('a')];
    expect(mergeInbox(local, [])).toEqual(local);
  });
});

describe('usage: freshest wins', () => {
  it('takes each window from the machine with the newest reading', () => {
    const local: UsageView = { ...emptyUsage(), fiveHour: win(40, 1000), sevenDay: win(20, 9000) };
    const remote: UsageView = { ...emptyUsage(), fiveHour: win(55, 5000), sevenDay: win(10, 2000) };
    const m = mergeUsage(local, [remote]);
    expect(m.fiveHour?.pct).toBe(55);
    expect(m.sevenDay?.pct).toBe(20);
  });

  it('fills windows the local machine has no reading for', () => {
    const m = mergeUsage(emptyUsage(), [{ ...emptyUsage(), fiveHour: win(12, 100), statuslineAt: 100 }]);
    expect(m.fiveHour?.pct).toBe(12);
    expect(m.statuslineAt).toBe(100);
  });

  it('covers an expired local login with a machine whose usage API answers', () => {
    const local: UsageView = { ...emptyUsage(), sevenDay: win(30, 1000, 'api'), api: { state: 'expired', message: 'login expired', at: 9000 } };
    const remote: UsageView = {
      ...emptyUsage(),
      sevenDay: win(33, 8000, 'api'),
      models: [{ label: 'Opus', window: win(40, 8000, 'api') }],
      api: { state: 'ok', message: 'usage API', at: 8000 },
    };
    const m = mergeUsage(local, [remote]);
    expect(m.api?.state).toBe('ok');
    expect(m.sevenDay?.pct).toBe(33);
    expect(m.models?.[0].label).toBe('Opus');
  });

  it('keeps the local view as it is without remotes', () => {
    const local: UsageView = { ...emptyUsage(), fiveHour: win(1, 1) };
    expect(mergeUsage(local, [])).toBe(local);
  });
});
