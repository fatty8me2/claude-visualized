// The usage "ping": a one-token Messages API request whose reply carries Anthropic's unified rate-limit headers (the real 5-hour / weekly
// utilization). Pure helpers; the network call is src/main/usagePing.ts. Haiku only, by owner decision: the request never names another model.

/** Cheapest first. Only Haiku ids ever: if none of them exists the ping is unavailable and the old usage-API behaviour takes over. */
export const PING_MODELS = ['claude-haiku-5-5', 'claude-haiku-5-5-latest', 'claude-haiku-5-latest', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001'] as const;

export const DEFAULT_PING_MINUTES = 10;
export const MIN_PING_MINUTES = 5;

export function pingBody(model: string): string {
  if (!/haiku/i.test(model)) throw new Error('the usage ping only ever uses a Haiku model');
  return JSON.stringify({
    model,
    max_tokens: 1,
    system: "You are Claude Code, Anthropic's official CLI for Claude.",
    messages: [{ role: 'user', content: 'quota' }],
  });
}

/** The unified headers (lower-case names) from any header source; nothing else is kept. */
export function unifiedHeaders(get: (name: string) => string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['5h', '7d']) {
    for (const f of ['utilization', 'reset', 'status']) {
      const n = `anthropic-ratelimit-unified-${k}-${f}`;
      const v = get(n);
      if (typeof v === 'string') out[n] = v;
    }
  }
  return out;
}

/** After a rejected 429: wait for the reset, but look again within 5 minutes and no sooner than 30 s. */
export function rejectedWaitMs(h: Record<string, string>, now: number): number {
  const resets = ['5h', '7d']
    .filter((k) => (h[`anthropic-ratelimit-unified-${k}-status`] ?? '').toLowerCase() === 'rejected')
    .map((k) => Number(h[`anthropic-ratelimit-unified-${k}-reset`]) * 1000)
    .filter((t) => Number.isFinite(t) && t > now);
  const until = resets.length ? Math.min(...resets) - now : 300_000;
  return Math.max(30_000, Math.min(300_000, until));
}
