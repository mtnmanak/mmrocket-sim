import type { ComponentNode } from '@online-openrocket/engine';
import { DEFAULT_FILLET_MATERIAL } from '../data/materials.js';
import { num, numOpt } from './nodeNum.js';
import { blankValue, fieldLimit, type FieldDef } from './schema.js';
import { tubeFinMaxCount, tubeFinMaxRadius, tubeFinRadius } from './tubefins.js';
import { shapeParamDefault, shapeParamMax } from './shapeProfile.js';
import { ventLimit } from './canopyVent.js';

/**
 * Model limits in SI, independent of the panel's display units (audit
 * 2026-10-11, S3a-8). Typing, sliders and catalogue choices read one rule;
 * placeholders keep their exact base separately from their rounded label.
 */
export function numericFieldRules(node: ComponentNode, field: FieldDef, tubeFinBodyR: number | null) {
  const raw = numOpt(node, field.key);
  let maxSi: number | undefined;
  let maxCount: number | undefined;
  let autoRadiusSi: number | undefined;
  let shapeDefault: number | undefined;
  if (tubeFinBodyR !== null && field.key === 'outerRadius') {
    const n = Math.round(num(node, 'finCount', 6));
    maxSi = tubeFinMaxRadius(n, tubeFinBodyR) ?? undefined;
    if (raw === undefined) autoRadiusSi = tubeFinRadius(node, tubeFinBodyR);
  }
  if (tubeFinBodyR !== null && field.key === 'finCount') {
    // Preserve the panel's positive-radius predicate, including +Infinity:
    // the touching-count rule handles it just as before this extraction.
    const r = numOpt(node, 'outerRadius') ?? (node['outerRadius'] === Infinity ? Infinity : 0);
    if (r > 0) maxCount = tubeFinMaxCount(r, tubeFinBodyR);
  }
  const limit = fieldLimit(node.type, field.key);
  if (field.unit === 'count' && limit?.hmax !== undefined) {
    maxCount = Math.min(maxCount ?? Infinity, limit.hmax);
  }
  if (field.key === 'shapeParameter') {
    const shape = String(node['shape'] ?? (node.type === 'transition' ? 'conical' : 'ogive'));
    maxSi = shapeParamMax(shape);
    if (raw === undefined) shapeDefault = shapeParamDefault(shape);
  }
  // The same canopy ceiling the engine flies, with its absent-diameter fallback.
  if (node.type === 'parachute' && field.key === 'spillHoleDiameter') {
    const vent = ventLimit(node);
    if (vent) maxSi = vent.maxHole;
  }
  return { maxSi, maxCount, autoRadiusSi, shapeDefault, limit };
}

/**
 * A first fillet gets paste; disabling an implicit Cardboard fillet remembers
 * its material for the next enable/reload. Stored and edit-supplied material
 * always win. Pure so non-panel writers can use it too (audit 2026-10-11, S3a-8).
 */
export function filletMaterialPatch(node: ComponentNode, next: number, patch: Partial<ComponentNode>): Partial<ComponentNode> {
  if (!('filletDensity' in patch) && !('filletMaterialName' in patch) && !('filletMaterialGroup' in patch)
    && node['filletDensity'] === undefined && node['filletMaterialName'] === undefined
    && node['filletMaterialGroup'] === undefined) {
    const previous = numOpt(node, 'filletRadius') ?? 0;
    if (next === 0 && previous > 0) {
      return { ...patch, filletDensity: blankValue(node.type, 'filletDensity'), filletMaterialName: 'Cardboard' };
    } else if (next > 0 && previous === 0) {
      return { ...patch, filletDensity: DEFAULT_FILLET_MATERIAL.density, filletMaterialName: DEFAULT_FILLET_MATERIAL.name };
    }
  }
  return patch;
}
