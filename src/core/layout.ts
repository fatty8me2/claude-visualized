// Tree layout for the agent graph: main on top, subagents below, nested by parent.
// Leaf-only sibling groups wrap into a grid so a 20-agent workflow stays readable.

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
  showFinished: boolean;
  /** parents whose finished children the user expanded */
  expanded?: ReadonlySet<string>;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  nodeW: 240,
  nodeH: 158,
  mainW: 330,
  mainH: 132,
  gapX: 22,
  gapY: 70,
  maxCols: 5,
  collapseAbove: 6,
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
    const crowded = children.length > opt.collapseAbove && finishedLeaves.length > 1 && !opt.expanded?.has(a.id);
    if (!opt.showFinished || crowded) {
      if (finishedLeaves.length > 0) {
        const ids = new Set(finishedLeaves.map((c) => c.id));
        for (const id of ids) hide(id, seen);
        children = children.filter((c) => !ids.has(c.id));
        collapsedBox = {
          id: `collapsed:${a.id}`,
          w: opt.nodeW,
          h: 64,
          collapsed: { count: ids.size, ids: [...ids], parentId: a.id },
          children: [],
          grid: false,
          sw: 0,
          sh: 0,
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
      grid: childBoxes.length > opt.maxCols && childBoxes.every((c) => c.children.length === 0),
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
      b.sw = Math.max(b.w, cols * cw + (cols - 1) * opt.gapX);
      b.sh = b.h + opt.gapY + rows * rowH + (rows - 1) * (opt.gapY * 0.45);
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
      const my = py + (cy - py) / 2;
      const st = statusOf(c.id);
      edges.push({ from: b.id, to: c.id, d: `M ${px} ${py} C ${px} ${my}, ${cx} ${my}, ${cx} ${cy}`, active: st === 'running' || st === 'waiting' });
    };
    if (b.children.length === 0) return;
    const ctop = top + b.h + opt.gapY;
    if (b.grid) {
      const cols = opt.maxCols;
      const gridW = cols * opt.nodeW + (cols - 1) * opt.gapX;
      const gx = left + (b.sw - gridW) / 2;
      const rowH = Math.max(...b.children.map((c) => c.h));
      b.children.forEach((c, i) => {
        const r = Math.floor(i / cols);
        const inRow = Math.min(cols, b.children.length - r * cols);
        const rowOffset = ((cols - inRow) * (opt.nodeW + opt.gapX)) / 2;
        const cx = gx + rowOffset + (i % cols) * (opt.nodeW + opt.gapX);
        const cy = ctop + r * (rowH + opt.gapY * 0.45);
        place({ ...c, sw: c.w }, cx, cy);
        edge({ id: c.id, x: cx, y: cy, w: c.w });
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
  if (added) measure(root);
  place(root, 0, 0);
  return { nodes, edges, width: root.sw, height: root.sh };
}
