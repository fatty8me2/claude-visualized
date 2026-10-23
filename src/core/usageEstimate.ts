// Live estimate of the 5-hour / weekly meters BETWEEN authoritative readings.
//
// The usage API is a slow, rate-limited channel and the status line only runs in terminal sessions, yet every assistant message of every
// session (desktop app included) lands in a transcript with its token counts. This module turns those into a weighted "unit" count (USD at
// API list price: output, cache and model family all weigh in), and learns how many percent of each window one unit costs from consecutive
// authoritative readings (EWMA). The meter then shows  reading + rate * units-since-the-reading.  Pure: no Electron, no clock of its own.

import type { UsageNumbers } from './events';
import { classifyModel } from './models';
import { estimateCostUSD } from './pricing';
import type { UsageView, UsageWindow } from './usage';

export type WindowKey = 'fiveHour' | 'sevenDay';
export const WINDOW_KEYS: readonly WindowKey[] = ['fiveHour', 'sevenDay'];

/** Percent of a window per unit (USD of list-price tokens) before anything has been learned. A guess for a Max 5x plan, scaled by plan. */
const BASE_RATE: Record<WindowKey, number> = { fiveHour: 2, sevenDay: 0.25 };
const PLAN_SCALE: Record<string, number> = { pro: 5, max: 1, max_5x: 1, max5x: 1, max_20x: 0.25, max20x: 0.25, team: 2, enterprise: 1 };
/** unknown models weigh like a mid-priced one */
const FALLBACK_MODEL = 'claude-sonnet-4-6';

/** Weighted units of one message: USD at list price (local models are free). */
export function weightOf(model: string | null | undefined, u: UsageNumbers): number {
  if (model && classifyModel(model).provider === 'local') return 0;
  return estimateCostUSD(u, model) ?? estimateCostUSD(u, FALLBACK_MODEL) ?? 0;
}

export function defaultRate(key: WindowKey, plan?: string | null): number {
  const k = plan ? plan.toLowerCase().replace(/^claude_?/, '') : '';
  return BASE_RATE[key] * (PLAN_SCALE[k] ?? 1);
}

export interface WindowEstimate {
  /** shown percentage: the confirmed reading plus the estimated growth since (never below the reading, never above 100) */
  pct: number;
  confirmedPct: number;
  /** estimated growth since the reading, in percentage points */
  delta: number;
  /** weighted units seen since the reading */
  units: number;
  /** percent per unit currently in use */
  rate: number;
  /** the rate was learned from this account's own readings (not the default guess) */
  calibrated: boolean;
}
export type UsageEstimate = Partial<Record<WindowKey, WindowEstimate>>;

interface Anchor {
  /** tokens stamped up to this long before the reading may not be in it yet (the usage API lags behind the transcripts) and still count */
  lagMs: number;
  pct: number;
  at: number;
  resetsAt: number | null;
  source: UsageWindow['source'];
}
interface Track {
  rate: number;
  calibrated: boolean;
  samples: number;
  anchor: Anchor | null;
}
export interface EstimatorSnapshot {
  rates: Partial<Record<WindowKey, { rate: number; samples: number }>>;
}

const SAME_WINDOW_MS = 60_000;
/** how far behind the transcripts a usage API answer may be; the status line is exact and the rollover anchor is a computed 0 */
export const API_LAG_MS = 20_000;
const MAX_SAMPLES = 20_000;
const KEEP_MS = 8 * 86400_000;
/** a pair of readings must span at least this much usage to teach anything (USD, i.e. about two cents) */
const MIN_UNITS = 0.02;
/** a reading must have moved at least this much to teach anything (rounding noise is below it) */
const MIN_DELTA_PCT = 1;

export class UsageEstimator {
  private tracks: Record<WindowKey, Track>;
  /** message id -> units counted so far (a message is logged once per content block, with the same or growing usage) */
  private seen = new Map<string, number>();
  private samples: { ts: number; units: number }[] = [];
  private version = 0;

  constructor(plan: string | null = null, snap?: EstimatorSnapshot) {
    const mk = (k: WindowKey): Track => {
      const s = snap?.rates?.[k];
      if (s && Number.isFinite(s.rate) && s.rate > 0) return { rate: s.rate, calibrated: s.samples > 0, samples: s.samples, anchor: null };
      return { rate: defaultRate(k, plan), calibrated: false, samples: 0, anchor: null };
    };
    this.tracks = { fiveHour: mk('fiveHour'), sevenDay: mk('sevenDay') };
  }

  /** Bumps whenever an estimate may have changed. */
  get changes(): number {
    return this.version;
  }

  snapshot(): EstimatorSnapshot {
    const r = (k: WindowKey) => ({ rate: this.tracks[k].rate, samples: this.tracks[k].samples });
    return { rates: { fiveHour: r('fiveHour'), sevenDay: r('sevenDay') } };
  }

  /** One assistant message's usage (from any session, any agent). Returns true if it added anything. */
  addMessage(msgId: string, model: string | null | undefined, usage: UsageNumbers, ts: number): boolean {
    const units = weightOf(model, usage);
    const prev = this.seen.get(msgId) ?? 0;
    this.seen.delete(msgId);
    this.seen.set(msgId, Math.max(prev, units));
    if (this.seen.size > MAX_SAMPLES) this.seen.delete(this.seen.keys().next().value as string);
    const add = units - prev;
    if (!(add > 0)) return false;
    this.samples.push({ ts, units: add });
    if (this.samples.length > MAX_SAMPLES || (this.samples.length % 500 === 0 && this.samples[0].ts < ts - KEEP_MS)) {
      this.samples = this.samples.filter((m) => m.ts >= ts - KEEP_MS).slice(-MAX_SAMPLES);
    }
    this.version++;
    return true;
  }

  /** units of messages stamped in (from, to] */
  private unitsBetween(from: number, to: number): number {
    let s = 0;
    for (const m of this.samples) if (m.ts > from && m.ts <= to) s += m.units;
    return s;
  }

  /**
   * Feed the authoritative view (after every reading). A reading that is new for a window becomes its anchor, and, if the previous anchor
   * was the same window, teaches the rate. Returns true when an anchor changed.
   */
  observe(view: UsageView): boolean {
    let changed = false;
    for (const key of WINDOW_KEYS) {
      const w = view[key];
      const t = this.tracks[key];
      if (!w) continue;
      const a = t.anchor;
      if (a && a.at === w.at && a.pct === w.pct) continue;
      changed = true;
      // a rollover (settleUsage's inferred 0%) or a transcript pin never teaches
      const sameWindow = !!a && !w.inferred && (a.resetsAt === null || w.resetsAt === null || Math.abs(a.resetsAt - w.resetsAt) <= SAME_WINDOW_MS);
      if (a && sameWindow && w.at > a.at && w.source !== 'transcript' && a.source !== 'transcript') this.learn(t, a, w);
      t.anchor = { lagMs: w.source === 'api' && !w.inferred ? API_LAG_MS : 0, pct: w.pct, at: w.at, resetsAt: w.resetsAt, source: w.source };
    }
    if (changed) this.version++;
    return changed;
  }

  private learn(t: Track, a: Anchor, w: UsageWindow) {
    let dPct = w.pct - a.pct;
    const lagW = w.source === 'api' ? API_LAG_MS : 0;
    const units = this.unitsBetween(a.at - a.lagMs, w.at - lagW);
    if (units < MIN_UNITS) return;
    // a reading that barely moved is rounding noise, unless the belief predicted a clear jump: then the rate was too high
    if (dPct < MIN_DELTA_PCT) {
      if (t.rate * units < 3) return;
      dPct = Math.max(dPct, 0.3);
    }
    // usage from machines we cannot see inflates the rate (and rounding deflates it): keep any single pair within a factor of the belief
    const f = t.calibrated ? 4 : 30;
    const obs = Math.min(t.rate * f, Math.max(t.rate / f, dPct / units));
    // the first pair replaces most of the default guess; later ones nudge
    const alpha = t.calibrated ? 0.3 : 0.7;
    t.rate = (1 - alpha) * t.rate + alpha * obs;
    t.calibrated = true;
    t.samples++;
  }

  /** The estimate per window at `now`, or nothing for a window without a reading. */
  estimate(now: number): UsageEstimate {
    const out: UsageEstimate = {};
    for (const key of WINDOW_KEYS) {
      const t = this.tracks[key];
      const a = t.anchor;
      if (!a) continue;
      const units = this.unitsBetween(a.at - a.lagMs, now);
      // a limit already hit stays at 100; otherwise the estimate never claims the limit is reached before a reading says so
      const cap = a.pct >= 100 ? 100 : 99;
      const pct = Math.max(a.pct, Math.min(cap, a.pct + units * t.rate));
      out[key] = { pct, confirmedPct: a.pct, delta: pct - a.pct, units, rate: t.rate, calibrated: t.calibrated };
    }
    return out;
  }
}
