import { describe, expect, it } from 'vitest';
import { OrkRocket, type RocketTree } from './orkEngine.js';

// The x1.8 fin interference factor (engine-java/patches/LEDGER.md, "The x1.8 fin interference
// factor" and "Boundary-layer transition exposed"): FinSetCalc.calculateFrictionCD multiplies
// a fin set's skin friction by 1.8 under `rogersKbf || supersonicAero` - a port of RASAero II's
// own "Fin Interference" component - and Classic (desktop parity) keeps 1.0. On the reference
// rocket it is +7.9 % of total CD at M0.30, so the DEFAULT model's apogees depend on it; the
// junction goldens (`ssjunction.*`) are difftest lines with no stored baseline and so cannot
// catch a change that moves the JVM and TeaVM together.
//
// Isolated by subtraction: the bodies' friction does not depend on the fins (their wetted
// area, the body fineness correction and Cf are fin-independent at a fixed aerodynamic length),
// so (finned - bare) friction is the fin set's alone, and Cf cancels in the model ratio.

// 'ssOnly' is the supersonic flag WITHOUT Kbf: the gate is a disjunction, and every other
// model here sets rogersKbf, which would leave the `supersonicAero` disjunct unexecuted.
type Model = 'classic' | 'kbf' | 'supersonic' | 'ssOnly' | 'hybrid';
const MACHS = [0.3, 0.7, 1.0, 1.5, 2.5];

const tree = (fins: boolean, crossSection: string): RocketTree => ({
  name: 'Fin friction',
  components: [
    { type: 'nosecone', shape: 'ogive', length: 0.12, aftRadius: 0.02, thickness: 0.002 },
    {
      type: 'bodytube', length: 0.5, outerRadius: 0.02, thickness: 0.001,
      children: fins ? [{
        type: 'trapezoidfinset', finCount: 4, rootChord: 0.08, tipChord: 0.04, sweep: 0.03, height: 0.05,
        thickness: 0.003, crossSection, position: { method: 'bottom', offset: 0 },
      }] : [],
    },
  ],
} as unknown as RocketTree);

function friction(t: RocketTree, model: Model): number[] {
  const r = OrkRocket.buildTree(t);
  r.setRogersModifiedBarrowman(model !== 'classic' && model !== 'ssOnly');
  r.setSupersonicAero(model === 'supersonic' || model === 'ssOnly');
  r.setHybridAero(model === 'hybrid');
  return r.forceSamples(MACHS).map((s) => s[13]);
}

describe('fin interference friction factor', () => {
  it('is x1.8 on the fin set in Kbf, Supersonic and Hybrid, x1.0 in Classic, and never on the body', () => {
    // Square, rounded and airfoil: the factor sits in calculateFrictionCD, ahead of any
    // cross-section branch, so every section takes it.
    for (const section of ['square', 'rounded', 'airfoil']) {
      const bareClassic = friction(tree(false, section), 'classic');
      const finsClassic = friction(tree(true, section), 'classic').map((v, i) => v - bareClassic[i]!);
      for (const model of ['kbf', 'supersonic', 'ssOnly', 'hybrid'] as const) {
        const bare = friction(tree(false, section), model);
        const fins = friction(tree(true, section), model).map((v, i) => v - bare[i]!);
        MACHS.forEach((m, i) => {
          const label = `${model} ${section} M${m}`;
          // The body alone is model-independent (perfectFinish is off).
          expect(bare[i], `${label} body friction`).toBe(bareClassic[i]);
          expect(finsClassic[i]!, `${label} fixture has fin friction`).toBeGreaterThan(0.01);
          expect(fins[i]! / finsClassic[i]! / 1.8 - 1, `${label} fin friction ratio`).toBeCloseTo(0, 10);
        });
      }
    }
  }, 30_000);
});
