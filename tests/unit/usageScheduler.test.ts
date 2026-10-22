import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, UsageScheduler, type PollOutcome } from '@core/usageScheduler';

const SEC = 1000;
const MIN = 60 * SEC;

function make(outcomes: PollOutcome[] | ((n: number) => PollOutcome) = [{ kind: 'ok' }]) {
  const calls: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let release: (() => void) | null = null;
  let hold = false;
  const s = new UsageScheduler({
    random: () => 0,
    poll: async () => {
      calls.push(Date.now());
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (hold) await new Promise<void>((r) => (release = r));
      inFlight--;
      const n = calls.length - 1;
      return typeof outcomes === 'function' ? outcomes(n) : (outcomes[Math.min(n, outcomes.length - 1)] ?? { kind: 'ok' });
    },
  });
  return {
    s,
    calls,
    maxInFlight: () => maxInFlight,
    hold: (h: boolean) => (hold = h),
    release: () => release?.(),
  };
}

const t0 = Date.parse('2026-10-21T12:00:00Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(t0);
});
afterEach(() => vi.useRealTimers());

describe('usage scheduler', () => {
  it('reads once at start, then every 5 minutes while idle', async () => {
    const m = make();
    m.s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4 * MIN + 59 * SEC);
    expect(m.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * SEC);
    expect(m.calls).toHaveLength(2);
    expect(m.s.status().active).toBe(false);
    expect(m.s.status().intervalMs).toBe(DEFAULT_CONFIG.idleMs);
  });

  it('polls every minute while there is activity, and falls back to idle after 5 quiet minutes', async () => {
    const m = make();
    m.s.start();
    await vi.advanceTimersByTimeAsync(0);
    m.s.activity();
    expect(m.s.status().active).toBe(true);
    await vi.advanceTimersByTimeAsync(12 * MIN);
    // at 0, ~7s (debounce, but not inside the 15s minimum gap -> 15s), then every 60s while active, then 5 min apart
    const gaps = m.calls.slice(1).map((t, i) => t - m.calls[i]);
    expect(gaps[0]).toBe(15 * SEC);
    expect(gaps.slice(1, 4).every((g) => g === 60 * SEC)).toBe(true);
    expect(gaps[gaps.length - 1]).toBe(5 * MIN);
  });

  it('reads once, 7 s after a burst of activity ends, not once per message', async () => {
    const m = make();
    m.s.start();
    await vi.advanceTimersByTimeAsync(20 * SEC);
    expect(m.calls).toHaveLength(1);
    for (let i = 0; i < 5; i++) {
      m.s.activity();
      await vi.advanceTimersByTimeAsync(2 * SEC);
    }
    // last activity was 2 s ago; the read lands 5 s from now
    await vi.advanceTimersByTimeAsync(4 * SEC);
    expect(m.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * SEC);
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1] - t0).toBe(35 * SEC); // 7 s after the last of the five messages (at +28 s)
  });

  it('never has two requests in flight and runs a click only after the current one', async () => {
    const m = make();
    m.hold(true);
    m.s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.s.status().inFlight).toBe(true);
    m.s.wake();
    m.s.activity();
    const click = m.s.request();
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(m.calls).toHaveLength(1);
    m.hold(false);
    m.release();
    const r = await click;
    expect(r.ran).toBe(false);
    expect(m.maxInFlight()).toBe(1);
  });

  it('honours Retry-After exactly (plus at most 10% jitter) and tells a click when it may ask again', async () => {
    const m = make([{ kind: 'rate-limited', retryAfterMs: 90 * SEC }, { kind: 'ok' }]);
    m.s.start();
    await vi.advanceTimersByTimeAsync(0);
    const st = m.s.status();
    expect(st.blockedUntil).toBe(t0 + 90 * SEC);
    m.s.activity();
    m.s.wake();
    await vi.advanceTimersByTimeAsync(89 * SEC);
    expect(m.calls).toHaveLength(1);
    const early = await m.s.request();
    expect(early).toEqual({ ran: false, nextAllowedAt: t0 + 90 * SEC });
    await vi.advanceTimersByTimeAsync(2 * SEC);
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1]).toBeGreaterThanOrEqual(t0 + 90 * SEC);

    const j = new UsageScheduler({ random: () => 1, poll: async () => ({ kind: 'rate-limited', retryAfterMs: 100 * SEC }) });
    j.start();
    await vi.advanceTimersByTimeAsync(0);
    const b = j.status().blockedUntil!;
    expect(b - Date.now()).toBeGreaterThanOrEqual(100 * SEC - 1);
    expect(b - Date.now()).toBeLessThanOrEqual(110 * SEC);
    j.stop();
  });

  it('treats Retry-After 0 / missing as no information: 2, 4, 8, 10 minute ladder, and slows the cadence afterwards', async () => {
    const m = make(() => ({ kind: 'rate-limited', retryAfterMs: 0 }));
    m.s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.s.status().blockedUntil).toBe(t0 + 2 * MIN);
    m.s.activity();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(m.calls).toHaveLength(2);
    expect(m.s.status().blockedUntil! - Date.now()).toBe(4 * MIN);
    // learned a slower floor: not back at the 60 s active cadence
    m.s.activity();
    expect(m.s.status().intervalMs).toBeGreaterThan(DEFAULT_CONFIG.activeMs);
  });

  it('eases the learned floor back after good answers', async () => {
    const m = make((n) => (n === 0 ? { kind: 'rate-limited' } : { kind: 'ok' }));
    m.s.start();
    await vi.advanceTimersByTimeAsync(0);
    m.s.activity();
    expect(m.s.status().intervalMs).toBe(120 * SEC);
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(MIN);
      m.s.activity();
    }
    expect(m.s.status().intervalMs).toBe(DEFAULT_CONFIG.activeMs);
  });

  it('a click is refused inside the minimum gap but allowed after it', async () => {
    const m = make();
    m.s.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3 * SEC);
    const no = await m.s.request();
    expect(no.ran).toBe(false);
    expect(no.nextAllowedAt).toBe(t0 + DEFAULT_CONFIG.manualGapMs);
    await vi.advanceTimersByTimeAsync(8 * SEC);
    expect((await m.s.request()).ran).toBe(true);
    expect(m.calls).toHaveLength(2);
  });

  it('wake from sleep re-polls at once, even though the next read was minutes away', async () => {
    const m = make();
    m.s.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60 * SEC);
    expect(m.calls).toHaveLength(1);
    m.s.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.calls).toHaveLength(2);
  });

  it('wake does not override a pending Retry-After', async () => {
    const m = make([{ kind: 'rate-limited', retryAfterMs: 5 * MIN }, { kind: 'ok' }]);
    m.s.start();
    await vi.advanceTimersByTimeAsync(0);
    m.s.wake();
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(m.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1 * MIN + 1);
    expect(m.calls).toHaveLength(2);
  });

  it('keeps polling after errors, backing off 30 s, 60 s, 120 s, and after a sign-out checks again within a minute', async () => {
    const m = make([{ kind: 'error' }, { kind: 'error' }, { kind: 'error' }, { kind: 'auth' }, { kind: 'ok' }]);
    m.s.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    const gaps = m.calls.slice(1, 5).map((t, i) => t - m.calls[i]);
    expect(gaps).toEqual([30 * SEC, 60 * SEC, 120 * SEC, 60 * SEC]);
    // a throwing poll counts as an error and never stops the loop
    const boom = new UsageScheduler({
      random: () => 0,
      poll: async () => {
        throw new Error('x');
      },
    });
    boom.start();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(boom.status().lastStartAt).not.toBeNull();
    expect(boom.status().nextAt).not.toBeNull();
    boom.stop();
  });

  it('reports the next read time so the meters can say when', async () => {
    const m = make();
    m.s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.s.status().nextAt).toBe(t0 + 5 * MIN);
    m.s.stop();
    expect(m.s.status().nextAt).toBeNull();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(m.calls).toHaveLength(1);
  });
});
