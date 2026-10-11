import { describe, expect, it } from 'vitest';
import { OrkRocket, type RocketTree } from './orkEngine.js';

// Fin drag by cross-section (open-items §3 item 8), on @Buckeye's WildMan Mach 2 from TRF 197207:
// the geometry of his Mach2.ork as the app imports it, flown at his CFD condition (102 m/s at ISA
// sea level, alpha 0, base included). His posts and files are in TRF thread 197207.
//
// He posted three columns this test uses, as fin-set increments (fins-on minus no-fins total CD):
//   desktop OpenRocket 24.12: airfoil 0.055, rounded 0.074, square 0.134 (reported to 3 dp)
//   CFD (simpleFOAM, k-omega SST, fully turbulent): airfoil 0.068, rounded 0.124, square 0.176
// The increments, not the totals, because v0.162's body-fineness fix (decision 70, every model)
// moved the no-fins body off his desktop figure; the fin rows are untouched by it.

const MACH = 102 / Math.sqrt(1.4 * 287.053 * 288.15);

type Cross = 'airfoil' | 'rounded' | 'square';
type Model = 'classic' | 'kbf' | 'supersonic' | 'hybrid';

function mach2(cross?: Cross): RocketTree {
  const fins = cross
    ? [{
        type: 'trapezoidfinset', id: 'fins', finish: 'mirror', density: 361.377,
        position: { method: 'top', offset: 0.69 }, finCount: 4, rootChord: 0.15, tipChord: 0.03,
        sweep: 0.12955, height: 0.06, thickness: 0.003, crossSection: cross,
      }]
    : [];
  return {
    name: 'WildMan Mach 2',
    components: [{
      type: 'stage', id: 'stage', children: [
        { type: 'nosecone', id: 'nose', finish: 'mirror', length: 0.33, aftRadius: 0.0285, filled: true,
          shape: 'haack', shapeParameter: 0 },
        { type: 'bodytube', id: 'body', finish: 'mirror', density: 688.794, length: 0.86, outerRadius: 0.0285,
          thickness: 0.002, children: [
            ...fins,
            { type: 'bulkhead', id: 'base', density: 344.269, position: { method: 'bottom', offset: 0 },
              length: 0.005, outerRadius: 0.0265 },
          ] },
      ],
    }],
  } as unknown as RocketTree;
}

function totalCd(tree: RocketTree, model: Model): number {
  const r = OrkRocket.buildTree(tree);
  r.setRogersModifiedBarrowman(model !== 'classic');
  r.setSupersonicAero(model === 'supersonic');
  r.setHybridAero(model === 'hybrid');
  return r.dragSweep({ machMin: MACH, machMax: MACH, machStep: 1e-4 }).powerOff.total[0]!;
}

const increment = (cross: Cross, model: Model) => totalCd(mach2(cross), model) - totalCd(mach2(), model);

describe('fin drag by cross-section, against TRF 197207', { timeout: 30_000 }, () => {
  it('Classic reproduces desktop OR 24.12 fin increments for all three sections', () => {
    const desktop: Record<Cross, number> = { airfoil: 0.055, rounded: 0.074, square: 0.134 };
    for (const cross of ['airfoil', 'rounded', 'square'] as const) {
      // 3-dp reporting (±0.0005) plus the ±0.4 % sweep-length spread between his three exports.
      expect(Math.abs(increment(cross, 'classic') - desktop[cross]), cross).toBeLessThan(0.0006);
    }
  });

  // A characterisation, not a target: the CFD is one code at one Mach on one rocket. Its airfoil is
  // a rounded-leading-edge NACA-type section, so it is not the ARCAS double wedge; the ARCAS tunnel
  // increment (TN D-4013, Short model, fin anchors left on for both runs) reads this desktop-import
  // fin path 14-31 % LOW. Re-baseline these bands in the same sitting as any change to fin friction. A change that moves these bands moves item 8's register
  // numbers, and should come with a scorecard.
  it('the non-classic models read airfoil about +41 % over the CFD, rounded and square on it', () => {
    const cfd: Record<Cross, number> = { airfoil: 0.068, rounded: 0.124, square: 0.176 };
    const band: Record<Cross, [number, number]> = { airfoil: [1.36, 1.46], rounded: [0.89, 0.99], square: [0.95, 1.05] };
    for (const model of ['kbf', 'supersonic', 'hybrid'] as const) {
      for (const cross of ['airfoil', 'rounded', 'square'] as const) {
        const ratio = increment(cross, model) / cfd[cross];
        expect(ratio, `${model} ${cross}`).toBeGreaterThan(band[cross][0]);
        expect(ratio, `${model} ${cross}`).toBeLessThan(band[cross][1]);
      }
    }
  });
});
