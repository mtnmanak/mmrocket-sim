import { describe, expect, it } from 'vitest';
import { csvToPresets, presetPatch, presetsToCsv, type Preset } from './presets.js';
import presetsJson from '../data/presets.json';

const db = (presetsJson as { presets: Preset[] }).presets;

describe('bundled preset database', () => {
  it('is present and substantial', () => {
    expect(db.length).toBeGreaterThan(3000);
  });

  it('covers the main component kinds', () => {
    for (const kind of ['BodyTube', 'NoseCone', 'Transition', 'CenteringRing', 'Parachute']) {
      expect(db.some((p) => p.kind === kind), kind).toBe(true);
    }
  });
});

describe('presetPatch', () => {
  it('maps a real body tube preset to node params', () => {
    const p = db.find((x) => x.kind === 'BodyTube'
      && typeof x['outsideDiameter'] === 'number' && typeof x['insideDiameter'] === 'number')!;
    const patch = presetPatch('bodytube', p);
    expect(patch['outerRadius']).toBeCloseTo((p['outsideDiameter'] as number) / 2);
    expect(patch['thickness']).toBeCloseTo(
      ((p['outsideDiameter'] as number) - (p['insideDiameter'] as number)) / 2);
    if (p.material?.type === 'BULK') expect(patch['density']).toBe(p.material.density);
  });

  it('maps a nose cone with shoulder + shape + catalog mass', () => {
    const p = db.find((x) => x.kind === 'NoseCone'
      && typeof x['shoulderDiameter'] === 'number' && typeof x.mass === 'number')!;
    const patch = presetPatch('nosecone', p);
    expect(patch['shoulderRadius']).toBeCloseTo((p['shoulderDiameter'] as number) / 2);
    expect(typeof patch['shape']).toBe('string');
    expect(patch['overrideMass']).toBe(p.mass);
  });

  it('maps a parachute with surface and line materials', () => {
    const p = db.find((x) => x.kind === 'Parachute' && x.material?.type === 'SURFACE')!;
    const patch = presetPatch('parachute', p);
    expect(patch['diameter']).toBe(p['diameter']);
    expect(patch['surfaceDensity']).toBe(p.material!.density);
  });
});

describe('CSV round-trip', () => {
  it('export → import preserves the essentials', () => {
    const sample = db.filter((p) => p.kind === 'BodyTube').slice(0, 5);
    const back = csvToPresets(presetsToCsv(sample));
    expect(back).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(back[i]!.partNo).toBe(sample[i]!.partNo);
      expect(back[i]!.manufacturer).toBe(sample[i]!.manufacturer);
      expect(back[i]!['outsideDiameter']).toBeCloseTo(sample[i]!['outsideDiameter'] as number, 9);
      expect(back[i]!.material?.density).toBeCloseTo(sample[i]!.material!.density, 6);
    }
  });

  it('handles quoted descriptions with commas', () => {
    const p: Preset = {
      kind: 'BodyTube', manufacturer: 'Me', partNo: 'X1',
      description: 'Tube, big, "the best"', length: 0.3, outsideDiameter: 0.025,
    };
    const back = csvToPresets(presetsToCsv([p]));
    expect(back[0]!.description).toBe('Tube, big, "the best"');
  });

  it('handles NEWLINES inside quoted cells (the export writes them)', () => {
    const p: Preset = {
      kind: 'BodyTube', manufacturer: 'Me', partNo: 'X2',
      description: 'line one\nline two', length: 0.25, outsideDiameter: 0.02,
    };
    const q: Preset = { kind: 'BodyTube', manufacturer: 'Me', partNo: 'X3', description: 'plain' };
    const back = csvToPresets(presetsToCsv([p, q]));
    expect(back).toHaveLength(2);
    expect(back[0]!.description).toBe('line one\nline two');
    expect(back[0]!['length']).toBeCloseTo(0.25, 9);
    expect(back[1]!.partNo).toBe('X3');
  });

  it('round-trips parachute shroud-line material through the CSV', () => {
    const chute: Preset = {
      kind: 'parachute', manufacturer: 'Test', partNo: 'PC-1', description: 'Chute',
      material: { name: 'Ripstop nylon', type: 'SURFACE', density: 0.067 },
      lineMaterial: { name: 'Braided Kevlar', type: 'LINE', density: 0.0018 },
      diameter: 0.45, lineCount: 8, lineLength: 0.5,
    };
    const back = csvToPresets(presetsToCsv([chute]));
    expect(back).toHaveLength(1);
    expect(back[0]!.lineMaterial?.name).toBe('Braided Kevlar');
    expect(back[0]!.lineMaterial?.density).toBeCloseTo(0.0018, 9);
    expect(back[0]!.lineMaterial?.type).toBe('LINE');
  });
});
