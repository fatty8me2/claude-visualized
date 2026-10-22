import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { diffEdgeFx } from '@core/edgeFx';
import { edgeLength, edgePath } from '@core/edgePath';
import type { Layout, LayoutEdge } from '@core/layout';
import { findHubs } from '../edgeFx/junctions';

/** What the edge layer needs to know about an agent (kept small and stable so the layer re-renders only when it matters). */
export interface EdgeMeta {
  /** display status: running | quiet | waiting | idle | done | error */
  st: string;
  /** model family: opus | sonnet | haiku | fable | local | other */
  fam: string;
  started: number;
  /** a tool call is in flight (only reported while few agents run; packets burn brighter) */
  tool?: boolean;
}

/** with more running edges than this the layer goes calm: static conduits, no packets, no filtered glow */
export const MAX_PARTICLE_EDGES = 16;
const MAX_BEACONS = 8;
const PACKET_SPEED = 130; // px per second along the route
const BEACON_SPEED = 70;
const TRAIL = 56; // px, the longest layer of a comet
const FX_LIFETIME_MS = 2400;

type Fx = { kind: 'spawn' | 'ret'; err: boolean; token: number };

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const hash = (id: string) => {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r2 = (n: number) => Math.round(n * 100) / 100;

/** comet layers, longest first: a tapered trail made of stacked dashes that all end at the same head */
const COMET = [
  { cls: 'pk-glow', l: TRAIL },
  { cls: 'pk-trail', l: 44 },
  { cls: 'pk-mid', l: 24 },
  { cls: 'pk-head', l: 9 },
  { cls: 'pk-tip', l: 3 },
];

/**
 * Comets streaming along a route at constant speed. One animation on the wrapper drives every layer (stroke-dashoffset is inherited,
 * and each layer's dash pattern is shifted so all heads coincide), so a packet costs a single SMIL animation.
 * Junction hubs on the route flash when a head passes (their flash cycle is locked to the packet cycle).
 */
const Packets = memo(function Packets({
  d,
  len,
  n,
  tool,
  hot,
  beacon,
  hubs,
}: {
  d: string;
  len: number;
  n: number;
  tool: boolean;
  hot: boolean;
  beacon: boolean;
  hubs: { x: number; y: number; s: number }[];
}) {
  const speed = beacon ? BEACON_SPEED : PACKET_SPEED;
  const P = len + TRAIL;
  const T = P / speed;
  const gap = P + TRAIL + 10;
  const cycle = T / n;
  return (
    <g className={`gf-l gf-anim gf-pk${tool ? ' gf-tool' : ''}${beacon ? ' gf-beacon' : ''}${hot ? ' hot' : ''}`}>
      {Array.from({ length: n }, (_, i) => (
        <g key={i}>
          <animate attributeName="stroke-dashoffset" from={TRAIL} to={r2(TRAIL - P)} dur={`${r2(T)}s`} begin={`${r2(-i * cycle)}s`} repeatCount="indefinite" />
          {COMET.map((c) => (
            <path key={c.cls} className={c.cls} d={d} strokeDasharray={`0 ${TRAIL - c.l} ${c.l} ${r2(gap)}`} />
          ))}
        </g>
      ))}
      {!beacon &&
        hubs.map((h) => (
          <circle key={`${h.x}-${h.y}`} className="gf-flash" cx={h.x} cy={h.y} r={6} opacity={0}>
            <animate
              attributeName="opacity"
              values="0;1;0;0"
              keyTimes="0;0.12;0.5;1"
              dur={`${r2(cycle)}s`}
              begin={`${r2(h.s / speed - 0.12 * cycle)}s`}
              repeatCount="indefinite"
            />
          </circle>
        ))}
    </g>
  );
});

/** one-off spawn effect: an energy arc races down the route with a bright spark at its head, then sparks burst from the child's socket */
function SpawnFx({ d, len, x2, y2 }: { d: string; len: number; x2: number; y2: number }) {
  const dur = clamp(len / 760, 0.36, 0.9);
  const lead = clamp((34 / len) * 100, 4, 40);
  const t = `${dur.toFixed(2)}s cubic-bezier(0.3, 0.6, 0.4, 1)`;
  const style = (l: number) => ({ ['--l' as string]: l, strokeDasharray: `${l} 400`, animation: `gf-head ${t} both, gf-arcout 0.45s ease-in ${(dur * 0.9).toFixed(2)}s forwards` });
  const sparks = Array.from({ length: 9 }, (_, i) => {
    const a = (200 + (i * 140) / 8) * (Math.PI / 180);
    const r = 14 + ((i * 7) % 5) * 5;
    return { dx: r2(Math.cos(a) * r), dy: r2(Math.sin(a) * r), i };
  });
  return (
    <g className="gf-l gf-anim gf-fxs">
      <path className="fx-arc-halo" d={d} pathLength={100} style={{ strokeDasharray: '100 400', animation: `gf-draw ${t} both, gf-flick 0.5s steps(1) both, gf-arcout 0.5s ease-in ${(dur * 0.85).toFixed(2)}s forwards` }} />
      <path className="fx-arc-core" d={d} pathLength={100} style={{ strokeDasharray: '100 400', animation: `gf-draw ${t} both, gf-flick 0.42s steps(1) both, gf-arcout 0.5s ease-in ${(dur * 0.85).toFixed(2)}s forwards` }} />
      <path className="fx-spark-halo" d={d} pathLength={100} style={style(lead)} />
      <path className="fx-spark" d={d} pathLength={100} style={style(lead * 0.3)} />
      <g transform={`translate(${x2} ${y2})`}>
        <circle className="fx-flash" r={5} style={{ animationDelay: `${dur.toFixed(2)}s` }} />
        {sparks.map((s) => (
          <circle key={s.i} className="fx-burst" r={1.7} style={{ ['--dx' as string]: `${s.dx}px`, ['--dy' as string]: `${s.dy}px`, animationDelay: `${(dur + s.i * 0.01).toFixed(2)}s` }} />
        ))}
      </g>
    </g>
  );
}

/** one-off return effect: a thick result surge runs child to parent, then a ripple ring opens at the parent's socket */
function ReturnFx({ rd, len, x1, y1, err }: { rd: string; len: number; x1: number; y1: number; err: boolean }) {
  const dur = clamp(len / 560, 0.4, 0.95);
  const l = clamp((56 / len) * 100, 8, 60);
  const t = `${dur.toFixed(2)}s cubic-bezier(0.45, 0, 0.5, 1)`;
  const style = (k: number) => ({ ['--l' as string]: l * k, strokeDasharray: `${l * k} 400`, animation: `gf-head ${t} both, gf-arcout 0.3s ease-in ${dur.toFixed(2)}s forwards` });
  return (
    <g className={`gf-l gf-anim gf-fxr${err ? ' err' : ''}`}>
      <path className="fx-surge-halo" d={rd} pathLength={100} style={style(1)} />
      <path className="fx-surge" d={rd} pathLength={100} style={style(0.7)} />
      <path className="fx-surge-head" d={rd} pathLength={100} style={style(0.16)} />
      <g transform={`translate(${x1} ${y1})`}>
        <circle className="fx-ripple" r={5} style={{ animationDelay: `${dur.toFixed(2)}s` }} />
        <circle className="fx-ripple fx-ripple2" r={5} style={{ animationDelay: `${(dur + 0.14).toFixed(2)}s` }} />
      </g>
    </g>
  );
}

const upMap = (edges: readonly LayoutEdge[]) => {
  const up = new Map<string, string>();
  for (const e of edges) up.set(e.to, e.from);
  return up;
};

export const GraphEdges = memo(function GraphEdges({
  layout,
  meta,
  focus,
  resetKey,
}: {
  layout: Layout;
  meta: ReadonlyMap<string, EdgeMeta>;
  /** agents the pointer (or the plan rail) is on: their incoming edge and the path up to the root light up */
  focus?: ReadonlySet<string>;
  /** changes when a different session is shown: forget previous statuses */
  resetKey: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
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
    const up = upMap(layout.edges);
    for (const id of focus) {
      let cur: string | undefined = id;
      for (let guard = 0; cur && up.has(cur) && !out.has(cur) && guard < 64; guard++) {
        out.add(cur);
        cur = up.get(cur);
      }
    }
    return out;
  }, [focus, layout.edges]);

  const hubIndex = useMemo(() => findHubs(layout.edges.map((e) => ({ to: e.to, from: e.from, pts: e.geom.pts }))), [layout.edges]);
  const lens = useMemo(() => new Map(layout.edges.map((e) => [e.to, edgeLength(e.geom)])), [layout.edges]);

  const running = useMemo(() => layout.edges.reduce((n, e) => n + (meta.get(e.to)?.st === 'running' ? 1 : 0), 0), [layout.edges, meta]);
  const calm = running > MAX_PARTICLE_EDGES;
  const focusing = hot.size > 0;

  const casing: React.ReactNode[] = [];
  const bases: React.ReactNode[] = [];
  const glows: React.ReactNode[] = [];
  const waitGlows: React.ReactNode[] = [];
  const cores: React.ReactNode[] = [];
  const packets: React.ReactNode[] = [];
  const fxs: React.ReactNode[] = [];
  const defs: React.ReactNode[] = [];
  const hotPaths: React.ReactNode[] = [];
  const childSock: React.ReactNode[] = [];
  const parentSock = new Map<string, { x: number; y: number; fam: string; st: string; hot: boolean }>();
  let beacons = 0;

  for (const e of layout.edges) {
    const m = meta.get(e.to);
    const st = m?.st ?? 'idle';
    const fam = m?.fam ?? 'other';
    const pm = meta.get(e.from);
    const f = fx.get(e.to);
    const isHot = hot.has(e.to);
    const len = lens.get(e.to) ?? 100;
    const cls = `fam-${fam} pfam-${pm?.fam ?? 'other'}`;
    const settleDone = f?.kind === 'ret' && st === 'done';
    const settleErr = f?.kind === 'ret' && st === 'error';
    const spawning = f?.kind === 'spawn';
    const grad = st === 'running' || settleDone;
    const gid = `${uid}g${hash(e.to)}`;
    const hc = isHot ? ' hot' : '';

    casing.push(<path key={e.to} className={`gf-l gf-casing${hc}`} d={e.d} />);
    bases.push(<path key={e.to} className={`gf-l gf-base gf-${st} ${cls}${hc}${spawning ? ' gf-spawn' : ''}`} d={e.d} />);

    if (grad) {
      defs.push(
        <linearGradient key={e.to} id={gid} className={cls} gradientUnits="userSpaceOnUse" x1={e.geom.x1} y1={e.geom.y1} x2={e.geom.x1} y2={e.geom.y2}>
          <stop offset={0} className="gf-s0" />
          <stop offset={0.6} className="gf-s1" />
          <stop offset={1} className="gf-s2" />
        </linearGradient>,
      );
    }
    const stroke = grad ? { stroke: `url(#${gid})` } : undefined;
    if (st === 'running' || settleDone) {
      const k = `${hc}${spawning ? ' gf-spawn' : ''}${settleDone ? ' gf-cool' : ''}`;
      glows.push(<path key={e.to} className={`gf-l gf-glow ${cls}${k}`} d={e.d} style={stroke} />);
      cores.push(<path key={e.to} className={`gf-l gf-core ${cls}${k}`} d={e.d} style={stroke} />);
    } else if (st === 'waiting') {
      waitGlows.push(<path key={e.to} className={`gf-l gf-glow gf-wglow${hc}`} d={e.d} />);
      cores.push(<path key={e.to} className={`gf-l gf-core gf-wait${hc}`} d={e.d} />);
    }
    if (settleErr) {
      cores.push(<path key={`${e.to}!`} className="gf-l gf-core gf-glitch" d={e.d} />);
      glows.push(<path key={`${e.to}!`} className="gf-l gf-glow gf-glitch" d={e.d} />);
    }

    if (isHot) {
      hotPaths.push(<path key={e.to} className={`gf-hot ${cls} gf-hot-${st}`} d={e.d} />);
    }

    if (!calm && (st === 'running' || (st === 'waiting' && beacons < MAX_BEACONS))) {
      const beacon = st === 'waiting';
      if (beacon) beacons++;
      const n = beacon ? 1 : clamp(Math.round(len / 190), 1, running > 8 ? 2 : 3);
      const hubs = (hubIndex.at.get(e.to) ?? []).map((s) => {
        const h = routePoint(e, s);
        return { x: h.x, y: h.y, s };
      });
      packets.push(
        <g key={e.to} className={`${beacon ? 'gf-wait ' : ''}${cls}${spawning ? ' gf-spawn' : ''}`}>
          <Packets d={e.d} len={len} n={n} tool={!!m?.tool} hot={isHot} beacon={beacon} hubs={beacon ? [] : hubs} />
        </g>,
      );
    }

    if (spawning) {
      fxs.push(
        <g key={`s${e.to}-${f.token}`} className={cls}>
          <SpawnFx d={e.d} len={len} x2={e.geom.x2} y2={e.geom.y2} />
        </g>,
      );
    } else if (f?.kind === 'ret') {
      fxs.push(
        <g key={`r${e.to}-${f.token}`} className={`${cls}${f.err ? ' gf-err' : ''}`}>
          <ReturnFx rd={edgePath(e.geom, true)} len={len} x1={e.geom.x1} y1={e.geom.y1} err={f.err} />
        </g>,
      );
    }

    childSock.push(
      <g key={e.to} className={`gf-sock gf-sock-${st} ${cls}${hc}`} transform={`translate(${e.geom.x2} ${e.geom.y2})`}>
        <circle className="gf-sock-halo" r={7} />
        <circle className="gf-sock-ring" r={3.6} />
      </g>,
    );
    const ps = parentSock.get(e.from);
    const rank = (s: string) => (s === 'running' ? 3 : s === 'waiting' ? 2 : s === 'error' ? 1 : 0);
    if (!ps) parentSock.set(e.from, { x: e.geom.x1, y: e.geom.y1, fam: pm?.fam ?? fam, st: st === 'running' || st === 'waiting' ? st : 'idle', hot: isHot });
    else {
      if (rank(st) > rank(ps.st) && (st === 'running' || st === 'waiting')) ps.st = st;
      ps.hot = ps.hot || isHot;
    }
  }

  const W = layout.width;
  const H = layout.height;
  const fid = `${uid}glow`;
  return (
    // --gf-s (the graph's CSS scale, so the draw-in stroke matches the crisp non-scaling one) is inherited from the scaled container
    <svg className={`edges gf${calm ? ' calm' : ''}${focusing ? ' focusing' : ''}`} width={W} height={H}>
      <defs>
        {/* one blur shared by every glowing conduit: the glow layers below are each a single filtered group */}
        <filter id={fid} filterUnits="userSpaceOnUse" x={-30} y={-30} width={W + 60} height={H + 60} colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation={3} result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="b" />
          </feMerge>
        </filter>
        {defs}
      </defs>
      <g className="gf-casings">{casing}</g>
      <g className="gf-bases">{bases}</g>
      {glows.length > 0 && <g className="gf-glows" filter={calm ? undefined : `url(#${fid})`}>{glows}</g>}
      {waitGlows.length > 0 && <g className="gf-glows gf-wglows" filter={calm ? undefined : `url(#${fid})`}>{waitGlows}</g>}
      <g className="gf-cores">{cores}</g>
      {hotPaths.length > 0 && <g className="gf-hotlayer">{hotPaths}</g>}
      <g className="gf-hubs">
        {hubIndex.hubs.map((h) => {
          const live = h.tos.find((id) => meta.get(id)?.st === 'running');
          const any = live ?? h.tos.find((id) => meta.get(id)?.st === 'waiting');
          const isHot = h.tos.some((id) => hot.has(id));
          return (
            <g key={`${h.x},${h.y}`} className={`gf-hub${live ? ' on' : any ? ' wait' : ''} fam-${meta.get(any ?? h.tos[0])?.fam ?? 'other'}${isHot ? ' hot' : ''}`} transform={`translate(${h.x} ${h.y})`}>
              <circle className="gf-hub-halo" r={7} />
              <circle className="gf-hub-dot" r={3} />
            </g>
          );
        })}
      </g>
      <g className="gf-packets">{packets}</g>
      <g className="gf-fxl">{fxs}</g>
      <g className="gf-socks">
        {[...parentSock].map(([id, p]) => (
          <g key={id} className={`gf-sock gf-sock-${p.st} fam-${p.fam}${p.hot ? ' hot' : ''}`} transform={`translate(${p.x} ${p.y})`}>
            <circle className="gf-sock-halo" r={7} />
            <circle className="gf-sock-ring" r={3.6} />
          </g>
        ))}
        {childSock}
      </g>
    </svg>
  );
});

/** the point at distance s along e's route */
function routePoint(e: LayoutEdge, s: number): { x: number; y: number } {
  let acc = 0;
  const pts = e.geom.pts;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const seg = Math.abs(bx - ax) + Math.abs(by - ay);
    if (s <= acc + seg + 0.01) {
      const t = seg === 0 ? 0 : (s - acc) / seg;
      return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t };
    }
    acc += seg;
  }
  return { x: pts[pts.length - 1][0], y: pts[pts.length - 1][1] };
}
