import { describe, expect, it } from 'vitest';
import { applyQuota, applyStatusline, applyUsageApi, emptyUsage, resolveWindow, settleUsage } from '@core/usage';

const NOW = Date.parse('2026-10-14T15:00:00Z');
const sec = (ms: number) => Math.floor(ms / 1000);
const R1 = NOW + 3600_000;
const slPayload = (pct: number, resets = R1) => ({ rate_limits: { five_hour: { used_percentage: pct, resets_at: sec(resets) } } });
const apiBody = (pct: number, resets = R1) => ({ five_hour: { utilization: pct, resets_at: new Date(resets).toISOString() } });

describe('source precedence and rollover', () => {
  it('the freshest reading wins across sources, compared on its own timestamp', () => {
    const sl = applyStatusline(emptyUsage(), slPayload(40), NOW);
    expect(applyUsageApi(sl, apiBody(45), NOW + 1000).fiveHour).toMatchObject({ pct: 45, source: 'api', at: NOW + 1000 });
    // a status-line reading that landed after the API answer's timestamp is not overwritten by it
    const newer = applyStatusline(emptyUsage(), slPayload(50), NOW + 5000);
    expect(applyUsageApi(newer, apiBody(46), NOW + 1000).fiveHour).toMatchObject({ pct: 50, source: 'statusline' });
  });

  it('within one window a stale lower number (an idle terminal re-sending its last response) never pulls the meter down', () => {
    const api = applyUsageApi(emptyUsage(), apiBody(60), NOW);
    const sl = applyStatusline(api, slPayload(52), NOW + 30_000);
    expect(sl.fiveHour?.pct).toBe(60);
    expect(sl.fiveHour?.at).toBe(NOW + 30_000);
  });

  it('a later window beats the earlier one whatever the timestamps say', () => {
    const old = applyStatusline(emptyUsage(), slPayload(90), NOW + 10_000);
    const R2 = R1 + 5 * 3600_000;
    const next = applyStatusline(old, slPayload(2, R2), NOW + 20_000);
    expect(next.fiveHour).toMatchObject({ pct: 2, resetsAt: R2 });
    expect(resolveWindow(next.fiveHour, old.fiveHour)?.pct).toBe(2);
    expect(resolveWindow(old.fiveHour, next.fiveHour)?.pct).toBe(2);
  });

  it('a window that has reset drops to 0% at the reset moment, flagged as inferred, and a new reading replaces it', () => {
    const sl = applyStatusline(emptyUsage(), slPayload(88), NOW);
    const after = settleUsage(sl, R1 + 5000);
    expect(after.fiveHour).toMatchObject({ pct: 0, resetsAt: null, at: R1, inferred: true });
    const fresh = applyStatusline(after, slPayload(3, R1 + 5 * 3600_000), R1 + 8000);
    expect(fresh.fiveHour).toMatchObject({ pct: 3, source: 'statusline' });
    expect(fresh.fiveHour?.inferred).toBeUndefined();
    // the inferred 0% is dated at the reset and does not refresh itself on later settles
    expect(settleUsage(after, R1 + 600_000).fiveHour?.at).toBe(R1);
  });

  it('weekly rolls over the same way, and the API replaces the inferred 0% with the real number', () => {
    const W = NOW + 2 * 86400_000;
    const sl = applyStatusline(emptyUsage(), { rate_limits: { seven_day: { used_percentage: 97, resets_at: sec(W) } } }, NOW);
    const after = settleUsage(sl, W + 1000);
    expect(after.sevenDay).toMatchObject({ pct: 0, inferred: true });
    const api = applyUsageApi(after, { seven_day: { utilization: 1.5, resets_at: new Date(W + 7 * 86400_000).toISOString() } }, W + 60_000);
    expect(api.sevenDay).toMatchObject({ pct: 1.5, source: 'api' });
  });

  it('peers: an inferred reset never beats a real reading taken after the reset', () => {
    const local = settleUsage(applyStatusline(emptyUsage(), slPayload(88), NOW), R1 + 60_000);
    const peer = applyStatusline(emptyUsage(), slPayload(4, R1 + 5 * 3600_000), R1 + 30_000);
    expect(resolveWindow(local.fiveHour, peer.fiveHour)?.pct).toBe(4);
    expect(resolveWindow(peer.fiveHour, local.fiveHour)?.pct).toBe(4);
  });

  it('a window the API stops reporting is cleared only if the API answer is the newer reading', () => {
    const sl = applyStatusline(emptyUsage(), slPayload(70), NOW + 100);
    expect(applyUsageApi(sl, {}, NOW + 50).fiveHour?.pct).toBe(70);
    expect(applyUsageApi(sl, {}, NOW + 200).fiveHour).toBeNull();
  });

  it('a transcript limit-hit pins 100% over an older reading and cannot override a newer one', () => {
    const sl = applyStatusline(emptyUsage(), slPayload(70), NOW + 100);
    const hit = applyQuota(sl, { limitType: 'five_hour', status: 'rejected', resetsAt: R1, ts: NOW + 200 }, NOW + 300);
    expect(hit.fiveHour?.pct).toBe(100);
    expect(applyQuota(sl, { limitType: 'five_hour', status: 'rejected', resetsAt: R1, ts: NOW + 50 }, NOW + 300)).toBe(sl);
  });
});
