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
function finCNa(fins: Record<string, unknown>, machs: number[], model: Model, aoa = 0): number[] {
  const withFins = build(tree(fins), model).forceSamples(machs, aoa);
  const bare = build(tree(), model).forceSamples(machs, aoa);
  return machs.map((_, i) => withFins[i]![3] - bare[i]![3]);
}

/**
 * The quartic PolyInterpolator builds from (v0, d0, curvature 0) at M0.9 and (v1, d1) at the top
 * of the bridge, written in u = M - 0.9: p = v0 + d0*u + a3*u^3 + a4*u^4. The top is M1.5 for
 * Classic and Kbf; for Supersonic it is the fin's own linear-theory validity Mach (see topMach).
 */
function quartic(v0: number, d0: number, v1: number, d1: number, top = M_SUP) {
  const h = top - M_SUB;
  const r1 = v1 - v0 - d0 * h; // a3 h^3 + a4 h^4
  const r2 = d1 - d0; //           3 a3 h^2 + 4 a4 h^3
  const a4 = (r2 * h - 3 * r1) / h ** 4;
  const a3 = (r1 - a4 * h ** 4) / h ** 3;
  return (m: number) => {
    const u = m - M_SUB;
    return v0 + d0 * u + a3 * u ** 3 + a4 * u ** 4;
  };
}

/**
 * Top of the transonic bridge (board row 88, 2026-10-11): Classic/Kbf keep M1.5; Supersonic
 * starts its analytic branch where the tip-corrected linear result is exact for a rectangular
 * wing, A*beta = 1, i.e. M = sqrt(1 + 1/A^2), floored at M1.2 and capped at M1.5. A is the
 * kernel's two-panel aspect ratio 2*span^2/area.
 */
function topMach(ar: number, model: Model): number {
  if (model !== 'supersonic') return M_SUP;
  return Math.min(M_SUP, Math.max(1.2, Math.sqrt(1 + 1 / (ar * ar))));
}

/** Second-order one-sided (backward) derivative at x from f(x), f(x-h), f(x-2h). */
const backD = (f0: number, f1: number, f2: number, h: number) => (3 * f0 - 4 * f1 + f2) / (2 * h);
/** Second-order one-sided (forward) derivative at x from f(x), f(x+h), f(x+2h). */
const fwdD = (f0: number, f1: number, f2: number, h: number) => (-3 * f0 + 4 * f1 - f2) / (2 * h);

const H = 2e-4;
const INTERIOR = Array.from({ length: 29 }, (_, i) => M_SUB + 0.02 * (i + 1)); // 0.92 .. 1.48
/** The interior grid that lies strictly inside a bridge ending at `top`. */
const inside = (top: number) => INTERIOR.filter((m) => m < top - 1e-9);

/**
 * The fixed endpoint data, measured from the model itself: CNa at both ends, the subsonic
 * formula's slope at 0.9 by a backward difference on the subsonic side, and the slope at the top.
 * Classic/Kbf write superD/superV = -(2M/beta^3)/(2/beta) = -M/beta^2 = -1.2 at M1.5 for the K1
 * (alpha = 0) term the bridge carries. Supersonic's top slope is measured on the analytic branch
 * itself: at alpha = 0 the branch is C * scale(M) * K1(M), so d1/v1 = scale'/scale + K1'/K1 =
 * [M/(A beta^3)]/scale - M/beta^2 (the first term 0 where the scale is floored). A bridge whose top
 * slope drops the scale's term (the held superD defect, wt/superd) cannot pass the interior check.
 */
function ssLogSlope(ar: number, m: number): number {
  const beta = Math.sqrt(m * m - 1);
  const corr = 1 - 1 / (2 * ar * beta);
  const scale = 2 * Math.max(corr, 0.25);
  const dScale = corr > 0.25 ? m / (ar * beta ** 3) : 0;
  return dScale / scale - m / (beta * beta);
}
function endpointData(fins: Fins, model: Model) {
  const top = topMach(fins.ar, model);
  const [v0, a, b, v1] = finCNa(fins.def, [M_SUB, M_SUB - H, M_SUB - 2 * H, top], model);
  const d1 = model === 'supersonic' ? v1! * ssLogSlope(fins.ar, top) : -1.2 * v1!;
  return { v0: v0!, d0: backD(v0!, a!, b!, H), v1: v1!, d1, top };
}

// Rectangular unswept fins: span = height, area = chord * height, cos(mid-chord sweep) = 1, so
// k = span^2 / (area cos) = height / chord and the subsonic slope at 0.9 is analytic:
// d0 / v0 = 0.9 k^2 / (sq (1 + sq)), sq = sqrt(1 + (1 - 0.81) k^2).
const CHORD = 0.05;
type Fins = { def: Record<string, unknown>; ar: number };
const rect = (height: number): Fins => ({
  def: {
    type: 'trapezoidfinset', id: 'fins', finCount: 3,
    rootChord: CHORD, tipChord: CHORD, sweep: 0, height, thickness: 0.002,
  },
  ar: (2 * height) / CHORD,
});
// Planform area (0.07 + 0.03) / 2 * 0.04 = 0.002, span 0.04: A = 2 * 0.0016 / 0.002 = 1.6.
const freeform = (crossSection: string): Fins => ({
  def: {
    type: 'freeformfinset', id: 'fins', finCount: 4, thickness: 0.003, crossSection,
    points: [[0, 0], [0.025, 0.04], [0.055, 0.04], [0.07, 0]],
  },
  ar: 1.6,
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
      for (const height of [0.02, 0.025, 0.04, 0.08]) {
        const { v0, d0, v1, d1, top } = endpointData(rect(height), model);
        const q = quartic(v0, d0, v1, d1, top);
        const ms = inside(top);
        const got = finCNa(rect(height).def, ms, model);
        ms.forEach((m, i) => {
          expect(Math.abs(got[i]! / q(m) - 1), `h${height} M${m.toFixed(2)}`).toBeLessThan(1e-7);
        });
      }
    });
  }

  it('the interpolant meets its endpoint data: values and slopes at 0.9 and 1.5 (classic)', () => {
    const fins = rect(0.04);
    const { v0, d0, v1, d1 } = endpointData(fins, 'classic');
    const [f0, f1, f2, g0, g1, g2] = finCNa(fins.def,
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
        const { v0, d0, v1, d1, top } = endpointData(freeform(section), model);
        const q = quartic(v0, d0, v1, d1, top);
        const ms = inside(top);
        const got = finCNa(freeform(section).def, ms, model);
        ms.forEach((m, i) => {
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
      const qk = quartic(k.v0, k.d0, k.v1, k.d1, k.top);
      const qs = quartic(s.v0, s.d0, s.v1, s.d1, s.top);
      // Inside both bridges and inside Hybrid's blend band (above M1.2 Hybrid IS Supersonic).
      const ms = inside(Math.min(k.top, s.top));
      const got = finCNa(fins.def, ms, 'hybrid');
      ms.forEach((m, i) => {
        const want = (1 - w(m)) * qk(m) + w(m) * qs(m);
        expect(Math.abs(got[i]! / want - 1), `${String(fins.def.type)} M${m.toFixed(2)}`).toBeLessThan(1e-7);
      });
    }
  });
});

// The rebuilt Supersonic bridge (board row 88, 2026-10-11; folds in the held superD fix). The
// analytic branch is ssaeroScale(M) * (K1 + K2 a + K3 a^2) with ssaeroScale = 2 - 1/(A beta)
// (floored at 0.5); it now starts at topMach(A) and the quartic meets it with the branch's own
// slope, the alpha terms' slopes included.
describe('Supersonic transonic bridge: per-fin top, C1 at the join', { timeout: 60_000 }, () => {
  // Rectangles A = 0.4 (scale floored), 0.8 (top 1.5), 1.0 (top sqrt 2), 1.6 and 3.2 (top 1.2).
  const HEIGHTS = [0.01, 0.02, 0.025, 0.04, 0.08];

  it('above the top the fin CNa IS the analytic branch (alpha = 0): CNa * beta / scale is constant', () => {
    for (const height of HEIGHTS) {
      const fins = rect(height);
      const top = topMach(fins.ar, 'supersonic');
      const ms = [top, top + 0.07, top + 0.31, 2.4];
      const got = finCNa(fins.def, ms, 'supersonic');
      const level = ms.map((m, i) => {
        const beta = Math.sqrt(m * m - 1);
        const scale = 2 * Math.max(1 - 1 / (2 * fins.ar * beta), 0.25);
        return (got[i]! * beta) / (2 * scale);
      });
      level.forEach((l) => expect(Math.abs(l / level[0]! - 1), `A${fins.ar}`).toBeLessThan(1e-9));
    }
  });

  for (const aoaDeg of [0, 2]) {
    it(`the bridge's slope just below the top equals the branch's just above it (AoA ${aoaDeg} deg)`, () => {
      const aoa = (aoaDeg * Math.PI) / 180;
      for (const height of HEIGHTS) {
        const fins = rect(height);
        const top = topMach(fins.ar, 'supersonic');
        const [b0, b1, b2, s0, s1, s2] = finCNa(fins.def,
          [top - 1e-9, top - H, top - 2 * H, top, top + H, top + 2 * H], 'supersonic', aoa);
        // Continuous in value, and in slope to the stencils' O(H^2). The slope is compared on the
        // value's scale, not as a ratio: at A = 1 the branch peaks exactly at its top (M sqrt 2,
        // where scale'/scale = -K1'/K1), so both one-sided slopes are ~0 there.
        expect(Math.abs(b0! / s0! - 1), `A${fins.ar} value`).toBeLessThan(1e-6);
        const gap = Math.abs(backD(b0!, b1!, b2!, H) - fwdD(s0!, s1!, s2!, H)) / s0!;
        expect(gap, `A${fins.ar} slope`).toBeLessThan(1e-3);
      }
    });
  }

  it('Classic and Kbf are untouched: their bridge still ends at M1.5 for every aspect ratio', () => {
    for (const model of ['classic', 'kbf'] as const) {
      for (const height of HEIGHTS) {
        const { v0, d0, v1, d1, top } = endpointData(rect(height), model);
        expect(top).toBe(M_SUP);
        const q = quartic(v0, d0, v1, d1, top);
        const got = finCNa(rect(height).def, [1.25, 1.45], model);
        [1.25, 1.45].forEach((m, i) => expect(Math.abs(got[i]! / q(m) - 1)).toBeLessThan(1e-7));
      }
    }
  });
});
