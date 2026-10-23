// What the usage pings (core/usagePing.ts) cost: running totals of the tokens their replies report, priced at list price (an estimate;
// a subscription is not billed per token). Persisted by the app in its profile folder; never sent to peers.

import { dayKey } from './history';
import { estimateCostUSD } from './pricing';

export interface PingUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PingBucket {
  n: number;
  input: number;
  output: number;
  costUsd: number;
}

export interface PingStats {
  all: PingBucket;
  /** by local day, the last 30 kept */
  days: Record<string, PingBucket>;
  lastAt: number | null;
}

export interface PingStatsSummary {
  today: PingBucket;
  week: PingBucket;
  all: PingBucket;
  lastAt: number | null;
}

const KEEP_DAYS = 30;
const zero = (): PingBucket => ({ n: 0, input: 0, output: 0, costUsd: 0 });
export const emptyPingStats = (): PingStats => ({ all: zero(), days: {}, lastAt: null });

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** the `usage` object of a Messages API reply -> counts, or null when it is not one */
export function parsePingUsage(u: unknown): PingUsage | null {
  if (!u || typeof u !== 'object') return null;
  const o = u as Record<string, unknown>;
  return { input: num(o.input_tokens), output: num(o.output_tokens), cacheRead: num(o.cache_read_input_tokens), cacheWrite: num(o.cache_creation_input_tokens) };
}

const bump = (b: PingBucket | undefined, u: PingUsage, cost: number): PingBucket => {
  const x = b ?? zero();
  return { n: x.n + 1, input: x.input + u.input + u.cacheRead + u.cacheWrite, output: x.output + u.output, costUsd: x.costUsd + cost };
};

/** One more ping (a reply without usage still counts as a ping). */
export function addPing(s: PingStats, u: PingUsage | null, model: string | null, now: number): PingStats {
  const use = u ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const cost = estimateCostUSD({ in: use.input, out: use.output, cacheRead: use.cacheRead, cacheWrite: use.cacheWrite }, model) ??
    estimateCostUSD({ in: use.input, out: use.output, cacheRead: use.cacheRead, cacheWrite: use.cacheWrite }, 'claude-haiku-5-5') ??
    0;
  const day = dayKey(now);
  const days = { ...s.days, [day]: bump(s.days[day], use, cost) };
  for (const k of Object.keys(days).sort().slice(0, -KEEP_DAYS)) delete days[k];
  return { all: bump(s.all, use, cost), days, lastAt: now };
}

export function summarizePingStats(s: PingStats, now: number): PingStatsSummary {
  const week = zero();
  for (let i = 0; i < 7; i++) {
    const b = s.days[dayKey(now - i * 86_400_000)];
    if (b) {
      week.n += b.n;
      week.input += b.input;
      week.output += b.output;
      week.costUsd += b.costUsd;
    }
  }
  return { today: s.days[dayKey(now)] ?? zero(), week, all: s.all, lastAt: s.lastAt };
}
