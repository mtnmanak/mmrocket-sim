import { describe, expect, it } from 'vitest';
import { OrkRocket, type RocketTree } from './orkEngine.js';

// The Supersonic model's NOSE physics (engine-java/patches/LEDGER.md, RASAero feature #1
// Phases 1, 2, 4 and 5), all in SymmetricComponentCalc and all behind `supersonicAero`:
//   - Phase 1: a nose's CNa grows above M1, CNa_slender * (1 + g (min(M,5) - 1)), g = 0.10 for a
//     cone and 0.07 for every other shape; transitions keep their slender value.
//   - Phase 2: past the last point of a nose's pressure table the kernel without the flag clamps
//     FLAT.
//     Supersonic continues a cone or ogive on its analytic branch and decays a stored-table
//     shape with the Fleeman/Bonney Mach shape (1.59 + 1.83/M^2).
//   - Phase 4: the cone's 2.1 sin^2(phi) coefficient fades to the stagnation Cp_max(M) over M4-8.
//   - Phase 5: a non-cone-like ogive NOSE (shape parameter >= 0.35) takes the Fleeman wave drag
//     (1.59 + 1.83/M^2) (atan(0.5 / (l/d)))^1.69, scaled by the ogive shape multiplier.
// Each is asserted as its formula against the shipped bridge. Nothing in this package pinned
// any of them (orkEngine.test.ts's supersonic test asserts the WHOLE rocket's CNa > 1.5x classic,
// which the fins carry), and difftest cannot: it has no stored baseline.
//
// The baseline is Rogers Kbf with the supersonic flag off (setRogersModifiedBarrowman(true)),
// NOT Classic: Classic shares the nose code it exercises, but nothing here flies it.
//
// Isolation: a nose on a plain tube, no fins. A body tube has no CNa at zero AoA and no
// pressure drag, so the rocket's CNa and pressure CD ARE the nose's; the nose's aft radius is
// the reference radius, so its frontal area ratio is exactly 1.

const R = 0.02;

const noseOnTube = (nose: Record<string, unknown>, length = 0.12, extra: Record<string, unknown>[] = []): RocketTree => ({
  name: 'Supersonic nose',
  components: [
    { type: 'nosecone', length, aftRadius: R, thickness: 0.002, ...nose },
    { type: 'bodytube', length: 0.5, outerRadius: R, thickness: 0.001 },
    ...extra,
  ],
} as unknown as RocketTree);

function sweep(t: RocketTree, supersonic: boolean, machMin = 0.5, machMax = 10, machStep = 0.25) {
  const r = OrkRocket.buildTree(t);
  r.setRogersModifiedBarrowman(true);
  r.setSupersonicAero(supersonic);
  const s = r.dragSweep({ machMin, machMax, machStep });
  const at = (m: number) => {
    const i = s.machs.findIndex((x) => Math.abs(x - m) < 1e-9);
    expect(i, `Mach ${m} on the grid`).toBeGreaterThanOrEqual(0);
    return i;
  };
  return { s, at };
}

const GAMMA = 1.4;

/** Stagnation Cp behind a normal shock (Rayleigh pitot, NACA Report 1135 eq. 100). */
function cpMax(m: number): number {
  const m2 = m * m;
  const a = ((GAMMA + 1) ** 2 * m2 / (4 * GAMMA * m2 - 2 * (GAMMA - 1))) ** (GAMMA / (GAMMA - 1));
  const b = (1 - GAMMA + 2 * GAMMA * m2) / (GAMMA + 1);
  return (2 / (GAMMA * m2)) * (a * b - 1);
}

describe('Supersonic nose physics', () => {
  it('nose CNa grows above M1 (g 0.10 cone, 0.07 other shapes), capped at M5; a transition does not grow', () => {
    const shapes: [Record<string, unknown>, number][] = [
      [{ shape: 'conical' }, 0.10],
      [{ shape: 'ogive', shapeParameter: 1 }, 0.07],
      [{ shape: 'haack', shapeParameter: 0 }, 0.07],
      [{ shape: 'ellipsoid' }, 0.07],
      [{ shape: 'power', shapeParameter: 0.5 }, 0.07],
    ];
    for (const [nose, g] of shapes) {
      const kbf = sweep(noseOnTube(nose), false);
      const ss = sweep(noseOnTube(nose), true);
      for (const m of [0.5, 1, 1.25, 2, 3.5, 5, 6, 10]) {
        const label = `${JSON.stringify(nose)} M${m}`;
        // Slender-body nose CNa is 2 per radian on its own base area, at every Mach, with the flag off.
        expect(kbf.s.cna[kbf.at(m)]! - 2, `${label} kbf`).toBeCloseTo(0, 12);
        const want = m > 1 ? 2 * (1 + g * (Math.min(m, 5) - 1)) : 2;
        expect(ss.s.cna[ss.at(m)]! / want - 1, `${label} supersonic`).toBeCloseTo(0, 12);
      }
    }
    // A boat tail is a transition, not a nose: its (negative) slender CNa stays put at every
    // Mach in both models, so the rocket's CNa changes by exactly that constant.
    const aftR = 0.012;
    const boattail = { type: 'transition', shape: 'conical', length: 0.04, foreRadius: R, aftRadius: aftR, thickness: 0.001 };
    const slender = 2 * (aftR * aftR - R * R) / (R * R);
    for (const supersonic of [false, true]) {
      const plain = sweep(noseOnTube({ shape: 'conical' }), supersonic);
      const tailed = sweep(noseOnTube({ shape: 'conical' }, 0.12, [boattail]), supersonic);
      for (const m of [0.5, 1.25, 3, 6]) {
        expect(tailed.s.cna[tailed.at(m)]! - plain.s.cna[plain.at(m)]! - slender,
          `boat tail CNa M${m} supersonic=${supersonic}`).toBeCloseTo(0, 12);
      }
    }
  }, 30_000);

  it('a tangent or near-tangent ogive nose carries the Fleeman wave drag above M1.3', () => {
    // Fineness l/d and the ogive shape multiplier 0.72 (p - 0.5)^2 + 0.82 (1 at p = 1).
    for (const [length, p] of [[0.12, 1], [0.2, 1], [0.12, 0.5]] as const) {
      const fn = length / (2 * R);
      const mul = 0.72 * (p - 0.5) ** 2 + 0.82;
      const fleemanN = Math.atan(0.5 / fn) ** 1.69 * mul;
      const ss = sweep(noseOnTube({ shape: 'ogive', shapeParameter: p }, length), true);
      const kbf = sweep(noseOnTube({ shape: 'ogive', shapeParameter: p }, length), false);
      for (const m of [1.5, 2, 3, 5, 8, 10]) {
        const want = (1.59 + 1.83 / (m * m)) * fleemanN;
        expect(ss.s.powerOff.pressure[ss.at(m)]! / want - 1, `l/d ${fn} p ${p} M${m}`).toBeCloseTo(0, 12);
      }
      // Since board row 87 (2026-10-11) Rogers Kbf takes the same Fleeman branch above M1. Only
      // Classic keeps desktop's sinphi-driven branch, which all but vanishes for a tangent ogive
      // (the defect Phase 5 fixed in the Supersonic model, and row 87 in the default).
      for (const m of [1.5, 2, 3, 5]) {
        expect(kbf.s.powerOff.pressure[kbf.at(m)]! / ss.s.powerOff.pressure[ss.at(m)]! - 1,
          `kbf l/d ${fn} p ${p} M${m}`).toBeCloseTo(0, 12);
      }
      if (p === 1) {
        const classic = OrkRocket.buildTree(noseOnTube({ shape: 'ogive', shapeParameter: p }, length));
        classic.setRogersModifiedBarrowman(false);
        const c = classic.dragSweep({ machMin: 0.5, machMax: 10, machStep: 0.25 });
        expect(c.powerOff.pressure[c.machs.findIndex((x) => Math.abs(x - 2) < 1e-9)]!).toBeLessThan(0.002);
      }
    }
    // A cone-like secant ogive (p < 0.35) is NOT Fleeman: it keeps the flag-off analytic curve
    // inside the table (M <= 3.98) in the Supersonic model too.
    const off = sweep(noseOnTube({ shape: 'ogive', shapeParameter: 0.2 }), false);
    const sl = sweep(noseOnTube({ shape: 'ogive', shapeParameter: 0.2 }), true);
    for (const m of [1.5, 2, 3, 3.75]) {
      expect(sl.s.powerOff.pressure[sl.at(m)], `secant p 0.2 M${m}`).toBe(off.s.powerOff.pressure[off.at(m)]);
    }
  }, 30_000);

  it('a cone continues analytically past its table, its coefficient fading to stagnation Cp over M4-8; with the flag off it stays flat', () => {
    const length = 0.12;
    // The kernel's own sinphi: the surface slope over the aft 1 % of the shape (exactly the
    // cone half-angle's sine, up to rounding).
    const rAt99 = 0.99 * R;
    const sinphi = (R - rAt99) / Math.hypot(R - rAt99, 0.01 * length);
    const off = sweep(noseOnTube({ shape: 'conical' }, length), false);
    const ss = sweep(noseOnTube({ shape: 'conical' }, length), true);
    const flat = off.s.powerOff.pressure[off.at(4)]!;
    for (const m of [4.5, 5, 6, 7, 8, 9, 10]) {
      // Flag off: the interpolator's last point (M3.98) held flat.
      expect(off.s.powerOff.pressure[off.at(m)], `kbf M${m}`).toBe(flat);
      const t = Math.min(Math.max((m - 4) / 4, 0), 1);
      const coeff = 2.1 * (1 - t) + cpMax(m) * t;
      const want = coeff * sinphi * sinphi + 0.5 * sinphi / Math.sqrt(m * m - 1);
      expect(ss.s.powerOff.pressure[ss.at(m)]! / want - 1, `supersonic M${m}`).toBeCloseTo(0, 12);
    }
    // Sanity on the transcription: Cp_max tends to 1.839 (gamma 1.4), below the 2.1 it replaces.
    expect(cpMax(1000)).toBeCloseTo(1.839, 3);
    // Inside the table the two models agree exactly.
    for (const m of [1.5, 2.5, 3.5]) {
      expect(ss.s.powerOff.pressure[ss.at(m)], `table M${m}`).toBe(off.s.powerOff.pressure[off.at(m)]);
    }
  }, 30_000);

  it('a stored-table nose decays as (1.59 + 1.83/M^2) past its last table Mach instead of clamping flat', () => {
    // TR R-100 tables: von Karman (Haack C = 0) ends at M3.0, ellipsoid at M2.4. Fineness 3
    // keeps the C7 stubby-nose floor (fineness < 1.8, subsonic only) out of it entirely.
    for (const [nose, mEnd] of [[{ shape: 'haack', shapeParameter: 0 }, 3.0], [{ shape: 'ellipsoid' }, 2.4]] as const) {
      const off = sweep(noseOnTube(nose), false, 0.5, 10, 0.1);
      const ss = sweep(noseOnTube(nose), true, 0.5, 10, 0.1);
      const end = off.s.powerOff.pressure[off.at(mEnd)]!;
      expect(end, `${nose.shape} table end`).toBeGreaterThan(0.05);
      // (The sweep's grid is accumulated, so its "M3.0" can sit an ulp past the table end and
      // start decaying: equal to 12 places here, exact everywhere else.)
      expect(ss.s.powerOff.pressure[ss.at(mEnd)]! / end - 1, `${nose.shape} at its table end`).toBeCloseTo(0, 12);
      const shape = (m: number) => 1.59 + 1.83 / (m * m);
      for (const m of [mEnd + 0.5, 4, 6, 10]) {
        const i = ss.at(m);
        const mach = ss.s.machs[i]!; // the grid's own value, which the kernel evaluated
        expect(off.s.powerOff.pressure[off.at(m)], `${nose.shape} kbf flat M${m}`).toBe(end);
        expect(ss.s.powerOff.pressure[i]! / (end * shape(mach) / shape(mEnd)) - 1,
          `${nose.shape} supersonic decay M${m}`).toBeCloseTo(0, 12);
      }
    }
  }, 30_000);
});
