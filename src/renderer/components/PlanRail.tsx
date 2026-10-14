import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeStepStatus, ORIGIN_LABEL, planProgress, resolvePlan, type ParsedPlan, type PlanOrigin, type StepStatus } from '@core/plan';
import type { SessionView } from '@core/state';
import { displayStatus, famClass } from '../util';

// ---------- preferences (same pattern as layout.tsx: localStorage, never required) ----------

export interface PlanPrefs {
  open: boolean;
  side: 'left' | 'right';
  width: number;
}

const STORE = 'cvis.plan.v1';
const DEFAULT_PREFS: PlanPrefs = { open: true, side: 'left', width: 290 };
export const PLAN_WIDTH = { min: 210, max: 520 };

const clampW = (w: number) => Math.max(PLAN_WIDTH.min, Math.min(PLAN_WIDTH.max, Math.round(w)));

function loadPrefs(): PlanPrefs {
  try {
    const o = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (!o || typeof o !== 'object') return DEFAULT_PREFS;
    return {
      open: typeof o.open === 'boolean' ? o.open : DEFAULT_PREFS.open,
      side: o.side === 'right' ? 'right' : 'left',
      width: typeof o.width === 'number' ? clampW(o.width) : DEFAULT_PREFS.width,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export interface PlanPrefsApi {
  prefs: PlanPrefs;
  set: (fn: (p: PlanPrefs) => PlanPrefs, persist?: boolean) => void;
}

export function usePlanRailPrefs(): PlanPrefsApi {
  const [prefs, setPrefs] = useState<PlanPrefs>(loadPrefs);
  const set = useCallback((fn: (p: PlanPrefs) => PlanPrefs) => {
    setPrefs((p) => {
      const next = fn(p);
      try {
        localStorage.setItem(STORE, JSON.stringify(next));
      } catch {
        /* storage unavailable: lasts for this run */
      }
      return next;
    });
  }, []);
  return { prefs, set };
}

// ---------- model ----------

export interface PlanModel {
  parsed: ParsedPlan;
  origin: PlanOrigin;
  statuses: StepStatus[];
  done: number;
  active: number;
  total: number;
}

/** The plan to show for a session, with each step's status; null = nothing to show. */
export function usePlanModel(view: SessionView | null): PlanModel | null {
  return useMemo(() => {
    if (!view) return null;
    const r = resolvePlan(view.plan, view.todos);
    if (!r) return null;
    const agents = Object.values(view.agents).map((a) => ({ id: a.id, kind: a.kind, agentType: a.agentType, description: a.description, status: a.status, lastText: a.lastText, prompt: a.prompt, startedAt: a.startedAt }));
    const statuses = computeStepStatus(r.parsed.steps, view.todos, agents, { since: r.origin === 'todos' ? undefined : view.plan?.since });
    const p = planProgress(statuses);
    return { parsed: r.parsed, origin: r.origin, statuses, ...p };
  }, [view]);
}

// ---------- UI ----------

export function PlanToggle({ plan, prefs }: { plan: PlanModel; prefs: PlanPrefsApi }) {
  return (
    <button className={prefs.prefs.open ? 'on' : ''} onClick={() => prefs.set((p) => ({ ...p, open: !p.open }))} title="Show or hide the plan beside the graph" data-testid="plan-toggle">
      ▤ plan {plan.done}/{plan.total}
    </button>
  );
}

const GLYPH = { done: '✓', in_progress: '▸', pending: '○' } as const;
const STATE_LABEL = { done: 'done', in_progress: 'in progress', pending: 'pending' } as const;

function ResizeEdge({ prefs }: { prefs: PlanPrefsApi }) {
  const side = prefs.prefs.side;
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let lx = e.clientX;
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - lx;
      lx = ev.clientX;
      prefs.set((p) => ({ ...p, width: clampW(p.width + (side === 'left' ? dx : -dx)) }));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  return <div className={`rz ${side === 'left' ? 'rz-right' : 'rz-left'}`} onPointerDown={onDown} title="Drag to resize the plan" data-testid="plan-resize" />;
}

export function PlanRail({
  view,
  plan,
  prefs,
  hoverAgent,
  onHighlight,
  onSelect,
  onFilterLog,
}: {
  view: SessionView;
  plan: PlanModel;
  prefs: PlanPrefsApi;
  hoverAgent: string | null;
  onHighlight: (ids: Set<string> | undefined) => void;
  onSelect: (id: string | null) => void;
  onFilterLog: (id: string | null) => void;
}) {
  const { parsed, statuses } = plan;
  const bodyRef = useRef<HTMLDivElement>(null);
  const pct = plan.total ? Math.round((plan.done / plan.total) * 100) : 0;
  const finished = plan.total > 0 && plan.done === plan.total;

  // keep the step being worked on in view
  const activeIdx = statuses.findIndex((s) => s.status === 'in_progress');
  const focusIdx = activeIdx >= 0 ? activeIdx : Math.min(statuses.length - 1, statuses.filter((s) => s.status === 'done').length);
  const focusId = parsed.steps[focusIdx]?.id;
  useEffect(() => {
    if (!focusId) return;
    bodyRef.current?.querySelector<HTMLElement>(`[data-step="${focusId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focusId, view.id]);

  const rows: React.ReactNode[] = [];
  let lastSection = -2;
  parsed.steps.forEach((step, i) => {
    const st = statuses[i];
    const prevDone = i === 0 ? false : statuses[i - 1].status === 'done';
    if (step.section !== lastSection && step.section >= 0 && parsed.sections[step.section]) {
      rows.push(
        <div key={`sec-${step.section}`} className={`pr-station ${prevDone || i === 0 ? 'up-on' : ''}`} data-station={step.section}>
          <span className="pr-sdot" />
          <span className="pr-stitle">{parsed.sections[step.section].title}</span>
        </div>,
      );
    }
    lastSection = step.section;
    const linked = st.linkedAgents.map((id) => view.agents[id]).filter(Boolean);
    const running = linked.find((a) => a.status !== 'done' && a.status !== 'error');
    const hl = !!hoverAgent && st.linkedAgents.includes(hoverAgent);
    const lineIn = i > 0 && statuses[i - 1].status === 'done';
    const evidence = st.reasons.length ? st.reasons.join('\n') : 'no evidence yet';
    rows.push(
      <div
        key={step.id}
        className={`pr-step st-${st.status} depth-${step.depth} ${lineIn ? 'up-on' : ''} ${i === parsed.steps.length - 1 ? 'last' : ''} ${hl ? 'hl' : ''} ${linked.length ? 'linked' : ''} ${running ? famClass(running.model) : ''}`}
        data-step={step.id}
        data-status={st.status}
        data-testid="plan-step"
        onMouseEnter={() => st.linkedAgents.length && onHighlight(new Set(st.linkedAgents))}
        onMouseLeave={() => onHighlight(undefined)}
        onClick={() => st.linkedAgents[0] && onSelect(st.linkedAgents[0])}
        title={`${step.text}\n\n${STATE_LABEL[st.status]}\n${evidence}`}
      >
        <span className="pr-node" aria-label={STATE_LABEL[st.status]}>
          {GLYPH[st.status]}
        </span>
        <div className="pr-body">
          <div className="pr-title">{step.title}</div>
          {linked.length > 0 && (
            <div className="pr-chips">
              {linked.slice(0, 4).map((a) => {
                const ds = displayStatus(a, Date.now());
                return (
                  <span
                    key={a.id}
                    role="link"
                    tabIndex={0}
                    className={`pr-chip ${famClass(a.model)} ds-${ds}`}
                    data-agent-chip={a.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(a.id);
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      onFilterLog(a.id);
                    }}
                    title={`${a.description || a.agentType}\nclick: select, double-click: filter the log`}
                  >
                    {a.agentType || 'agent'} · {ds}
                  </span>
                );
              })}
              {linked.length > 4 && <span className="pr-more">+{linked.length - 4}</span>}
            </div>
          )}
        </div>
      </div>,
    );
  });

  return (
    <aside className={`plan-rail side-${prefs.prefs.side} ${finished ? 'finished' : ''}`} style={{ width: prefs.prefs.width }} data-testid="plan-rail" data-tour="plan">
      <ResizeEdge prefs={prefs} />
      <div className="pr-head">
        <div className="pr-h1">
          <b>PLAN</b>
          <span className="pr-count" data-testid="plan-count">
            {plan.done}/{plan.total} steps
          </span>
          <span className="pr-spacer" />
          <button onClick={() => prefs.set((p) => ({ ...p, side: p.side === 'left' ? 'right' : 'left' }))} title="Move the plan to the other side">
            ⇄
          </button>
          <button onClick={() => prefs.set((p) => ({ ...p, open: false }))} title="Hide the plan (the ▤ plan button brings it back)">
            ✕
          </button>
        </div>
        <div className="pr-meter" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${pct}%` }} />
          {plan.active > 0 && <i className="act" style={{ left: `${pct}%`, width: `${Math.round((plan.active / plan.total) * 100)}%` }} />}
        </div>
        <div className="pr-src" data-testid="plan-origin">
          from {ORIGIN_LABEL[plan.origin]}
          {parsed.title ? ` · ${parsed.title}` : ''}
        </div>
      </div>
      <div className="pr-body-scroll" ref={bodyRef}>
        {rows}
      </div>
    </aside>
  );
}
