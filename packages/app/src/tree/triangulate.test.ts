import { describe, expect, it } from 'vitest';
import { triangulateOutline } from './triangulate.js';

/**
 * triangulateOutline is three's ear-clipper, and it caps every extruded fin,
 * tab and centering-ring solid the app exports as STL or DXF (extrudePolygon
 * in solidMesh.ts). It had no test of its own (audit 2026-09-22, Tests row
 * 481): only extrudePolygon's watertightness checks reached it, and those
 * would not say whether a three.js upgrade changed what it returns or what it
 * silently gives up on.
 */

type P = [number, number];

const area2 = ([ax, ay]: P, [bx, by]: P, [cx, cy]: P) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/** Twice the polygon's signed area (shoelace). */
const loopArea2 = (pts: P[]) => pts.reduce((s, [x0, y0], i) => {
  const [x1, y1] = pts[(i + 1) % pts.length]!;
  return s + x0 * y1 - x1 * y0;
}, 0);

/** Every property extrudePolygon relies on, for a simple polygon. */
function expectCovers(pts: P[]) {
  const tris = triangulateOutline(pts);
  // m-2 triangles, indices into the ORIGINAL array, every vertex used.
  expect(tris).toHaveLength(pts.length - 2);
  const used = new Set<number>();
  for (const t of tris) {
    expect(t).toHaveLength(3);
    for (const v of t) {
      expect(Number.isInteger(v) && v >= 0 && v < pts.length).toBe(true);
      used.add(v);
    }
  }
  expect(used.size).toBe(pts.length);
  // The pieces tile the outline: their unsigned areas add up to its area, with
  // no triangle of zero or reversed area hiding an overlap.
  const sum = tris.reduce((s, [a, b, c]) => s + Math.abs(area2(pts[a!]!, pts[b!]!, pts[c!]!)), 0);
  expect(sum).toBeCloseTo(Math.abs(loopArea2(pts)), 12);
  return tris;
}

/** A clipped-delta fin: the editor's default outline (FinPointsEditor). */
const FIN: P[] = [[0, 0], [0.020, 0.030], [0.045, 0.030], [0.060, 0]];

/**
 * A freeform fin of the kind the owner designs: swept, with a concave notch in
 * the trailing edge and a curved tip run — concave, so ear-clipping has to
 * choose its ears.
 */
const FREEFORM: P[] = [
  [0, 0], [0.018, 0.012], [0.032, 0.026], [0.041, 0.034], [0.050, 0.038],
  [0.058, 0.036], [0.062, 0.030], [0.052, 0.018], [0.060, 0.008], [0.070, 0],
];

describe('triangulateOutline', () => {
  it('splits a convex outline into m-2 triangles that tile it', () => {
    expectCovers(FIN);
    expectCovers([[0, 0], [1, 0], [1, 1], [0, 1]]);
  });

  it('tiles a concave freeform outline exactly', () => {
    expect(loopArea2(FREEFORM)).toBeLessThan(0); // clockwise as written
    expectCovers(FREEFORM);
  });

  it('accepts either winding and indexes the outline as given', () => {
    const ccw = [...FREEFORM].reverse();
    expectCovers(ccw);
    // Whatever the input winding, every triangle comes back counter-clockwise
    // in the input's own coordinates.
    for (const pts of [FREEFORM, ccw]) {
      for (const [a, b, c] of triangulateOutline(pts)) {
        expect(area2(pts[a!]!, pts[b!]!, pts[c!]!)).toBeGreaterThan(0);
      }
    }
  });

  it('returns nothing for fewer than three points', () => {
    expect(triangulateOutline([])).toEqual([]);
    expect(triangulateOutline([[0, 0], [1, 0]])).toEqual([]);
  });

  /**
   * THE REASON extrudePolygon checks the result: the ear-clipper does not
   * report failure. On a self-intersecting or zero-area outline it deletes
   * vertices and returns FEWER than m-2 triangles, which would cap a solid
   * with holes. These are the two outlines solidMesh.ts's comment names.
   */
  it('gives up SILENTLY on a crossed or flat outline — the caller has to count', () => {
    const bowTie: P[] = [[0, 0], [0.05, 0.03], [0, 0.03], [0.05, 0]];
    expect(triangulateOutline(bowTie).length).toBeLessThan(bowTie.length - 2);
    const flat: P[] = [[0, 0], [0.02, 0], [0.04, 0], [0.05, 0]];
    expect(triangulateOutline(flat)).toEqual([]);
  });
});
