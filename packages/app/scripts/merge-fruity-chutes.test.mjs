/**
 * Tests for merge-fruity-chutes.mjs — the step that makes Fruity Chutes' own
 * published data canonical (owner ruling 2026-09-03; CLAUDE.md "Fruity Chutes").
 *
 * Its three exports had no importer at all (audit 2026-09-22, Dead code row
 * 574: "drop them, or add the test that justifies them"). This is that test.
 * The step mutates shipped data and is re-applied after every wholesale
 * regeneration of presets.json, so the three things worth pinning are the
 * part-number join, the one-fact rule for Cd and spill hole, and that the
 * SHIPPED file already carries every published model — which is what fails if
 * a regeneration ever skips this step.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fcDescription, fcKey, mergeFruityChutes } from './merge-fruity-chutes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MODELS = JSON.parse(readFileSync(join(here, 'fruity-chutes-models.json'), 'utf8'));
const shippedPresets = () => JSON.parse(readFileSync(join(here, '..', 'src', 'data', 'presets.json'), 'utf8'));

describe('fcKey joins the site\'s sku to our part number', () => {
  it('drops OpenRocket\'s zero padding: IFC-084-S is the site\'s IFC-84-S', () => {
    expect(fcKey('IFC-084-S')).toBe(fcKey('IFC-84-S'));
    expect(fcKey('IFC-084-S')).toBe('IFC84S');
  });

  it('reads our trailing -N (nylon lines) as the site\'s base sku', () => {
    expect(fcKey('IFC-084-S-N')).toBe(fcKey('IFC-84-S'));
    expect(fcKey('CFC-12N')).toBe(fcKey('CFC-12'));
  });

  it('keeps sizes apart, and tolerates a missing part number', () => {
    expect(fcKey('CFC-12')).not.toBe(fcKey('CFC-120'));
    expect(fcKey(null)).toBe('');
  });

  it('no site sku ends in N, which is what makes stripping it safe', () => {
    for (const m of MODELS.models) expect(m.sku.toUpperCase().replace(/[^A-Z0-9]/g, '')).not.toMatch(/N$/);
  });
});

describe('fcDescription', () => {
  it('writes the size first, then Cd, weight and gores', () => {
    expect(fcDescription({ diameterIn: 12, family: 'Classic Elliptical', dragCoefficient: 1.5, weightOz: 1.31, gores: 8 }))
      .toBe('12" Classic Elliptical — Cd 1.5, 1.3 oz, 8 gores');
    expect(fcDescription({ diameterIn: 84.5, family: 'Iris Ultra', dragCoefficient: 2.2, weightOz: 42.4, gores: 16 }))
      .toBe('84.5" Iris Ultra — Cd 2.2, 42 oz, 16 gores');
  });
});

describe('mergeFruityChutes', () => {
  it('finds nothing to do on the shipped presets.json: every published model is already in it, current', () => {
    // The header's own promise ("IDEMPOTENT: a second run reports 0
    // changes"), held against the file users get. A regeneration that skipped
    // this step would show every model here as a change or an addition.
    const { changes, added, models } = mergeFruityChutes(shippedPresets(), MODELS);
    expect(models).toBe(MODELS.models.length);
    expect(changes).toEqual([]);
    expect(added).toEqual([]);
  });

  it('writes the Cd and the spill hole together, from the manufacturer', () => {
    const m = MODELS.models.find((x) => x.sku === 'CFC-12');
    const db = { presets: [
      { kind: 'Parachute', manufacturer: 'Fruity Chutes', partNo: 'CFC-012', material: 'Ripstop nylon',
        dragCoefficient: 0.8, diameter: 0.3, mass: 0.05, lineCount: 6 },
    ] };
    const data = { models: [m] };
    const { changes, added } = mergeFruityChutes(db, data);
    expect(added).toEqual([]);
    expect(changes).toHaveLength(1);
    const row = db.presets[0];
    expect(row.dragCoefficient).toBe(m.dragCoefficient);
    expect(row.spillHoleDiameter).toBe(m.spillHoleM);
    expect(row.mass).toBe(m.massKg);
    expect(row.lineCount).toBe(m.gores);
    // A second run over its own output is a no-op.
    expect(mergeFruityChutes(db, data).changes).toEqual([]);
  });

  it('refuses a Cd without its spill hole: they are one fact', () => {
    const m = { ...MODELS.models.find((x) => x.sku === 'CFC-12'), spillHoleM: undefined };
    const db = { presets: [
      { kind: 'Parachute', manufacturer: 'Fruity Chutes', partNo: 'CFC-12', material: 'Ripstop nylon' },
    ] };
    expect(() => mergeFruityChutes(db, { models: [m] })).toThrow(/Cd without a spill hole/);
  });

  it('adds a model the catalogue lacks, taking materials from its nearest sibling', () => {
    const small = MODELS.models.find((x) => x.sku === 'CFC-12');
    const big = MODELS.models.find((x) => x.sku !== 'CFC-12' && x.sku.startsWith('CFC-'));
    const db = { presets: [
      { kind: 'Parachute', manufacturer: 'Fruity Chutes', partNo: small.sku, material: 'Ripstop nylon',
        lineMaterial: 'Nylon line', diameter: small.diameterM, lineLength: 0.5 },
    ] };
    const { added } = mergeFruityChutes(db, { models: [small, big] });
    expect(added.map((a) => a.sku)).toEqual([big.sku]);
    const row = db.presets.find((r) => r.partNo === big.sku);
    expect(row.material).toBe('Ripstop nylon');
    expect(row.lineMaterial).toBe('Nylon line');
    expect(row.spillHoleDiameter).toBe(big.spillHoleM);
    expect(row.source).toBe('fruitychutes.com');
  });
});
