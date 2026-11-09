// Renderer side of the time estimates (src/core/eta.ts): the history priors (asked from the main process, refreshed every
// 10 minutes, every minute while the index has nothing yet), one hook that works out a session's estimates for a clock
// tick (shared by the progress strip, the cards and the drawer), and how estimated times are written.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { agentEta, agentEtas, NO_PRIORS, promptEta, type AgentEta, type EtaAgentInput, type EtaPriors, type EtaStep, type PromptEta } from '@core/eta';
import type { SessionView } from '@core/state';
import type { StepState } from '@core/plan';

const REFRESH_MS = 10 * 60_000;
const RETRY_MS = 60_000;

let priors: EtaPriors = NO_PRIORS;
let fetchedAt = 0;
let inFlight = false;
const subs = new Set<() => void>();

function load() {
  if (inFlight || typeof window === 'undefined' || !window.api?.etaPriors) return;
  inFlight = true;
  window.api
    .etaPriors()
    .then((p) => {
      if (p && typeof p === 'object' && p.agents) priors = p;
    })
    .catch(() => {})
    .finally(() => {
      inFlight = false;
      fetchedAt = Date.now();
      subs.forEach((cb) => cb());
    });
}

const empty = (p: EtaPriors) => !Object.keys(p.agents).length && !p.turns.length;

function subscribe(cb: () => void) {
  subs.add(cb);
  return () => subs.delete(cb);
}

/** The history the estimates compare with. Empty until the first answer (and on a machine with no history yet). */
export function useEtaPriors(): EtaPriors {
  useEffect(() => {
    if (!fetchedAt) load();
    const t = setInterval(() => {
      if (Date.now() - fetchedAt > (empty(priors) ? RETRY_MS : REFRESH_MS)) load();
    }, 30_000);
    return () => clearInterval(t);
  }, []);
  return useSyncExternalStore(subscribe, () => priors);
}

/** Test hook: set the priors directly (unit tests of components). */
export function setEtaPriorsForTest(p: EtaPriors) {
  priors = p;
  fetchedAt = Date.now();
  subs.forEach((cb) => cb());
}

/** The plan rail's model, as far as the estimates need it (src/renderer/components/PlanRail.tsx usePlanModel). */
export interface EtaPlanInput {
  origin: string;
  parsed: { steps: { text: string }[] };
  statuses: { status: StepState }[];
}

export interface SessionEta {
  prompt: PromptEta | null;
  /** running subagents with an estimate */
  agents: Map<string, AgentEta>;
}

const NONE: SessionEta = { prompt: null, agents: new Map() };

/** A session's estimates at `now`. `plan`: the plan model, used when the session has plan text (the todo list is read from the view). */
export function sessionEta(view: SessionView | null, now: number, priors: EtaPriors, plan?: EtaPlanInput | null, project?: string | null): SessionEta {
  if (!view) return NONE;
  const agents = agentEtas(view.agents as Record<string, EtaAgentInput>, now, priors);
  const planSteps: EtaStep[] | null =
    plan && plan.origin !== 'todos' ? plan.parsed.steps.map((s, i) => ({ text: s.text, status: plan.statuses[i]?.status ?? 'pending' })) : null;
  const prompt = promptEta(
    {
      agents: view.agents,
      todos: view.todos,
      turnStartedAt: view.turnStartedAt ?? null,
      ship: view.ship ?? [],
      startedAt: view.startedAt,
      ended: view.ended,
      planSince: view.plan?.since ?? null,
      planSteps,
      project: project ?? null,
      etas: agents,
    },
    now,
    priors,
  );
  return { prompt, agents };
}

/** sessionEta for a component; recomputed when the view, the clock or the priors change. */
export function useSessionEta(view: SessionView | null, now: number, plan?: EtaPlanInput | null, project?: string | null): SessionEta {
  const p = useEtaPriors();
  return useMemo(() => sessionEta(view, now, p, plan, project), [view, now, p, plan, project]);
}

/** One agent's estimate (for places that show a single agent, like the details drawer). */
export function useAgentEta(agent: EtaAgentInput | null | undefined, now: number): AgentEta | null {
  const p = useEtaPriors();
  return agent ? agentEta(agent, now, p) : null;
}

// ---------- words ----------

/** Time left, rounded so the text changes about once a minute: "<1 min", "~4 min", "~1 h 05 min". */
export function fmtLeft(ms: number): string {
  if (!(ms > 0)) return '<1 min';
  if (ms < 60_000) return '<1 min';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `~${m} min`;
  const h = Math.floor(m / 60);
  const mm = Math.round((m % 60) / 5) * 5;
  return mm === 60 ? `~${h + 1} h` : mm ? `~${h} h ${String(mm).padStart(2, '0')} min` : `~${h} h`;
}

/** A plain duration: "45 s", "4 min", "1 h 05 min". */
export function fmtSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

const clockFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** Wall-clock time without seconds, in the user's locale ("3:42 PM", "15:42"). */
export function fmtClock(ts: number): string {
  return clockFmt.format(new Date(ts));
}

/** "Explore · opus agents took 2–8 min (41 runs)": what an agent estimate is based on. */
export function agentBasis(e: AgentEta): string {
  const lo = Math.max(1, Math.round(e.typical[0] / 60_000));
  const hi = Math.max(lo, Math.round(e.typical[1] / 60_000));
  const span = lo === hi ? `about ${lo} min` : `${lo}–${hi} min`;
  return `${e.runs} similar runs (${e.group}) mostly took ${span}`;
}

/** The short label for a running agent: "~3 min left", "running long", "waiting". */
export function agentLeftLabel(e: AgentEta | null): string {
  if (!e) return '';
  if (e.paused) return 'waiting';
  if (e.overdue) return 'running long';
  return `${fmtLeft(e.remaining)} left`;
}
