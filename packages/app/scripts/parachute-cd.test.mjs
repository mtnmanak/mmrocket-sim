/**
 * The parachute drag coefficients and spill holes in the SHIPPED database.
 *
 * HOW THIS GOT HERE. Owner report 2026-09-01b: his 4" Wildman Extreme showed
 * 21 ft/s where the canopy should give about 14. The whole gap was one input —
 * the Fruity Chutes rows he was picking carried no Cd, so the kernel default of
 * 0.8 flew a canopy rated 2.2. v0.096 patched those ten rows from this
 * database's own sibling rows. v0.098 replaced that patch with the real thing.
 *
 * THE STANDING RULE, owner 2026-09-03: *"For Fruity Chutes, the standing rule
 * should be to take the information they have on their website as canonical and
 * it should supercede anything from other sources."* So every Fruity Chutes row
 * now comes from `merge-fruity-chutes.mjs` + `fruity-chutes-models.json`, which
 * hold the manufacturer's own published figures.
 *
 * WHAT THIS FILE GUARDS, and why each matters more than it looks:
 *
 *  - **A Cd never ships without its spill hole.** Their Cd is referenced to the
 *    canopy area MINUS the vent; our kernel uses the nominal diameter and scales
 *    by 1 − (d/D)². Apply one without the other and every vented canopy reads
 *    1.5–2 % slow. This is the invariant the whole exercise turns on.
 *  - **The spill ratios are theirs, not ours** — 0.176·D on every Iris, 0.20·D
 *    on every Classic and TARC, from their own descent-rate calculator.
 *  - **No RockSim duplicate comes back.** They were dropped 2026-09-03; a
 *    regeneration that reintroduces them puts the friendly-named, data-poor rows
 *    back in front of users.
 *  - **IFC-096-S is not 46 grams.** OpenRocket's own `.orc` carries a
 *    factor-of-ten slip on that row (0.046 kg for a 425 g canopy).
 *
 * It reads the SHIPPED `presets.json`, so a regeneration that loses any of this
 * fails the deploy rather than quietly changing people's descent rates. See
 * CLAUDE.md for the pipeline order — merge-fruity-chutes runs after
 * merge-cw-tubes and before apply-preset-corrections; curate-presets runs last.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const db = JSON.parse(readFileSync(join(here, '../src/data/presets.json'), 'utf8'));
const models = JSON.parse(readFileSync(join(here, 'fruity-chutes-models.json'), 'utf8'));
const chutes = db.presets.filter((p) => p.kind === 'Parachute');
const fruity = chutes.filter((p) => /fruity/i.test(String(p.manufacturer)));
const byPartNo = (pn) => chutes.find((p) => String(p.partNo) === pn);

describe('Fruity Chutes — the manufacturer\'s own data is canonical (ruled 2026-09-03)', () => {
  it('every published model is in the database, and nothing else claims to be one', () => {
    expect(models.models.length).toBe(68);
    expect(fruity.length).toBe(models.models.length);
  });

  it('EVERY Fruity Chutes row carries BOTH a Cd and a spill hole — they are one fact', () => {
    for (const p of fruity) {
      expect(typeof p.dragCoefficient, `${p.partNo} has no Cd`).toBe('number');
      expect(typeof p.spillHoleDiameter, `${p.partNo} has a Cd but no spill hole`).toBe('number');
      expect(p.spillHoleDiameter, String(p.partNo)).toBeGreaterThan(0);
      expect(p.spillHoleDiameter, `${p.partNo} spill hole is not smaller than the canopy`)
        .toBeLessThan(p.diameter);
    }
  });

  it('the spill ratios are Fruity Chutes own: 0.176 D for Iris, 0.20 D for Classic and TARC', () => {
    for (const p of fruity) {
      const ratio = p.spillHoleDiameter / p.diameter;
      const expected = /^IFC-/.test(String(p.partNo)) ? 0.176 : 0.20;
      expect(ratio, `${p.partNo} ${ratio.toFixed(4)}`).toBeCloseTo(expected, 3);
    }
  });

  it('the Iris Ultra rows read 2.2 — except the ZP, which they rate at 3.0', () => {
    const iris = fruity.filter((p) => /^IFC-/.test(String(p.partNo)));
    expect(iris.length).toBeGreaterThan(15);
    for (const p of iris) {
      expect(p.dragCoefficient, `${p.partNo} ${p.description}`)
        .toBe(/-ZP$/.test(String(p.partNo)) ? 3 : 2.2);
    }
  });

  it('the Classic Elliptical and TARC rows read 1.5 — their figure, not the 1.55 midpoint', () => {
    // OpenRocket's database chose 1.55, the middle of the "1.5 - 1.6" the product
    // pages state. Fruity Chutes own calculator and every published "lb @ 20 fps"
    // rating use 1.5, and 1.5 with the spill hole reproduces those ratings
    // exactly — so 1.5 is the number, ruled 2026-09-03.
    const cfc = fruity.filter((p) => /^(CFC|TARC)-/.test(String(p.partNo)));
    expect(cfc.length).toBeGreaterThan(10);
    for (const p of cfc) expect(p.dragCoefficient, String(p.partNo)).toBe(1.5);
  });

  it('the part he named is right, and the 10x mass slip in the .orc is fixed', () => {
    const named = byPartNo('IFC-084-S');
    expect(named, 'IFC-084-S has gone from the database').toBeTruthy();
    expect(named.dragCoefficient).toBe(2.2);
    expect(named.diameter).toBeCloseTo(84 * 0.0254, 6);

    // OpenRocket's Fruity_Chutes_Enhanced.orc stores 0.046209723 kg for a canopy
    // its own description calls 16.3 oz. Fruity Chutes say 425.5 g.
    const slip = byPartNo('IFC-096-S');
    expect(slip.mass).toBeGreaterThan(0.4);
    expect(slip.mass).toBeLessThan(0.5);
  });

  it('no RockSim duplicate has come back', () => {
    for (const pn of ['29161', '29162', '29163', '29165', '29167',
      '29181', '29182', '29183', '29184', '29185']) {
      expect(byPartNo(pn), `${pn} is back — it was dropped 2026-09-03`).toBeFalsy();
    }
    expect(fruity.some((p) => p.source === 'rocksim')).toBe(false);
  });

  it('the descriptions lead with the size, the way the dropped names did', () => {
    // "84\" Nylon Toroidal" is what people picked; the replacement has to be
    // findable by typing 84.
    for (const p of fruity) {
      expect(p.description, String(p.partNo)).toMatch(/^\d+(\.\d+)?"\s/);
    }
    expect(byPartNo('IFC-084-S').description).toMatch(/^84"/);
  });

  it('no parachute anywhere carries an obviously wrong Cd', () => {
    for (const p of chutes) {
      if (p.dragCoefficient === undefined) continue;
      expect(p.dragCoefficient, `${p.manufacturer} ${p.partNo}`).toBeGreaterThan(0.5);
      expect(p.dragCoefficient, `${p.manufacturer} ${p.partNo}`).toBeLessThanOrEqual(3);
    }
  });

  it('a spill hole never reaches a NON-Fruity row by accident', () => {
    // Only Fruity Chutes publish one today. If another manufacturer's rows gain
    // one, that is a new data source and wants its own merge step and its own
    // provenance — not a silent inheritance.
    const others = chutes.filter((p) => !/fruity/i.test(String(p.manufacturer))
      && typeof p.spillHoleDiameter === 'number');
    expect(others.map((p) => `${p.manufacturer} ${p.partNo}`)).toEqual([]);
  });
});
