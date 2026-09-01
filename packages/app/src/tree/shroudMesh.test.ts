import { describe, expect, it } from 'vitest';
import { shroudGeometry, type ShroudMeshSpec } from './shroudMesh.js';
import { surfaceBumpFrontalArea, shroudHalfAngle, shroudEnds, isConformal } from './shroud.js';
import type { ComponentNode } from '@online-openrocket/engine';

/**
 * The shroud shell (v0.088). These are not cosmetic checks: `Rocket3D.buildPieces`
 * IS the STL export (App.tsx -> piecesToStl, which takes facet normals from the
 * winding), so a non-manifold or inside-out mesh here ships a file that renders
 * fine on screen and fails in a slicer, with nothing else in the suite covering
 * it. An inside-out face is also invisible on screen: opaque pieces render with
 * THREE.FrontSide.
 */

const SPEC = (over: Partial<ShroudMeshSpec> = {}): ShroudMeshSpec => ({
  length: 0.08, width: 0.025, height: 0.02, bodyRadius: 0.027,
  conformal: true, fore: 'streamlined', aft: 'halfround', ...over,
});

/**
 * Every triangle edge, keyed by DIRECTION. A closed, consistently-oriented
 * surface uses each edge exactly once each way.
 *
 * This was an UNDIRECTED check when it was first written, and that is why it
 * passed over a mesh whose two end caps and two side walls were wound
 * inside-out: an inverted patch still touches every edge twice. Caught in
 * review of v0.088. Directed is the check that means something.
 */
function badEdges(geo: ReturnType<typeof shroudGeometry>): number {
  const idx = geo.getIndex()!;
  const dir = new Map<string, number>();
  for (let t = 0; t < idx.count; t += 3) {
    const v = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
    for (let e = 0; e < 3; e++) dir.set(`${v[e]}>${v[(e + 1) % 3]}`, (dir.get(`${v[e]}>${v[(e + 1) % 3]}`) ?? 0) + 1);
  }
  let bad = 0;
  for (const [k, n] of dir) {
    const [a, b] = k.split('>');
    if (n !== 1 || (dir.get(`${b}>${a}`) ?? 0) !== 1) bad++;
  }
  return bad;
}

/** Signed volume via the divergence theorem — positive when wound outward. */
function signedVolume(geo: ReturnType<typeof shroudGeometry>): number {
  const p = geo.getAttribute('position');
  const idx = geo.getIndex()!;
  let v = 0;
  for (let t = 0; t < idx.count; t += 3) {
    const [i, j, k] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
    const ax = p.getX(i), ay = p.getY(i), az = p.getZ(i);
    const bx = p.getX(j), by = p.getY(j), bz = p.getZ(j);
    const cx = p.getX(k), cy = p.getY(k), cz = p.getZ(k);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

describe('the camera-shroud shell is a solid, not a picture of one', () => {
  const CASES: [string, Partial<ShroudMeshSpec>][] = [
    ['conformal, streamlined + domed (the default)', {}],
    ['flat-bottomed', { conformal: false }],
    ['both ends flat', { fore: 'box', aft: 'box' }],
    // Flat-bottomed AND flat-ended together. Absent from the first version of
    // this matrix, which tested conformal:false only with the default ends and
    // box/box only conformal — and it is the combination whose signed volume
    // came out NEGATIVE, i.e. the one case the old assertion would have caught.
    ['flat-bottomed with flat ends', { conformal: false, fore: 'box', aft: 'box' }],
    ['both ends domed', { fore: 'halfround', aft: 'halfround' }],
    ['both ends streamlined', { fore: 'streamlined', aft: 'streamlined' }],
    ['wider than the tube — the NaN case', { width: 0.09, bodyRadius: 0.012 }],
    ['very short, so both end runs collide', { length: 0.006 }],
  ];

  for (const [label, over] of CASES) {
    it(`${label}: watertight and wound outward`, () => {
      const geo = shroudGeometry(SPEC(over));
      const p = geo.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        expect(Number.isFinite(p.getX(i)) && Number.isFinite(p.getY(i)) && Number.isFinite(p.getZ(i)))
          .toBe(true);
      }
      // Closed AND consistently oriented: every edge used once each way.
      expect(badEdges(geo), 'inconsistently wound or non-manifold edges').toBe(0);
      // ...and oriented OUTWARD, not merely consistently.
      expect(signedVolume(geo)).toBeGreaterThan(0);
    });
  }

  it('a conformal shroud encloses MORE than a flat-bottomed one of the same envelope', () => {
    // The conformal part fills the crescent the flat one leaves as dead air.
    // Same outer shell, so the difference IS the gap.
    const conf = signedVolume(shroudGeometry(SPEC({ conformal: true })));
    const flat = signedVolume(shroudGeometry(SPEC({ conformal: false })));
    expect(conf).toBeGreaterThan(flat);
  });

  it('has STRAIGHT PARALLEL SIDES and a flat top — not an annular sector', () => {
    // The shape itself, pinned. Reverting to the v0.088 shell-between-two-arcs
    // (the owner's "trapezoidal" report) passes watertightness, winding and
    // volume unchanged — those check that the mesh is a solid, not WHICH
    // solid. This is the only test that would catch it.
    const geo = shroudGeometry(SPEC());
    const p = geo.getAttribute('position');
    const zs: number[] = [];
    let topY = -Infinity;
    for (let i = 0; i < p.count; i++) zs.push(p.getZ(i));
    const zMax = Math.max(...zs);
    const zMin = Math.min(...zs);

    expect(zMax).toBeCloseTo(-zMin, 7);

    // THE DISCRIMINATOR: the top spans exactly the same z as the floor.
    // In an annular sector the outer arc is at a larger radius, so it fans
    // WIDER than the floor — the splay that reads as a trapezoid. Straight
    // parallel walls mean one width at every height.
    //
    // (The floor equation below does NOT distinguish the two shapes: an arc
    // parameterisation satisfies y = sqrt(R^2 - z^2) as well. Verified by
    // mutation — reverting the floor alone kept this file green until this
    // assertion existed.)
    let topZ = -Infinity;
    let floorZ = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < p.count; i++) maxY = Math.max(maxY, p.getY(i));
    for (let i = 0; i < p.count; i++) {
      if (Math.abs(p.getY(i) - maxY) < 1e-6) topZ = Math.max(topZ, Math.abs(p.getZ(i)));
      if (p.getY(i) <= 0.027 + 1e-9) floorZ = Math.max(floorZ, Math.abs(p.getZ(i)));
    }
    expect(topZ, 'the top must not fan wider than the floor').toBeCloseTo(floorZ, 7);

    // The TOP is flat: at the tallest station every outer vertex shares one y.
    for (let i = 0; i < p.count; i++) topY = Math.max(topY, p.getY(i));
    const topRow = [];
    for (let i = 0; i < p.count; i++) {
      if (Math.abs(p.getY(i) - topY) < 1e-9) topRow.push(p.getZ(i));
    }
    expect(topRow.length, 'a flat top spans the width at one height')
      .toBeGreaterThan(2);

    // The FLOOR follows the tube's own arc, exactly: every floor vertex
    // satisfies y = sqrt(R^2 - z^2). That single equation IS "conformal", and
    // an annular sector's floor (which fans in z as well) cannot satisfy it.
    const R = 0.027;
    let floorCount = 0;
    let floorMin = Infinity;
    let floorMax = -Infinity;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      const z = p.getZ(i);
      if (y > R + 1e-9) continue;                     // the outer sheet sits above R
      floorCount++;
      floorMin = Math.min(floorMin, y);
      floorMax = Math.max(floorMax, y);
      // 7 places: positions are stored as Float32 in the buffer attribute.
      expect(y).toBeCloseTo(Math.sqrt(R * R - z * z), 7);
    }
    expect(floorCount).toBeGreaterThan(10);
    // …and it genuinely WRAPS: the edges sit lower than the middle.
    expect(floorMax).toBeGreaterThan(floorMin);
    expect(floorMax).toBeLessThanOrEqual(R + 1e-9);
  });

  it('keeps a finite wall at a tapered end — a knife edge is not a solid', () => {
    // A profile running to exactly zero collapses the end cap: zero-area
    // triangles, no normal, and a surface that is no longer closed. That is
    // what produced 52 inconsistently-wound edges before END_WALL existed.
    const geo = shroudGeometry(SPEC({ fore: 'streamlined', aft: 'halfround' }));
    const p = geo.getAttribute('position');
    let foreMin = Infinity, foreMax = 0;
    for (let i = 0; i < p.count; i++) {
      if (p.getX(i) > 1e-9) continue;
      const r = Math.hypot(p.getY(i), p.getZ(i));
      foreMin = Math.min(foreMin, r);
      foreMax = Math.max(foreMax, r);
    }
    // The fore face has real height: its outer edge stands clear of its base.
    expect(foreMax - foreMin).toBeGreaterThan(0);
  });

  it('a flat end is taller at the tip than a streamlined one', () => {
    const maxR = (over: Partial<ShroudMeshSpec>): number => {
      const g = shroudGeometry(SPEC(over));
      const p = g.getAttribute('position');
      let best = 0;
      for (let i = 0; i < p.count; i++) {
        if (p.getX(i) > 1e-9) continue;           // the fore face only
        best = Math.max(best, Math.hypot(p.getY(i), p.getZ(i)));
      }
      return best;
    };
    expect(maxR({ fore: 'box' })).toBeGreaterThan(maxR({ fore: 'streamlined' }) + 1e-4);
  });
});

describe('shroud geometry helpers', () => {
  it('clamps the half-angle instead of returning NaN', () => {
    // The app's own defaults: a 25 mm shroud on a 24 mm tube.
    expect(shroudHalfAngle(0.012, 0.025)).toBeCloseTo(Math.PI / 2, 12);
    expect(Number.isFinite(shroudHalfAngle(0.012, 10))).toBe(true);
    expect(shroudHalfAngle(0, 0.02)).toBe(0);
    expect(shroudHalfAngle(0.027, 0.025)).toBeCloseTo(Math.asin(0.0125 / 0.027), 12);
  });

  it('migrates a pre-v0.088 single shape onto BOTH ends', () => {
    const legacy = { type: 'fairing', fairingShape: 'box' } as unknown as ComponentNode;
    expect(shroudEnds(legacy)).toEqual({ fore: 'box', aft: 'box' });
    // An explicit new field wins over the legacy one.
    const mixed = { type: 'fairing', fairingShape: 'box', fairingAftShape: 'halfround' } as unknown as ComponentNode;
    expect(shroudEnds(mixed)).toEqual({ fore: 'box', aft: 'halfround' });
    // NO shape key at all falls back to HALF-ROUND on both ends — what every
    // reader independently used before v0.088. Falling back to the new default
    // pair instead would change such a shroud's Cd from 0.55 to 0.40 and
    // reshape its strake: a numbers move on a design nobody touched. The new
    // pair belongs to shrouds someone CREATES (defaultParams sets it there).
    expect(shroudEnds({ type: 'fairing' } as unknown as ComponentNode))
      .toEqual({ fore: 'halfround', aft: 'halfround' });
    // Junk falls back rather than reaching a renderer.
    expect(shroudEnds({ type: 'fairing', fairingForeShape: 'banana' } as unknown as ComponentNode).fore)
      .toBe('halfround');
  });

  it('reads an ABSENT conformal flag as true, so old files are conformal too', () => {
    expect(isConformal({ type: 'fairing' } as unknown as ComponentNode)).toBe(true);
    expect(isConformal({ type: 'fairing', conformal: true } as unknown as ComponentNode)).toBe(true);
    expect(isConformal({ type: 'fairing', conformal: false } as unknown as ComponentNode)).toBe(false);
  });

  it('charges a curved-body bump more frontal area than width x height', () => {
    // The exact tangent-gap area, checked against its own closed form at the
    // limit where the bump is as wide as the tube: R^2 (2 - pi/2). Isolated by
    // SUBTRACTING the flat term rather than by setting the height to zero -
    // a zero-height bump is not a bump, and since v0.090 it charges nothing
    // (see the zero-height case below), so H = 0 can no longer be used to
    // expose the crescent.
    const R = 1, W = 2, H = 0.25;
    expect(surfaceBumpFrontalArea(R, W, H) - W * H).toBeCloseTo(2 - Math.PI / 2, 12);

    // The app's default shroud: 25 x 20 mm on a 54 mm body, ~5 % more than W*H.
    const wh = 0.025 * 0.02;
    const got = surfaceBumpFrontalArea(0.027, 0.025, 0.02);
    expect(got).toBeGreaterThan(wh);
    expect((got - wh) / wh).toBeCloseTo(0.050, 3);

    // A narrow bump on a big tube is essentially flat-wall — the correction
    // must vanish, or it would be charging curvature that is not there.
    expect(surfaceBumpFrontalArea(1.0, 0.002, 0.01) / (0.002 * 0.01)).toBeCloseTo(1, 4);

    // NO HEIGHT MEANS NO BUMP, so no crescent under it either. Guarding only
    // the width let a shroud whose height was typed to 0 disappear from all
    // three views and still charge the whole gap term as drag - +0.055 on the
    // rocket's CD from a part that is not there. Both zero cases return 0.
    expect(surfaceBumpFrontalArea(0.0121, 0.024, 0)).toBe(0);
    expect(surfaceBumpFrontalArea(0.0121, 0, 0.008)).toBe(0);
    // …and a hair of height still charges only a hair more than the crescent.
    expect(surfaceBumpFrontalArea(0.0121, 0.024, 1e-9)).toBeGreaterThan(6e-5);
  });
});
