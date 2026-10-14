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
  source: 'statusline' | 'transcript';
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
export function applyQuota(u: UsageView, q: { limitType: string; status: string; resetsAt: number | null; ts: number }): UsageView {
  if (q.status !== 'rejected') return u;
  const key = q.limitType === 'five_hour' ? 'fiveHour' : q.limitType === 'seven_day' ? 'sevenDay' : null;
  if (!key) return u;
  const cur = u[key];
  if (cur && cur.at >= q.ts) return u;
  return { ...u, [key]: { pct: 100, resetsAt: q.resetsAt, at: q.ts, source: 'transcript' } };
}

/** Windows whose reset time has passed restart at 0% (until the next reading). */
export function settleUsage(u: UsageView, now: number): UsageView {
  const fix = <T extends UsageWindow>(w: T | null): T | null => (w && w.resetsAt && w.resetsAt <= now ? { ...w, pct: 0, resetsAt: null, at: now } : w);
  return { ...u, fiveHour: fix(u.fiveHour), sevenDay: fix(u.sevenDay), spend: fix(u.spend) };
}
