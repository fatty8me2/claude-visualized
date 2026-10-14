import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  ARRANGEMENTS,
  DEFAULT_LAYOUT,
  LIMITS,
  arrangementOf,
  clamp,
  gridStyle,
  resizeDelta,
  sanitizeLayout,
  shuffled,
  slotOf,
  swapPanels,
  visibleAreas,
  type Arrangement,
  type Edge,
  type PanelId,
  type PanelLayout,
  type SizeKey,
  type Slot,
} from '@core/panelLayout';

const STORE = 'cvis.layout.v1';

function load(): PanelLayout {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? sanitizeLayout(JSON.parse(raw)) : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function save(l: PanelLayout) {
  try {
    localStorage.setItem(STORE, JSON.stringify(l));
  } catch {
    /* storage unavailable: layout lasts for this run */
  }
}

// ---------- FLIP animation: snapshot rects before a change, spring from there after it ----------

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
let pending: Map<string, DOMRect> | null = null;

function snapshot() {
  pending = new Map();
  document.querySelectorAll<HTMLElement>('[data-flip]').forEach((el) => pending!.set(el.dataset.flip!, el.getBoundingClientRect()));
}

function play() {
  const first = pending;
  pending = null;
  if (!first || reducedMotion()) return;
  let i = 0;
  document.querySelectorAll<HTMLElement>('[data-flip]').forEach((el) => {
    const a = first.get(el.dataset.flip!);
    const b = el.getBoundingClientRect();
    if (!a || !b.width || !b.height) {
      // newly shown: grow in
      el.animate(
        [
          { opacity: 0, transform: 'scale(0.92)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 420, easing: 'cubic-bezier(.2,1.2,.3,1)' },
      );
      return;
    }
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    const sx = a.width / b.width;
    const sy = a.height / b.height;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
    const delay = i++ * 45;
    el.animate(
      [
        {
          transformOrigin: 'top left',
          transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
          filter: 'brightness(1.25)',
          boxShadow: '0 0 0 1px var(--opus), 0 0 40px -8px var(--opus)',
        },
        {
          transformOrigin: 'top left',
          transform: 'translate(0, 0) scale(1, 1)',
          filter: 'brightness(1)',
          boxShadow: '0 0 0 1px transparent, 0 0 0 0 transparent',
        },
      ],
      { duration: 680, delay, easing: 'cubic-bezier(.18,1.28,.32,1)', fill: 'backwards' },
    );
  });
}

// ---------- state ----------

export function usePanelLayout() {
  const [layout, setRaw] = useState<PanelLayout>(load);
  const animate = useRef(false);

  /** change the layout with the spring animation */
  const change = useCallback((fn: (l: PanelLayout) => PanelLayout) => {
    snapshot();
    animate.current = true;
    setRaw((l) => {
      const next = fn(l);
      save(next);
      return next;
    });
  }, []);

  /** change without animating (live resizing) */
  const changeQuiet = useCallback((fn: (l: PanelLayout) => PanelLayout) => {
    setRaw((l) => {
      const next = fn(l);
      save(next);
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    if (!animate.current) return;
    animate.current = false;
    play();
  }, [layout]);

  return { layout, change, changeQuiet };
}

export type LayoutApi = ReturnType<typeof usePanelLayout>;

// ---------- resize handles ----------

function useDragResize(onDelta: (dx: number, dy: number) => void) {
  return (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let lx = e.clientX;
    let ly = e.clientY;
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => {
      onDelta(ev.clientX - lx, ev.clientY - ly);
      lx = ev.clientX;
      ly = ev.clientY;
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
}

function ResizeHandle({ edge, sizeKey, api }: { edge: Edge; sizeKey: SizeKey; api: LayoutApi }) {
  const onDown = useDragResize((dx, dy) => api.changeQuiet((l) => ({ ...l, [sizeKey]: clamp(l[sizeKey] + resizeDelta(edge, dx, dy), LIMITS[sizeKey]) })));
  return <div className={`rz rz-${edge}`} onPointerDown={onDown} title="Drag to resize" data-testid={`resize-${sizeKey}-${edge}`} />;
}

export function SidebarResizeHandle({ api }: { api: LayoutApi }) {
  const side = api.layout.sidebar.side;
  const edge: Edge = side === 'left' ? 'right' : 'left';
  const onDown = useDragResize((dx, dy) =>
    api.changeQuiet((l) => ({ ...l, sidebar: { ...l.sidebar, width: clamp(l.sidebar.width + resizeDelta(edge, dx, dy), LIMITS.sidebar) } })),
  );
  return <div className={`rz rz-${edge} rz-sidebar`} onPointerDown={onDown} title="Drag to resize the session list" data-testid="resize-sidebar" />;
}

// ---------- the panel grid ----------

const PANEL_LABEL: Record<PanelId, string> = { mode: 'Mode & checklist', graph: 'Agent graph', log: 'Session log' };
const PANEL_ICON: Record<PanelId, string> = { mode: '◆', graph: '⌬', log: '≡' };

export function PanelGrid({ api, editing, panels }: { api: LayoutApi; editing: boolean; panels: Record<PanelId, ReactNode> }) {
  const { layout } = api;
  const arr = arrangementOf(layout);
  const areas = new Set(visibleAreas(layout).flat());
  const [drag, setDrag] = useState<{ panel: PanelId; x: number; y: number; over: PanelId | null } | null>(null);

  const startDrag = (panel: PanelId) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    setDrag({ panel, x: e.clientX, y: e.clientY, over: null });
    const overAt = (x: number, y: number): PanelId | null => {
      const el = document.elementsFromPoint(x, y).find((n) => (n as HTMLElement).dataset?.panel && (n as HTMLElement).dataset.panel !== panel) as
        HTMLElement | undefined;
      return (el?.dataset.panel as PanelId) ?? null;
    };
    const move = (ev: PointerEvent) => setDrag({ panel, x: ev.clientX, y: ev.clientY, over: overAt(ev.clientX, ev.clientY) });
    const up = (ev: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      const over = overAt(ev.clientX, ev.clientY);
      setDrag(null);
      if (over) api.change((l) => swapPanels(l, panel, over));
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  return (
    <div className={`panel-grid ${editing ? 'editing' : ''}`} style={gridStyle(layout)} data-testid="panel-grid">
      {(['A', 'B', 'C'] as Slot[]).map((slot) => {
        const p = layout.slots[slot];
        if (!areas.has(slot)) return null;
        return (
          <div
            key={p}
            className={`lp lp-${p} ${drag?.over === p ? 'drop-target' : ''} ${drag?.panel === p ? 'dragging' : ''}`}
            style={{ gridArea: slot }}
            data-flip={`panel-${p}`}
            data-panel={p}
          >
            {panels[p]}
            {(arr.handles[slot] ?? []).map((h) => (
              <ResizeHandle key={h.edge} edge={h.edge} sizeKey={h.key} api={api} />
            ))}
            {editing && (
              <div className="lp-edit" onPointerDown={startDrag(p)} data-testid={`drag-${p}`}>
                <div className="lp-edit-card">
                  <span className="lp-icon">{PANEL_ICON[p]}</span>
                  <b>{PANEL_LABEL[p]}</b>
                  <span>drag onto another panel to swap</span>
                  {p !== 'graph' && (
                    <button onPointerDown={(e) => e.stopPropagation()} onClick={() => api.change((l) => ({ ...l, hidden: { ...l.hidden, [p]: true } }))}>
                      hide
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
      {drag && (
        <div className="drag-ghost" style={{ left: drag.x, top: drag.y }}>
          {PANEL_ICON[drag.panel]} {PANEL_LABEL[drag.panel]}
          {drag.over ? <span> ⇄ {PANEL_LABEL[drag.over]}</span> : null}
        </div>
      )}
    </div>
  );
}

// ---------- toolbar ----------

/** tiny diagram of an arrangement, with the panels currently in each slot */
function ArrangementThumb({ a, layout }: { a: Arrangement; layout: PanelLayout }) {
  const rows = a.areas.length;
  const cols = a.areas[0].length;
  const seen = new Set<string>();
  const cells: { slot: Slot; r: number; c: number; rs: number; cs: number }[] = [];
  a.areas.forEach((row, r) =>
    row.forEach((slot, c) => {
      if (seen.has(slot)) return;
      seen.add(slot);
      let rs = 1,
        cs = 1;
      while (a.areas[r + rs]?.[c] === slot) rs++;
      while (row[c + cs] === slot) cs++;
      cells.push({ slot, r, c, rs, cs });
    }),
  );
  return (
    <svg viewBox={`0 0 ${cols * 10} ${rows * 10}`} width={46} height={32} preserveAspectRatio="none" aria-hidden>
      {cells.map((x) => (
        <rect
          key={x.slot}
          className={`th th-${layout.slots[x.slot]}`}
          x={x.c * 10 + 0.8}
          y={x.r * 10 + 0.8}
          width={x.cs * 10 - 1.6}
          height={x.rs * 10 - 1.6}
          rx={1.2}
        />
      ))}
    </svg>
  );
}

export function LayoutToolbar({ api, onDone }: { api: LayoutApi; onDone: () => void }) {
  const { layout, change } = api;
  const toggle = (k: keyof PanelLayout['hidden']) => change((l) => ({ ...l, hidden: { ...l.hidden, [k]: !l.hidden[k] } }));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onDone();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone]);
  return (
    <div className="layout-bar" data-testid="layout-bar">
      <span className="lb-title">LAYOUT</span>
      <div className="lb-presets">
        {ARRANGEMENTS.map((a) => (
          <button
            key={a.id}
            className={`lb-preset ${layout.arrangement === a.id ? 'on' : ''}`}
            title={a.label}
            onClick={() => change((l) => ({ ...l, arrangement: a.id }))}
            data-testid={`preset-${a.id}`}
          >
            <ArrangementThumb a={a} layout={layout} />
            <span>{a.label}</span>
          </button>
        ))}
      </div>
      <div className="lb-group">
        <button className={layout.hidden.mode ? '' : 'on'} onClick={() => toggle('mode')}>
          ◆ mode
        </button>
        <button className={layout.hidden.log ? '' : 'on'} onClick={() => toggle('log')}>
          ≡ log
        </button>
        <button className={layout.hidden.legend ? '' : 'on'} onClick={() => toggle('legend')}>
          legend
        </button>
        <button className={layout.hidden.status ? '' : 'on'} onClick={() => toggle('status')}>
          status bar
        </button>
      </div>
      <div className="lb-group">
        <button
          onClick={() => change((l) => ({ ...l, sidebar: { ...l.sidebar, side: l.sidebar.side === 'left' ? 'right' : 'left' } }))}
          title="Move the session list to the other side"
        >
          ⇆ sessions {layout.sidebar.side === 'left' ? 'right' : 'left'}
        </button>
        <button onClick={() => change((l) => shuffled(l))} title="Surprise me">
          ✦ shuffle
        </button>
        <button className="danger" onClick={() => change(() => DEFAULT_LAYOUT)} data-testid="layout-reset" title="Back to the default layout">
          ↺ reset
        </button>
        <button className="primary" onClick={onDone}>
          done
        </button>
      </div>
    </div>
  );
}

export { slotOf };
