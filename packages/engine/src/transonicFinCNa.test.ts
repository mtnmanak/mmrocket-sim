import { describe, expect, it } from 'vitest';
import { OrkRocket, type RocketTree } from './orkEngine.js';

// OpenRocket #3236: between Mach 0.9 and 1.5 FinSetCalc.calculateFinCNa1 bridges the subsonic and
// supersonic fin normal-force slopes with a quartic (PolyInterpolator: value and slope at both
// ends, zero curvature at 0.9). Its lower-end slope, d(CNa)/dM of the subsonic formula at M0.9,
// was written with the QUERIED Mach in place of 0.9, so the "endpoint" data moved with every
// query and the curve was not the interpolant it claims to be. Eric's 2026-10-08 ruling
// (decision 70) applies the fix in every aero model, Classic included.
//
// Requires the rebuilt kernel (npm run engine:js). The fin set's own CNa is isolated through the
// shipped bridge as (rocket with fins) - (same rocket without them): at zero AoA the body tube
// carries no normal force and the nose does not depend on the fins. Every multiplier the kernel
// applies to the single-fin value (fin count, body interference, the Kbf carryover, the NACA-1307
// split) is Mach-independent, so the isolated CNa is a constant times calculateFinCNa1 and the
// interpolation contract can be checked on it directly.

type Model = 'classic' | 'kbf' | 'supersonic' | 'hybrid';
const R = 0.0125;
const M_SUB = 0.9;
const M_SUP = 1.5;

function tree(fins?: Record<string, unknown>): RocketTree {
  return {
    name: 'transonicCNa',
    components: [
      { type: 'nosecone', id: 'nose', length: 0.1, aftRadius: R, thickness: 0.002 },
      {
        type: 'bodytube', id: 'body', length: 0.3, outerRadius: R, thickness: 0.0005,
        children: fins ? [{ position: { method: 'bottom', offset: 0 }, ...fins }] : [],
      },
    ],
  } as RocketTree;
}

function build(t: RocketTree, model: Model): OrkRocket {
  const r = OrkRocket.buildTree(t);
  r.setRogersModifiedBarrowman(model !== 'classic');
  r.setSupersonicAero(model === 'supersonic');
  r.setHybridAero(model === 'hybrid');
  return r;
}

/** The fin set's CNa (per radian, kernel reference area) at each Mach. */
function finCNa(fins: Record<string, unknown>, machs: number[], model: Model): number[] {
  const withFins = build(tree(fins), model).forceSamples(machs);
  const bare = build(tree(), model).forceSamples(machs);
  return machs.map((_, i) => withFins[i]![3] - bare[i]![3]);
}

/**
 * The quartic PolyInterpolator builds from (v0, d0, curvature 0) at M0.9 and (v1, d1) at M1.5,
 * written in u = M - 0.9: p = v0 + d0*u + a3*u^3 + a4*u^4.
 */
function quartic(v0: number, d0: number, v1: number, d1: number) {
  const h = M_SUP - M_SUB;
  const r1 = v1 - v0 - d0 * h; // a3 h^3 + a4 h^4
  const r2 = d1 - d0; //           3 a3 h^2 + 4 a4 h^3
  const a4 = (r2 * h - 3 * r1) / h ** 4;
  const a3 = (r1 - a4 * h ** 4) / h ** 3;
  return (m: number) => {
    const u = m - M_SUB;
    return v0 + d0 * u + a3 * u ** 3 + a4 * u ** 4;
  };
}

/** Second-order one-sided (backward) derivative at x from f(x), f(x-h), f(x-2h). */
const backD = (f0: number, f1: number, f2: number, h: number) => (3 * f0 - 4 * f1 + f2) / (2 * h);
/** Second-order one-sided (forward) derivative at x from f(x), f(x+h), f(x+2h). */
const fwdD = (f0: number, f1: number, f2: number, h: number) => (-3 * f0 + 4 * f1 - f2) / (2 * h);

const H = 2e-4;
const INTERIOR = Array.from({ length: 29 }, (_, i) => M_SUB + 0.02 * (i + 1)); // 0.92 .. 1.48

/**
 * The fixed endpoint data, measured from the model itself: CNa at both ends, the subsonic
 * formula's slope at 0.9 by a backward difference on the subsonic side, and the slope the kernel
 * writes at 1.5 - superD/superV = -(2M/beta^3)/(2/beta) = -M/beta^2 = -1.2 at M1.5 for the K1
 * (alpha = 0) term the bridge carries (Supersonic multiplies both by the same ssaeroScale(1.5)).
 */
function endpointData(fins: Record<string, unknown>, model: Model) {
  const [v0, a, b, v1] = finCNa(fins, [M_SUB, M_SUB - H, M_SUB - 2 * H, M_SUP], model);
  return { v0: v0!, d0: backD(v0!, a!, b!, H), v1: v1!, d1: -1.2 * v1! };
}

// Rectangular unswept fins: span = height, area = chord * height, cos(mid-chord sweep) = 1, so
// k = span^2 / (area cos) = height / chord and the subsonic slope at 0.9 is analytic:
// d0 / v0 = 0.9 k^2 / (sq (1 + sq)), sq = sqrt(1 + (1 - 0.81) k^2).
const CHORD = 0.05;
const rect = (height: number) => ({
  type: 'trapezoidfinset', id: 'fins', finCount: 3,
  rootChord: CHORD, tipChord: CHORD, sweep: 0, height, thickness: 0.002,
});
const freeform = (crossSection: string) => ({
  type: 'freeformfinset', id: 'fins', finCount: 4, thickness: 0.003, crossSection,
  points: [[0, 0], [0.025, 0.04], [0.055, 0.04], [0.07, 0]],
});

describe('#3236: transonic fin CNa interpolates from FIXED endpoint data', { timeout: 60_000 }, () => {
  it('the subsonic slope at M0.9 is the analytic one (finite-difference check of the endpoint)', () => {
    for (const height of [0.02, 0.04, 0.08]) {
      const k = height / CHORD;
      const sq = Math.sqrt(1 + (1 - M_SUB * M_SUB) * k * k);
      for (const model of ['classic', 'kbf', 'supersonic'] as const) {
        const { v0, d0 } = endpointData(rect(height), model);
        expect(d0 / v0, `h${height} ${model}`).toBeCloseTo(M_SUB * k * k / (sq * (1 + sq)), 6);
      }
    }
  });

  for (const model of ['classic', 'kbf', 'supersonic'] as const) {
    it(`${model}: every interior Mach lies on the one quartic the endpoint data define`, () => {
      for (const height of [0.02, 0.04, 0.08]) {
        const { v0, d0, v1, d1 } = endpointData(rect(height), model);
        const q = quartic(v0, d0, v1, d1);
        const got = finCNa(rect(height), INTERIOR, model);
        INTERIOR.forEach((m, i) => {
          expect(Math.abs(got[i]! / q(m) - 1), `h${height} M${m.toFixed(2)}`).toBeLessThan(1e-7);
        });
      }
    });
  }

  it('the interpolant meets its endpoint data: values and slopes at 0.9 and 1.5 (classic)', () => {
    const fins = rect(0.04);
    const { v0, d0, v1, d1 } = endpointData(fins, 'classic');
    const [f0, f1, f2, g0, g1, g2] = finCNa(fins,
      [M_SUB + 1e-9, M_SUB + H, M_SUB + 2 * H, M_SUP - 1e-9, M_SUP - H, M_SUP - 2 * H], 'classic');
    expect(Math.abs(f0! / v0 - 1)).toBeLessThan(1e-7);
    expect(Math.abs(g0! / v1 - 1)).toBeLessThan(1e-7);
    // Slopes from inside the bridge, one-sided: second-order stencils, so O(H^2) error.
    expect(fwdD(f0!, f1!, f2!, H) / d0).toBeCloseTo(1, 4);
    expect(backD(g0!, g1!, g2!, H) / d1).toBeCloseTo(1, 4);
  });

  for (const section of ['rounded', 'airfoil']) {
    it(`freeform ${section} fins, Classic/Kbf/Supersonic: on the fixed-endpoint quartic`, () => {
      for (const model of ['classic', 'kbf', 'supersonic'] as const) {
        const { v0, d0, v1, d1 } = endpointData(freeform(section), model);
        const q = quartic(v0, d0, v1, d1);
        const got = finCNa(freeform(section), INTERIOR, model);
        INTERIOR.forEach((m, i) => {
          expect(Math.abs(got[i]! / q(m) - 1), `${section} ${model} M${m.toFixed(2)}`).toBeLessThan(1e-7);
        });
      }
    });
  }

  it('Hybrid blends the two corrected endpoint models (rect and freeform)', () => {
    // Hybrid's default band is M0.8-1.2: smoothstep weight on Supersonic, Kbf below the band,
    // Supersonic above it. Its fin CNa is that mix of the two endpoint calculators' values.
    const w = (m: number) => {
      const t = Math.min(1, Math.max(0, (m - 0.8) / 0.4));
      return t * t * (3 - 2 * t);
    };
    for (const fins of [rect(0.04), freeform('rounded'), freeform('airfoil')]) {
      const k = endpointData(fins, 'kbf');
      const s = endpointData(fins, 'supersonic');
      const qk = quartic(k.v0, k.d0, k.v1, k.d1);
      const qs = quartic(s.v0, s.d0, s.v1, s.d1);
      const got = finCNa(fins, INTERIOR, 'hybrid');
      INTERIOR.forEach((m, i) => {
        const want = (1 - w(m)) * qk(m) + w(m) * qs(m);
        expect(Math.abs(got[i]! / want - 1), `${String(fins.type)} M${m.toFixed(2)}`).toBeLessThan(1e-7);
      });
    }
  });
});
