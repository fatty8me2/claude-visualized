// Tree layout for the agent graph: main on top, subagents below, nested by parent.
// Leaf-only sibling groups wrap into a grid so a 20-agent workflow stays readable.

import { edgePath, gridGeom, treeGeom, trunkY } from './edgePath';
import type { EdgeGeom } from './edgePath';
import { MAIN, type AgentNode } from './state';

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** a collapsed group of finished agents */
  collapsed?: { count: number; ids: string[]; parentId: string };
}

export interface LayoutEdge {
  from: string;
  to: string;
  d: string;
  active: boolean;
  /** end points and trunk height (see edgePath) */
  geom: EdgeGeom;
}

export interface Layout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

export interface LayoutOptions {
  nodeW: number;
  nodeH: number;
  mainW: number;
  mainH: number;
  gapX: number;
  gapY: number;
  maxCols: number;
  /** collapse finished leaf children into one chip when a parent has more than this many */
  collapseAbove: number;
  /** height of the "N finished" chip */
  chipH: number;
  showFinished: boolean;
  /** parents whose finished children the user expanded */
  expanded?: ReadonlySet<string>;
  /** parents the user folded: their finished children go into a chip even when the group is small */
  folded?: ReadonlySet<string>;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  nodeW: 240,
  nodeH: 182,
  mainW: 330,
  mainH: 132,
  gapX: 22,
  gapY: 70,
  maxCols: 5,
  collapseAbove: 6,
  chipH: 64,
  showFinished: true,
};

/** Smaller cards for wide trees in a narrow panel (see core/graphZoom.ts: the graph switches to these instead of shrinking text). */
export const COMPACT_LAYOUT: LayoutOptions = {
  nodeW: 196,
  nodeH: 60,
  mainW: 264,
  mainH: 64,
  gapX: 16,
  gapY: 46,
  maxCols: 6,
  collapseAbove: 6,
  chipH: 40,
  showFinished: true,
};

interface Box {
  id: string;
  w: number;
  h: number;
  collapsed?: LayoutNode['collapsed'];
  children: Box[];
  grid: boolean;
  /** subtree extent */
  sw: number;
  sh: number;
}

/** Narrowest vertical gutter between grid columns: a connector runs down its middle, so it needs clear margin on both sides. */
const MIN_GUTTER = 20;
const gutterW = (opt: LayoutOptions) => Math.max(opt.gapX, MIN_GUTTER);

const isFinished = (a: AgentNode) => a.status === 'done' || a.status === 'error';

export function layoutAgents(agents: Record<string, AgentNode>, opt: LayoutOptions = DEFAULT_LAYOUT): Layout {
  const kids = new Map<string, AgentNode[]>();
  for (const a of Object.values(agents)) {
    if (a.id === MAIN) continue;
    const p = a.parentId && agents[a.parentId] && a.parentId !== a.id ? a.parentId : MAIN;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(a);
  }
  for (const list of kids.values()) list.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));

  const hasLiveDescendant = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    return (kids.get(id) ?? []).some((c) => !isFinished(c) || hasLiveDescendant(c.id, seen));
  };

  /** mark a hidden subtree as accounted for so it isn't re-added as an orphan */
  const hide = (id: string, seen: Set<string>) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const c of kids.get(id) ?? []) hide(c.id, seen);
  };

  const build = (a: AgentNode, depth: number, seen: Set<string>): Box => {
    seen.add(a.id);
    const isMain = a.id === MAIN;
    let children = (kids.get(a.id) ?? []).filter((c) => !seen.has(c.id));
    let collapsedBox: Box | null = null;
    // finished subtrees with nothing still running inside them
    const finishedLeaves = children.filter((c) => isFinished(c) && !hasLiveDescendant(c.id));
    const crowded =
      !opt.expanded?.has(a.id) &&
      ((children.length > opt.collapseAbove && finishedLeaves.length > 1) || (!!opt.folded?.has(a.id) && finishedLeaves.length > 0));
    if (!opt.showFinished || crowded) {
      if (finishedLeaves.length > 0) {
        const ids = new Set(finishedLeaves.map((c) => c.id));
        for (const id of ids) hide(id, seen);
        children = children.filter((c) => !ids.has(c.id));
        collapsedBox = {
          id: `collapsed:${a.id}`,
          w: opt.nodeW,
          h: opt.chipH,
          collapsed: { count: ids.size, ids: [...ids], parentId: a.id },
          children: [],
          grid: false,
          // sized up front: a zero-width chip gets placed on top of its neighbour
          sw: opt.nodeW,
          sh: opt.chipH,
        };
      }
    }
    const childBoxes = depth > 12 ? [] : children.map((c) => build(c, depth + 1, seen));
    if (collapsedBox) childBoxes.push(collapsedBox);
    const box: Box = {
      id: a.id,
      w: isMain ? opt.mainW : opt.nodeW,
      h: isMain ? opt.mainH : opt.nodeH,
      children: childBoxes,
      grid: opt.maxCols >= 2 && childBoxes.length > opt.maxCols && childBoxes.every((c) => c.children.length === 0),
      sw: 0,
      sh: 0,
    };
    measure(box);
    return box;
  };

  const measure = (b: Box) => {
    if (b.collapsed) {
      b.sw = b.w;
      b.sh = b.h;
      return;
    }
    if (b.children.length === 0) {
      b.sw = b.w;
      b.sh = b.h;
      return;
    }
    if (b.grid) {
      const cols = opt.maxCols;
      const rows = Math.ceil(b.children.length / cols);
      const cw = opt.nodeW;
      const rowH = Math.max(...b.children.map((c) => c.h));
      b.sw = Math.max(b.w, cols * cw + (cols - 1) * gutterW(opt));
      // each row gap holds a connector lane with clearance above and below
      b.sh = b.h + opt.gapY + rows * rowH + (rows - 1) * opt.gapY;
      return;
    }
    const cw = b.children.reduce((s, c) => s + c.sw, 0) + (b.children.length - 1) * opt.gapX;
    b.sw = Math.max(b.w, cw);
    b.sh = b.h + opt.gapY + Math.max(...b.children.map((c) => c.sh));
  };

  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];
  const statusOf = (id: string) => agents[id]?.status;

  const place = (b: Box, left: number, top: number) => {
    const x = left + (b.sw - b.w) / 2;
    nodes.push({ id: b.id, x, y: top, w: b.w, h: b.h, collapsed: b.collapsed });
    const px = x + b.w / 2;
    const py = top + b.h;
    const edge = (c: { id: string; x: number; y: number; w: number }) => {
      const cx = c.x + c.w / 2;
      const cy = c.y;
      const st = statusOf(c.id);
      const geom: EdgeGeom = treeGeom(px, py, cx, cy, trunkY(py, cy));
      edges.push({ from: b.id, to: c.id, d: edgePath(geom), active: st === 'running' || st === 'waiting', geom });
    };
    if (b.children.length === 0) return;
    const ctop = top + b.h + opt.gapY;
    if (b.grid) {
      const cols = opt.maxCols;
      const gw = gutterW(opt);
      const step = opt.nodeW + gw;
      const gridW = cols * opt.nodeW + (cols - 1) * gw;
      const gx = left + (b.sw - gridW) / 2;
      const rowH = Math.max(...b.children.map((c) => c.h));
      const lane0 = trunkY(py, ctop);
      // vertical gutter between columns nearest the parent (every row above the last is full, so they line up)
      let trunkX = gx + opt.nodeW + gw / 2;
      for (let k = 1; k < cols - 1; k++) {
        const g = gx + k * step + opt.nodeW + gw / 2;
        if (Math.abs(g - px) < Math.abs(trunkX - px)) trunkX = g;
      }
      b.children.forEach((c, i) => {
        const r = Math.floor(i / cols);
        const inRow = Math.min(cols, b.children.length - r * cols);
        const rowOffset = ((cols - inRow) * step) / 2;
        const cx = gx + rowOffset + (i % cols) * step;
        const cy = ctop + r * (rowH + opt.gapY);
        place({ ...c, sw: c.w }, cx, cy);
        const ex = cx + c.w / 2;
        const st = statusOf(c.id);
        const geom: EdgeGeom = r === 0 ? treeGeom(px, py, ex, cy, lane0) : gridGeom(px, py, ex, cy, lane0, trunkX, cy - opt.gapY / 2);
        edges.push({ from: b.id, to: c.id, d: edgePath(geom), active: st === 'running' || st === 'waiting', geom });
      });
      return;
    }
    const total = b.children.reduce((s, c) => s + c.sw, 0) + (b.children.length - 1) * opt.gapX;
    let cx = left + (b.sw - total) / 2;
    for (const c of b.children) {
      place(c, cx, ctop);
      edge({ id: c.id, x: cx + (c.sw - c.w) / 2, y: ctop, w: c.w });
      cx += c.sw + opt.gapX;
    }
  };

  const main = agents[MAIN];
  if (!main) return { nodes: [], edges: [], width: 0, height: 0 };
  const seen = new Set<string>();
  const root = build(main, 0, seen);
  // orphans whose parent chain loops back: hang them off main
  let added = false;
  for (const o of Object.values(agents)) {
    if (seen.has(o.id)) continue;
    root.children.push(build(o, 1, seen));
    added = true;
  }
  if (added) {
    root.grid = opt.maxCols >= 2 && root.children.length > opt.maxCols && root.children.every((c) => c.children.length === 0);
    measure(root);
  }
  place(root, 0, 0);
  return { nodes, edges, width: root.sw, height: root.sh };
}
