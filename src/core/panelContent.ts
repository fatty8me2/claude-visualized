// What an overview panel shows, chosen from its measured size and the density setting (pure; tests/unit/panelContent.test.ts).
//   small:  graph + a short log
//   medium: + the insight rail (activity sparkline, burn rate, context forecast, agent counts)
//   large:  + the live feed, the plan strip (only with a plan) and the agent table
// "Body" is the panel below its header: the graph, the rail and the log share it.

export type PanelTier = 'small' | 'medium' | 'large';
export type PanelDensity = 'compact' | 'comfortable' | 'spacious';

export interface TierLimits {
  /** body height at which the rail appears */
  medium: number;
  /** body height at which the feed / table / plan appear */
  large: number;
  /** body width needed for the large tier (below it the extras would be cramped) */
  largeW: number;
}

/** spacious panels spend their room on content sooner; compact never leaves the small tier */
export const TIER_LIMITS: Record<PanelDensity, TierLimits> = {
  compact: { medium: Infinity, large: Infinity, largeW: Infinity },
  comfortable: { medium: 440, large: 700, largeW: 540 },
  spacious: { medium: 340, large: 600, largeW: 480 },
};

/** a tier that was already showing stays until the size falls this far below its limit (resize jitter) */
export const TIER_HYSTERESIS = 24;
/** body width from which the large tier splits into two columns (feed | plan + table) */
export const WIDE_W = 820;
/** below this body height a stacked (single-column) large tier leaves out the agent table */
export const TABLE_STACKED_H = 760;

const RANK: Record<PanelTier, number> = { small: 0, medium: 1, large: 2 };

/** Tier for a body of w x h px. `prev` (the tier it had) makes the thresholds sticky. */
export function panelTier(w: number, h: number, density: PanelDensity, prev?: PanelTier): PanelTier {
  if (!(w > 0) || !(h > 0)) return prev ?? 'small';
  const lim = TIER_LIMITS[density];
  const slack = (k: number) => (prev && RANK[prev] >= k ? TIER_HYSTERESIS : 0);
  if (h >= lim.large - slack(2) && w >= lim.largeW - slack(2)) return 'large';
  if (h >= lim.medium - slack(1)) return 'medium';
  return 'small';
}

export interface PanelPlan {
  tier: PanelTier;
  rail: boolean;
  feed: boolean;
  plan: boolean;
  table: boolean;
  /** large tier in two columns */
  wide: boolean;
  /** log lines under the graph (small and medium) */
  logLines: number;
  /** agent table rows that fit */
  tableRows: number;
}

const LOG_LINES: Record<PanelDensity, number> = { compact: 2, comfortable: 2, spacious: 4 };
const ROW_H = 20;

/** Which sections a panel of this tier shows. `hasPlan` gates the plan strip. */
export function panelPlan(tier: PanelTier, density: PanelDensity, w: number, h: number, hasPlan: boolean): PanelPlan {
  const large = tier === 'large';
  const wide = large && w >= WIDE_W;
  const table = large && (wide || h >= TABLE_STACKED_H);
  // the lower block takes ~42% of the body (38% stacked); in the wide layout the plan strip shares the right column with the table,
  // stacked the table sits under the feed and stays short so the feed keeps room
  const planH = wide && hasPlan ? 72 : 0;
  const room = wide ? h * 0.42 - planH : h * 0.38 * 0.45;
  const tableRows = table ? Math.max(3, Math.min(wide ? 16 : 5, Math.floor((room - 44) / ROW_H))) : 0;
  return {
    tier,
    rail: tier !== 'small',
    feed: large,
    plan: large && hasPlan,
    table,
    wide,
    logLines: large ? 0 : LOG_LINES[density],
    tableRows,
  };
}

/** "auto-compact in ~N min" text and tone: warn under 15 minutes */
export function compactForecast(minutes: number | null): { text: string; tone: 'ok' | 'warn' | 'none' } {
  if (minutes == null || !Number.isFinite(minutes)) return { text: 'forecast unknown', tone: 'none' };
  if (minutes < 1) return { text: 'auto-compact imminent', tone: 'warn' };
  const tone = minutes < 15 ? 'warn' : 'ok';
  if (minutes >= 90) return { text: `auto-compact in ~${Math.round(minutes / 60)} h`, tone };
  return { text: `auto-compact in ~${Math.round(minutes)} min`, tone };
}

/** colour of the context bar by fill */
export function ctxTone(pct: number | null): 'ok' | 'warn' | 'hot' | 'none' {
  if (pct == null) return 'none';
  return pct >= 90 ? 'hot' : pct >= 70 ? 'warn' : 'ok';
}

/** quantize a clock to a coarse step so memoized rate figures refresh every `stepMs`, not every second */
export const coarseNow = (now: number, stepMs = 15_000) => Math.floor(now / stepMs) * stepMs;
