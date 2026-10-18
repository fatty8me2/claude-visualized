// Connector geometry for the agent graph: a shared trunk from the parent, then a branch to each child, with rounded corners.

export interface EdgeGeom {
  /** parent bottom centre */
  x1: number;
  y1: number;
  /** child top centre */
  x2: number;
  y2: number;
  /** y of the horizontal run, shared by siblings in a row */
  ty: number;
}

const f = (n: number) => Math.round(n * 100) / 100;
export const CORNER_R = 10;

/** Orthogonal path from (sx,sy) to (ex,ey) whose horizontal run is at ty. Works in both directions (child -> parent for result pulses). */
export function roundedPath(sx: number, sy: number, ex: number, ey: number, ty: number, r = CORNER_R): string {
  const dx = ex - sx;
  const v = Math.sign(ey - sy) || 1;
  if (Math.abs(dx) < 1) return `M ${f(sx)} ${f(sy)} L ${f(ex)} ${f(ey)}`;
  const h = Math.sign(dx);
  const rr = Math.min(r, Math.abs(dx) / 2, Math.abs(ty - sy), Math.abs(ey - ty));
  if (rr < 1) return `M ${f(sx)} ${f(sy)} L ${f(sx)} ${f(ty)} L ${f(ex)} ${f(ty)} L ${f(ex)} ${f(ey)}`;
  return (
    `M ${f(sx)} ${f(sy)} V ${f(ty - v * rr)} Q ${f(sx)} ${f(ty)} ${f(sx + h * rr)} ${f(ty)} ` +
    `H ${f(ex - h * rr)} Q ${f(ex)} ${f(ty)} ${f(ex)} ${f(ty + v * rr)} V ${f(ey)}`
  );
}

export const edgePath = (g: EdgeGeom, reverse = false) =>
  reverse ? roundedPath(g.x2, g.y2, g.x1, g.y1, g.ty) : roundedPath(g.x1, g.y1, g.x2, g.y2, g.ty);

/** Approximate length (corners cut a little), for constant particle speed. */
export const edgeLength = (g: EdgeGeom) => Math.abs(g.y2 - g.y1) + Math.abs(g.x2 - g.x1);

/** Trunk height for a child row: halfway down the gap above it (capped so deep grid rows keep the run near the children). */
export function trunkY(parentBottom: number, childTop: number, maxDrop = 36): number {
  return childTop - Math.min((childTop - parentBottom) / 2, maxDrop);
}
