import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { RAIL_BUTTON_AFT_GAP, railButtonPlacement } from './railButtonPlacement.js';

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
