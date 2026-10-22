// Junction hubs: points where the connectors of one parent split (a bus feeding several branches). Works on arbitrary orthogonal routes:
// a junction is a bend of one route that another sibling route passes through (as a bend or along a segment).
import type { Pt } from '@core/edgePath';

export interface HubEdge {
  to: string;
  from: string;
  pts: Pt[];
}

export interface Hub {
  x: number;
  y: number;
  /** children whose route passes through the hub */
  tos: string[];
}

export interface HubIndex {
  hubs: Hub[];
  /** per child: distance along its own route to each hub it passes (px, Manhattan) */
  at: Map<string, number[]>;
}

const EPS = 0.75;
const MAX_SIBLINGS = 48;

/** distance along the route to p when p lies on it, else -1 */
export function distanceAlong(pts: Pt[], p: Pt): number {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const inX = p[0] >= Math.min(ax, bx) - EPS && p[0] <= Math.max(ax, bx) + EPS;
    const inY = p[1] >= Math.min(ay, by) - EPS && p[1] <= Math.max(ay, by) + EPS;
    const onLine = ax === bx ? Math.abs(p[0] - ax) <= EPS : Math.abs(p[1] - ay) <= EPS;
    if (inX && inY && onLine) return acc + Math.abs(p[0] - ax) + Math.abs(p[1] - ay);
    acc += Math.abs(bx - ax) + Math.abs(by - ay);
  }
  return -1;
}

export function findHubs(edges: readonly HubEdge[]): HubIndex {
  const byParent = new Map<string, HubEdge[]>();
  for (const e of edges) {
    const l = byParent.get(e.from);
    if (l) l.push(e);
    else byParent.set(e.from, [e]);
  }
  const hubs: Hub[] = [];
  const at = new Map<string, number[]>();
  for (const group of byParent.values()) {
    if (group.length < 2) continue;
    const sibs = group.slice(0, MAX_SIBLINGS);
    const seen = new Set<string>();
    for (const f of sibs) {
      for (let i = 1; i < f.pts.length - 1; i++) {
        const v = f.pts[i];
        const key = `${Math.round(v[0])},${Math.round(v[1])}`;
        if (seen.has(key)) continue;
        const through: { e: HubEdge; s: number }[] = [];
        for (const e of sibs) {
          const s = distanceAlong(e.pts, v);
          // the start (parent socket) and the end (child socket) are not junctions
          if (s > EPS) through.push({ e, s });
        }
        if (through.length < 2) continue;
        seen.add(key);
        hubs.push({ x: v[0], y: v[1], tos: through.map((t) => t.e.to) });
        for (const t of through) {
          const l = at.get(t.e.to);
          if (l) l.push(t.s);
          else at.set(t.e.to, [t.s]);
        }
      }
    }
  }
  return { hubs, at };
}
