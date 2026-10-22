import { useEffect, useLayoutEffect, useRef } from 'react';
import { diffEdgeFx } from '@core/edgeFx';
import { planRipples } from '@core/backdrop';
import type { Layout } from '@core/layout';
import { BackdropEngine, type BackdropNode } from '../backdrop';
import type { EdgeMeta } from './GraphEdges';
import '../backdrop.css';

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * The graph's ambient backdrop: one canvas, pinned to the visible area of the scrolling graph panel and drawn behind the cards and
 * connectors. It reads pan from the card layer's position on screen and zoom from its scale, so it follows both without React state.
 * `paused` (replay) freezes it to a still grid; reduced motion does the same.
 */
export function GraphBackdrop({ layout, meta, resetKey, paused }: { layout: Layout; meta: ReadonlyMap<string, EdgeMeta>; resetKey: string; paused: boolean }) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engine = useRef<BackdropEngine | null>(null);
  const prev = useRef<{ key: string; st: Map<string, string> } | null>(null);

  const pausedRef = useRef(paused);
  // a layout effect, so the engine exists before the feed below runs on mount
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const wrap = anchorRef.current?.parentElement;
    if (!canvas || !wrap) return;
    const e = new BackdropEngine(wrap, canvas);
    e.setFrozen(reducedMotion() || pausedRef.current, pausedRef.current);
    engine.current = e;
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const onMq = () => e.setFrozen(reducedMotion() || pausedRef.current, pausedRef.current);
    mq?.addEventListener?.('change', onMq);
    return () => {
      mq?.removeEventListener?.('change', onMq);
      e.destroy();
      engine.current = null;
    };
  }, []);

  useEffect(() => {
    pausedRef.current = paused;
    engine.current?.setFrozen(reducedMotion() || paused, paused);
  }, [paused]);

  // feed the painter: agent positions (for heat and dust), then the transitions that happened (for ripples)
  useLayoutEffect(() => {
    const e = engine.current;
    const pos = new Map<string, { x: number; y: number }>();
    const nodes: BackdropNode[] = [];
    const fam = new Map<string, string>();
    for (const n of layout.nodes) {
      if (n.collapsed) continue;
      const m = meta.get(n.id);
      if (!m) continue;
      const c = { x: n.x + n.w / 2, y: n.y + n.h / 2 };
      pos.set(n.id, c);
      fam.set(n.id, m.fam);
      nodes.push({ id: n.id, ...c, fam: m.fam, running: m.st === 'running' });
    }
    const next = new Map<string, string>();
    for (const [id, m] of meta) next.set(id, m.st);
    const before = prev.current && prev.current.key === resetKey ? prev.current.st : null;
    prev.current = { key: resetKey, st: next };
    if (!e) return;
    e.setNodes(nodes);
    if (before) {
      const plan = diffEdgeFx(before, next);
      if (plan.spawn.length || plan.ret.length) e.addRipples(planRipples(plan, pos, fam, performance.now()));
    }
    e.invalidate();
  }, [layout, meta, resetKey]);

  return (
    <div className="gb-anchor" ref={anchorRef} aria-hidden>
      <canvas className="gb-canvas" ref={canvasRef} data-testid="graph-backdrop" />
    </div>
  );
}
