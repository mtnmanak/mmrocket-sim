import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINE_DENSITY_RANGE, SURFACE_DENSITY_RANGE } from '../src/data/materialDensityRanges.ts';
import { LINE_MATERIALS, SURFACE_MATERIALS } from '../src/data/materials.ts';

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

const BULK_MIN = 10;
const BULK_MAX = 25000;

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
