// Attention inbox: everything across all sessions that needs the user, derived from session views.
// Pure: (previous items, session views, usage, now, dismissed ids) -> items. The main process keeps the result and pushes it to renderers.

import { MAIN, type AgentNode, type LogEntry, type SessionView } from './state';
import type { UsageView } from './usage';

export type InboxKind = 'permission' | 'input' | 'reply' | 'agent-failed' | 'tool-errors' | 'usage' | 'api-error' | 'notice';
export type InboxSeverity = 'critical' | 'warn' | 'info';

export interface InboxItem {
  /** stable: derived from the session, the kind and when the thing first happened */
  id: string;
  /** null for account-wide items (usage limits) */
  sessionId: string | null;
  sessionTitle: string;
  kind: InboxKind;
  severity: InboxSeverity;
  title: string;
  detail: string;
  firstSeen: number;
  lastSeen: number;
  /** how many events were folded into this item (failed calls, failed agents ...) */
  count: number;
  /** the agent the item is about (null = the session itself) */
  agentId: string | null;
  agentName: string | null;
  resolved: boolean;
  resolvedAt: number | null;
}

export interface InboxSnapshot {
  items: InboxItem[];
  /** unresolved items (not dismissed): the number shown on badges */
  count: number;
}

export const SEVERITY_RANK: Record<InboxSeverity, number> = { critical: 0, warn: 1, info: 2 };
/** usage windows at or above this percentage raise an item */
export const USAGE_WARN_PCT = 90;
/** failed tool calls within one burst needed before they become an item */
export const TOOL_ERROR_MIN = 3;
/** errors closer together than this belong to one burst */
export const BURST_GAP_MS = 10 * 60_000;
/** older events never create items (they are history, not news) */
export const MAX_AGE_MS = 24 * 3_600_000;
/** resolved items disappear after this */
export const RESOLVED_KEEP_MS = 6 * 3_600_000;
/** unresolved items of sessions we no longer watch go stale after this */
export const STALE_MS = 24 * 3_600_000;
const MAX_ITEMS = 200;

const PLURAL = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function agentLabel(a: AgentNode | undefined): string | null {
  if (!a) return null;
  if (a.kind === 'main') return 'main';
  return a.description ? `${a.agentType || 'agent'}: ${a.description}`.slice(0, 80) : a.agentType || 'agent';
}

function sessionTitle(v: SessionView): string {
  if (v.title) return v.title;
  if (v.cwd) return v.cwd.split(/[\\/]/).filter(Boolean).pop() ?? v.cwd;
  return v.id.slice(0, 8);
}

type Candidate = Omit<InboxItem, 'firstSeen' | 'lastSeen' | 'resolved' | 'resolvedAt'> & { firstSeen: number; lastSeen: number; open: boolean };

/** Bursts of timestamps (sorted ascending) separated by more than BURST_GAP_MS. */
function bursts<T extends { ts: number }>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (const x of xs) {
    const last = out[out.length - 1];
    if (last && x.ts - last[last.length - 1].ts <= BURST_GAP_MS) last.push(x);
    else out.push([x]);
  }
  return out;
}

function sessionCandidates(v: SessionView, now: number): Candidate[] {
  const out: Candidate[] = [];
  const title = sessionTitle(v);
  const log = [...v.log].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  const lastPrompt = log.reduce((t, l) => (l.kind === 'prompt' && l.agentId === MAIN && l.ts > t ? l.ts : t), 0);
  const main = v.agents[MAIN];
  const recent = (ts: number) => now - ts <= MAX_AGE_MS;
  const base = { sessionId: v.id, sessionTitle: title, count: 1 };

  // 1. permission prompts and "needs your input": only the newest per agent can still be open
  const attn = log.filter((l) => l.kind === 'attention' && (l.attn === 'permission' || l.attn === 'notification'));
  const newestByAgent = new Map<string, LogEntry>();
  for (const l of attn) newestByAgent.set(l.agentId, l);
  for (const l of attn) {
    if (!recent(l.ts)) continue;
    const a = v.agents[l.agentId];
    const isNewest = newestByAgent.get(l.agentId) === l;
    const open = isNewest && !v.ended && a?.status === 'waiting' && l.ts >= lastPrompt;
    const permission = l.attn === 'permission';
    out.push({
      ...base,
      id: `${v.id}:${permission ? 'permission' : 'input'}:${l.agentId}:${l.ts}`,
      kind: permission ? 'permission' : 'input',
      severity: 'critical',
      title: permission ? 'Permission needed' : 'Claude needs your input',
      detail: l.text,
      firstSeen: l.ts,
      lastSeen: l.ts,
      agentId: l.agentId,
      agentName: agentLabel(a),
      open,
    });
  }
  // a waiting main agent we have no attention line for (e.g. the log rolled over)
  if (main?.status === 'waiting' && !v.ended && !attn.some((l) => l.agentId === MAIN) && main.endedAt && recent(main.endedAt)) {
    out.push({
      ...base,
      id: `${v.id}:input:${MAIN}:${main.endedAt}`,
      kind: 'input',
      severity: 'critical',
      title: 'Claude is waiting for you',
      detail: main.lastText ?? 'The main agent is waiting for an answer.',
      firstSeen: main.endedAt,
      lastSeen: main.endedAt,
      agentId: MAIN,
      agentName: 'main',
      open: main.endedAt >= lastPrompt,
    });
  }

  // 2. a finished turn awaiting a reply
  const busy = Object.values(v.agents).some((a) => a.id !== MAIN && a.status === 'running');
  if (main && main.status === 'idle' && main.endedAt && !v.ended && main.lastTextAt > 0 && recent(main.endedAt)) {
    const open = main.endedAt >= lastPrompt && !busy;
    out.push({
      ...base,
      id: `${v.id}:reply:${main.endedAt}`,
      kind: 'reply',
      severity: 'info',
      title: 'Finished, waiting for your reply',
      detail: main.lastText ?? 'The turn is complete.',
      firstSeen: main.endedAt,
      lastSeen: main.endedAt,
      agentId: MAIN,
      agentName: 'main',
      open,
    });
  }

  // 3. failed agents, grouped per burst
  const failed = Object.values(v.agents)
    .filter((a) => a.kind !== 'main' && a.status === 'error' && a.endedAt && recent(a.endedAt))
    .map((a) => ({ ts: a.endedAt as number, a }))
    .sort((x, y) => x.ts - y.ts);
  for (const b of bursts(failed)) {
    const first = b[0].ts;
    const last = b[b.length - 1].ts;
    out.push({
      ...base,
      id: `${v.id}:agent-failed:${first}`,
      kind: 'agent-failed',
      severity: 'warn',
      title: b.length === 1 ? 'An agent failed' : `${b.length} agents failed`,
      detail: b
        .slice(-3)
        .map((x) => agentLabel(x.a))
        .join(' | '),
      firstSeen: first,
      lastSeen: last,
      count: b.length,
      agentId: b[b.length - 1].a.id,
      agentName: agentLabel(b[b.length - 1].a),
      open: last >= lastPrompt,
    });
  }

  // 4. bursts of failed tool calls
  const toolErrors = log.filter((l) => l.kind === 'tool-error' && recent(l.ts));
  for (const b of bursts(toolErrors)) {
    if (b.length < TOOL_ERROR_MIN) continue;
    const last = b[b.length - 1];
    const names = new Set(b.map((l) => l.text.split(/[ :]/)[0]).filter(Boolean));
    out.push({
      ...base,
      id: `${v.id}:tool-errors:${b[0].ts}`,
      kind: 'tool-errors',
      severity: 'warn',
      title: `${PLURAL(b.length, 'tool call')} failed`,
      detail: [...names].slice(0, 4).join(', ') + (last.text ? ` - last: ${last.text}` : ''),
      firstSeen: b[0].ts,
      lastSeen: last.ts,
      count: b.length,
      agentId: last.agentId,
      agentName: agentLabel(v.agents[last.agentId]),
      open: last.ts >= lastPrompt,
    });
  }

  // 5. API errors: open while nothing has happened since and the agent is not working
  const apiErrors = log.filter((l) => l.kind === 'attention' && l.attn === 'error' && recent(l.ts));
  for (const b of bursts(apiErrors)) {
    const last = b[b.length - 1];
    const progressed = log.some((l) => l.ts > last.ts && l.kind !== 'attention' && l.kind !== 'notice' && l.kind !== 'tool-error');
    out.push({
      ...base,
      id: `${v.id}:api-error:${b[0].ts}`,
      kind: 'api-error',
      severity: 'warn',
      title: v.ended ? 'Session ended with an API error' : b.length > 1 ? `${b.length} API errors` : 'API error',
      detail: last.text,
      firstSeen: b[0].ts,
      lastSeen: last.ts,
      count: b.length,
      agentId: last.agentId,
      agentName: agentLabel(v.agents[last.agentId]),
      open: !progressed && main?.status !== 'running',
    });
  }

  // 6. a usage limit this session ran into
  const q = v.quota;
  if (q && q.status === 'rejected' && q.resetsAt && q.resetsAt > now) {
    out.push(usageCandidate(q.limitType, 100, q.resetsAt, q.ts, 'critical', true));
  }
  return out;
}

const LIMIT_NAME: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly' };

function usageCandidate(limitType: string, pct: number, resetsAt: number | null, at: number, severity: InboxSeverity, rejected: boolean): Candidate {
  const name = LIMIT_NAME[limitType] ?? limitType.replace(/_/g, '-');
  return {
    id: `usage:${limitType}:${resetsAt ? Math.round(resetsAt / 60_000) : 'open'}`,
    sessionId: null,
    sessionTitle: 'Usage limits',
    kind: 'usage',
    severity,
    title: rejected ? `${name} usage limit reached` : `${name} usage at ${Math.round(pct)}%`,
    detail: resetsAt ? `Resets ${new Date(resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.` : 'Reset time unknown.',
    firstSeen: at,
    lastSeen: at,
    count: 1,
    agentId: null,
    agentName: null,
    open: true,
  };
}

function usageCandidates(u: UsageView | null, now: number): Candidate[] {
  if (!u) return [];
  const out: Candidate[] = [];
  for (const [type, w] of [
    ['five_hour', u.fiveHour],
    ['seven_day', u.sevenDay],
  ] as const) {
    if (!w || w.pct < USAGE_WARN_PCT) continue;
    if (w.resetsAt && w.resetsAt <= now) continue;
    const full = w.pct >= 100;
    out.push(usageCandidate(type, w.pct, w.resetsAt, w.at, full ? 'critical' : 'warn', full));
  }
  return out;
}

/**
 * Derive the inbox.
 * - Items are keyed by id; an item that was resolved stays resolved. One that is no longer derivable from a watched session is resolved.
 * - New items that are already resolved when first seen (history in a transcript backlog) are not added.
 * - `views` only has the sessions being watched; items of other sessions are kept as they were (and go stale after STALE_MS).
 * - Dismissed ids never come back.
 */
export function deriveInbox(
  prev: readonly InboxItem[],
  views: readonly SessionView[],
  usage: UsageView | null,
  now: number,
  dismissed: ReadonlySet<string> = new Set(),
): InboxItem[] {
  const cands = new Map<string, Candidate>();
  const watched = new Set<string>();
  for (const v of views) {
    watched.add(v.id);
    for (const c of sessionCandidates(v, now)) cands.set(c.id, c);
  }
  for (const c of usageCandidates(usage, now)) if (!cands.has(c.id)) cands.set(c.id, c);

  const prevById = new Map(prev.map((p) => [p.id, p]));
  const out: InboxItem[] = [];
  for (const c of cands.values()) {
    if (dismissed.has(c.id)) continue;
    const old = prevById.get(c.id);
    const { open, ...rest } = c;
    if (!old) {
      if (!open) continue;
      out.push({ ...rest, resolved: false, resolvedAt: null });
      continue;
    }
    const resolved = old.resolved || !open;
    out.push({
      ...rest,
      firstSeen: Math.min(old.firstSeen, c.firstSeen),
      count: Math.max(old.count, c.count),
      resolved,
      resolvedAt: resolved ? (old.resolvedAt ?? now) : null,
    });
  }
  for (const old of prev) {
    if (cands.has(old.id) || dismissed.has(old.id)) continue;
    const live = old.sessionId === null || watched.has(old.sessionId);
    if (old.resolved) {
      if (now - (old.resolvedAt ?? old.lastSeen) < RESOLVED_KEEP_MS) out.push(old);
    } else if (old.kind === 'notice') {
      // notices come from OS notifications, not derivation: they stay until dismissed (or stale)
      if (now - old.lastSeen < STALE_MS) out.push(old);
      else out.push({ ...old, resolved: true, resolvedAt: now });
    } else if (live || now - old.lastSeen > STALE_MS) {
      // the thing that raised it no longer holds (usage dropped, window reset, agent resumed ...)
      out.push({ ...old, resolved: true, resolvedAt: now });
    } else out.push(old);
  }
  // expire resolved items derived this round too
  const kept = out.filter((i) => !i.resolved || now - (i.resolvedAt ?? now) < RESOLVED_KEEP_MS);
  kept.sort(compareItems);
  return kept.slice(0, MAX_ITEMS);
}

/** An OS notification that is not an attention line (e.g. "agent finished") becomes a notice item. */
export function noticeItem(n: { sessionId: string; sessionTitle: string; title: string; body: string }, now: number): InboxItem {
  return {
    id: `${n.sessionId}:notice:${now}`,
    sessionId: n.sessionId,
    sessionTitle: n.sessionTitle,
    kind: 'notice',
    severity: 'info',
    title: n.title,
    detail: n.body,
    firstSeen: now,
    lastSeen: now,
    count: 1,
    agentId: null,
    agentName: null,
    resolved: false,
    resolvedAt: null,
  };
}

/** Open items first, then by severity, then newest first. */
export function compareItems(a: InboxItem, b: InboxItem): number {
  return Number(a.resolved) - Number(b.resolved) || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.lastSeen - a.lastSeen;
}

export function snapshotOf(items: readonly InboxItem[]): InboxSnapshot {
  return { items: [...items], count: items.filter((i) => !i.resolved).length };
}

/** Group for display: sessions with open items first (their worst severity, then newest), account-wide items first of all. */
export interface InboxGroup {
  sessionId: string | null;
  title: string;
  items: InboxItem[];
}

export function groupBySession(items: readonly InboxItem[]): InboxGroup[] {
  const groups = new Map<string, InboxGroup>();
  for (const i of [...items].sort(compareItems)) {
    const key = i.sessionId ?? '';
    const g = groups.get(key) ?? { sessionId: i.sessionId, title: i.sessionTitle, items: [] };
    g.items.push(i);
    groups.set(key, g);
  }
  return [...groups.values()];
}
