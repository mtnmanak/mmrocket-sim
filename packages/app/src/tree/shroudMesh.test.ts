import { describe, expect, it } from 'vitest';
import { shroudGeometry, type ShroudMeshSpec } from './shroudMesh.js';
import { surfaceBumpFrontalArea, shroudHalfAngle, shroudEnds, isConformal } from './shroud.js';
import type { ComponentNode } from '@online-openrocket/engine';

/**
 * The shroud shell (v0.088). These are not cosmetic checks: `Rocket3D.buildPieces`
 * IS the OBJ and glTF export, so a non-manifold or inside-out mesh here ships a
 * file that renders fine on screen and fails in a slicer, with nothing else in
 * the suite covering it.
 */

const SPEC = (over: Partial<ShroudMeshSpec> = {}): ShroudMeshSpec => ({
  length: 0.08, width: 0.025, height: 0.02, bodyRadius: 0.027,
  conformal: true, fore: 'streamlined', aft: 'halfround', ...over,
});

/** Every triangle edge, keyed undirected. A closed surface uses each twice. */
function edgeUse(geo: ReturnType<typeof shroudGeometry>): Map<string, number> {
  const idx = geo.getIndex()!;
  const uses = new Map<string, number>();
  for (let t = 0; t < idx.count; t += 3) {
    const v = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
    for (let e = 0; e < 3; e++) {
      const a = v[e]!, b = v[(e + 1) % 3]!;
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      uses.set(k, (uses.get(k) ?? 0) + 1);
    }
  }
  return uses;
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
      // Closed: no edge used once (a hole) or three+ times (a fold).
      const bad = [...edgeUse(geo).values()].filter((n) => n !== 2);
      expect(bad, `${bad.length} non-manifold edges`).toHaveLength(0);
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
    // No shape at all: the new default pair, NOT options[0] twice.
    expect(shroudEnds({ type: 'fairing' } as unknown as ComponentNode))
      .toEqual({ fore: 'streamlined', aft: 'halfround' });
    // Junk falls back rather than reaching a renderer.
    expect(shroudEnds({ type: 'fairing', fairingForeShape: 'banana' } as unknown as ComponentNode).fore)
      .toBe('streamlined');
  });

  it('reads an ABSENT conformal flag as true, so old files are conformal too', () => {
    expect(isConformal({ type: 'fairing' } as unknown as ComponentNode)).toBe(true);
    expect(isConformal({ type: 'fairing', conformal: true } as unknown as ComponentNode)).toBe(true);
    expect(isConformal({ type: 'fairing', conformal: false } as unknown as ComponentNode)).toBe(false);
  });

  it('charges a curved-body bump more frontal area than width x height', () => {
    // The exact tangent-gap area, checked against its own closed form at the
    // limit where the bump is as wide as the tube: R^2 (2 - pi/2).
    const R = 1, W = 2, H = 0;
    expect(surfaceBumpFrontalArea(R, W, H)).toBeCloseTo(2 - Math.PI / 2, 12);

    // The app's default shroud: 25 x 20 mm on a 54 mm body, ~5 % more than W*H.
    const wh = 0.025 * 0.02;
    const got = surfaceBumpFrontalArea(0.027, 0.025, 0.02);
    expect(got).toBeGreaterThan(wh);
    expect((got - wh) / wh).toBeCloseTo(0.050, 3);

    // A narrow bump on a big tube is essentially flat-wall — the correction
    // must vanish, or it would be charging curvature that is not there.
    expect(surfaceBumpFrontalArea(1.0, 0.002, 0.01) / (0.002 * 0.01)).toBeCloseTo(1, 4);
  });
});
