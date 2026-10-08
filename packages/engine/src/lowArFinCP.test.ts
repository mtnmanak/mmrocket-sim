import { describe, expect, it } from 'vitest';
import { OrkRocket, type RocketTree } from './orkEngine.js';

// OpenRocket #3196 / PR #3262 (and #3235, which #3262 supersedes): the fin and tube-fin CP along
// the MAC used (AR*beta - 0.67)/(2*AR*beta - 1) above Mach 2, which has a pole at AR*beta = 0.5,
// and between Mach 0.5 and 2 a fifth-order polynomial whose rounded coefficients share the
// denominator (1 - 3.4641*AR)^2 (singular at AR ~ 0.2887). Tube fins never filled that polynomial
// at all, so their transonic CP sat at the tube's leading edge. Eric's 2026-10-08 ruling
// (decision 70) applies the bounded replacement in every aero model, Classic included.
//
// Requires the rebuilt kernel (npm run engine:js). The FIN's own CP is isolated exactly through
// the shipped bridge: at zero AoA a cylinder carries no normal force and the nose's CNa does not
// depend on the fins, so finCP = (cp*W - cp0*W0) / (W - W0) with cp0/W0 from the same rocket
// without its fins. Rectangular unswept fins make the MAC the root chord, so the CP fraction is
// 0.25 + (finCP(M) - finCP(0.3)) / chord.

type Model = 'classic' | 'kbf' | 'supersonic' | 'hybrid';
const MODELS: Model[] = ['classic', 'kbf', 'supersonic', 'hybrid'];
const R = 0.0125;

function tree(fins?: Record<string, unknown>): RocketTree {
  return {
    name: 'lowAR',
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

/** The kernel's CP x is `number | null` (null only where the force-consistent CP is undefined above 20 deg). */
function finite(v: number | null | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Expected finite kernel value');
  return v;
}

/** Absolute x of the fin set's own CP at each Mach (metres), isolated by subtraction. */
function finCP(fins: Record<string, unknown>, machs: number[], model: Model): number[] {
  const withFins = build(tree(fins), model).forceSamples(machs);
  const bare = build(tree(), model).forceSamples(machs);
  return machs.map((_, i) => {
    const [cp, , , w] = withFins[i]!;
    const [cp0, , , w0] = bare[i]!;
    return (finite(cp) * w - finite(cp0) * w0) / (w - w0);
  });
}

/** CP fraction of the chord, referenced to the quarter chord at Mach 0.3. */
function relativeCP(fins: Record<string, unknown>, chord: number, machs: number[], model: Model): number[] {
  const x = finCP(fins, [0.3, ...machs], model);
  return x.slice(1).map((v) => 0.25 + (v - x[0]!) / chord);
}

const range = (lo: number, hi: number, step: number) =>
  Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => lo + i * step);

// Rectangular unswept trapezoid: AR = 2*height/chord.
const CHORD = 0.06;
const rect = (ar: number) => ({
  type: 'trapezoidfinset', id: 'fins', finCount: 3,
  rootChord: CHORD, tipChord: CHORD, sweep: 0, height: (ar * CHORD) / 2, thickness: 0.002,
});

// A transcription of the regularised curve (upstream RocketComponentCalc), used ONLY as the
// Classic contract: quarter chord below AR*beta 0.84, a cubic Hermite bridge to the source
// formula at AR*beta = 1, the source formula above.
const X0 = (0.67 - 0.25) / (1 - 2 * 0.25);
const src = (x: number) => (x - 0.67) / (2 * x - 1);
const srcD = (x: number) => (2 * 0.67 - 1) / ((2 * x - 1) ** 2);
function g(x: number): number {
  if (x <= X0) return 0.25;
  if (x >= 1) return src(x);
  const w = 1 - X0;
  const t = (x - X0) / w;
  return (2 * t ** 3 - 3 * t ** 2 + 1) * 0.25 + (-2 * t ** 3 + 3 * t ** 2) * src(1) + (t ** 3 - t ** 2) * w * srcD(1);
}

function expectBoundedSmoothMonotone(rel: number[], machs: number[], label: string, monotone = true) {
  for (let i = 0; i < rel.length; i++) {
    const m = machs[i]!.toFixed(2);
    expect(Number.isFinite(rel[i]), `${label} finite at M${m}`).toBe(true);
    expect(rel[i], `${label} not ahead of the quarter chord at M${m}`).toBeGreaterThanOrEqual(0.25 - 1e-9);
    expect(rel[i], `${label} not past mid-chord at M${m}`).toBeLessThanOrEqual(0.5);
    if (i === 0) continue;
    // A 0.01 Mach step may not move the CP by a hundredth of the chord.
    expect(Math.abs(rel[i]! - rel[i - 1]!), `${label} step at M${m}`).toBeLessThan(0.01);
    if (monotone) expect(rel[i]!, `${label} moved forward at M${m}`).toBeGreaterThanOrEqual(rel[i - 1]! - 1e-9);
  }
}

describe('#3196/#3262 + #3235: bounded fin and tube-fin CP at low aspect ratio', { timeout: 60_000 }, () => {
  const sweep = range(0.3, 5.5, 0.01);

  it('AR 0.2 fins pass through the old AR*beta = 0.5 pole (M~2.69) finite, smooth and aft-moving', () => {
    const rel = relativeCP(rect(0.2), CHORD, sweep, 'classic');
    expectBoundedSmoothMonotone(rel, sweep, 'AR0.2');
    // AR*beta = 0.2*sqrt(15) = 0.775 < 0.84 at M4: the quarter-chord fallback, not the source branch.
    expect(rel[sweep.findIndex((m) => Math.abs(m - 4) < 1e-9)]!).toBeCloseTo(0.25, 9);
    // AR*beta = 0.2*sqrt(26.04) = 1.02 at M5.2: rejoined the source formula.
    expect(rel[sweep.findIndex((m) => Math.abs(m - 5.2) < 1e-9)]!).toBeGreaterThan(0.25);
  });

  it('AR 0.29 fins (old transonic denominator ~0) stay between their endpoints', () => {
    const machs = range(0.5, 2.0, 0.01);
    expectBoundedSmoothMonotone(relativeCP(rect(0.29), CHORD, machs, 'classic'), machs, 'AR0.29');
  });

  it('AR 0.6 fins: no forward excursion in the transonic interpolation', () => {
    const machs = range(0.5, 2.0, 0.01);
    expectBoundedSmoothMonotone(relativeCP(rect(0.6), CHORD, machs, 'classic'), machs, 'AR0.6');
  });

  it('Classic follows the regularised curve above Mach 2 and the source formula at ordinary AR', () => {
    const machs = range(2, 5.5, 0.25);
    for (const ar of [0.2, 0.35, 0.6, 2.5]) {
      const rel = relativeCP(rect(ar), CHORD, machs, 'classic');
      machs.forEach((m, i) => {
        expect(rel[i], `AR${ar} M${m}`).toBeCloseTo(g(ar * Math.sqrt(m * m - 1)), 9);
      });
    }
  });

  it('Classic CP is continuous in Mach at 0.5 and 2 for low and ordinary AR', () => {
    for (const ar of [0.2, 0.29, 0.6, 2.5]) {
      const [a, b, c, d] = relativeCP(rect(ar), CHORD, [0.4999, 0.5001, 1.9999, 2.0001], 'classic');
      expect(Math.abs(b! - a!), `AR${ar} at M0.5`).toBeLessThan(1e-4);
      expect(Math.abs(d! - c!), `AR${ar} at M2`).toBeLessThan(1e-4);
    }
  });

  describe('tube fins', () => {
    // AR = 2*innerRadius/chord; inner = outer - wall.
    const tubes = (outer: number) => ({
      type: 'tubefinset', id: 'fins', finCount: 6, length: 0.05, outerRadius: outer, thickness: 0.002,
    });

    for (const [outer, ar] of [[0.007, 0.2], [0.027, 1]] as const) {
      it(`AR ${ar}: transonic CP is no longer pinned to the tube's leading edge`, () => {
        for (const model of MODELS) {
          const rel = relativeCP(tubes(outer), 0.05, sweep, model);
          expectBoundedSmoothMonotone(rel, sweep, `tube AR${ar} ${model}`);
        }
      });
    }
  });

  describe('freeform fins with rounded and airfoil sections, every model', () => {
    // Root 0.08, tip 0.04, span 6 mm: area 3.6e-4 m^2, AR = 2*span^2/area = 0.2 (pole at M~2.69).
    const freeform = (crossSection: string) => ({
      type: 'freeformfinset', id: 'fins', finCount: 3, thickness: 0.002, crossSection,
      points: [[0, 0], [0.02, 0.006], [0.06, 0.006], [0.08, 0]],
    });
    for (const section of ['rounded', 'airfoil']) {
      it(`${section}: finite and inside the root chord through Mach 5.5`, () => {
        for (const model of MODELS) {
          const x = finCP(freeform(section), sweep, model);
          const x0 = x[0]!; // Mach 0.3
          x.forEach((v, i) => {
            const m = sweep[i]!.toFixed(2);
            expect(Number.isFinite(v), `${section} ${model} finite at M${m}`).toBe(true);
            // MAC quarter chord at M0.3; the CP may move aft of it by at most half the root chord.
            expect(v - x0, `${section} ${model} ahead at M${m}`).toBeGreaterThan(-0.002);
            expect(v - x0, `${section} ${model} aft at M${m}`).toBeLessThan(0.04);
            if (i > 0) expect(Math.abs(v - x[i - 1]!), `${section} ${model} step at M${m}`).toBeLessThan(0.0008);
          });
        }
      });
    }
  });
});
