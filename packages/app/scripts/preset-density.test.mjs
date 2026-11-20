import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINE_DENSITY_RANGE, SURFACE_DENSITY_RANGE } from '../src/data/materialDensityRanges.ts';
import { LINE_MATERIALS, SURFACE_MATERIALS } from '../src/data/materials.ts';
import { CORRECTIONS } from './apply-preset-corrections.mjs';
import { presetKey } from './manufacturers.mjs';
import { fcKey } from './merge-fruity-chutes.mjs';
import { presetPatch } from '../src/services/presets.ts';

/**
 * A plausibility screen on every supplied material density the shipped parts
 * catalogue carries. Runs against the SHIPPED presets.json in `npm test`, so a
 * regeneration that re-imports an impossible upstream value fails the deploy.
 *
 * Why (2026-09-05): eighteen paper centering rings and engine blocks shipped
 * at 0.0011 kg/m3 — a hundred-thousandth of air — from 3 July to 5 September,
 * and weighed nothing in every rocket that used them. Four fiberglass nose
 * cones shipped at balsa density; one kraft tube at 9072 kg/m3, heavier than
 * steel. All faithfully transcribed from upstream .orc files, and nothing in
 * the pipeline asked whether the number could be true. This does.
 *
 * The band is deliberately wide. The lightest real bulk material a rocket is
 * built from is EPS foam at 20 kg/m3; the heaviest anything in the catalogue
 * plausibly is is a tungsten or lead weight around 19,000. Anything outside
 * [10, 25000] is a transcription error, not a material.
 */
const here = dirname(fileURLToPath(import.meta.url));
const db = JSON.parse(readFileSync(join(here, '..', 'src', 'data', 'presets.json'), 'utf8'));
const rows = db.presets ?? db;
const fcModels = JSON.parse(readFileSync(join(here, 'fruity-chutes-models.json'), 'utf8')).models;

const BULK_MIN = 10;
const BULK_MAX = 25000;

describe('row 148 recovery and tube corrections', () => {
  it('never leaves an unweighed polyethylene or ripstop nylon sheet unresolved', () => {
    expect(rows.filter(p => !(p.mass > 0) && p.material?.type === 'SURFACE'
      && /polyethylene|LDPE|rip\s*stop\s*nylon/i.test(p.material.name) && !Number.isFinite(p.material.density))
      .map(presetKey)).toEqual([]);
  });

  it.each(['302264', '302267', '302271'])('leaves the weighed Estes %s sheet unchanged', partNo => {
    const p = rows.find(p => p.manufacturer === 'Estes' && p.partNo === partNo);
    expect(p.mass).toBeGreaterThan(0);
    // Exercise a legitimate upstream density addition even while the current
    // catalogue omits it. The listed whole-canopy mass must still win.
    for (const candidate of [p, { ...p, material: { ...p.material, density: SURFACE_DENSITY_RANGE.min } }]) {
      if (candidate.material.density !== undefined) {
        expect(candidate.material.density).toBeGreaterThanOrEqual(SURFACE_DENSITY_RANGE.min);
        expect(candidate.material.density).toBeLessThanOrEqual(SURFACE_DENSITY_RANGE.max);
      }
      expect(presetPatch('parachute', candidate).overrideMass).toBe(p.mass);
    }
    expect(CORRECTIONS.some(c => c.key === presetKey(p))).toBe(false);
  });

  it('ships a resolved line density in the maker’s family on every Fruity Chutes model', () => {
    for (const m of fcModels.filter(m => /Spectra|nylon/i.test(m.style))) {
      const p = rows.find(p => p.manufacturer === 'Fruity Chutes' && fcKey(p.partNo) === fcKey(m.sku));
      expect(p.lineMaterial.name, m.sku).toMatch(/Spectra/i.test(m.style) ? /Spectra/i : /nylon/i);
      expect(Number.isFinite(p.lineMaterial.density), m.sku).toBe(true);
    }
  });

  const keys = [
    'Parachute|estes|302262',
    ...['12', '16', '20', '24', '32'].map(s => `Parachute|semroc|cp${s}`),
    'Streamer|publicmissiles|pmltbd123',
    ...['14', '18', '24', '30', '36'].map(s => `Parachute|semroc|pn${s}`),
    ...['036', '048', '060', '072', '084', '096', '120'].map(s => `Parachute|fruitychutes|ifc${s}n`),
  ];
  it.each(keys)('J4 V211-13 ships the sourced correction for %s', key => {
    // Independent owner/source targets: changing the applying table must fail.
    const c = CORRECTIONS.find(c => c.key === key);
    expect(c, key).toBeDefined();
    const p = rows.find(p => presetKey(p) === key);
    expect(p, key).toBeDefined();
    const field = key.startsWith('Parachute|fruitychutes|') ? 'lineMaterial.density' : 'material.density';
    const expected = field === 'lineMaterial.density' ? 0.003718285
      : key === 'Streamer|publicmissiles|pmltbd123' ? 0.046952679179544
        : key.startsWith('Parachute|semroc|pn') ? 0.06685 : 0.0235;
    expect(c.fields, `${key} correction target`).toEqual({ [field]: { bad: undefined, good: expected } });
    expect(field.split('.').reduce((o, k) => o?.[k], p), `${key} ${field}`).toBe(expected);
  });

  it.each([
    ['BodyTube|apogee|10064', 0.0012, 0.0014],
    ['TubeCoupler|quest|10100', 0.0028, 0.0031],
    ['TubeCoupler|quest|10104', 0.0031, 0.0035],
  ])('%s uses a plausible geometry-derived mass, with no listed override', (key, min, max) => {
    const p = rows.find(p => presetKey(p) === key);
    expect(p.mass).toBeUndefined();
    const mass = Math.PI / 4 * (p.outsideDiameter ** 2 - p.insideDiameter ** 2)
      * p.length * p.material.density;
    // Broad gram-scale ranges distinguish a short paper tube from its former
    // 8.1 g / one-ounce override; geometry supplies the result, not a float pin.
    expect(mass).toBeGreaterThan(min);
    expect(mass).toBeLessThan(max);
    const correction = CORRECTIONS.find(c => c.key === key);
    expect(correction).toBeDefined();
    expect(correction.fields.mass.bad).toBeGreaterThan(mass);
    expect(correction.fields.mass.good).toBeUndefined();
  });
});

describe('J4 S10b-g1 BMS nose-block geometry', () => {
  // BMS CONES1.asp OD column, inches; independent of CORRECTIONS.
  it.each([
    ['NB20-2', 0.710], ['NB50-2', 0.950], ['NB55-2', 1.283], ['NB55-3', 1.283],
    ['NB60-4', 1.595], ['NB70-4', 2.180], ['NB80-4', 2.558],
  ])('ships %s at its maker’s diameter', (partNo, inches) => {
    const p = rows.find(p => p.manufacturer === 'BalsaMachining' && p.partNo === partNo);
    expect(p.outsideDiameter).toBeCloseTo(inches * 0.0254, 12);
    expect(p.mass).toBeUndefined();
  });

  it('screens BT-sized bulkheads for inch-as-mm slips', () => {
    expect(rows.filter(p => p.kind === 'BulkHead' && /\bBT(?:20|50|55|60|70|80)\b/i.test(p.description)
      && !(p.outsideDiameter >= 0.005)).map(presetKey)).toEqual([]);
  });
});

describe('every bulk density in presets.json could belong to a real material', () => {
  it('lies in [10, 25000] kg/m3 and is a positive finite number', () => {
    const offenders = [];
    for (const p of rows) {
      const m = p.material;
      if (!m || m.type !== 'BULK') continue;
      const d = m.density;
      if (!(Number.isFinite(d) && d >= BULK_MIN && d <= BULK_MAX)) {
        offenders.push(`${p.kind} ${p.manufacturer} ${p.partNo}: "${m.name}" = ${d} kg/m3`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('a "paper" or "fiber" ring is not lighter than air or heavier than steel', () => {
    const offenders = [];
    for (const p of rows) {
      const m = p.material;
      if (!m || m.type !== 'BULK' || !/paper|fiber|kraft/i.test(m.name)) continue;
      if (!(m.density >= 200 && m.density <= 2000)) {
        offenders.push(`${p.kind} ${p.manufacturer} ${p.partNo}: "${m.name}" = ${m.density} kg/m3`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('nothing called fiberglass is lighter than water', () => {
    const offenders = rows
      .filter((p) => p.material?.type === 'BULK' && /fiberglass|fibreglass|g10|g12/i.test(p.material.name))
      .filter((p) => !(p.material.density >= 1000))
      .map((p) => `${p.kind} ${p.manufacturer} ${p.partNo}: "${p.material.name}" = ${p.material.density}`);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe.each([
  ['SURFACE', SURFACE_DENSITY_RANGE, SURFACE_MATERIALS, 'kg/m²'],
  ['LINE', LINE_DENSITY_RANGE, LINE_MATERIALS, 'kg/m'],
])('%s material densities', (type, { min, max }, builtins, unit) => {
  it(`keeps shipped densities within [${min}, ${max}] ${unit}`, () => {
    const offenders = [];
    for (const p of rows) {
      for (const field of ['material', 'lineMaterial']) {
        const m = p[field];
        // Missing densities are not numbers: presetPatch leaves the kernel
        // default in place. Do not invent a material value to fill those gaps.
        if (m?.type !== type || m.density === undefined) continue;
        if (!(Number.isFinite(m.density) && m.density >= min && m.density <= max)) {
          offenders.push(`${p.kind} ${p.manufacturer} ${p.partNo} ${field}: "${m.name}" = ${m.density} ${unit}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('also admits every built-in material of this type', () => {
    expect(builtins.filter(m => !(Number.isFinite(m.density) && m.density >= min && m.density <= max))).toEqual([]);
  });
});
