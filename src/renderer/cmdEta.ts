// Renderer side of the running-command countdown (src/core/cmdEta.ts): the past command durations (asked from the main
// process like the agent priors in eta.ts), one agent's running command estimate, and how it is written.
import { useEffect, useSyncExternalStore } from 'react';
import { cmdEta, cwdProject, NO_CMD_PRIORS, type CmdEta, type CmdPriors } from '@core/cmdEta';
import type { AgentNode } from '@core/state';
import { fmtClock, fmtLeft, fmtSpan } from './eta';

const REFRESH_MS = 10 * 60_000;
const RETRY_MS = 60_000;

let priors: CmdPriors = NO_CMD_PRIORS;
let fetchedAt = 0;
let inFlight = false;
const subs = new Set<() => void>();

function load() {
  if (inFlight || typeof window === 'undefined' || !window.api?.cmdPriors) return;
  inFlight = true;
  window.api
    .cmdPriors()
    .then((p) => {
      if (p && typeof p === 'object' && p.all) priors = p;
    })
    .catch(() => {})
    .finally(() => {
      inFlight = false;
      fetchedAt = Date.now();
      subs.forEach((cb) => cb());
    });
}

function subscribe(cb: () => void) {
  subs.add(cb);
  return () => subs.delete(cb);
}

/** Past shell-command durations. Empty until the first answer (and on a machine with no history yet). */
export function useCmdPriors(): CmdPriors {
  useEffect(() => {
    if (!fetchedAt) load();
    const t = setInterval(() => {
      if (Date.now() - fetchedAt > (Object.keys(priors.all).length ? REFRESH_MS : RETRY_MS)) load();
    }, 30_000);
    return () => clearInterval(t);
  }, []);
  return useSyncExternalStore(subscribe, () => priors);
}

/** The estimate for the shell command an agent is running, or null (no command, a quick one, nothing like it in the history). */
export function agentCmdEta(a: AgentNode, now: number, p: CmdPriors, project: string | null): CmdEta | null {
  const t = a.currentTool;
  if (!t || a.status === 'done' || a.status === 'error') return null;
  return cmdEta({ name: t.name, input: t.input, since: t.since, project }, now, p);
}

/** The project the priors are grouped by, from a session's working folder. */
export const sessionProject = (cwd: string | null | undefined): string | null => cwdProject(cwd) || null;

/** "3–5 min", "about 4 min", "40 s – 2 min" */
export function cmdTypical(e: CmdEta): string {
  const [a, b] = e.typical;
  if (b < 90_000) return `${fmtSpan(a)} – ${fmtSpan(b)}`;
  const lo = Math.max(1, Math.round(a / 60_000));
  const hi = Math.max(lo, Math.round(b / 60_000));
  return lo === hi ? `about ${lo} min` : `${lo}–${hi} min`;
}

/** "based on 14 past runs of npm run test:e2e in this project, typically 3–5 min" */
export function cmdBasis(e: CmdEta): string {
  return `based on ${e.runs} past runs of ${e.key}${e.scope === 'project' ? ' in this project' : ' across your projects'}, typically ${cmdTypical(e)}`;
}

/** Time left in a few characters: "~3 min", "<1 min", "40 s". Under a minute a countdown in seconds (rounded to 5). */
export function cmdLeft(ms: number): string {
  if (ms >= 60_000) return fmtLeft(ms);
  return `${Math.max(5, Math.round(ms / 5000) * 5)} s`;
}

/** What a card's countdown strip shows: primitives only, so a card re-renders only when one of them changes. */
export interface CmdStripModel {
  label: string;
  /** 0..1, rounded to 2% */
  fraction: number;
  /** "~2 min left", "running long" */
  left: string;
  /** "4:12 PM" (expected end) or "4 min in" when running long */
  when: string;
  overdue: boolean;
  title: string;
}

export function cmdStripModel(e: CmdEta | null): CmdStripModel | null {
  if (!e) return null;
  const limit = e.timeoutAt ? ` It stops (or moves to the background) at its timeout, ${fmtClock(e.timeoutAt)}.` : '';
  return {
    label: e.key,
    fraction: Math.round(e.fraction * 50) / 50,
    left: e.overdue ? 'running long' : `${cmdLeft(e.remaining)} left`,
    when: e.overdue ? `${fmtSpan(e.elapsed)} in` : fmtClock(e.at),
    overdue: e.overdue,
    title: e.overdue
      ? `${e.key}: running longer than nearly every past run (${fmtSpan(e.elapsed)} so far); the end is a guess. ${cmdBasis(e)}.${limit}`
      : `${e.key}: est. done ${fmtClock(e.at)}, likely ${fmtClock(e.low)} – ${fmtClock(e.high)}. ${cmdBasis(e)}.${limit}`,
  };
}

export const cmdStripKey = (m: CmdStripModel | null) => (m ? `${m.label}|${m.fraction}|${m.left}|${m.when}|${m.overdue}` : '');
