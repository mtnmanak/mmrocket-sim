import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ComponentNode, ComponentType } from '@online-openrocket/engine';
import { applyPresetLinks, catalogueDifferences, componentToPreset, csvToPresets, KIND_FOR_TYPE, presetPatch, presetsToCsv } from './presets.js';
import { defaultParams } from '../tree/schema.js';

const tube = { length: 0.27, outerRadius: 0.032, thickness: 0.0017 };
const shapes = { length: 0.14, thickness: 0.0011, shape: 'power', shapeParameter: 0.63, filled: false };
const values: Partial<Record<ComponentType, Record<string, unknown>>> = {
  bodytube: { ...tube, filled: true }, innertube: tube, tubecoupler: tube, launchlug: tube, engineblock: tube,
  centeringring: { length: 0.004, outerRadius: 0.031, innerRadius: 0.014 },
  bulkhead: { length: 0.003, outerRadius: 0.031 },
  nosecone: { ...shapes, aftRadius: 0.032, shoulderRadius: 0.03, shoulderLength: 0.02, shoulderThickness: 0.002 },
  transition: { ...shapes, foreRadius: 0.02, aftRadius: 0.032, clipped: false,
    foreShoulderRadius: 0.018, foreShoulderLength: 0.01, foreShoulderThickness: 0.001,
    aftShoulderRadius: 0.03, aftShoulderLength: 0.02, aftShoulderThickness: 0.002 },
  parachute: { diameter: 0.76, cd: 1.4, spillHoleDiameter: 0.08, packedRadius: 0.02, packedLength: 0.09,
    lineCount: 8, lineLength: 0.9 },
  streamer: { stripLength: 1.2, stripWidth: 0.12, cd: 0.4, packedRadius: 0.012, packedLength: 0.08 },
};

describe('M2.1 componentToPreset', () => {
  it.each(Object.keys(KIND_FOR_TYPE) as ComponentType[])('round-trips %s dimensions, material and own mass through CSV', (type) => {
    const surface = type === 'parachute' || type === 'streamer';
    const materials = surface ? { surfaceMaterialName: 'My fabric', surfaceDensity: 0.052 }
      : { materialName: 'My composite', density: 1234 };
    const lines = type === 'parachute' ? { lineMaterialName: 'My cord', lineDensity: 0.0012 } : {};
    const expected = { ...values[type], ...materials, ...lines, overrideMass: 0.047 };
    const node: ComponentNode = { type, name: 'My component', ...defaultParams(type), ...expected };
    const before = JSON.stringify(node);
    const saved = componentToPreset(node);
    expect(saved.kind).toBe(KIND_FOR_TYPE[type]);
    expect(saved.description).toBe('My component');
    const csvRow = csvToPresets(presetsToCsv([{ ...saved, partNo: 'TEST-1' }]))[0]!;
    const fresh: ComponentNode = { type, ...defaultParams(type), ...presetPatch(type, csvRow, undefined, undefined, { saved: true }) };
    for (const [key, value] of Object.entries(expected)) {
      if (typeof value === 'number') expect(fresh[key], key).toBeCloseTo(value, 12);
      else expect(fresh[key], key).toEqual(value);
    }
    expect(fresh['overrideSubcomponentsMass']).toBeUndefined();
    expect(JSON.stringify(node)).toBe(before); // saving never edits the design
  });

  it.each([undefined, 0.125])('saves only an own override (%s)', (overrideMass) => {
    const node: ComponentNode = { type: 'bodytube', mass: 42, overrideMass, ...tube };
    const p = componentToPreset(node);
    expect(p.mass).toBe(overrideMass);
    expect(presetPatch('bodytube', p, undefined, undefined, { saved: true })['overrideMass']).toBe(overrideMass);
    expect(componentToPreset({ ...node, overrideSubcomponentsMass: true }).mass).toBeUndefined();
  });

  it('clears optional dimensions while keeping required dimensions when saved CSV cells are blank', () => {
    for (const type of Object.keys(KIND_FOR_TYPE) as ComponentType[]) {
      const p = componentToPreset({ type });
      const fresh = { ...defaultParams(type), ...presetPatch(type, p, undefined, undefined, { saved: true }) };
      for (const key of Object.keys(values[type]!)) {
        const required = ['length', 'thickness', 'stripLength', 'stripWidth'].includes(key)
          || (key === 'outerRadius' && ['bodytube', 'innertube', 'launchlug'].includes(type))
          || (key === 'aftRadius' && type === 'nosecone');
        expect(fresh[key], `${type}.${key}`).toEqual(required ? defaultParams(type)[key] : undefined);
      }
      expect(fresh['overrideMass']).toBeUndefined();
    }
  });

  it.each(Object.keys(KIND_FOR_TYPE) as ComponentType[])('round-trips unnamed default materials for %s through CSV', (type) => {
    const node: ComponentNode = { type, ...defaultParams(type) };
    const row = csvToPresets(presetsToCsv([{ ...componentToPreset(node), partNo: 'DEFAULT' }]))[0]!;
    const picked: ComponentNode = { ...node, materialName: 'Previous', ...presetPatch(type, row, undefined, undefined, { saved: true }) };
    for (const [key, value] of Object.entries(defaultParams(type))) {
      if (typeof value === 'number') expect(picked[key], key).toBeCloseTo(value, 12);
    }
    if (node['density'] !== undefined) expect(picked['materialName']).toBeUndefined();
    expect(picked['surfaceMaterialName']).not.toBe('Custom');
    expect(picked['lineMaterialName']).not.toBe('Custom');
  });

  it.each(['nosecone', 'transition'] as const)('has no shoulder conflict immediately after picking a solid saved %s with hollow shoulders', (type) => {
    const row = componentToPreset({ type, ...values[type], filled: true });
    const picked: ComponentNode = { type, ...presetPatch(type, row, undefined, undefined, { saved: true }) };
    expect(catalogueDifferences(picked, row)).toEqual([]);
    const takeShape = catalogueDifferences({ ...picked, shape: 'ogive' }, row).find((d) => d.key === 'shape')!.patch;
    expect(takeShape).toMatchObject({ shape: 'power', shapeParameter: 0.63 });
    if (type === 'transition') expect(takeShape['clipped']).toBe(false);
  });

  it('keeps target packed size when a saved parachute has none and is picked into a tube', () => {
    const target = { type: 'parachute', packedRadius: 0.02, packedLength: 0.12 } as const;
    const patch = presetPatch('parachute', componentToPreset({ type: 'parachute' }), undefined, { parentRadius: 0.03 }, { saved: true });
    expect({ ...target, ...patch }).toMatchObject(target);
  });

  it('keeps a typed mass and missing rigid material but clears a previous My part mass', () => {
    const row = { ...componentToPreset({ type: 'bodytube' }), partNo: 'T1' };
    const typed: ComponentNode = { type: 'bodytube', overrideMass: 0.12, density: 1234, materialName: 'My composite' };
    const patch = presetPatch('bodytube', row, { node: typed, presets: [] }, undefined, { saved: true });
    expect({ ...typed, ...patch }).toMatchObject({ overrideMass: 0.12, density: 1234, materialName: 'My composite' });
    const old = { ...row, partNo: 'OLD', mass: 0.08 };
    const held: ComponentNode = { type: 'bodytube', presetManufacturer: old.manufacturer, presetPartNo: old.partNo, overrideMass: 0.08 };
    expect(presetPatch('bodytube', row, { node: held, presets: [old] }, undefined, { saved: true }))
      .toMatchObject({ overrideMass: undefined, overrideSubcomponentsMass: undefined });
  });

  it.each([{ lineCount: 0, lineLength: 0.9 }, { lineCount: 8, lineLength: 0 }, { lineCount: 0, lineLength: 0 }])('round-trips zero shroud-line dimensions %s through CSV', (lines) => {
    const row = csvToPresets(presetsToCsv([{ ...componentToPreset({ type: 'parachute', ...values.parachute, ...lines }), partNo: 'ZERO' }]))[0]!;
    expect(presetPatch('parachute', row, undefined, undefined, { saved: true })).toMatchObject(lines);
  });

  it.each([0, -1])('guards unsafe saved CSV mass and recovery values (%s)', (bad) => {
    const row = { ...componentToPreset({ type: 'parachute' }), partNo: 'P1', mass: bad,
      dragCoefficient: bad, diameter: bad, lineCount: bad, lineLength: bad };
    const parsed = csvToPresets(presetsToCsv([row]))[0]!;
    const patch = presetPatch('parachute', parsed, undefined, undefined, { saved: true });
    for (const key of ['overrideMass', 'cd', 'diameter']) expect(patch[key], key).toBeUndefined();
    for (const key of ['lineCount', 'lineLength']) expect(patch[key], key).toBe(bad === 0 ? 0 : undefined);
    expect(presetPatch('bodytube', { ...parsed, kind: 'BodyTube' }, undefined, undefined, { saved: true }))
      .not.toHaveProperty('overrideMass');
  });

  it('refuses fractional and non-finite saved line counts', () => {
    for (const lineCount of [-1, 1.5, NaN, Infinity]) {
      const row = { ...componentToPreset({ type: 'parachute' }), lineCount };
      expect(presetPatch('parachute', row, undefined, undefined, { saved: true })['lineCount']).toBeUndefined();
    }
  });

  it('fits a saved parachute to its new bay while preserving packed volume', () => {
    const row = componentToPreset({ type: 'parachute', packedRadius: 0.05, packedLength: 0.12 });
    const patch = presetPatch('parachute', row, undefined, { parentRadius: 0.038 }, { saved: true });
    expect(patch['packedRadius']).toBeCloseTo(0.038, 12);
    expect(patch['packedLength']).toBeCloseTo(0.05 ** 2 * 0.12 / 0.038 ** 2, 12);
  });

  it('keeps saved-row link fill on ordinary catalogue semantics', () => {
    for (const type of Object.keys(KIND_FOR_TYPE) as ComponentType[]) {
      const row = { ...componentToPreset({ type, ...values[type] }), partNo: 'LINK' };
      const plain = { ...row, savedComponent: false };
      expect(presetPatch(type, row)).toEqual(presetPatch(type, plain));
      for (const explicit of [{}, { innerRadius: 0 }]) {
        const node: ComponentNode = { type, ...explicit };
        const ordinary = { ...node };
        const notes: string[] = [], ordinaryNotes: string[] = [];
        applyPresetLinks([{ node, manufacturer: row.manufacturer, partNo: row.partNo }], [row], notes);
        applyPresetLinks([{ node: ordinary, manufacturer: plain.manufacturer, partNo: plain.partNo }], [plain], ordinaryNotes);
        expect(node, type).toEqual(ordinary);
        expect(notes, type).toEqual(ordinaryNotes);
        expect(node, type).not.toHaveProperty('packedRadius');
        expect(node, type).not.toHaveProperty('packedLength');
      }
    }
  });

  it('rejects a component type without presets', () => {
    expect(() => componentToPreset({ type: 'freeformfinset' })).toThrow('no part presets');
  });
});

it('M2.4 documents saving, browser-local lifetime, the My parts view, delete and CSV', () => {
  const guide = readFileSync(new URL('../../user-guide.md', import.meta.url), 'utf8');
  const section = guide.slice(guide.indexOf('## Component presets'), guide.indexOf('### Adding your own parts through CSV'));
  for (const words of ['Save as My part', 'My parts only', 'Delete', 'browser only', 'CSV', 'automatic']) expect(section).toContain(words);
  expect(guide).not.toContain('no filter for your own rows');
  expect(guide).not.toContain('There is no "save this part as a preset" button');
});

it('uses a prototype-free saved-field lookup for file-supplied component types', () => {
  const row = { kind: 'BodyTube', manufacturer: 'Mine', partNo: 'X', description: '', savedComponent: true };
  expect(presetPatch('constructor' as ComponentType, row, undefined, undefined, { saved: true })).toEqual({
    name: 'Mine X', presetManufacturer: 'Mine', presetPartNo: 'X', orkPresetManufacturer: undefined,
    orkPresetPartNo: undefined, orkPresetDigest: undefined,
  });
});

it('documents the My part shape, mass, packing, keyboard and CSV exceptions', () => {
  const guide = readFileSync(new URL('../../user-guide.md', import.meta.url), 'utf8');
  const glossary = guide.split('**Component preset**')[1]!.split('\n')[0]!;
  for (const term of ['My part', 'shape parameter', 'mass', 'packed size', 'Flip to tail cone', 'holed']) expect(glossary).toContain(term);
  for (const term of ['Backspace', 'My parts only', 'streamers', 'CSV']) expect(guide).toContain(term);
});
