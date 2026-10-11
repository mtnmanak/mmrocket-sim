import { describe, expect, it } from 'vitest';
import { OrkRocket, type RocketTree } from './orkEngine.js';

// The Supersonic model's boat-tail wave drag (engine-java/patches/LEDGER.md, RASAero feature #1
// Phase 5, SymmetricComponentCalc): the classic kernel charges a boat tail its Mach-flat
// base-scaled estimate at every speed. With `supersonicAero` it is
//   M <= 0.90       the classic estimate, unchanged
//   0.90 -> 1.05    a smoothstep from the classic estimate to the peak
//   1.05 -> 1.20    a plateau at the peak, Cp_PM(1.20, theta) x frontal ratio
//   M >= 1.20       the EXACT Prandtl-Meyer expansion Cp for the turn theta, decaying monotonically
// with theta = min(atan2(fore - aft, length), 0.349) and the frontal ratio (fore^2 - aft^2)/ref^2.
// Phase 2's linear blend put the boat tail's maximum at exactly M1.500 and gave the ARCAS total-CD
// curve a false second transonic peak; nothing in this package pinned the replacement, and
// difftest's `ssphase5.boattail.*` lines have no stored baseline.
//
// The baseline is Rogers Kbf with the supersonic flag off (setRogersModifiedBarrowman(true)),
// NOT Classic: "the classic estimate" above is the flag-off kernel's, which Classic shares.
//
// The boat tail's own pressure CD is isolated by subtracting the same rocket without it (a
// cylinder has none, and the nose ahead does not see the tail). The Prandtl-Meyer inverse here
// is an independent Newton solve, not the kernel's fixed-count bisection.

const R = 0.02;
const GAMMA = 1.4;

const rocket = (tail?: { length: number; aft: number }): RocketTree => ({
  name: 'Boat tail',
  components: [
    { type: 'nosecone', shape: 'ogive', length: 0.12, aftRadius: R, thickness: 0.002 },
    { type: 'bodytube', length: 0.5, outerRadius: R, thickness: 0.001 },
    ...(tail ? [{ type: 'transition', shape: 'conical', length: tail.length, foreRadius: R, aftRadius: tail.aft, thickness: 0.001 }] : []),
  ],
} as unknown as RocketTree);

function pressure(t: RocketTree, supersonic: boolean, machMin: number, machMax: number, machStep: number) {
  const r = OrkRocket.buildTree(t);
  r.setRogersModifiedBarrowman(true);
  r.setSupersonicAero(supersonic);
  const s = r.dragSweep({ machMin, machMax, machStep });
  return { machs: s.machs, p: s.powerOff.pressure };
}

/** The boat tail's own pressure CD over a Mach grid, by subtraction. */
function tailPressure(tail: { length: number; aft: number }, supersonic: boolean,
  machMin = 0.5, machMax = 6, machStep = 0.02) {
  const a = pressure(rocket(tail), supersonic, machMin, machMax, machStep);
  const b = pressure(rocket(), supersonic, machMin, machMax, machStep);
  return { machs: a.machs, cd: a.p.map((v, i) => v - b.p[i]!) };
}

const nu = (m: number) => {
  const b2 = m * m - 1;
  return Math.sqrt(6) * Math.atan(Math.sqrt(b2 / 6)) - Math.atan(Math.sqrt(b2));
};
/** |Cp| behind a Prandtl-Meyer expansion of `theta` from Mach `m` (gamma 1.4). */
function pmCp(m: number, theta: number): number {
  const target = nu(m) + theta;
  let m2 = m + 0.5;
  for (let i = 0; i < 60; i++) {
    // d(nu)/dM = sqrt(M^2 - 1) / (M (1 + 0.2 M^2))
    const step = (nu(m2) - target) * m2 * (1 + 0.2 * m2 * m2) / Math.sqrt(m2 * m2 - 1);
    m2 -= step;
    if (Math.abs(step) < 1e-15 * m2) break;
  }
  const ratio = ((1 + 0.2 * m * m) / (1 + 0.2 * m2 * m2)) ** (GAMMA / (GAMMA - 1));
  return (2 / (GAMMA * m * m)) * (1 - ratio);
}

const TAILS = [
  { length: 0.04, aft: 0.012 }, // 11.3 deg, frontal ratio 0.64
  { length: 0.08, aft: 0.015 }, // 3.6 deg, a gentle tail
  { length: 0.02, aft: 0.01 }, // 26.6 deg: separated, theta clamped at 0.349 rad
];

describe('Supersonic boat-tail wave drag (Phase 5)', () => {
  it('follows the flag-off estimate to M0.90, smoothsteps to a M1.05-1.20 plateau, then exact Prandtl-Meyer', () => {
    for (const tail of TAILS) {
      const theta = Math.min(Math.atan2(R - tail.aft, tail.length), 0.349);
      const frontal = (R * R - tail.aft * tail.aft) / (R * R);
      const peak = pmCp(1.2, theta) * frontal;
      const cl = tailPressure(tail, false);
      const ss = tailPressure(tail, true);
      ss.machs.forEach((m, i) => {
        const label = `aft ${tail.aft} M${m.toFixed(2)}`;
        const c = cl.cd[i]!, s = ss.cd[i]!;
        let want: number;
        if (m <= 0.9) want = c;
        else if (m < 1.05) {
          const t = (m - 0.9) / 0.15;
          const sm = t * t * (3 - 2 * t);
          want = c * (1 - sm) + peak * sm;
        } else if (m < 1.2) want = peak;
        else want = pmCp(m, theta) * frontal;
        // Absolute: the subtraction of two whole-rocket pressures costs a few 1e-17.
        expect(Math.abs(s - want), label).toBeLessThan(1e-11 + 1e-9 * Math.abs(want));
      });
    }
  }, 30_000);

  it('has ONE maximum, on the plateau, and decays monotonically above it (no false peak at M1.5)', () => {
    for (const tail of TAILS) {
      const ss = tailPressure(tail, true, 0.9, 8, 0.02);
      let iMax = 0;
      ss.cd.forEach((v, i) => { if (v > ss.cd[iMax]!) iMax = i; });
      expect(ss.machs[iMax]!, `aft ${tail.aft}: maximum on the plateau`).toBeGreaterThanOrEqual(1.05 - 1e-9);
      expect(ss.machs[iMax]!).toBeLessThanOrEqual(1.2 + 1e-9);
      for (let i = 1; i < ss.cd.length; i++) {
        const m = ss.machs[i]!;
        if (m < 1.05 - 1e-9) expect(ss.cd[i]!, `rising M${m.toFixed(2)}`).toBeGreaterThanOrEqual(ss.cd[i - 1]! - 1e-15);
        if (m > 1.2 + 1e-9) expect(ss.cd[i]!, `decaying M${m.toFixed(2)}`).toBeLessThan(ss.cd[i - 1]!);
      }
    }
  }, 30_000);
});
