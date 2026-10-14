// 5-hour / weekly usage limits. Two sources:
//  - Claude Code's status-line JSON (rate_limits.five_hour / seven_day: used_percentage + resets_at epoch s),
//    forwarded by our status-line script. This is the only source with live percentages.
//  - transcript quotaLimits records, written when a limit is hit (status "rejected"), with the reset time.

type Json = Record<string, any>;

export interface UsageWindow {
  pct: number;
  /** epoch ms */
  resetsAt: number | null;
  /** epoch ms of the reading */
  at: number;
  source: 'statusline' | 'transcript' | 'api';
}

export interface SpendWindow extends UsageWindow {
  usedUsd: number | null;
  limitUsd: number | null;
  period: string | null;
}

export interface UsageView {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  spend: SpendWindow | null;
  /** last status-line reading, null if the status line has never reported */
  statuslineAt: number | null;
  /** per-model weekly windows from the usage API (e.g. "Opus", "Sonnet") */
  models?: { label: string; window: UsageWindow }[];
  /** state of the usage API poller */
  api?: { state: 'ok' | 'no-login' | 'expired' | 'error'; message: string; at: number };
}

export const emptyUsage = (): UsageView => ({ fiveHour: null, sevenDay: null, spend: null, statuslineAt: null });

function win(w: Json | undefined, at: number): UsageWindow | null {
  if (!w || typeof w.used_percentage !== 'number') return null;
  return { pct: Math.max(0, Math.min(100, w.used_percentage)), resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : null, at, source: 'statusline' };
}

/** Merge a status-line payload. Payloads without rate_limits (API-key users, before the first response) change nothing. */
export function applyStatusline(u: UsageView, payload: Json, now: number): UsageView {
  const rl = payload?.rate_limits as Json | undefined;
  if (!rl || typeof rl !== 'object') return u;
  const next: UsageView = { ...u, statuslineAt: now };
  const f = win(rl.five_hour, now);
  const s = win(rl.seven_day, now);
  if (f) next.fiveHour = f;
  if (s) next.sevenDay = s;
  const sp = rl.spend_limit as Json | undefined;
  const spw = win(sp, now);
  if (spw) {
    next.spend = {
      ...spw,
      usedUsd: typeof sp!.used_usd === 'number' ? sp!.used_usd : null,
      limitUsd: typeof sp!.limit_usd === 'number' ? sp!.limit_usd : null,
      period: typeof sp!.period === 'string' ? sp!.period : null,
    };
  }
  return next;
}

/** A transcript record of a limit being hit pins that window at 100% until it resets. */
export function applyQuota(u: UsageView, q: { limitType: string; status: string; resetsAt: number | null; ts: number }, now: number): UsageView {
  // a limit that has since reset says nothing about now
  if (q.status !== 'rejected' || !q.resetsAt || q.resetsAt <= now) return u;
  const key = q.limitType === 'five_hour' ? 'fiveHour' : q.limitType === 'seven_day' ? 'sevenDay' : null;
  if (!key) return u;
  const cur = u[key];
  if (cur && cur.at >= q.ts) return u;
  return { ...u, [key]: { pct: 100, resetsAt: q.resetsAt, at: q.ts, source: 'transcript' } };
}

/**
 * After a window's reset time: a status-line window restarts at 0% until the next reading; a
 * transcript-only reading (limit hit) is dropped, since nothing is known about the new window.
 */
export function settleUsage(u: UsageView, now: number): UsageView {
  const fix = <T extends UsageWindow>(w: T | null): T | null => {
    if (!w) return w;
    if (w.source === 'transcript' && (!w.resetsAt || w.resetsAt <= now)) return null;
    return w.resetsAt && w.resetsAt <= now ? { ...w, pct: 0, resetsAt: null, at: now } : w;
  };
  return { ...u, fiveHour: fix(u.fiveHour), sevenDay: fix(u.sevenDay), spend: fix(u.spend) };
}

/** "2026-10-14T18:00:00Z" | epoch s | epoch ms -> epoch ms */
function toMs(v: unknown): number | null {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function apiWin(w: Json | undefined, now: number): UsageWindow | null {
  if (!w || typeof w !== 'object') return null;
  const raw = typeof w.utilization === 'number' ? w.utilization : typeof w.used_percentage === 'number' ? w.used_percentage : null;
  if (raw === null) return null;
  return { pct: Math.max(0, Math.min(100, raw)), resetsAt: toMs(w.resets_at), at: now, source: 'api' };
}

/** Merge a response from Anthropic's OAuth usage endpoint (what Claude Code's /usage shows). */
export function applyUsageApi(u: UsageView, body: Json, now: number): UsageView {
  const next: UsageView = { ...u, api: { state: 'ok', message: 'usage API', at: now } };
  const f = apiWin(body?.five_hour, now);
  const s = apiWin(body?.seven_day, now);
  // the API is authoritative when it answers: an absent window means no limit applies right now
  next.fiveHour = f;
  next.sevenDay = s;
  const models: { label: string; window: UsageWindow }[] = [];
  for (const [k, v] of Object.entries(body ?? {})) {
    const m = /^seven_day_(\w+)$/.exec(k);
    const w = m ? apiWin(v as Json, now) : null;
    if (m && w) models.push({ label: m[1][0].toUpperCase() + m[1].slice(1), window: w });
  }
  next.models = models;
  return next;
}
