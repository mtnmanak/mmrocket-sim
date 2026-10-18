import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { designMaterials } from './designMaterials.js';
import type { FlightTree } from '../model/design.js';
import { BULK_MATERIALS, LINE_MATERIALS, SURFACE_MATERIALS } from '../data/materials.js';
import { MAX_BULK_DENSITY } from '../tree/schema.js';

const tree = (...components: ComponentNode[]): RocketTree => ({ components });
describe('design materials', () => {
  it.each([
    ['bulk', BULK_MATERIALS], ['surface', SURFACE_MATERIALS], ['line', LINE_MATERIALS],
  ] as const)('Round2 picker hides built-in document %s names at every density', (kind, builtIns) => {
    const builtIn = builtIns[0]!;
    const source: FlightTree = { components: [], documentMaterials: [
      { kind, name: ` ${builtIn.name.toUpperCase()} `, density: builtIn.density },
      { kind, name: builtIn.name, density: builtIn.density + 1 },
      { kind, name: ' CUSTOM ', density: 1 },
      { kind, name: 'At bulk limit', density: MAX_BULK_DENSITY },
      { kind, name: 'Above bulk limit', density: MAX_BULK_DENSITY + 1 },
    ] };
    const before = JSON.stringify(source);
    const offered = designMaterials(source, kind);
    expect(offered.some(m => m.name.trim().toLowerCase() === builtIn.name.toLowerCase())).toBe(false);
    expect(offered).toContainEqual({ name: 'At bulk limit', density: MAX_BULK_DENSITY, count: 0 });
    expect(offered.some(m => m.name.toLowerCase().trim() === 'custom')).toBe(false);
    expect(offered.some(m => m.density === builtIn.density)).toBe(false);
    expect(offered.some(m => m.name === 'Above bulk limit')).toBe(kind !== 'bulk');
    expect(JSON.stringify(source)).toBe(before);
  });
  it.each(['bulk', 'surface', 'line'] as const)('Round2 picker merges piped part names with desktop document %s aliases', kind => {
    const nameKey = kind === 'bulk' ? 'materialName' : kind === 'surface' ? 'surfaceMaterialName' : 'lineMaterialName';
    const densityKey = kind === 'bulk' ? 'density' : kind === 'surface' ? 'surfaceDensity' : 'lineDensity';
    const source: FlightTree = { components: [
      { type: 'bodytube', [nameKey]: ' Kraft|0.5mm ', [densityKey]: 900 },
    ], documentMaterials: [
      { kind, name: 'Kraft 0.5mm', density: 900 },
      { kind, name: 'Kraft 0.5mm', density: 901 },
      { kind: kind === 'bulk' ? 'line' : 'bulk', name: 'Kraft 0.5mm', density: 900 },
    ] };
    const before = JSON.stringify(source);
    expect(designMaterials(source, kind)).toEqual([
      { name: ' Kraft|0.5mm ', density: 900, count: 1 },
      { name: 'Kraft 0.5mm', density: 901, count: 0 },
    ]);
    expect(JSON.stringify(source)).toBe(before);
  });
  it('skips the reserved Custom placeholder in every material slot', () => {
    const source = tree({ type: 'bodytube', materialName: 'custom', density: 1200,
      filletMaterialName: ' CUSTOM ', filletDensity: 900,
      surfaceMaterialName: 'Custom', surfaceDensity: 0.1, lineMaterialName: 'custom', lineDensity: 0.01 });
    for (const kind of ['bulk', 'surface', 'line'] as const) expect(designMaterials(source, kind)).toEqual([]);
  });
  it('walks nested parts, includes fillets, distinguishes densities and counts parts once', () => {
    const source = tree({ type: 'stage', children: [
      { type: 'bodytube', materialName: 'Z mix', density: 900, children: [
        { type: 'freeformfinset', crossSection: 'rounded', materialName: 'A mix', density: 800,
          filletMaterialName: 'Z mix', filletDensity: 900 },
        { type: 'freeformfinset', crossSection: 'airfoil', materialName: 'Z mix', density: 1000 },
        { type: 'bodytube', materialName: 'Z mix', density: 900, filletMaterialName: 'Z mix', filletDensity: 900 },
      ] },
    ] });
    const before = JSON.stringify(source);
    expect(designMaterials(source, 'bulk')).toEqual([
      { name: 'A mix', density: 800, count: 1 },
      { name: 'Z mix', density: 900, count: 3 },
      { name: 'Z mix', density: 1000, count: 1 },
    ]);
    expect(JSON.stringify(source)).toBe(before);
  });
  it('keeps kinds separate, excludes built-ins case-insensitively, and skips nonpositive densities', () => {
    const source = tree(
      { type: 'bodytube', materialName: 'bALSa', density: 171, filletMaterialName: 'Bad', filletDensity: NaN },
      { type: 'bodytube', materialName: 'Zero bulk', density: 0 },
      { type: 'bodytube', materialName: 'Negative', density: -1 },
      { type: 'bodytube', materialName: 'Infinite', density: Infinity },
      { type: 'bodytube', materialName: '', density: 100 },
      { type: 'bodytube', materialName: 'Missing' },
      { type: 'parachute', surfaceMaterialName: 'Balsa', surfaceDensity: 0.1, lineMaterialName: 'My cord', lineDensity: 0.001 },
      { type: 'streamer', surfaceMaterialName: 'Zero cloth', surfaceDensity: 0 },
      { type: 'shockcord', lineMaterialName: 'Zero cord', lineDensity: 0 },
      { type: 'streamer', surfaceMaterialName: 'RIPSTOP NYLON', surfaceDensity: 0.067 },
      { type: 'shockcord', lineMaterialName: 'THREAD (HEAVY-DUTY)', lineDensity: 0.0003 },
    );
    expect(designMaterials(source, 'bulk')).toEqual([]);
    expect(designMaterials(source, 'surface')).toEqual([{ name: 'Balsa', density: 0.1, count: 1 }]);
    expect(designMaterials(source, 'line')).toEqual([{ name: 'My cord', density: 0.001, count: 1 }]);
  });
});
