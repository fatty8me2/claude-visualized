// Tree layout for the agent graph: main on top, subagents below, nested by parent.
// Leaf-only sibling groups wrap into a grid so a 20-agent workflow stays readable.

import { edgePath, freeChannel, gridGeom, treeGeom, trunkY } from './edgePath';
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
  /** row: one line of children; grid: all-leaf children wrapped; blocks: leaf grid plus subtree rows beneath */
  kind: 'row' | 'grid' | 'blocks';
  /** blocks only */
  leaves: Box[];
  rows: Box[][];
  /** blocks only: side margins reserved so a connector can run down past the upper rows */
  pad: number;
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
          kind: 'row',
          leaves: [],
          rows: [],
          pad: 0,
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
      kind: 'row',
      leaves: [],
      rows: [],
      pad: 0,
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
    const gw = gutterW(opt);
    const targetW = opt.maxCols * opt.nodeW + (opt.maxCols - 1) * gw;
    const subs = b.children.filter((c) => c.children.length > 0);
    const flatW = b.children.reduce((s, c) => s + c.sw, 0) + (b.children.length - 1) * opt.gapX;
    b.kind = 'row';
    if (opt.maxCols >= 2 && subs.length === 0 && b.children.length > opt.maxCols) b.kind = 'grid';
    else if (opt.maxCols >= 2 && subs.length > 0 && flatW > targetW) b.kind = 'blocks';
    if (b.kind === 'grid') {
      const cols = opt.maxCols;
      const rows = Math.ceil(b.children.length / cols);
      const rowH = Math.max(...b.children.map((c) => c.h));
      b.sw = Math.max(b.w, cols * opt.nodeW + (cols - 1) * gw);
      // each row gap holds a connector lane with clearance above and below
      b.sh = b.h + opt.gapY + rows * rowH + (rows - 1) * opt.gapY;
      return;
    }
    if (b.kind === 'blocks') {
      // leaves wrap into a grid; subtrees (and workflow groups) go in rows beneath it, wrapping when too wide
      b.leaves = b.children.filter((c) => c.children.length === 0);
      b.rows = [];
      let cur: Box[] = [];
      let curW = 0;
      for (const c of subs) {
        if (cur.length > 0 && curW + gw + c.sw > targetW) {
          b.rows.push(cur);
          cur = [];
          curW = 0;
        }
        curW += (cur.length ? gw : 0) + c.sw;
        cur.push(c);
      }
      if (cur.length) b.rows.push(cur);
      const lcols = Math.min(opt.maxCols, b.leaves.length);
      const leafW = lcols > 0 ? lcols * opt.nodeW + (lcols - 1) * gw : 0;
      const rowW = (r: Box[]) => r.reduce((s, c) => s + c.sw, 0) + (r.length - 1) * gw;
      const nRows = b.rows.length + (b.leaves.length > 0 ? 1 : 0);
      b.pad = nRows >= 2 ? gw : 0;
      b.sw = Math.max(b.w, leafW, ...b.rows.map(rowW)) + 2 * b.pad;
      let h = 0;
      if (b.leaves.length > 0) {
        const lr = Math.ceil(b.leaves.length / lcols);
        h += lr * Math.max(...b.leaves.map((c) => c.h)) + (lr - 1) * opt.gapY;
      }
      for (const r of b.rows) h += (h > 0 ? opt.gapY : 0) + Math.max(...r.map((c) => c.sh));
      b.sh = b.h + opt.gapY + h;
      return;
    }
    b.sw = Math.max(b.w, flatW);
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
    const pushEdge = (c: { id: string }, geom: EdgeGeom) => {
      const st = statusOf(c.id);
      edges.push({ from: b.id, to: c.id, d: edgePath(geom), active: st === 'running' || st === 'waiting', geom });
    };
    if (b.kind === 'grid' || b.kind === 'blocks') {
      const gw = gutterW(opt);
      const step = opt.nodeW + gw;
      const lane0 = trunkY(py, ctop);
      const cardsStart = nodes.length;
      const leaves = b.kind === 'grid' ? b.children : b.leaves;
      const cols = Math.max(1, Math.min(opt.maxCols, leaves.length));
      const gridW = cols * opt.nodeW + (cols - 1) * gw;
      const gx = left + (b.sw - gridW) / 2;
      const rowH = leaves.length ? Math.max(...leaves.map((c) => c.h)) : 0;
      // vertical gutter between columns nearest the parent (every row above the last is full, so they line up)
      let trunkX = gx + opt.nodeW + gw / 2;
      for (let k = 1; k < cols - 1; k++) {
        const g = gx + k * step + opt.nodeW + gw / 2;
        if (Math.abs(g - px) < Math.abs(trunkX - px)) trunkX = g;
      }
      leaves.forEach((c, i) => {
        const r = Math.floor(i / cols);
        const inRow = Math.min(cols, leaves.length - r * cols);
        const rowOffset = ((cols - inRow) * step) / 2;
        const cx = gx + rowOffset + (i % cols) * step;
        const cy = ctop + r * (rowH + opt.gapY);
        place({ ...c, sw: c.w }, cx, cy);
        const ex = cx + c.w / 2;
        pushEdge(c, r === 0 ? treeGeom(px, py, ex, cy, lane0) : gridGeom(px, py, ex, cy, lane0, trunkX, cy - opt.gapY / 2));
      });
      if (b.kind === 'blocks') {
        const lr = leaves.length ? Math.ceil(leaves.length / cols) : 0;
        let y = ctop + (lr ? lr * rowH + (lr - 1) * opt.gapY : 0);
        const roots: Array<{ c: Box; ex: number; top: number; first: boolean }> = [];
        b.rows.forEach((row, ri) => {
          const first = ri === 0 && lr === 0;
          const top = first ? ctop : y + opt.gapY;
          const rw = row.reduce((s, c) => s + c.sw, 0) + (row.length - 1) * gw;
          let bx = left + (b.sw - rw) / 2;
          for (const c of row) {
            place(c, bx, top);
            roots.push({ c, ex: bx + c.sw / 2, top, first });
            bx += c.sw + gw;
          }
          y = top + Math.max(...row.map((c) => c.sh));
        });
        for (const rt of roots) {
          if (rt.first) {
            pushEdge(rt.c, treeGeom(px, py, rt.ex, rt.top, lane0));
            continue;
          }
          // run down a clear channel (between blocks, or the side margin) to the lane above this row
          const laneY = rt.top - opt.gapY / 2;
          const blocked: Array<[number, number]> = [];
          for (let i = cardsStart; i < nodes.length; i++) {
            const n = nodes[i];
            if (n.y < laneY && n.y + n.h > lane0) blocked.push([n.x, n.x + n.w]);
          }
          const chx = freeChannel(blocked, left + 3, left + b.sw - 3, px, 7) ?? left + gw / 2;
          pushEdge(rt.c, gridGeom(px, py, rt.ex, rt.top, lane0, chx, laneY));
        }
      }
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
    measure(root);
  }
  place(root, 0, 0);
  return { nodes, edges, width: root.sw, height: root.sh };
}
