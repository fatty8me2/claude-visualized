import { describe, expect, it } from 'vitest';
import { emptyUsage, settleUsage, type UsageView, type UsageWindow } from '@core/usage';
import { defaultRate, UsageEstimator, weightOf } from '@core/usageEstimate';

const T0 = Date.parse('2026-10-20T10:00:00Z');
const RESET = T0 + 3 * 3600_000;
const win = (pct: number, at: number, extra: Partial<UsageWindow> = {}): UsageWindow => ({ pct, resetsAt: RESET, at, source: 'api', ...extra });
const view = (f: UsageWindow | null, s: UsageWindow | null = null): UsageView => ({ ...emptyUsage(), fiveHour: f, sevenDay: s });
/** an opus-5.5 message of `inTok` input tokens: 4 USD per million */
const msg = (e: UsageEstimator, id: string, inTok: number, ts: number, model = 'claude-opus-5-5') =>
  e.addMessage(id, model, { in: inTok, out: 0, cacheRead: 0, cacheWrite: 0 }, ts);

describe('usage estimator', () => {
  it('weighs output above input, cache reads far below, and model families apart', () => {
    const u = { in: 1000, out: 1000, cacheRead: 1000, cacheWrite: 1000 };
    const opus = weightOf('claude-opus-5-5', u);
    expect(opus).toBeGreaterThan(weightOf('claude-haiku-5-5', u));
    expect(weightOf('claude-opus-5-5', { in: 0, out: 1000, cacheRead: 0, cacheWrite: 0 })).toBeGreaterThan(weightOf('claude-opus-5-5', { in: 1000, out: 0, cacheRead: 0, cacheWrite: 0 }));
    expect(weightOf('claude-opus-5-5', { in: 0, out: 0, cacheRead: 1000, cacheWrite: 0 })).toBeLessThan(weightOf('claude-opus-5-5', { in: 1000, out: 0, cacheRead: 0, cacheWrite: 0 }));
    expect(weightOf('qwen2.5-coder:32b', u)).toBe(0);
    expect(weightOf('some-future-model', u)).toBeGreaterThan(0);
  });

  it('shows the reading unchanged until tokens arrive, then grows with them (default rate)', () => {
    const e = new UsageEstimator();
    e.observe(view(win(20, T0)));
    expect(e.estimate(T0 + 1000).fiveHour).toMatchObject({ pct: 20, delta: 0, calibrated: false });
    msg(e, 'm1', 500_000, T0 + 5000); // 2 USD
    const est = e.estimate(T0 + 6000).fiveHour!;
    expect(est.pct).toBeCloseTo(20 + 2 * defaultRate('fiveHour'), 5);
    expect(est.confirmedPct).toBe(20);
  });

  it('counts a message id once, even if its later lines carry larger usage', () => {
    const e = new UsageEstimator();
    e.observe(view(win(10, T0)));
    expect(msg(e, 'm1', 100_000, T0 + 1000)).toBe(true);
    expect(msg(e, 'm1', 100_000, T0 + 1100)).toBe(false);
    const one = e.estimate(T0 + 2000).fiveHour!.units;
    expect(msg(e, 'm1', 150_000, T0 + 1200)).toBe(true); // grew
    expect(e.estimate(T0 + 2000).fiveHour!.units).toBeCloseTo(one * 1.5, 6);
  });

  it('ignores tokens from before the reading', () => {
    const e = new UsageEstimator();
    msg(e, 'old', 1_000_000, T0 - 60_000);
    e.observe(view(win(10, T0)));
    expect(e.estimate(T0 + 1).fiveHour!.units).toBe(0);
  });

  it('learns the rate from two consecutive readings and snaps to the second', () => {
    const e = new UsageEstimator();
    e.observe(view(win(10, T0)));
    msg(e, 'a', 1_000_000, T0 + 60_000); // 4 USD
    e.observe(view(win(18, T0 + 120_000))); // 8 points: 2 %/USD; default is also 2, so use a different truth below
    expect(e.estimate(T0 + 121_000).fiveHour).toMatchObject({ pct: 18, delta: 0, calibrated: true });

    const f = new UsageEstimator();
    f.observe(view(win(10, T0)));
    msg(f, 'a', 1_000_000, T0 + 60_000); // 4 USD, truth: 1 %/USD
    f.observe(view(win(14, T0 + 120_000)));
    const r = f.estimate(T0 + 121_000).fiveHour!;
    expect(r.rate).toBeGreaterThan(1);
    expect(r.rate).toBeLessThan(2);
    expect(r.rate).toBeCloseTo(0.3 * 2 + 0.7 * 1, 5); // alpha .7 on the first pair
    // the next 4 USD is estimated with the learned rate, not the default
    msg(f, 'b', 1_000_000, T0 + 130_000);
    expect(f.estimate(T0 + 131_000).fiveHour!.delta).toBeCloseTo(4 * r.rate, 5);
  });

  it('converges toward a steady true rate over several pairs (EWMA)', () => {
    const e = new UsageEstimator();
    let pct = 5;
    let t = T0;
    e.observe(view(win(pct, t)));
    for (let i = 0; i < 12; i++) {
      msg(e, `m${i}`, 500_000, t + 30_000); // 2 USD -> +1.0 points at 0.5 %/USD ... use 1.5 so deltas clear the noise floor
      pct += 3; // 1.5 %/USD
      t += 60_000;
      e.observe(view(win(pct, t)));
    }
    expect(e.estimate(t + 1).fiveHour!.rate).toBeCloseTo(1.5, 1);
  });

  it('does not learn from a rollover, a transcript pin, noise, or a window change', () => {
    const e = new UsageEstimator();
    e.observe(view(win(50, T0)));
    msg(e, 'a', 1_000_000, T0 + 1000);
    const before = e.estimate(T0 + 2000).fiveHour!.rate;
    // new window (different reset) with a lower number: no teaching
    e.observe(view(win(3, T0 + 5000, { resetsAt: RESET + 5 * 3600_000 })));
    expect(e.estimate(T0 + 6000).fiveHour!.rate).toBe(before);
    // transcript pin
    e.observe(view(win(100, T0 + 7000, { source: 'transcript', resetsAt: RESET + 5 * 3600_000 })));
    expect(e.estimate(T0 + 8000).fiveHour!.rate).toBe(before);
  });

  it('keeps tokens just before an API reading (the API lags the transcripts) but not before a status-line one', () => {
    const e = new UsageEstimator();
    msg(e, 'a', 250_000, T0 - 5000);
    e.observe(view(win(10, T0)));
    expect(e.estimate(T0 + 1).fiveHour!.units).toBeGreaterThan(0);
    const f = new UsageEstimator();
    msg(f, 'a', 250_000, T0 - 5000);
    f.observe(view(win(10, T0, { source: 'statusline' })));
    expect(f.estimate(T0 + 1).fiveHour!.units).toBe(0);
  });

  it('learns downward when the estimate overshot the next reading', () => {
    const e = new UsageEstimator();
    e.observe(view(win(10, T0)));
    msg(e, 'a', 1_000_000, T0 + 1000); // 4 USD -> predicted +8
    e.observe(view(win(10.2, T0 + 60_000)));
    expect(e.estimate(T0 + 61_000).fiveHour!.rate).toBeLessThan(defaultRate('fiveHour'));
  });

  it('never drops below the reading and never claims the limit before it is read', () => {
    const e = new UsageEstimator();
    e.observe(view(win(90, T0)));
    msg(e, 'huge', 50_000_000, T0 + 1000);
    expect(e.estimate(T0 + 2000).fiveHour!.pct).toBe(99);
    const f = new UsageEstimator();
    f.observe(view(win(100, T0, { source: 'transcript' })));
    expect(f.estimate(T0 + 1).fiveHour!.pct).toBe(100);
  });

  it('restarts from 0 at a window reset and counts the new window from the reset moment', () => {
    const e = new UsageEstimator();
    e.observe(view(win(80, T0)));
    msg(e, 'before', 1_000_000, RESET - 1000);
    const rolled = settleUsage(view(win(80, T0)), RESET + 1000);
    e.observe(rolled);
    expect(e.estimate(RESET + 1500).fiveHour).toMatchObject({ confirmedPct: 0, units: 0 });
    msg(e, 'after', 250_000, RESET + 2000); // 1 USD
    expect(e.estimate(RESET + 3000).fiveHour!.pct).toBeCloseTo(defaultRate('fiveHour'), 5);
  });

  it('scales the default rate by plan and restores learned rates from a snapshot', () => {
    expect(defaultRate('fiveHour', 'pro')).toBeGreaterThan(defaultRate('fiveHour', 'max'));
    expect(defaultRate('fiveHour', 'max_20x')).toBeLessThan(defaultRate('fiveHour', 'max'));
    const e = new UsageEstimator();
    e.observe(view(win(10, T0)));
    msg(e, 'a', 1_000_000, T0 + 1000);
    e.observe(view(win(12, T0 + 60_000)));
    const snap = e.snapshot();
    const g = new UsageEstimator(null, snap);
    g.observe(view(win(12, T0 + 60_000)));
    expect(g.estimate(T0 + 61_000).fiveHour).toMatchObject({ calibrated: true, rate: snap.rates.fiveHour!.rate });
  });

  it('tracks the weekly window independently', () => {
    const e = new UsageEstimator();
    e.observe(view(win(10, T0), win(40, T0, { resetsAt: T0 + 5 * 86400_000 })));
    msg(e, 'a', 500_000, T0 + 1000);
    const est = e.estimate(T0 + 2000);
    expect(est.sevenDay!.delta).toBeCloseTo(2 * defaultRate('sevenDay'), 5);
    expect(est.fiveHour!.delta).toBeGreaterThan(est.sevenDay!.delta);
  });
});
