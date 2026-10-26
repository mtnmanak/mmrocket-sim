import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { filletMaterialPatch, numericFieldRules } from './numericFieldRules.js';
import { FIELDS } from './schema.js';
import { applyStageNozzles } from './treeModel.js';
import { MAX_DIMENSION_M } from './schema.js';

it('bounds nozzle values installed from a saved configuration', () => {
  const tree = applyStageNozzles({ components: [{ type: 'stage', id: 's' }] }, { s: MAX_DIMENSION_M * 2 });
  expect(tree.components[0]!['nozzleExitDiameter']).toBe(MAX_DIMENSION_M);
});

const field = (node: ComponentNode, key: string) => FIELDS[node.type]!.find(f => f.key === key)!;
const rules = (node: ComponentNode, key: string, bodyRadius: number | null = null) =>
  numericFieldRules(node, field(node, key), bodyRadius);

it('treats a non-finite tube-fin radius as automatic when editing count', () => {
  expect(rules({ type: 'tubefinset', outerRadius: Infinity }, 'finCount', 0.02).maxCount).toBe(8);
});

describe('numeric model rules extracted from the panel (S3a-8)', () => {
  it('caps touching tube radii and counts, retaining the automatic SI radius', () => {
    const node: ComponentNode = { type: 'tubefinset', finCount: 6 };
    expect(rules(node, 'outerRadius', 0.02).maxSi).toBeCloseTo(0.02, 12);
    expect(rules(node, 'outerRadius', 0.02).autoRadiusSi).toBeCloseTo(0.02, 12);
    expect(rules({ ...node, outerRadius: 0.02 }, 'finCount', 0.02).maxCount).toBe(6);
    expect(rules({ ...node, outerRadius: 0.001 }, 'finCount', 0.02).maxCount).toBe(8);
    expect(rules({ ...node, finCount: 2 }, 'outerRadius', 0.02).maxSi).toBeUndefined();
    expect(rules({ ...node, outerRadius: 0.01 }, 'outerRadius', 0.02).autoRadiusSi).toBeUndefined();
    expect(rules(node, 'outerRadius').maxSi).toBeUndefined();
  });

  it('returns shape-specific ceilings and blank defaults without changing a stated parameter', () => {
    expect(rules({ type: 'nosecone', shape: 'haack' }, 'shapeParameter')).toMatchObject({ maxSi: 1 / 3, shapeDefault: 0 });
    expect(rules({ type: 'nosecone' }, 'shapeParameter')).toMatchObject({ maxSi: 1, shapeDefault: 1 });
    expect(rules({ type: 'transition' }, 'shapeParameter')).toMatchObject({ maxSi: 1, shapeDefault: 0 });
    expect(rules({ type: 'nosecone', shape: 'power', shapeParameter: 0.2 }, 'shapeParameter').shapeDefault).toBeUndefined();
  });

  it('uses the flown canopy ceiling, including absent, zero and non-finite diameters', () => {
    for (const diameter of [undefined, NaN, Infinity]) {
      expect(rules({ type: 'parachute', diameter }, 'spillHoleDiameter').maxSi).toBeCloseTo(0.285, 12);
    }
    expect(rules({ type: 'parachute', diameter: 2 }, 'spillHoleDiameter').maxSi).toBe(1.9);
    for (const diameter of [0, -1]) expect(rules({ type: 'parachute', diameter }, 'spillHoleDiameter').maxSi).toBeUndefined();
  });

  it.each(['trapezoidfinset', 'ellipticalfinset', 'freeformfinset'] as const)(
    'keeps first-enable and zero-radius material semantics for %s, rounded and airfoil', type => {
      for (const crossSection of ['rounded', 'airfoil']) {
        const node: ComponentNode = { type, crossSection, points: [[0, 0], [0.2, 0.1], [0.1, 0]] };
        const before = structuredClone(node);
        expect(filletMaterialPatch(node, 0.001, { filletRadius: 0.001 })).toEqual({
          filletRadius: 0.001, filletDensity: 1200, filletMaterialName: 'Epoxy + silica (fillet paste)',
        });
        expect(filletMaterialPatch({ ...node, filletRadius: 0.001 }, 0, { filletRadius: 0 })).toEqual({
          filletRadius: 0, filletDensity: 680, filletMaterialName: 'Cardboard',
        });
        expect(filletMaterialPatch(node, 0, { filletRadius: 0 })).toEqual({ filletRadius: 0 });
        expect(node).toEqual(before);
      }
    });

  it.each(['filletDensity', 'filletMaterialName', 'filletMaterialGroup'])(
    'preserves a stored or edit-supplied %s, including explicitly cleared partner keys', key => {
      const node: ComponentNode = { type: 'freeformfinset' };
      const patch = { filletRadius: 0.002 };
      expect(filletMaterialPatch({ ...node, [key]: 'kept' }, 0.002, patch)).toBe(patch);
      const partner = { ...patch, [key]: undefined };
      expect(filletMaterialPatch(node, 0.002, partner)).toBe(partner);
    });
});
