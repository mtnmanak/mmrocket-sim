import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { BULK_MATERIALS, LINE_MATERIALS, SURFACE_MATERIALS } from '../data/materials.js';
import { numOpt } from '../tree/nodeNum.js';
import { MAX_BULK_DENSITY } from '../tree/schema.js';
import type { FlightTree } from '../model/design.js';
import { cleanDocumentMaterials } from './documentMaterials.js';

export type MaterialKind = 'bulk' | 'surface' | 'line';
const MATERIAL_LISTS = { bulk: BULK_MATERIALS, surface: SURFACE_MATERIALS, line: LINE_MATERIALS };
export const MATERIAL_UNITS = { bulk: 'kg/m³', surface: 'kg/m²', line: 'kg/m' };
export const materialNameKey = (name: string): string => name.trim().toLowerCase();
export const builtInMaterial = (kind: MaterialKind, name: string): boolean =>
  MATERIAL_LISTS[kind].some(m => materialNameKey(m.name) === materialNameKey(name));

// schema.ts permits zero; bulk zero flies the default, while the file readers
// discard zero surface/line densities. Reusable entries require positive values
// so they can travel in designs without changing the existing import behavior.
export const usableMaterialDensity = (density: number): boolean =>
  Number.isFinite(density) && density > 0;

export interface DesignMaterial {
  name: string;
  density: number;
  /** Parts, not material fields: a part using the same mix twice counts once. */
  count: number;
}

export function designMaterials(tree: RocketTree, kind: MaterialKind): DesignMaterial[] {
  const pairs = kind === 'bulk' ? [['materialName', 'density'], ['filletMaterialName', 'filletDensity']]
    : kind === 'surface' ? [['surfaceMaterialName', 'surfaceDensity']] : [['lineMaterialName', 'lineDensity']];
  const found = new Map<string, DesignMaterial>();
  const pending: ComponentNode[] = [...tree.components];
  while (pending.length) {
    const node = pending.pop()!;
    const used = new Set<string>();
    for (const [nameKey, densityKey] of pairs) {
      const name = node[nameKey!];
      const density = numOpt(node, densityKey!);
      if (typeof name !== 'string' || !name.trim() || materialNameKey(name) === 'custom' || builtInMaterial(kind, name)
        || density === undefined || !usableMaterialDensity(density)) continue;
      // Preserve the design's exact spelling and density when picked.
      const key = JSON.stringify([name, density]);
      if (used.has(key)) continue;
      used.add(key);
      const old = found.get(key);
      if (old) old.count++;
      else found.set(key, { name, density, count: 1 });
    }
    pending.push(...node.children ?? []);
  }
  // Desktop OR replaces pipes in document-list names, but keeps them on parts.
  // Only merge the document alias; preserve each part's exact selectable pair.
  const documentKey = (name: string, density: number) => JSON.stringify([name.replaceAll('|', ' ').trim(), density]);
  const partKeys = new Set([...found.values()].map(m => documentKey(m.name, m.density)));
  for (const m of cleanDocumentMaterials((tree as FlightTree).documentMaterials)) {
    if (m.kind !== kind || materialNameKey(m.name) === 'custom'
      || (kind === 'bulk' && m.density > MAX_BULK_DENSITY)
      || builtInMaterial(kind, m.name)
      || partKeys.has(documentKey(m.name, m.density))) continue;
    const key = JSON.stringify([m.name, m.density]);
    if (!found.has(key)) found.set(key, { name: m.name, density: m.density, count: 0 });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.density - b.density);
}
