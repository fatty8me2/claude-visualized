// Connector geometry for the agent graph. A connector is an orthogonal polyline from the parent's bottom centre
// to the child's top centre (pts), drawn with rounded corners. Layout decides the route (e.g. through the gutters
// between cards); everything that draws or animates edges only reads pts / the path helpers below.

export type Pt = [number, number];

export interface EdgeGeom {
  /** orthogonal route, parent bottom centre first, child top centre last */
  pts: Pt[];
  /** parent bottom centre (= pts[0]) */
  x1: number;
  y1: number;
  /** child top centre (= last pt) */
  x2: number;
  y2: number;
}

const f = (n: number) => Math.round(n * 100) / 100;
export const CORNER_R = 10;

export function geomFromPoints(pts: Pt[]): EdgeGeom {
  const clean = dedupe(pts);
  const a = clean[0];
  const b = clean[clean.length - 1];
  return { pts: clean, x1: a[0], y1: a[1], x2: b[0], y2: b[1] };
}

/** drop repeated and collinear middle points so corners are real corners */
function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 0.01 && Math.abs(last[1] - p[1]) < 0.01) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i >= 1; i--) {
    const [a, b, c] = [out[i - 1], out[i], out[i + 1]];
    const sameX = Math.abs(a[0] - b[0]) < 0.01 && Math.abs(b[0] - c[0]) < 0.01;
    const sameY = Math.abs(a[1] - b[1]) < 0.01 && Math.abs(b[1] - c[1]) < 0.01;
    if (sameX || sameY) out.splice(i, 1);
  }
  return out;
}

/** SVG path through orthogonal points with quadratic rounded corners (radius shrinks on short segments). */
export function roundedPolyline(pts: Pt[], r = CORNER_R): string {
  if (pts.length < 2) return '';
  let d = `M ${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const inLen = Math.hypot(cx - px, cy - py);
    const outLen = Math.hypot(nx - cx, ny - cy);
    const rr = Math.min(r, inLen / 2, outLen / 2);
    if (rr < 1) {
      d += ` L ${f(cx)} ${f(cy)}`;
      continue;
    }
    const ax = cx - ((cx - px) / inLen) * rr;
    const ay = cy - ((cy - py) / inLen) * rr;
    const bx = cx + ((nx - cx) / outLen) * rr;
    const by = cy + ((ny - cy) / outLen) * rr;
    d += ` L ${f(ax)} ${f(ay)} Q ${f(cx)} ${f(cy)} ${f(bx)} ${f(by)}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L ${f(last[0])} ${f(last[1])}`;
}

/** Classic tree connector: down from the parent, across at height ty, down into the child. */
export function treeGeom(sx: number, sy: number, ex: number, ey: number, ty: number): EdgeGeom {
  return geomFromPoints([
    [sx, sy],
    [sx, ty],
    [ex, ty],
    [ex, ey],
  ]);
}

/**
 * Connector for a child in a lower grid row: parent stub down to the first lane (lane0), along it to a vertical gutter
 * between columns (gx), down the gutter to the lane above the child's row (laneY), across to the child, down into it.
 */
export function gridGeom(sx: number, sy: number, ex: number, ey: number, lane0: number, gx: number, laneY: number): EdgeGeom {
  return geomFromPoints([
    [sx, sy],
    [sx, lane0],
    [gx, lane0],
    [gx, laneY],
    [ex, laneY],
    [ex, ey],
  ]);
}

/** Kept for callers that only need the classic three-segment shape. */
export function roundedPath(sx: number, sy: number, ex: number, ey: number, ty: number, r = CORNER_R): string {
  return roundedPolyline(treeGeom(sx, sy, ex, ey, ty).pts, r);
}

/** reverse = child -> parent (result pulses travel back up the same route) */
export const edgePath = (g: EdgeGeom, reverse = false) => roundedPolyline(reverse ? [...g.pts].reverse() : g.pts);

/** Route length (corners cut a little), for constant particle speed. */
export function edgeLength(g: EdgeGeom): number {
  let n = 0;
  for (let i = 1; i < g.pts.length; i++) n += Math.abs(g.pts[i][0] - g.pts[i - 1][0]) + Math.abs(g.pts[i][1] - g.pts[i - 1][1]);
  return n;
}

/** Trunk height for a child row: halfway down the gap above it (capped so deep grid rows keep the run near the children). */
export function trunkY(parentBottom: number, childTop: number, maxDrop = 36): number {
  return childTop - Math.min((childTop - parentBottom) / 2, maxDrop);
}
