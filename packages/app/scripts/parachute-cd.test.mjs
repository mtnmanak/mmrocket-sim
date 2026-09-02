/**
 * The parachute drag coefficients in the SHIPPED database.
 *
 * Owner report, 2026-09-01b: his 4" Wildman Extreme showed 21 ft/s against
 * 13.70 from Fruity Chutes' own calculator. Reproduced — the whole gap is one
 * input. At 8.57 kg under an 84 inch canopy, `v = sqrt(2mg/(rho·Cd·A))` gives
 * 22.72 ft/s at Cd 0.8 and 13.70 ft/s at Cd 2.2, their figure to the digit.
 *
 * He then asked the question that found the real bug: *"does our parts database
 * properly show that the Fruity Chutes IFC-084-S has a Cd of 2.2? - if so, why
 * isn't that updated when I choose that part?"*
 *
 * It does, and it is: `presetPatch` has applied `dragCoefficient` since v0.033.
 * But Fruity Chutes is in this catalogue TWICE — 42 rows from the OpenRocket
 * database that carry a Cd, and 10 from the RockSim source that did not. The
 * RockSim ten have the friendlier names ("84\" Nylon Toroidal"), so they are the
 * ones a user picks, and they silently fell back to the kernel default of 0.8.
 *
 * This test guards the SHIPPED presets.json, so a regeneration that drops these
 * values again fails the deploy rather than quietly halving people's descent
 * rates. The values are re-applied by `curate-presets.mjs`, which must run after
 * `fetch-component-presets.mjs` — see CLAUDE.md's pipeline order.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const db = JSON.parse(readFileSync(join(here, '../src/data/presets.json'), 'utf8'));
const chutes = db.presets.filter((p) => p.kind === 'Parachute');
const byPartNo = (pn) => chutes.find((p) => String(p.partNo) === pn);

describe('Fruity Chutes drag coefficients', () => {
  // Every Iris Ultra row in the database agrees on 2.2 and every Classic
  // Elliptical on 1.55, which is what makes the RockSim rows' values derivable
  // rather than invented.
  it('the toroidal Iris Ultra rows all read 2.2', () => {
    const iris = chutes.filter((p) => /^IFC-/.test(String(p.partNo)));
    expect(iris.length).toBeGreaterThan(15);
    for (const p of iris) expect(p.dragCoefficient, String(p.partNo)).toBe(2.2);
  });

  it('the Classic Elliptical rows all read 1.55', () => {
    const cfc = chutes.filter((p) => /^CFC-/.test(String(p.partNo)));
    expect(cfc.length).toBeGreaterThan(10);
    for (const p of cfc) expect(p.dragCoefficient, String(p.partNo)).toBe(1.55);
  });

  it('the part he named carries its published Cd', () => {
    const p = byPartNo('IFC-084-S');
    expect(p, 'IFC-084-S has gone from the database').toBeTruthy();
    expect(p.dragCoefficient).toBe(2.2);
    expect(p.diameter).toBeCloseTo(84 * 0.0254, 6);
  });

  it('the RockSim-sourced toroidal duplicates carry it too', () => {
    // 29181-29185 are the 48/60/72/84/96 inch Iris Ultra under RockSim part
    // numbers. Without a Cd they apply the kernel default 0.8 and descend
    // 1.66x too fast — and these are the rows with the obvious names.
    for (const pn of ['29181', '29182', '29183', '29184', '29185']) {
      const p = byPartNo(pn);
      expect(p, `${pn} missing`).toBeTruthy();
      expect(p.description).toMatch(/Toroidal/i);
      expect(p.dragCoefficient, `${pn} ${p.description}`).toBe(2.2);
    }
  });

  it('the RockSim-sourced elliptical duplicates carry it too', () => {
    for (const pn of ['29163', '29165', '29167']) {
      const p = byPartNo(pn);
      expect(p, `${pn} missing`).toBeTruthy();
      expect(p.description).toMatch(/Elliptical/i);
      expect(p.dragCoefficient, `${pn} ${p.description}`).toBe(1.55);
    }
  });

  it('no parachute carries an obviously wrong Cd', () => {
    // A canopy below ~0.5 or above ~3 is not a parachute the app should be
    // flying; this catches a units slip or a stray field far more cheaply than
    // a descent-rate report from a tester does.
    for (const p of chutes) {
      if (p.dragCoefficient === undefined) continue;
      expect(p.dragCoefficient, `${p.manufacturer} ${p.partNo}`).toBeGreaterThan(0.5);
      expect(p.dragCoefficient, `${p.manufacturer} ${p.partNo}`).toBeLessThanOrEqual(3);
    }
  });

  it('records the two rows still WITHOUT a Cd, so the gap stays visible', () => {
    // 29161 and 29162 are the 15 and 18 inch "Drogue Chute" rows. There is no
    // desktop row of that name to take a number from and a drogue's Cd is not
    // something to invent, so they are deliberately left alone and are [ERIC]
    // in open-items. If this list changes, it changed for a reason worth
    // reading about.
    const missing = chutes
      .filter((p) => /fruity/i.test(String(p.manufacturer)) && p.dragCoefficient === undefined)
      .map((p) => String(p.partNo))
      .sort();
    expect(missing).toEqual(['29161', '29162']);
  });
});
