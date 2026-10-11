import { describe, expect, it } from 'vitest';
import { OrkRocket, type RocketTree } from './orkEngine.js';

// Board row 87, "M3+ deficit on the shipped default" (approved by Eric 2026-10-11).
//
// The classic OGIVE nose branch builds its whole supersonic wave-drag curve from `sinphi`, the
// surface slope over the aft 1 % of the nose. A TANGENT ogive has zero slope there by definition,
// so the curve collapses to ~0.0002 above M1.3 and the only supersonic nose drag left is a
// transonic bump. The Supersonic model has replaced that branch with the Fleeman ogive
// correlation since Phase 5; the Rogers Kbf model (the app default) now takes the same branch
// above M1. At and below M0.8 it keeps the desktop curve (subsonic body drag is parked, Eric
// 2026-09-04) - bit for bit at L/D 1.8 and above, with the stubby-nose floor below that (board
// row 89) - and the Fleeman drag-divergence tail's excess is smoothstepped in over M0.8-1.0.
// Classic stays the desktop branch, conical noses and cone-like secant ogives (shape parameter
// < 0.35) stay on the classic branch in every model.
//
// Requires the rebuilt kernel (npm run engine:js). Isolated nose-only rockets: at zero AoA the
// sweep's pressure CD is the nose's own wave drag, referenced to its base area.

type Model = 'classic' | 'kbf' | 'supersonic';
const R = 0.02;

function nose(shape: string, shapeParameter: number, fineness: number): RocketTree {
  return {
    name: 'ogiveWave',
    components: [
      { type: 'nosecone', id: 'nose', shape, shapeParameter, length: 2 * R * fineness, aftRadius: R, thickness: 0.002 },
    ],
  } as RocketTree;
}

function pressure(t: RocketTree, model: Model, machs: number[]): number[] {
  const r = OrkRocket.buildTree(t);
  r.setRogersModifiedBarrowman(model !== 'classic');
  r.setSupersonicAero(model === 'supersonic');
  const s = r.dragSweep({ machMin: 0.05, machMax: 6, machStep: 0.05 });
  return machs.map((m) => {
    const i = s.machs.findIndex((x) => Math.abs(x - m) < 1e-9);
    if (i < 0) throw new Error(`Mach ${m} not on the sweep grid`);
    return s.powerOff.pressure[i]!;
  });
}

/** Fleeman, Tactical Missile Design: CD_wave = (1.59 + 1.83/M^2) * atan(0.5/(l_N/d))^1.69. */
const fleeman = (m: number, fineness: number) => (1.59 + 1.83 / (m * m)) * Math.atan(0.5 / fineness) ** 1.69;

const SUPERSONIC = [2, 3, 5];

describe('tangent-ogive nose wave drag under Rogers Kbf', () => {
  it('Kbf charges a tangent ogive the Fleeman wave drag the Supersonic model does', { timeout: 30_000 }, () => {
    for (const fineness of [3, 4, 6]) {
      const t = nose('ogive', 1, fineness);
      const kbf = pressure(t, 'kbf', SUPERSONIC);
      const ss = pressure(t, 'supersonic', SUPERSONIC);
      SUPERSONIC.forEach((m, i) => {
        // Same branch, so the same number (within float noise between two calc objects).
        expect(kbf[i]).toBeCloseTo(ss[i]!, 10);
        // And a physical size: the correlation itself, within 5 % (the shape multiplier is 1.0
        // for a tangent ogive; the Mach grid lands exactly on these points).
        expect(Math.abs(kbf[i]! / fleeman(m, fineness) - 1)).toBeLessThan(0.05);
      });
    }
  });

  it('Classic keeps the desktop branch: a tangent ogive collapses above M1.3', { timeout: 30_000 }, () => {
    const t = nose('ogive', 1, 4);
    const classic = pressure(t, 'classic', SUPERSONIC);
    const kbf = pressure(t, 'kbf', SUPERSONIC);
    SUPERSONIC.forEach((_, i) => {
      expect(classic[i]).toBeLessThan(0.005);
      // The default model now carries at least ten times the classic figure.
      expect(kbf[i]!).toBeGreaterThan(10 * classic[i]!);
    });
  });

  it('wave drag decays with Mach on the Kbf branch, toward the Fleeman asymptote', { timeout: 30_000 }, () => {
    const [m2, m3, m5] = pressure(nose('ogive', 1, 4), 'kbf', SUPERSONIC);
    expect(m2!).toBeGreaterThan(m3!);
    expect(m3!).toBeGreaterThan(m5!);
    expect(m5!).toBeGreaterThan(1.59 * Math.atan(0.5 / 4) ** 1.69);
  });

  it('at and below M0.8 Kbf is the desktop curve (with the stubby-nose floor); at M1 it is the Fleeman curve', { timeout: 30_000 }, () => {
    for (const fineness of [1, 2, 4]) {
      const t = nose('ogive', 1, fineness);
      const low = [0.1, 0.3, 0.5, 0.65, 0.8];
      // Board row 89: below L/D 1.8 the desktop curve Kbf keeps carries the C7 stubby-nose floor,
      // a third of 0.8/(1+4f^2) tapering to zero at L/D 1.8; at L/D 2 and 4 it is Classic bit for bit.
      const floor = fineness < 1.8 ? (1 / 3) * (0.8 / (1 + 4 * fineness * fineness)) * (1 - (fineness / 1.8) ** 2) : 0;
      const kbfLow = pressure(t, 'kbf', low);
      const classicLow = pressure(t, 'classic', low);
      if (floor === 0) expect(kbfLow).toEqual(classicLow);
      else kbfLow.forEach((v, i) => expect(v, `L/D ${fineness} M${low[i]}`).toBeCloseTo(Math.max(classicLow[i]!, floor), 12));
      // Approaching M1 the drag-divergence tail exceeds the flat desktop clamp, and at M1 Kbf
      // joins the Supersonic curve (continuous: same value there, on the Fleeman bridge).
      const [kbf95, kbf1] = pressure(t, 'kbf', [0.95, 1]);
      const [cl95] = pressure(t, 'classic', [0.95]);
      const [ss95, ss1] = pressure(t, 'supersonic', [0.95, 1]);
      // Between them: no lower than the desktop value, no higher than the Supersonic tail.
      expect(kbf95!).toBeGreaterThan(cl95!);
      expect(kbf95!).toBeLessThanOrEqual(ss95! + 1e-15);
      expect(kbf1).toBeCloseTo(ss1!, 12);
    }
  });

  it('conical noses and cone-like secant ogives stay on the classic branch under Kbf', { timeout: 30_000 }, () => {
    for (const t of [nose('conical', 0, 4), nose('ogive', 0.2, 4)]) {
      const classic = pressure(t, 'classic', SUPERSONIC);
      const kbf = pressure(t, 'kbf', SUPERSONIC);
      SUPERSONIC.forEach((_, i) => expect(kbf[i]).toBe(classic[i]));
    }
  });
});
