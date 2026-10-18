import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { diffEdgeFx } from '@core/edgeFx';
import { edgeLength, edgePath } from '@core/edgePath';
import type { Layout } from '@core/layout';

/** What the edge layer needs to know about an agent (kept small and stable so the layer re-renders only when it matters). */
export interface EdgeMeta {
  /** display status: running | quiet | waiting | idle | done | error */
  st: string;
  /** model family: opus | sonnet | haiku | fable | local | other */
  fam: string;
  started: number;
}

/** at most this many edges carry travelling particles, and with more running agents the layer goes calm */
export const MAX_PARTICLE_EDGES = 16;
const PARTICLE_SPEED = 85; // px per second along the edge
const FX_LIFETIME_MS = 1600;

type Fx = { kind: 'spawn' | 'ret'; err: boolean; token: number };

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const gid = (id: string) => {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  return `gf${(h >>> 0).toString(36)}`;
};

function Pulse({ d, err, len }: { d: string; err: boolean; len: number }) {
  const dur = `${Math.max(0.7, Math.min(1.3, len / 260)).toFixed(2)}s`;
  return (
    <g
      className={`gf-pulse${err ? ' err' : ''}`}
      opacity={0}
      ref={(g) => {
        // SMIL animations inserted later start at document time zero, so start these by hand
        g?.querySelectorAll<SVGAnimationElement>('animate,animateMotion').forEach((a) => a.beginElement?.());
      }}
    >
      <animateMotion begin="indefinite" dur={dur} path={d} fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.35 0 0.35 1" />
      <animate begin="indefinite" attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.8;1" dur={dur} fill="freeze" />
      <circle className="gf-halo" r={9} />
      <circle className="gf-core" r={3.4} />
    </g>
  );
}

export const GraphEdges = memo(function GraphEdges({
  layout,
  meta,
  focus,
  scale,
  resetKey,
}: {
  layout: Layout;
  meta: ReadonlyMap<string, EdgeMeta>;
  /** agents the pointer (or the plan rail) is on: their incoming edge and the path up to the root light up */
  focus?: ReadonlySet<string>;
  /** the graph's CSS scale, so the draw-in stroke matches the crisp (non-scaling) one */
  scale: number;
  /** changes when a different session is shown: forget previous statuses */
  resetKey: string;
}) {
  const [fx, setFx] = useState<ReadonlyMap<string, Fx>>(() => new Map());
  const prevRef = useRef<{ key: string; st: Map<string, string> } | null>(null);
  const seq = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  // transitions are detected by diffing statuses; only changes seen while watching animate (see diffEdgeFx)
  useLayoutEffect(() => {
    const next = new Map<string, string>();
    for (const [id, m] of meta) next.set(id, m.st);
    const prev = prevRef.current && prevRef.current.key === resetKey ? prevRef.current.st : null;
    prevRef.current = { key: resetKey, st: next };
    if (!prev || reducedMotion()) return;
    const plan = diffEdgeFx(prev, next);
    if (!plan.spawn.length && !plan.ret.length) return;
    const token = ++seq.current;
    const add = new Map<string, Fx>();
    for (const id of plan.spawn) add.set(id, { kind: 'spawn', err: false, token });
    for (const r of plan.ret) add.set(r.id, { kind: 'ret', err: r.err, token });
    setFx((cur) => new Map([...cur, ...add]));
    const t = setTimeout(() => {
      timers.current.delete(t);
      setFx((cur) => {
        let changed = false;
        const n = new Map(cur);
        for (const [id, f] of add) if (n.get(id)?.token === f.token) changed = n.delete(id) || changed;
        return changed ? n : cur;
      });
    }, FX_LIFETIME_MS);
    timers.current.add(t);
  }, [meta, resetKey]);
  useEffect(() => {
    const ts = timers.current;
    return () => ts.forEach(clearTimeout);
  }, []);

  // edges whose child is in the focus set, plus everything above it
  const hot = useMemo(() => {
    const out = new Set<string>();
    if (!focus || focus.size === 0) return out;
    const up = new Map<string, string>();
    for (const e of layout.edges) up.set(e.to, e.from);
    for (const id of focus) {
      let cur: string | undefined = id;
      for (let guard = 0; cur && up.has(cur) && !out.has(cur) && guard < 64; guard++) {
        out.add(cur);
        cur = up.get(cur);
      }
    }
    return out;
  }, [focus, layout.edges]);

  // travelling particles: the most recently started running edges, capped
  const { particles, running } = useMemo(() => {
    const run = layout.edges.filter((e) => meta.get(e.to)?.st === 'running');
    const picked = [...run].sort((a, b) => (meta.get(b.to)?.started ?? 0) - (meta.get(a.to)?.started ?? 0)).slice(0, MAX_PARTICLE_EDGES);
    return { particles: new Set(picked.map((e) => e.to)), running: run.length };
  }, [layout.edges, meta]);

  // many running agents: one fade-less particle per edge, no breathing
  const calm = running > MAX_PARTICLE_EDGES;
  return (
    <svg
      className={`edges gf${calm ? ' calm' : ''}`}
      width={layout.width}
      height={layout.height}
      style={{ ['--gf-s' as string]: scale }}
    >
      {layout.edges.map((e) => {
        const m = meta.get(e.to);
        const st = m?.st ?? 'idle';
        const f = fx.get(e.to);
        const settling = f?.kind === 'ret';
        const grad = st === 'running' || (settling && st === 'done');
        const flow = grad || st === 'waiting' || (settling && st === 'error');
        const id = gid(e.to);
        const len = edgeLength(e.geom);
        const dur = Math.max(1.2, len / PARTICLE_SPEED);
        const parent = meta.get(e.from);
        return (
          <g
            key={`${e.from}>${e.to}`}
            className={`gf-edge gf-${st} fam-${m?.fam ?? 'other'} pfam-${parent?.fam ?? 'other'}${f ? ` gf-${f.kind}` : ''}${f?.err ? ' gf-err' : ''}`}
          >
            {grad && (
              <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={e.geom.x1} y1={e.geom.y1} x2={e.geom.x1} y2={e.geom.y2}>
                <stop offset={0} className="gf-s0" />
                <stop offset={0.7} className="gf-s1" />
              </linearGradient>
            )}
            <path className="gf-base" d={e.d} pathLength={f?.kind === 'spawn' ? 1 : undefined} />
            {flow && (
              <path
                className="gf-flow"
                d={e.d}
                pathLength={f?.kind === 'spawn' ? 1 : undefined}
                style={grad ? { stroke: `url(#${id})` } : undefined}
              />
            )}
            {st === 'running' && particles.has(e.to) && (
              <g className="gf-particles">
                {(calm ? [0] : [0, 1]).map((i) => (
                  <g key={i} opacity={calm ? 1 : 0}>
                    <animateMotion dur={`${dur.toFixed(2)}s`} begin={`${-(i * dur) / 2}s`} repeatCount="indefinite" path={e.d} />
                    {!calm && (
                      <animate
                        attributeName="opacity"
                        values="0;1;1;0"
                        keyTimes="0;0.12;0.82;1"
                        dur={`${dur.toFixed(2)}s`}
                        begin={`${-(i * dur) / 2}s`}
                        repeatCount="indefinite"
                      />
                    )}
                    <circle className="gf-halo" r={4.6} />
                    <circle className="gf-spark" r={1.8} />
                  </g>
                ))}
              </g>
            )}
            {settling && <Pulse key={f.token} d={edgePath(e.geom, true)} err={f.err} len={len} />}
          </g>
        );
      })}
      {hot.size > 0 && (
        <g className="gf-hotlayer">
          {layout.edges
            .filter((e) => hot.has(e.to))
            .map((e) => (
              <path key={e.to} className={`gf-hot fam-${meta.get(e.to)?.fam ?? 'other'}`} d={e.d} />
            ))}
        </g>
      )}
    </svg>
  );
});
