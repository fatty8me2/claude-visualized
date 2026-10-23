// When to ask Anthropic's usage endpoint for the 5-hour / weekly numbers. A small state machine (no Electron, no network): the caller
// supplies `poll` and tells it about activity; it owns the timer and decides the next request time.
//
// What was measured (2026-10-21, see the commit message): the endpoint is strictly rate limited per login. Four calls 5 to 20 s apart
// all answered 429 with `retry-after: 0`, `cache-control: no-store`. A zero Retry-After carries no information, and the old poller read
// it as "absent" and slept 10 minutes, on top of a fixed 3-minute base cadence. So the endpoint is a slow channel at best; the
// real-time channel is the status-line forwarder (terminal sessions), which the merge in core/usage.ts prefers whenever it is newer.
//
// Cadence (AIMD around what the endpoint tolerates):
//  - active (assistant/hook/status-line activity in the last 5 min): every 60 s
//  - idle: every 5 min
//  - a burst of activity schedules one extra read 7 s after the burst ends (never closer than MIN_GAP to the previous request)
//  - 429: wait Retry-After exactly (+0-10% jitter); with no usable Retry-After wait 2, 4, 8, 10 min; and learn: the cadence floor
//    doubles (up to 10 min) so we stop provoking it, then eases back by 20% per good answer
//  - network/server error: 30 s, 60 s, 120 s … never beyond the normal interval; signed out: re-check every 60 s (cheap, no request)
//  - one request in flight at a time; wake from sleep / unlock / network back re-polls at once unless a Retry-After is pending
//  - a click may force a read, but not within MANUAL_GAP of the last request or inside a Retry-After wait (the answer says when)

export type PollOutcome =
  | { kind: 'ok' }
  | { kind: 'rate-limited'; retryAfterMs?: number }
  | { kind: 'auth' }
  | { kind: 'error' };

export interface SchedulerConfig {
  activeMs: number;
  idleMs: number;
  /** how long after the last activity the cadence stays "active" */
  activeForMs: number;
  debounceMs: number;
  /** smallest gap between two requests, whatever asks */
  minGapMs: number;
  manualGapMs: number;
  errorBaseMs: number;
  authMs: number;
  rateLimitBaseMs: number;
  rateLimitMaxMs: number;
}

export const DEFAULT_CONFIG: SchedulerConfig = {
  activeMs: 60_000,
  idleMs: 300_000,
  activeForMs: 300_000,
  debounceMs: 7_000,
  minGapMs: 15_000,
  manualGapMs: 10_000,
  errorBaseMs: 30_000,
  authMs: 60_000,
  rateLimitBaseMs: 120_000,
  rateLimitMaxMs: 600_000,
};

export function scaleConfig(c: SchedulerConfig, k: number): SchedulerConfig {
  return Object.fromEntries(Object.entries(c).map(([key, v]) => [key, Math.max(1, Math.round(v * k))])) as unknown as SchedulerConfig;
}

export interface SchedulerStatus {
  /** how often a read is attempted right now (before jitter and backoff) */
  intervalMs: number;
  nextAt: number | null;
  /** do not ask before this (Retry-After), or null */
  blockedUntil: number | null;
  lastStartAt: number | null;
  lastOkAt: number | null;
  inFlight: boolean;
  active: boolean;
}

export interface SchedulerDeps {
  poll: () => Promise<PollOutcome>;
  now?: () => number;
  random?: () => number;
  onChange?: (s: SchedulerStatus) => void;
  /** when it returns false a due read is skipped (and looked at again in CAN_RUN_RECHECK_MS); the usage ping only runs while a session is active */
  canRun?: () => boolean;
}

const CAN_RUN_RECHECK_MS = 15_000;

export class UsageScheduler {
  private cfg: SchedulerConfig;
  private now: () => number;
  private random: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private flight: Promise<void> | null = null;
  private lastActivity = -Infinity;
  private lastStart: number | null = null;
  private lastOk: number | null = null;
  private blockedUntil: number | null = null;
  private debounceAt: number | null = null;
  private wakeWanted = false;
  private failures = 0;
  private rateLimits = 0;
  private floorMs = 0;
  /** what the last outcome asks for beyond the normal cadence (error backoff) */
  private retryDelay: number | null = null;
  private jitter = 0;
  private nextAt: number | null = null;

  constructor(
    private deps: SchedulerDeps,
    cfg: Partial<SchedulerConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.jitter = this.random();
  }

  /** new cadence numbers (a changed setting) */
  reconfigure(cfg: Partial<SchedulerConfig>) {
    this.cfg = { ...this.cfg, ...cfg };
    this.plan();
  }

  start() {
    this.running = true;
    this.plan();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
  }

  /** New assistant/hook/status-line activity: switches to the active cadence and schedules one debounced read after the burst. */
  activity() {
    const t = this.now();
    this.lastActivity = t;
    this.debounceAt = t + this.cfg.debounceMs;
    this.plan();
  }

  /** Wake from sleep, unlock, network back: read now (still never inside a Retry-After wait or the minimum gap). */
  wake() {
    this.wakeWanted = true;
    this.plan();
  }

  /** A user click. Starts a read when allowed, otherwise says when it will be. Resolves when the read (if any) is done. */
  async request(): Promise<{ ran: boolean; nextAllowedAt: number | null }> {
    const t = this.now();
    if (this.flight) {
      await this.flight;
      return { ran: false, nextAllowedAt: this.earliest(true) };
    }
    const at = this.earliest(true);
    if (at > t) return { ran: false, nextAllowedAt: at };
    await this.run();
    return { ran: true, nextAllowedAt: null };
  }

  status(): SchedulerStatus {
    return {
      intervalMs: this.interval(),
      nextAt: this.nextAt,
      blockedUntil: this.blockedUntil && this.blockedUntil > this.now() ? this.blockedUntil : null,
      lastStartAt: this.lastStart,
      lastOkAt: this.lastOk,
      inFlight: !!this.flight,
      active: this.isActive(),
    };
  }

  private isActive() {
    return this.now() - this.lastActivity < this.cfg.activeForMs;
  }

  private interval(): number {
    return Math.max(this.isActive() ? this.cfg.activeMs : this.cfg.idleMs, this.floorMs);
  }

  /** earliest time a request is allowed at all */
  private earliest(manual: boolean): number {
    const gap = manual ? this.cfg.manualGapMs : this.cfg.minGapMs;
    return Math.max(this.blockedUntil ?? 0, this.lastStart === null ? 0 : this.lastStart + gap);
  }

  private plan() {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
    if (this.flight) {
      this.notify();
      return;
    }
    const t = this.now();
    let target: number;
    if (this.lastStart === null) target = t;
    else {
      const iv = this.retryDelay ?? this.interval();
      target = this.lastStart + iv * (1 + this.jitter * 0.1);
    }
    if (this.debounceAt !== null && this.retryDelay === null) target = Math.min(target, this.debounceAt);
    if (this.wakeWanted) target = t;
    target = Math.max(target, this.earliest(false));
    this.nextAt = target;
    this.timer = setTimeout(() => void this.fire(), Math.max(0, target - t));
    this.notify();
  }

  private async fire() {
    this.timer = null;
    if (!this.running || this.flight) return;
    // the timer can wake slightly early on a coarse clock; re-plan instead of firing inside the gap
    if (this.earliest(false) > this.now()) return this.plan();
    if (this.deps.canRun && !this.deps.canRun()) {
      this.timer = setTimeout(() => void this.fire(), CAN_RUN_RECHECK_MS);
      this.nextAt = null;
      return;
    }
    await this.run();
  }

  private run(): Promise<void> {
    if (this.flight) return this.flight;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.lastStart = this.now();
    this.debounceAt = null;
    this.wakeWanted = false;
    this.jitter = this.random();
    this.flight = (async () => {
      let out: PollOutcome;
      try {
        out = await this.deps.poll();
      } catch {
        out = { kind: 'error' };
      }
      this.settle(out);
    })().finally(() => {
      this.flight = null;
      this.plan();
    });
    this.notify();
    return this.flight;
  }

  private settle(out: PollOutcome) {
    const t = this.now();
    this.retryDelay = null;
    if (out.kind === 'ok') {
      this.lastOk = t;
      this.failures = 0;
      this.rateLimits = 0;
      this.blockedUntil = null;
      this.floorMs = this.floorMs * 0.8 < this.cfg.activeMs ? 0 : this.floorMs * 0.8;
    } else if (out.kind === 'rate-limited') {
      this.rateLimits++;
      const ra = out.retryAfterMs;
      const wait =
        ra !== undefined && ra > 0
          ? ra * (1 + this.jitter * 0.1)
          : Math.min(this.cfg.rateLimitMaxMs, this.cfg.rateLimitBaseMs * 2 ** (this.rateLimits - 1));
      this.blockedUntil = t + wait;
      this.floorMs = Math.min(this.cfg.rateLimitMaxMs, Math.max(this.cfg.activeMs, this.floorMs) * 2);
    } else if (out.kind === 'auth') {
      this.retryDelay = this.cfg.authMs;
    } else {
      this.failures++;
      this.retryDelay = Math.min(this.interval(), this.cfg.errorBaseMs * 2 ** (this.failures - 1));
    }
  }

  private notify() {
    this.deps.onChange?.(this.status());
  }
}
