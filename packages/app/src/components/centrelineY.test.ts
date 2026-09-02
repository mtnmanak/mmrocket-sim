import { describe, expect, it } from 'vitest';
import { centrelineY } from './TreeSchematic.js';

/**
 * v0.092 — the hero canvas's chip headroom, spent where it was asked for.
 *
 * Owner report, 2026-09-01: "The gadget square has no room anymore, there is
 * almost no way to fit it in the canvas window without covering part of the
 * rocket when the 'All Stats' drawer is open."
 *
 * The headroom had been requested since v0.076 — App adds HERO_CHIP_RESERVE
 * (140px) to the stage height for exactly this — but the drawing is centred, so
 * half of it landed BELOW the rocket. Measured in the built app on a 1920x1080
 * window, the 124px chip overlapped the drawn nose cone by ~75px with the
 * drawer closed.
 *
 * These are the properties that make the fix safe to apply to every drawing.
 */

// The hero canvas's real numbers: RULER_TOP, the schematic's padding and the
// CG/CP callout lanes.
const GEOM = { gutY: 18, pad: 26, lanes: 34 };
const centred = (h: number, gutY = GEOM.gutY) => gutY + (h - gutY) / 2;

describe('centrelineY', () => {
  it('centres the drawing when nothing asks for headroom', () => {
    // Every caller but the hero canvas passes topReserve 0, so this pins that
    // they draw exactly as they did before the reserve existed.
    for (const h of [200, 335, 460, 620]) {
      expect(centrelineY({ ...GEOM, h, halfDrawn: 60, topReserve: 0 })).toBe(centred(h));
    }
  });

  it('moves the rocket down so the reserve lands ABOVE it', () => {
    const h = 460;
    const halfDrawn = 108;
    const skyAboveCentred = centred(h) - halfDrawn - GEOM.gutY;
    expect(skyAboveCentred, 'the premise: centring leaves less than the reserve')
      .toBeLessThan(140);

    const cy = centrelineY({ ...GEOM, h, halfDrawn, topReserve: 140 });
    expect(cy - halfDrawn - GEOM.gutY).toBe(140);
    expect(cy).toBeGreaterThan(centred(h));
  });

  it('takes the headroom out of the sky BELOW, not out of the rocket', () => {
    // The drawing's size is set by `scale` and is not this function's business.
    // What moves is where it sits: what the top gains, the bottom loses.
    const h = 460;
    const halfDrawn = 108;
    const before = centred(h);
    const after = centrelineY({ ...GEOM, h, halfDrawn, topReserve: 140 });
    const gainedAbove = (after - halfDrawn) - (before - halfDrawn);
    const lostBelow = (h - (before + halfDrawn)) - (h - (after + halfDrawn));
    expect(gainedAbove).toBe(lostBelow);
  });

  it('never pushes the rocket onto its own bottom callout lane', () => {
    // A greedy reserve would drive the rocket into the CP callout drawn below
    // it. keepBelow is what a symmetric layout leaves there, and it is a floor.
    const h = 460;
    const halfDrawn = 108;
    const keepBelow = GEOM.pad + GEOM.lanes / 2;
    for (const topReserve of [140, 400, 10_000]) {
      const cy = centrelineY({ ...GEOM, h, halfDrawn, topReserve });
      expect(h - (cy + halfDrawn)).toBeGreaterThanOrEqual(keepBelow);
    }
  });

  it('leaves a height-fitted drawing exactly where it was', () => {
    // When the rocket fills the box there is no slack to redistribute, and the
    // honest answer is to change nothing. This is the case that would otherwise
    // clip a fin off the bottom of the canvas.
    const h = 335;
    const halfDrawn = (h - 2 * GEOM.pad - GEOM.lanes - GEOM.gutY) / 2;
    expect(centrelineY({ ...GEOM, h, halfDrawn, topReserve: 140 })).toBe(centred(h));
  });

  it('is monotonic in the reserve and never moves the rocket UP', () => {
    const h = 460;
    const halfDrawn = 108;
    let previous = centred(h);
    for (const topReserve of [0, 20, 60, 140, 300]) {
      const cy = centrelineY({ ...GEOM, h, halfDrawn, topReserve });
      expect(cy).toBeGreaterThanOrEqual(previous);
      expect(cy).toBeGreaterThanOrEqual(centred(h));
      previous = cy;
    }
  });

  it('does nothing when centring already affords the reserve', () => {
    // A short rocket in a tall box already has more sky above it than asked
    // for; asking for less than you have must not pull the rocket down.
    const h = 620;
    const halfDrawn = 40;
    expect(centrelineY({ ...GEOM, h, halfDrawn, topReserve: 60 })).toBe(centred(h));
  });
});
