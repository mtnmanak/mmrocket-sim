import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { newRailButtonPair, RAIL_BUTTON_AFT_GAP, railButtonPlacement } from './railButtonPlacement.js';

/**
 * The auto-place rule on its own. The panel's button — its words, and that it
 * writes exactly `patch` — is pinned in PropertyPanel.oneShots.test.tsx.
 *
 * The fixture: a 1 m tube starting 100 mm behind the nose tip (so spanning
 * 100-1100 mm), on a 1.1 m rocket.
 */
const button = (position?: { method: string; offset: number }) =>
  ({ id: 'rb', type: 'railbutton', outerDiameter: 0.0097, ...(position ? { position } : {}) }) as unknown as ComponentNode;

/** The kernel's station for a zero-length part on each method at offset 0. */
const STATION = { top: 0.1, middle: 0.6, bottom: 1.1 } as const;

describe('railButtonPlacement', () => {
  for (const method of ['top', 'middle', 'bottom'] as const) {
    it(`puts the forward button on the CG and reaches aft to an inch off the tail (${method})`, () => {
      const at = railButtonPlacement(button({ method, offset: 0 }), {
        rocketLength: 1.1, cg: 0.55, positionX: STATION[method], parentLength: 1,
      });
      expect(at.parentStart).toBeCloseTo(0.1, 12);
      expect(at.parentEnd).toBeCloseTo(1.1, 12);
      expect(at.fwdX).toBe(0.55);
      expect(at.aftX).toBeCloseTo(1.1 - RAIL_BUTTON_AFT_GAP, 15);
      expect(at.fits).toBe(true);
      expect(at.feasible).toBe(true);
      expect(at.patch.instanceCount).toBe(2);
      expect(at.patch.instanceSeparation).toBeCloseTo(1.1 - 0.0254 - 0.55, 12);
      // 0.45 m into the tube, written on the button's own method.
      expect(at.patch.position.method).toBe(method);
      expect(at.patch.position.offset)
        .toBeCloseTo(method === 'top' ? 0.45 : method === 'middle' ? -0.05 : -0.55, 12);
    });
  }

  it('an inch is 25.4 mm', () => expect(RAIL_BUTTON_AFT_GAP).toBe(0.0254));

  it('a button with no position resolves on the top method', () => {
    const at = railButtonPlacement(button(), { rocketLength: 1.1, cg: 0.55, positionX: 0.1, parentLength: 1 });
    expect(at.patch.position.method).toBe('top');
    expect(at.patch.position.offset).toBeCloseTo(0.45, 12);
  });

  it('with no kernel station, the tube starts at the nose tip', () => {
    const at = railButtonPlacement(button({ method: 'top', offset: 0 }), {
      rocketLength: 1.1, cg: 0.55, positionX: undefined, parentLength: 1,
    });
    expect(at.parentStart).toBe(0);
    expect(at.parentEnd).toBe(1);
    expect(at.fits).toBe(false); // the aft button's 1.0746 m is past the tube's end
    expect(at.feasible).toBe(false);
  });

  it('refuses a CG forward of the tube', () => {
    const at = railButtonPlacement(button({ method: 'middle', offset: 0 }), {
      rocketLength: 1.1, cg: 0.05, positionX: 0.6, parentLength: 1,
    });
    expect(at.fits).toBe(false);
    expect(at.feasible).toBe(false);
  });

  it('refuses a pair 20 mm apart or less, and holds a nanometre of tolerance at the tube ends', () => {
    const at = (cg: number, rocketLength = 1.1) => railButtonPlacement(button({ method: 'middle', offset: 0 }), {
      rocketLength, cg, positionX: 0.6, parentLength: 1,
    });
    expect(at(1.0556).fits).toBe(true);
    expect(at(1.0556).feasible).toBe(false); // 19 mm
    expect(at(1.0536).feasible).toBe(true); // 21 mm
    // CG a hair forward of the tube's start still counts as on it.
    expect(at(0.1 - 5e-10).fits).toBe(true);
    expect(at(0.1 - 5e-9).fits).toBe(false);
  });
});

/**
 * A NEW rail button from the Add menu (Eric, 2026-09-30): Auto-place pressed on
 * it until it stops moving, else a pair on the tube alone. The Add menu's
 * wiring, the kernel, the flight and one Ctrl+Z are in addComponent.test.ts and
 * App.addRailButton.test.tsx.
 */
describe('newRailButtonPair', () => {
  const fresh = () => button({ method: 'middle', offset: 0 });
  /**
   * Auto-place on the 1 m tube at 100-1100 mm of a 1.1 m rocket, the button's
   * kernel station read from its own position (a zero-length part), and a CG
   * that `cgOf` gives for the button as placed — so a test can move the CG
   * with the pair the way its mass does.
   */
  const pressOn = (cgOf: (b: ComponentNode) => number) => (b: ComponentNode) => {
    const pos = b.position as { method: 'middle'; offset: number };
    return railButtonPlacement(b, {
      rocketLength: 1.1, cg: cgOf(b), positionX: STATION.middle + pos.offset, parentLength: 1,
    });
  };

  it('is exactly the auto-place patch on the first press when the CG does not move', () => {
    const pair = newRailButtonPair(fresh(), 1, pressOn(() => 0.55));
    const pressed = railButtonPlacement(fresh(), {
      rocketLength: 1.1, cg: 0.55, positionX: STATION.middle, parentLength: 1,
    });
    expect(pair.rule).toBe('auto-place');
    expect(pair.patch).toEqual(pressed.patch);
    expect(pair.patch.instanceCount).toBe(2);
    // One press placed it; the second found it had not moved.
    expect(pair.presses).toBe(2);
  });

  it('presses again while the pair moves the CG, and stops where a press no longer moves it', () => {
    // A CG that follows the pair's forward station a little (its own mass):
    // 0.55 m with the button at the tube middle, 5 % of any move after that.
    const cgOf = (b: ComponentNode) => {
      const fwd = STATION.middle + (b.position as { offset: number }).offset;
      return 0.55 + 0.05 * (fwd - STATION.middle);
    };
    const pair = newRailButtonPair(fresh(), 1, pressOn(cgOf));
    expect(pair.rule).toBe('auto-place');
    expect(pair.presses).toBeGreaterThan(2);
    // A fixed point: one more press does not move it.
    const again = pressOn(cgOf)({ ...fresh(), ...pair.patch } as ComponentNode);
    expect(Math.abs(again.patch.position.offset - pair.patch.position.offset)).toBeLessThan(1e-7);
    // The fixed point of cg = 0.55 + 0.05 (cg - 0.6): cg = (0.55 - 0.03) / 0.95.
    expect(STATION.middle + pair.patch.position.offset).toBeCloseTo(0.52 / 0.95, 6);
  });

  it('keeps the last accepted placement when a later press refuses', () => {
    let n = 0;
    const pair = newRailButtonPair(fresh(), 1, (b) => (++n === 1 ? pressOn(() => 0.55)(b) : null));
    expect(pair.rule).toBe('auto-place');
    expect(pair.presses).toBe(1);
    expect(STATION.middle + pair.patch.position.offset).toBeCloseTo(0.55, 12);
  });

  it('with no build (no press), puts the pair at the tube middle and an inch off the tube end', () => {
    const pair = newRailButtonPair(fresh(), 1, null);
    expect(pair.rule).toBe('tube-middle');
    expect(pair.patch.instanceCount).toBe(2);
    expect(pair.patch.position).toEqual({ method: 'middle', offset: 0 });
    expect(pair.patch.instanceSeparation).toBeCloseTo(0.5 - RAIL_BUTTON_AFT_GAP, 12);
  });

  it('falls back to the tube when auto-place refuses the first press, or the design does not build', () => {
    // CG forward of the tube (the pair would leave it).
    expect(newRailButtonPair(fresh(), 1, pressOn(() => 0.05)).rule).toBe('tube-middle');
    // CG within 20 mm of the aft button's station.
    expect(newRailButtonPair(fresh(), 1, pressOn(() => 1.06)).rule).toBe('tube-middle');
    // A CG the kernel could not give a number for.
    expect(newRailButtonPair(fresh(), 1, pressOn(() => Number.NaN)).rule).toBe('tube-middle');
    // The design with the button in it does not build.
    expect(newRailButtonPair(fresh(), 1, () => null).rule).toBe('tube-middle');
  });

  it('on a tube too short for the middle rule, uses its quarter points — both buttons on the tube', () => {
    // 90.8 mm is the break-even: L/2 - 25.4 mm must exceed 20 mm.
    expect(newRailButtonPair(fresh(), 0.0909, null).rule).toBe('tube-middle');
    const pair = newRailButtonPair(fresh(), 0.08, null);
    expect(pair.rule).toBe('tube-quarters');
    expect(pair.patch.instanceCount).toBe(2);
    expect(pair.patch.instanceSeparation).toBeCloseTo(0.04, 12);
    // Forward button at 20 mm on the tube: 20 mm forward of its 40 mm middle.
    expect(pair.patch.position.method).toBe('middle');
    expect(pair.patch.position.offset).toBeCloseTo(-0.02, 12);
  });

  it("writes on the button's own position method", () => {
    const pair = newRailButtonPair(button({ method: 'top', offset: 0 }), 1, null);
    expect(pair.patch.position).toEqual({ method: 'top', offset: 0.5 });
  });
});
