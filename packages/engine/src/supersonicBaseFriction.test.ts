import { describe, expect, it } from 'vitest';
import { OrkRocket, type RocketTree } from './orkEngine.js';

// Two high-Mach corrections the Supersonic model makes in BarrowmanCalculator
// (engine-java/patches/LEDGER.md, RASAero feature #1 Phases 2 and 4), both flag-gated:
//   - effectiveBaseCD: the Hoerner 0.25/M base law is capped at 1.2/M^2 above M1 (about 0.85 of
//     the vacuum limit 2/(gamma M^2)); the crossover is M4.8. With the flag off it stays 0.25/M.
//   - calculateFrictionCoefficient: the turbulent compressibility factor 1/(1+0.15 M^2)^0.58
//     fades to the Van Driest II fit 1/(1+0.144 M^2)^0.65 over M3.5-4.5. With the flag off it
//     keeps the former.
// Neither was asserted anywhere in this package; difftest has no stored baseline.
//
// The baseline is Rogers Kbf with the supersonic flag off (setRogersModifiedBarrowman(true)),
// NOT Classic: Classic shares this base law and friction code, but nothing here flies it.

const R = 0.02;

const rocket = (finish: string): RocketTree => ({
  name: 'High Mach',
  components: [
    { type: 'nosecone', shape: 'ogive', length: 0.12, aftRadius: R, thickness: 0.002, finish },
    { type: 'bodytube', length: 0.5, outerRadius: R, thickness: 0.001, finish },
  ],
} as unknown as RocketTree);

function sweep(finish: string, supersonic: boolean) {
  const r = OrkRocket.buildTree(rocket(finish));
  r.setRogersModifiedBarrowman(true);
  r.setSupersonicAero(supersonic);
  return r.dragSweep({ machMin: 0.5, machMax: 10, machStep: 0.25 });
}

describe('Supersonic model, high-Mach base and friction', () => {
  it('caps base drag at 1.2/M^2 above M1; Kbf with the flag off keeps 0.25/M', () => {
    const kbf = sweep('normal', false);
    const ss = sweep('normal', true);
    kbf.machs.forEach((m, i) => {
      // One aft base of the reference diameter: the base CD is the law itself.
      const hoerner = m <= 1 ? 0.12 + 0.13 * m * m : 0.25 / m;
      const capped = m > 1 ? Math.min(hoerner, 1.2 / (m * m)) : hoerner;
      expect(kbf.powerOff.base[i]! / hoerner - 1, `kbf M${m}`).toBeCloseTo(0, 12);
      expect(ss.powerOff.base[i]! / capped - 1, `supersonic M${m}`).toBeCloseTo(0, 12);
    });
    // The cap binds only past the crossover 0.25/M = 1.2/M^2, i.e. M4.8.
    const at = (m: number) => ss.machs.findIndex((x) => Math.abs(x - m) < 1e-9);
    expect(ss.powerOff.base[at(4.5)]).toBe(kbf.powerOff.base[at(4.5)]);
    expect(ss.powerOff.base[at(5)]!).toBeLessThan(kbf.powerOff.base[at(5)]!);
  }, 30_000);

  it('fades turbulent skin friction to Van Driest II over M3.5-4.5; Kbf with the flag off keeps the 0.58 power law', () => {
    // A mirror finish keeps the turbulent Cf above the roughness limit at every Mach here, so the
    // ratio of the two models' friction is the ratio of their compressibility factors (Cf, the
    // wetted areas and the body correction cancel). On the default paint finish the roughness
    // limit binds over roughly M4-6.5 and hides the fade there.
    const kbf = sweep('mirror', false);
    const ss = sweep('mirror', true);
    kbf.machs.forEach((m, i) => {
      const c2 = 1 / (1 + 0.15 * m * m) ** 0.58;
      const vd = 1 / (1 + 0.144 * m * m) ** 0.65;
      const t = Math.min(Math.max(m - 3.5, 0), 1);
      const want = m > 0.9 ? (c2 * (1 - t) + vd * t) / c2 : 1;
      expect(ss.powerOff.friction[i]! / kbf.powerOff.friction[i]! / want - 1, `M${m}`).toBeCloseTo(0, 12);
      if (m <= 3.5) expect(ss.powerOff.friction[i], `identical through M3.5, M${m}`).toBe(kbf.powerOff.friction[i]);
    });
  }, 30_000);
});
