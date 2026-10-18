// Estimated cost from token counts at Anthropic API list prices. Used only when Claude Code reported no cost for a session:
// reported cost always wins. Subscription plans are not billed per token, so this is a yardstick, not a bill.

import type { UsageNumbers } from './events';
import type { AgentNode } from './state';
import { classifyModel } from './models';

export const PRICES_AS_OF = '2026-10-06';

/** USD per million tokens */
export interface ModelPrice {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

/** list prices; cache write defaults to 1.25x input and cache read to 0.1x input unless given */
const TABLE: Record<string, { in: number; out: number; cacheRead?: number }> = {
  'fable-5.1': { in: 10, out: 50, cacheRead: 0.25 },
  'fable-5': { in: 10, out: 50, cacheRead: 1 },
  'opus-5.5': { in: 4, out: 20, cacheRead: 0.2 },
  'opus-5': { in: 5, out: 25 },
  'opus-4.8': { in: 5, out: 25 },
  'opus-4.7': { in: 5, out: 25 },
  'opus-4.6': { in: 5, out: 25 },
  'sonnet-5.5': { in: 2, out: 10, cacheRead: 0.2 },
  'sonnet-5': { in: 2, out: 10 },
  'sonnet-4.6': { in: 3, out: 15 },
  // prompts up to 100K tokens; the higher long-prompt tier is not modelled
  'haiku-5.5': { in: 0.1, out: 0.5 },
  'haiku-4.5': { in: 1, out: 5 },
};

/**
 * "claude-opus-5-5", "claude-opus-5-5-20260401", "anthropic.claude-opus-5-5-v1:0", "claude-opus-5-5@20260401" -> {opus, 5.5}.
 * Null for local and other non-Claude models.
 */
export function parseClaudeVersion(model: string | null | undefined): { family: string; version: string } | null {
  if (!model) return null;
  const c = classifyModel(model);
  if (c.provider !== 'anthropic') return null;
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?=$|[-@:.])/i.exec(model);
  if (!m) return null;
  return { family: m[1].toLowerCase(), version: m[3] ? `${m[2]}.${m[3]}` : m[2] };
}

export function priceFor(model: string | null | undefined): ModelPrice | null {
  const v = parseClaudeVersion(model);
  if (!v) return null;
  const p = TABLE[`${v.family}-${v.version}`];
  if (!p) return null;
  return { in: p.in, out: p.out, cacheRead: p.cacheRead ?? p.in * 0.1, cacheWrite: p.in * 1.25 };
}

export function estimateCostUSD(t: UsageNumbers, model: string | null | undefined): number | null {
  const p = priceFor(model);
  if (!p) return null;
  return (t.in * p.in + t.out * p.out + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) / 1_000_000;
}

const hasTokens = (t: UsageNumbers) => t.in + t.out + t.cacheRead + t.cacheWrite > 0;

export interface Estimate {
  usd: number;
  /** models that had tokens but no known price (left out of usd) */
  unpriced: string[];
}

/**
 * A session's estimate: every agent's tokens at that agent's model. AgentNode.tokens is a lifetime sum while AgentNode.model is the
 * latest model, so an agent that switched models mid-session is priced entirely at its current model.
 */
export function estimateAgents(agents: Record<string, AgentNode>): Estimate {
  let usd = 0;
  const unpriced = new Set<string>();
  for (const a of Object.values(agents)) {
    if (!hasTokens(a.tokens)) continue;
    const c = estimateCostUSD(a.tokens, a.model);
    if (c === null) {
      // local models cost nothing at Anthropic: they are not "missing" from the estimate
      if (a.model && classifyModel(a.model).provider !== 'local') unpriced.add(a.model);
    } else usd += c;
  }
  return { usd, unpriced: [...unpriced] };
}

/** History's per-model usage rows (exact per model, so no switching approximation). */
export function estimateRows(rows: { model: string; in: number; out: number; cacheRead: number; cacheWrite: number }[]): Estimate {
  let usd = 0;
  const unpriced = new Set<string>();
  for (const r of rows) {
    const t = { in: r.in, out: r.out, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite };
    if (!r.model || !hasTokens(t)) continue;
    const c = estimateCostUSD(t, r.model);
    if (c === null) {
      if (classifyModel(r.model).provider !== 'local') unpriced.add(r.model);
    } else usd += c;
  }
  return { usd, unpriced: [...unpriced] };
}

export function estimateTooltip(e?: Estimate | null): string {
  const lines = [
    `Estimate at Anthropic API list prices (as of ${PRICES_AS_OF}), from the token counts.`,
    'Subscription plans are not billed per token, so this is not what you pay.',
    'Cost reported by Claude Code is shown instead whenever it exists.',
  ];
  if (e?.unpriced.length) lines.push(`Not included (no list price known): ${e.unpriced.join(', ')}`);
  return lines.join('\n');
}

export function formatUSD(usd: number): string {
  if (usd >= 1000) return `$${Math.round(usd).toLocaleString('en-US')}`;
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  return `$${usd.toFixed(2)}`;
}
