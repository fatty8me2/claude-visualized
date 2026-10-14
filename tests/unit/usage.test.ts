import { describe, expect, it } from 'vitest';
import { installHooks, statusLineState, uninstallHooks } from '@core/hooksConfig';
import { normalizeLine } from '@core/normalize';
import { applyQuota, applyStatusline, emptyUsage, settleUsage } from '@core/usage';

const NOW = Date.parse('2026-10-14T15:00:00Z');
const sec = (ms: number) => Math.floor(ms / 1000);

describe('usage limits', () => {
  it('reads rate_limits from the status-line payload (percent 0-100, resets_at epoch seconds)', () => {
    const u = applyStatusline(emptyUsage(), { rate_limits: { five_hour: { used_percentage: 23.5, resets_at: sec(NOW + 3600_000) }, seven_day: { used_percentage: 41.2, resets_at: sec(NOW + 3 * 86400_000) } } }, NOW);
    expect(u.fiveHour).toMatchObject({ pct: 23.5, resetsAt: NOW + 3600_000, source: 'statusline' });
    expect(u.sevenDay?.pct).toBe(41.2);
    expect(u.statuslineAt).toBe(NOW);
  });

  it('ignores payloads without rate_limits and keeps windows that are missing', () => {
    const a = applyStatusline(emptyUsage(), { rate_limits: { five_hour: { used_percentage: 10, resets_at: sec(NOW + 1000_000) } } }, NOW);
    expect(applyStatusline(a, { model: { id: 'x' } }, NOW + 1)).toBe(a);
    const b = applyStatusline(a, { rate_limits: { seven_day: { used_percentage: 5, resets_at: sec(NOW + 9000_000) } } }, NOW + 2);
    expect(b.fiveHour?.pct).toBe(10);
    expect(b.sevenDay?.pct).toBe(5);
  });

  it('pins a window at 100% when a transcript records the limit being hit, unless a newer reading exists', () => {
    const hit = applyQuota(emptyUsage(), { limitType: 'five_hour', status: 'rejected', resetsAt: NOW + 7200_000, ts: NOW });
    expect(hit.fiveHour).toMatchObject({ pct: 100, source: 'transcript' });
    const newer = applyStatusline(emptyUsage(), { rate_limits: { five_hour: { used_percentage: 3, resets_at: sec(NOW + 9e6) } } }, NOW + 10);
    expect(applyQuota(newer, { limitType: 'five_hour', status: 'rejected', resetsAt: NOW, ts: NOW })).toBe(newer);
    expect(applyQuota(emptyUsage(), { limitType: 'five_hour', status: 'allowed', resetsAt: null, ts: NOW }).fiveHour).toBeNull();
  });

  it('resets windows whose reset time has passed', () => {
    const u = applyQuota(emptyUsage(), { limitType: 'seven_day', status: 'rejected', resetsAt: NOW - 1, ts: NOW - 100 });
    expect(settleUsage(u, NOW).sevenDay).toMatchObject({ pct: 0, resetsAt: null });
  });

  it('parses quotaLimits from transcript lines', () => {
    const line = JSON.stringify({ type: 'assistant', timestamp: '2026-09-24T22:54:47.021Z', quotaLimits: { status: 'rejected', resetsAt: 1790297400, rateLimitType: 'five_hour' }, message: { id: 'm', model: '<synthetic>', content: [] } });
    const q = normalizeLine(line, { sessionId: 's', agentId: null }).find((e) => e.k === 'quota');
    expect(q).toMatchObject({ limitType: 'five_hour', status: 'rejected', resetsAt: 1790297400_000 });
  });
});

describe('status line install', () => {
  const CMD = 'node "C:/Users/x/.claude/claude-visualized-statusline.mjs"';
  it('adds ours only when the user has none, and removes only ours', () => {
    const base = { model: 'opus' };
    const inst = installHooks(base, 47821, CMD);
    expect(inst.statusLine).toEqual({ type: 'command', command: CMD, padding: 0 });
    expect(statusLineState(inst)).toBe('ours');
    expect(uninstallHooks(inst)).toEqual(base);
    const own = { statusLine: { type: 'command', command: 'my-line.sh' } };
    const kept = installHooks(own, 47821, CMD);
    expect(kept.statusLine).toEqual(own.statusLine);
    expect(statusLineState(kept)).toBe('other');
    expect(uninstallHooks(kept).statusLine).toEqual(own.statusLine);
  });
});
