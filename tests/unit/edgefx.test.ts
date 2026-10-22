import { describe, expect, it } from 'vitest';
import { diffEdgeFx } from '@core/edgeFx';
import { edgeLength, edgePath, trunkY, treeGeom, geomFromPoints } from '@core/edgePath';

const m = (o: Record<string, string>) => new Map(Object.entries(o));

describe('diffEdgeFx', () => {
  it('does not animate first sight of a session', () => {
    expect(diffEdgeFx(null, m({ main: 'running', a: 'done' }))).toEqual({ spawn: [], ret: [] });
  });
  it('animates a new live child and a child that finishes', () => {
    const p = m({ main: 'running', a: 'running' });
    expect(diffEdgeFx(p, m({ main: 'running', a: 'done', b: 'running' }))).toEqual({ spawn: ['b'], ret: [{ id: 'a', err: false }] });
    expect(diffEdgeFx(p, m({ main: 'running', a: 'error' })).ret).toEqual([{ id: 'a', err: true }]);
  });
  it('ignores backward moves and removals', () => {
    expect(diffEdgeFx(m({ a: 'done' }), m({ a: 'running' }))).toEqual({ spawn: [], ret: [] });
    expect(diffEdgeFx(m({ a: 'running' }), m({}))).toEqual({ spawn: [], ret: [] });
  });
  it('treats a big change as a jump', () => {
    const next = m(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`a${i}`, 'running'])));
    expect(diffEdgeFx(m({}), next)).toEqual({ spawn: [], ret: [] });
  });
});

describe('edgePath', () => {
  const g = treeGeom(100, 0, 40, 100, 50);
  it('is straight when aligned and rounded otherwise', () => {
    expect(edgePath(treeGeom(100, 0, 100, 100, 50))).toBe('M 100 0 L 100 100');
    expect(edgePath(g)).toContain('Q');
    expect(edgePath(g, true).startsWith('M 40 100')).toBe(true);
    expect(edgePath(g, true).endsWith('L 100 0')).toBe(true);
  });
  it('length and trunk', () => {
    expect(edgeLength(g)).toBe(160);
    expect(trunkY(0, 70)).toBe(35);
    expect(trunkY(0, 500)).toBe(464);
  });
  it('routes through any orthogonal polyline and drops collinear points', () => {
    const r = geomFromPoints([[0, 0], [0, 40], [0, 60], [80, 60], [80, 120]]);
    expect(r.pts).toEqual([[0, 0], [0, 60], [80, 60], [80, 120]]);
    expect(edgeLength(r)).toBe(200);
  });
});
