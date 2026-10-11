import { describe, expect, it } from 'vitest';
import { OrkRocket, type RocketTree } from './orkEngine.js';

// RASAero feature #1 Phase 1 (engine-java/patches/LEDGER.md), FinSetCalc: the classic kernel's
// supersonic fin slope is the single-surface Busemann K1 = 2/beta, HALF of 2D linear theory. The
// Supersonic model scales it by ssaeroScale = 2 (1 - 1/(2 AR beta)), the 4/beta level with the
// finite-span tip correction, floored at 2 x 0.25 for very low AR*beta - and replaces Barrowman's
// (1 + tau) interference with NACA 1307's K_W(B) + fa K_B(W). orkEngine.test.ts asserts only that
// the whole rocket's CNa exceeds 1.5x classic above M2, which a wrong tip correction, a missing
// floor or a lost factor of two in either term can all pass.
//
// At zero AoA a fin set's CNa is (fin count) x S x K1(M) / A_ref x interference, so the ratio of
// the Supersonic fin CNa to the classic one is ssaeroScale(M) x (K_W(B) + fa K_B(W)) / (1 + tau),
// with S, K1 and the fin count cancelling. The classic K1 is read off a table built from the same
// analytic 2/beta at 0.1-Mach steps, so the comparison is made ON those steps (M2, 2.5, 3, 4).

const R = 0.02;
const MACHS = [2, 2.5, 3, 4];

const tree = (fins: { root: number; tip: number; sweep: number; span: number } | null): RocketTree => ({
  name: 'Supersonic fin slope',
  components: [
    { type: 'nosecone', shape: 'ogive', length: 0.12, aftRadius: R, thickness: 0.002 },
    {
      type: 'bodytube', length: 0.5, outerRadius: R, thickness: 0.001,
      children: fins ? [{
        type: 'trapezoidfinset', finCount: 4, rootChord: fins.root, tipChord: fins.tip, sweep: fins.sweep,
        height: fins.span, thickness: 0.002, position: { method: 'bottom', offset: 0 },
      }] : [],
    },
  ],
} as unknown as RocketTree);

function cna(t: RocketTree, supersonic: boolean): number[] {
  const r = OrkRocket.buildTree(t);
  // Kbf off on both sides: its root carryover is a separate term (kbfCarryover.test.ts).
  r.setRogersModifiedBarrowman(false);
  r.setSupersonicAero(supersonic);
  return r.forceSamples(MACHS).map((s) => s[3]);
}

/** NACA Report 1307 eq. 14 K_W(B), the same transcription finAfterbody.test.ts uses. */
function kWB(t: number): number {
  const num = (1 + t ** 4) * (0.5 * Math.atan(0.5 * (1 / t - t)) + Math.PI / 4)
    - t ** 2 * ((1 / t - t) + 2 * Math.atan(t));
  return (2 / Math.PI) * num / (1 - t) ** 2;
}

describe('Supersonic fin slope: 4/beta with the finite-span tip correction (Phase 1)', () => {
  it('scales the classic supersonic fin CNa by 2 (1 - 1/(2 AR beta)), floored, times the NACA 1307 split', () => {
    const FINS = [
      { root: 0.05, tip: 0.05, sweep: 0, span: 0.05 }, // AR 2
      { root: 0.08, tip: 0.04, sweep: 0.03, span: 0.05 }, // AR 1.04
      { root: 0.1, tip: 0.1, sweep: 0, span: 0.012 }, // AR 0.24: the 0.25 floor binds at M2 and M2.5
    ];
    for (const f of FINS) {
      const area = 0.5 * (f.root + f.tip) * f.span;
      const ar = 2 * f.span * f.span / area;
      const tau = R / (f.span + R);
      const kw = kWB(tau);
      const interference = (kw + 0.5 * ((1 + tau) ** 2 - kw)) / (1 + tau); // flush with the base: fa 0.5
      const bareC = cna(tree(null), false), finC = cna(tree(f), false);
      const bareS = cna(tree(null), true), finS = cna(tree(f), true);
      MACHS.forEach((m, i) => {
        const beta = Math.sqrt(m * m - 1);
        const scale = 2 * Math.max(1 - 1 / (2 * ar * beta), 0.25);
        const got = (finS[i]! - bareS[i]!) / (finC[i]! - bareC[i]!);
        expect(got / (scale * interference) - 1, `AR ${ar.toFixed(2)} M${m}`).toBeCloseTo(0, 9);
      });
    }
  }, 30_000);
});
