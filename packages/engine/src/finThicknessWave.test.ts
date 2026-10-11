import { describe, expect, it } from 'vitest';
import { OrkRocket, type RocketTree } from './orkEngine.js';

// Fin THICKNESS wave drag on a sharp section (engine-java/patches/LEDGER.md, RASAero feature #1
// Phases 5 and 6, FinSetCalc). For an AIRFOIL cross-section under Rogers Kbf or the Supersonic
// model (and for a named section under the Supersonic model) the fin set's pressure CD is
//   (16/3) tc^2 / beta_eff(M) x sweepWaveFactor(M) x N S / A_ref
// where
//   - thicknessWave (Phase 6): zero to M0.90, a smoothstep to its M1.05 peak, then the 1/beta
//     branch, with beta floored at the transonic-similarity value [(gamma+1) M^2 tc]^(1/3) so it
//     cannot run away near M1. Phase 2-5's linear M0.9-1.2 ramp put the maximum at M1.200.
//   - sweepWaveFactor (Phase 5): simple-sweep relief cos^2(Gamma_LE) only while the leading edge
//     is subsonic-normal, M cos(Gamma) <= 0.90; a smoothstep to 1 by M cos(Gamma) = 1.05; then
//     min(1, max(cos^2, beta cos(Gamma) / beta_n)), which is 1. Phases 2-4 used cos^2 at every Mach.
// No test in this package asserted either shape (orkEngine.test.ts checks only that the Kbf
// AIRFOIL branch is taken and is continuous across M0.9), and difftest has no stored baseline.
//
// The fin set's pressure CD is isolated by subtracting the same rocket without fins.

const R = 0.02;
const CHORD = 0.05;
const SPAN = 0.05;
const THICK = 0.002;
const N = 4;
const TC = THICK / CHORD; // rectangular planform: the MAC is the chord
const GAMMA = 1.4;

type Model = 'kbf' | 'ssOnly' | 'supersonic';

const rocket = (fins: Record<string, unknown> | null): RocketTree => ({
  name: 'Fin wave',
  components: [
    { type: 'nosecone', shape: 'ogive', length: 0.12, aftRadius: R, thickness: 0.002 },
    {
      type: 'bodytube', length: 0.5, outerRadius: R, thickness: 0.001,
      children: fins ? [{
        type: 'trapezoidfinset', finCount: N, rootChord: CHORD, tipChord: CHORD, height: SPAN,
        thickness: THICK, crossSection: 'airfoil', position: { method: 'bottom', offset: 0 }, ...fins,
      }] : [],
    },
  ],
} as unknown as RocketTree);

function pressure(t: RocketTree, model: Model) {
  const r = OrkRocket.buildTree(t);
  r.setRogersModifiedBarrowman(model !== 'ssOnly');
  r.setSupersonicAero(model !== 'kbf');
  const s = r.dragSweep({ machMin: 0.5, machMax: 5, machStep: 0.05 });
  return { machs: s.machs, p: s.powerOff.pressure };
}

function finPressure(fins: Record<string, unknown>, model: Model) {
  const a = pressure(rocket(fins), model);
  const b = pressure(rocket(null), model);
  return { machs: a.machs, cd: a.p.map((v, i) => v - b.p[i]!) };
}

const betaEff = (m: number) => Math.max(Math.sqrt(m * m - 1), Math.cbrt((GAMMA + 1) * m * m * TC));
function thicknessWave(m: number): number {
  if (m <= 0.9) return 0;
  const k = (16 / 3) * TC * TC;
  if (m >= 1.05) return k / betaEff(m);
  const t = (m - 0.9) / 0.15;
  return (k / betaEff(1.05)) * t * t * (3 - 2 * t);
}
function sweepWaveFactor(m: number, cosG: number): number {
  const c2 = cosG * cosG;
  const mn = m * cosG;
  if (mn <= 0.9) return c2;
  if (mn < 1.05) {
    const t = (mn - 0.9) / 0.15;
    return c2 + (1 - c2) * t * t * (3 - 2 * t);
  }
  return Math.min(1, Math.max(c2, Math.sqrt(m * m - 1) * cosG / Math.sqrt(mn * mn - 1)));
}
const AREA = N * CHORD * SPAN / (Math.PI * R * R);

describe('fin thickness wave drag: transonic shape (Phase 6) and LE-sonic sweep fade (Phase 5)', () => {
  it('an unswept sharp fin rises from zero at M0.90 to a peak at M1.05, then follows the floored 1/beta branch', () => {
    for (const model of ['kbf', 'ssOnly', 'supersonic'] as const) {
      const f = finPressure({ sweep: 0 }, model);
      let iMax = 0;
      f.machs.forEach((m, i) => {
        const want = thicknessWave(m) * AREA;
        expect(Math.abs(f.cd[i]! - want), `${model} M${m.toFixed(2)}`).toBeLessThan(1e-12 + 1e-9 * want);
        if (f.cd[i]! > f.cd[iMax]!) iMax = i;
      });
      // The maximum sits at the M1.05 peak, not at the M1.20 top of the old ramp.
      expect(Math.abs(f.machs[iMax]! - 1.05), `${model} peak Mach`).toBeLessThan(1e-9);
    }
  }, 30_000);

  it('a swept fin keeps cos^2 relief only while its leading edge is subsonic-normal', () => {
    // tan(Gamma_LE) = 3 (NACA RM A53D02's fins): cos^2 = 0.1, LE sonic from M2.85 to 3.32.
    const sweepLen = 3 * SPAN;
    const cosG = 1 / Math.sqrt(10);
    for (const model of ['kbf', 'ssOnly', 'supersonic'] as const) {
      const swept = finPressure({ sweep: sweepLen }, model);
      swept.machs.forEach((m, i) => {
        const want = thicknessWave(m) * sweepWaveFactor(m, cosG) * AREA;
        expect(Math.abs(swept.cd[i]! - want), `${model} swept M${m.toFixed(2)}`).toBeLessThan(1e-12 + 1e-9 * want);
      });
      const at = (m: number) => swept.machs.findIndex((x) => Math.abs(x - m) < 1e-9);
      const straight = finPressure({ sweep: 0 }, model);
      // Fully relieved below the LE-sonic band, no relief at all above it.
      expect(swept.cd[at(2)]! / straight.cd[at(2)]! - 0.1).toBeCloseTo(0, 9);
      expect(swept.cd[at(4)]! / straight.cd[at(4)]! - 1).toBeCloseTo(0, 9);
    }
  }, 30_000);

  it('a NAMED sharp section takes the same shape and sweep fade under the Supersonic model', () => {
    // biconvex: factor 16/3, sharp edges, no base - the sectionPressureCD path, whose wave and
    // sweep terms are wrapped in `supersonicAero` (Kbf keeps the older ramp there).
    for (const sweep of [0, 3 * SPAN]) {
      const named = finPressure({ sweep, airfoilSection: 'biconvex' }, 'supersonic');
      const plain = finPressure({ sweep }, 'supersonic');
      named.cd.forEach((v, i) => {
        expect(Math.abs(v - plain.cd[i]!), `sweep ${sweep} M${named.machs[i]!.toFixed(2)}`)
          .toBeLessThan(1e-12 + 1e-9 * Math.abs(plain.cd[i]!));
      });
    }
  }, 30_000);
});
