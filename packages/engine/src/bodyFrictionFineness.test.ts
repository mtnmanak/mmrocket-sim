import { describe, expect, it } from 'vitest';
import { OrkRocket, type RocketTree } from './orkEngine.js';

// OpenRocket #3237: BarrowmanCalculator.calculateFrictionCD multiplies the summed body skin
// friction by the wetted-area correction 1 + 1/(2 fB) (OpenRocket technical documentation eq.
// 3.85), where fB is the body fineness ratio, length / maximum DIAMETER. 24.12 divided by the
// maximum RADIUS, which doubled fB and halved the correction term: 1 + R/(2L) where 1 + R/L is
// right. Fins, lugs, buttons and every other appendage are outside the correction and must not
// move. Eric's 2026-10-08 ruling (decision 70) applies the fix in every aero model.
//
// Requires the rebuilt kernel (npm run engine:js). The kernel's own length is L + 0.0001 m
// (its regulariser against a zero-length body), so the correction it applies is 1 + R/(L+1e-4).
//
// Neither test needs the skin-friction coefficient Cf itself. A lone body tube has wetted area
// 2 pi R L and reference area pi R^2, so its friction CD is corr * Cf * 2L/R; and Cf depends only
// on Mach, the aerodynamic length (Reynolds number, roughness limit) and the finish, so two
// tubes of the same length and finish share it.

type Model = 'classic' | 'kbf' | 'supersonic' | 'hybrid';
const MODELS: Model[] = ['classic', 'kbf', 'supersonic', 'hybrid'];
// Hybrid's default band is M0.8-1.2: M0.3 is its Kbf endpoint, M1.0 the blend, M2.0 Supersonic.
const MACHS = [0.3, 0.6, 1.0, 1.4, 2.0];

const corr = (L: number, R: number) => 1 + R / (L + 1e-4);

function tube(L: number, R: number, fins?: Record<string, unknown>): RocketTree {
  return {
    name: 'fineness',
    components: [{
      type: 'bodytube', id: 'body', length: L, outerRadius: R, thickness: 0.0005,
      children: fins ? [{ position: { method: 'bottom', offset: 0 }, ...fins }] : [],
    }],
  } as unknown as RocketTree;
}

function build(t: RocketTree, model: Model): OrkRocket {
  const r = OrkRocket.buildTree(t);
  r.setRogersModifiedBarrowman(model !== 'classic');
  r.setSupersonicAero(model === 'supersonic');
  r.setHybridAero(model === 'hybrid');
  return r;
}

/** Whole-rocket friction CD at each Mach, through the flight path (forceSamples) and the sweep. */
function friction(t: RocketTree, model: Model): { force: number[]; sweep: number[] } {
  const r = build(t, model);
  const force = r.forceSamples(MACHS).map((s) => s[13]);
  const sw = r.dragSweep({ machMin: MACHS[0], machMax: MACHS[MACHS.length - 1], machStep: 0.1 });
  const sweep = MACHS.map((m) => sw.powerOff.friction[sw.machs.findIndex((x) => Math.abs(x - m) < 1e-9)]!);
  return { force, sweep };
}

const FINS = {
  type: 'trapezoidfinset', id: 'fins', finCount: 4, rootChord: 0.06, tipChord: 0.06, sweep: 0,
  height: 0.04, thickness: 0.003,
};

describe('#3237: body skin-friction correction uses length / DIAMETER', { timeout: 60_000 }, () => {
  it('two radii, one length: friction scales by the diameter-based correction, every model', () => {
    const L = 0.5;
    for (const model of MODELS) {
      for (const [R1, R2] of [[0.05, 0.025], [0.04, 0.0125]] as const) {
        const a = friction(tube(L, R1), model);
        const b = friction(tube(L, R2), model);
        const want = corr(L, R1) / corr(L, R2);
        MACHS.forEach((m, i) => {
          for (const path of ['force', 'sweep'] as const) {
            // corr(R1)*Cf*2L/R1 * R1  /  (corr(R2)*Cf*2L/R2 * R2)
            const got = (a[path][i]! * R1) / (b[path][i]! * R2);
            expect(got / want - 1, `${model} ${path} R${R1}/${R2} M${m}`).toBeCloseTo(0, 10);
          }
        });
      }
    }
  });

  it('fin friction is not corrected: fins / Cf is the same for every body length, every model', () => {
    const R = 0.025;
    for (const model of MODELS) {
      const ratios = [0.3, 0.6, 1.2].map((L) => {
        const bare = friction(tube(L, R), model).force;
        const finned = friction(tube(L, R, FINS), model).force;
        // Cf(L) recovered from the bare tube; the fins' increment divided by it is geometry only.
        return MACHS.map((_, i) => (finned[i]! - bare[i]!) / (bare[i]! * R / (corr(L, R) * 2 * L)));
      });
      MACHS.forEach((m, i) => {
        expect(ratios[1]![i]! / ratios[0]![i]! - 1, `${model} L0.6/L0.3 M${m}`).toBeCloseTo(0, 10);
        expect(ratios[2]![i]! / ratios[0]![i]! - 1, `${model} L1.2/L0.3 M${m}`).toBeCloseTo(0, 10);
      });
      if (model === 'classic') {
        // Classic's fin friction is Cf (1 + 2t/c) 2 S / Aref per fin, unchanged by #3237.
        const g = 4 * (1 + (2 * 0.003) / 0.06) * 2 * (0.06 * 0.04) / (Math.PI * R * R);
        ratios[0]!.forEach((v, i) => expect(v / g - 1, `classic fins M${MACHS[i]}`).toBeCloseTo(0, 10));
      }
    }
  });
});
