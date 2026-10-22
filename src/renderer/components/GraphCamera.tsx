import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { centerOn, chipBounds, edgeChip, spreadChips, mapToScroll, minimapSize, needsMap, pickOffscreen, type Box } from '@core/graphCamera';
import type { Layout } from '@core/layout';
import type { AgentNode } from '@core/state';
import { MAIN } from '@core/state';
import type { EdgeMeta } from './GraphEdges';
import { agentName, famClass } from '../util';
import type { CameraAnimator } from '../graphCamera';

const FAM_VAR: Record<string, string> = { opus: '--opus', sonnet: '--sonnet', haiku: '--haiku', fable: '--fable' };

function famColor(css: CSSStyleDeclaration, fam: string): string {
  return css.getPropertyValue(FAM_VAR[fam] ?? '--muted').trim() || '#8a8f9c';
}

interface Geo {
  /** the canvas's position inside the scrolling content, and its size */
  ox: number;
  oy: number;
  cw: number;
  ch: number;
  left: number;
  top: number;
  vw: number;
  vh: number;
  sw: number;
  sh: number;
}

function geo(wrap: HTMLElement, canvas: HTMLElement): Geo {
  return {
    ox: canvas.offsetLeft,
    oy: canvas.offsetTop,
    cw: canvas.offsetWidth,
    ch: canvas.offsetHeight,
    left: wrap.scrollLeft,
    top: wrap.scrollTop,
    vw: wrap.clientWidth,
    vh: wrap.clientHeight,
    sw: wrap.scrollWidth,
    sh: wrap.scrollHeight,
  };
}

/**
 * The graph's navigation layer, a zero-height sticky overlay in the scrolling panel: a glass minimap (cards as model-coloured dots
 * and the viewport as a rectangle; click or drag to move) and edge chips that point at running agents that are out of view.
 * Everything that follows the scroll is written straight to the DOM from one rAF-coalesced tick; React only hears about which
 * chips exist.
 */
export function GraphCamera({
  wrapRef,
  canvasRef,
  cam,
  layout,
  scale,
  pad,
  agents,
  meta,
  selected,
  obscuredRight,
  onGo,
}: {
  wrapRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLDivElement | null>;
  cam: CameraAnimator;
  layout: Layout;
  scale: number;
  pad: number;
  agents: Record<string, AgentNode>;
  meta: ReadonlyMap<string, EdgeMeta>;
  selected: string | null;
  /** px of the panel the drawer covers on the right */
  obscuredRight: number;
  /** a chip was clicked: fly there and select it */
  onGo: (id: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const mapCanvas = useRef<HTMLCanvasElement>(null);
  const vpRef = useRef<HTMLDivElement>(null);
  const chipEls = useRef(new Map<string, HTMLButtonElement>());
  const [chips, setChips] = useState<string[]>([]);
  const chipKey = useRef('');

  // the latest of everything the tick needs, without re-subscribing the scroll listener
  const live = useRef({ layout, scale, pad, meta, obscuredRight, selected });
  live.current = { layout, scale, pad, meta, obscuredRight, selected };

  const raf = useRef(0);
  const tick = useCallback(() => {
    raf.current = 0;
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!wrap || !canvas || !root) return;
    const g = geo(wrap, canvas);
    const { layout: l, scale: s, pad: p, meta: m, obscuredRight: obs } = live.current;
    root.style.setProperty('--vh', `${g.vh}px`);
    root.style.setProperty('--obs', `${obs}px`);

    // minimap: visible when there is something to scroll to
    const map = mapRef.current;
    if (map) {
      const show = needsMap({ w: g.sw, h: g.sh }, { w: g.vw, h: g.vh }) && g.vw > 360 && g.vh > 260;
      map.classList.toggle('on', show);
      if (show) {
        const sz = minimapSize({ w: g.cw, h: g.ch });
        if (map.dataset.sz !== `${sz.w}x${sz.h}`) {
          map.dataset.sz = `${sz.w}x${sz.h}`;
          map.style.width = `${sz.w}px`;
          map.style.height = `${sz.h}px`;
          drawMap();
        }
        const vp = vpRef.current;
        if (vp) {
          const x = Math.max(0, (g.left - g.ox) * sz.scale);
          const y = Math.max(0, (g.top - g.oy) * sz.scale);
          const w = Math.min(sz.w - x, g.vw * sz.scale);
          const h = Math.min(sz.h - y, g.vh * sz.scale);
          vp.style.transform = `translate(${x}px, ${y}px)`;
          vp.style.width = `${Math.max(4, w)}px`;
          vp.style.height = `${Math.max(4, h)}px`;
        }
      }
    }

    // chips for running agents out of view
    const items: { id: string; box: Box }[] = [];
    for (const n of l.nodes) {
      if (n.collapsed || n.id === MAIN) continue;
      const st = m.get(n.id)?.st;
      if (st !== 'running' && st !== 'waiting') continue;
      items.push({ id: n.id, box: { x: g.ox + p + n.x * s, y: g.oy + p + n.y * s, w: n.w * s, h: n.h * s } });
    }
    const view = { w: g.vw, h: g.vh };
    const picked = pickOffscreen(items, { left: g.left, top: g.top }, view, obs);
    const key = picked.map((i) => i.id).join(',');
    if (key !== chipKey.current) {
      chipKey.current = key;
      setChips(picked.map((i) => i.id));
    }
    const els = picked.map((it) => chipEls.current.get(it.id));
    if (els.every(Boolean)) {
      const raw = picked.map((it) => edgeChip({ x: it.box.x + it.box.w / 2 - g.left, y: it.box.y + it.box.h / 2 - g.top }, view, obs));
      const sizes = els.map((el) => ({ w: el!.offsetWidth, h: el!.offsetHeight }));
      const bounds = chipBounds(view, obs);
      const pos = spreadChips(raw, sizes, bounds);
      els.forEach((el, i) => {
        el!.style.transform = `translate(${pos[i].x}px, ${pos[i].y}px) translate(-50%, -50%)`;
        el!.style.setProperty('--ang', `${raw[i].angle}rad`);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrapRef, canvasRef]);
  const schedule = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(tick);
  }, [tick]);

  // draw the minimap: edges, then one dot per card (running ones bright, finished ones dim), the main node a ring
  const drawMap = useCallback(() => {
    const cv = mapCanvas.current;
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const map = mapRef.current;
    if (!cv || !wrap || !canvas || !map) return;
    const cw = canvas.offsetWidth;
    const ch = canvas.offsetHeight;
    const sz = minimapSize({ w: cw, h: ch });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(sz.w * dpr) || cv.height !== Math.round(sz.h * dpr)) {
      cv.width = Math.round(sz.w * dpr);
      cv.height = Math.round(sz.h * dpr);
      cv.style.width = `${sz.w}px`;
      cv.style.height = `${sz.h}px`;
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const { layout: l, scale: s, pad: p, meta: m, selected: sel } = live.current;
    const css = getComputedStyle(document.documentElement);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, sz.w, sz.h);
    const k = sz.scale * s;
    const px = p * sz.scale;
    const pos = new Map<string, { x: number; y: number }>();
    for (const n of l.nodes) pos.set(n.id, { x: px + (n.x + n.w / 2) * k, y: px + (n.y + n.h / 2) * k });
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = 'rgba(160,168,190,0.22)';
    ctx.beginPath();
    for (const e of l.edges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (a && b) {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
    }
    ctx.stroke();
    const dim = Math.max(2.4, Math.min(5.5, 200 * k * 0.02 + 2));
    for (const n of l.nodes) {
      const c = pos.get(n.id)!;
      const st = n.collapsed ? 'done' : (m.get(n.id)?.st ?? 'done');
      const fam = n.collapsed ? 'other' : (m.get(n.id)?.fam ?? 'other');
      const live_ = st === 'running' || st === 'waiting';
      const col = n.collapsed ? 'rgba(160,168,190,0.55)' : famColor(css, fam);
      ctx.globalAlpha = live_ ? 1 : st === 'error' ? 0.9 : 0.42;
      ctx.fillStyle = st === 'error' ? (css.getPropertyValue('--err').trim() || '#ff6b6b') : col;
      const r = n.id === MAIN ? dim * 1.5 : n.collapsed ? dim * 0.7 : dim;
      if (live_) {
        ctx.shadowColor = col;
        ctx.shadowBlur = 6;
      }
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (n.id === MAIN) {
        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(c.x, c.y, r + 2.4, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (n.id === sel) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(c.x, c.y, r + 2, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }, [wrapRef, canvasRef]);

  // repaint the map when what it shows changes; follow the scroll and the panel size
  useLayoutEffect(() => {
    if (mapRef.current) mapRef.current.dataset.sz = '';
    schedule();
  }, [layout, scale, meta, selected, obscuredRight, schedule]);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    wrap.addEventListener('scroll', schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(wrap);
    if (canvasRef.current) ro.observe(canvasRef.current);
    return () => {
      wrap.removeEventListener('scroll', schedule);
      ro.disconnect();
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [wrapRef, canvasRef, schedule]);
  // chips mount after the tick that asked for them: place them right away
  useLayoutEffect(() => {
    schedule();
  }, [chips, schedule]);

  // ---- minimap input: click flies there, drag scrubs ----
  const dragging = useRef(false);
  const toScroll = (e: React.PointerEvent) => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const map = mapRef.current;
    if (!wrap || !canvas || !map) return null;
    const r = map.getBoundingClientRect();
    const g = geo(wrap, canvas);
    const sz = minimapSize({ w: g.cw, h: g.ch });
    return mapToScroll({ x: e.clientX - r.left, y: e.clientY - r.top }, sz.scale, { w: g.sw, h: g.sh }, { w: g.vw, h: g.vh }, { x: g.ox, y: g.oy });
  };
  const onMapDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const s = toScroll(e);
    if (!s) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add('drag');
    cam.moveTo(s.left, s.top, 220);
  };
  const onMapMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const s = toScroll(e);
    const wrap = wrapRef.current;
    if (!s || !wrap) return;
    cam.cancel();
    wrap.scrollLeft = s.left;
    wrap.scrollTop = s.top;
  };
  const onMapUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    e.currentTarget.classList.remove('drag');
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div className="gcam" ref={rootRef} data-testid="graph-camera">
      <div
        className="gcam-map"
        ref={mapRef}
        data-testid="minimap"
        onPointerDown={onMapDown}
        onPointerMove={onMapMove}
        onPointerUp={onMapUp}
        onPointerCancel={onMapUp}
        onClick={(e) => e.stopPropagation()}
        title="Overview: click or drag to move"
      >
        <canvas ref={mapCanvas} />
        <div className="gcam-vp" ref={vpRef} />
      </div>
      {chips.map((id) => {
        const a = agents[id];
        if (!a) return null;
        const label = a.description ? a.description.split('\n')[0].slice(0, 24) : agentName(a);
        return (
          <button
            key={id}
            ref={(el) => {
              if (el) chipEls.current.set(id, el);
              else chipEls.current.delete(id);
            }}
            className={`gcam-chip ${famClass(a.model)} ${meta.get(id)?.st ?? ''}`}
            data-chase={id}
            title={`${a.description || agentName(a)} (out of view): click to go there`}
            onClick={(e) => {
              e.stopPropagation();
              onGo(id);
            }}
          >
            <svg className="arrow" viewBox="0 0 12 12" aria-hidden>
              <path d="M3 1.5 9 6 3 10.5" />
            </svg>
            <span className="dot" />
            <span className="lbl">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Scroll target (scroll space) that centres agent `id`, or null when it is not drawn. */
export function targetFor(wrap: HTMLElement, canvas: HTMLElement, layout: Layout, scale: number, pad: number, id: string, obscuredRight: number) {
  const n = layout.nodes.find((x) => x.id === id);
  if (!n) return null;
  const box: Box = { x: canvas.offsetLeft + pad + n.x * scale, y: canvas.offsetTop + pad + n.y * scale, w: n.w * scale, h: n.h * scale };
  return { box, to: centerOn(box, { w: wrap.scrollWidth, h: wrap.scrollHeight }, { w: wrap.clientWidth, h: wrap.clientHeight }, obscuredRight) };
}
