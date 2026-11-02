import type { ComponentNode } from '@online-openrocket/engine';

/** File-carried values, before this app's catalogue can fill any blanks. */
export const ORK_PRESET_IMPORT_STATE = 'orkPresetImportState';

export function presetOverrideFields(type: ComponentNode['type']): readonly string[] {
  return type === 'parachute' ? ['cd', 'overrideMass']
    : type === 'railbutton' ? ['overrideCD', 'overrideMass'] : [];
}

export function presetImportState(node: ComponentNode): Record<string, boolean> | undefined {
  const raw = node[ORK_PRESET_IMPORT_STATE];
  const fields = presetOverrideFields(node.type);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !fields.length) return undefined;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length
    || !fields.every(key => Object.hasOwn(record, key) && typeof record[key] === 'boolean')) return undefined;
  return record as Record<string, boolean>;
}
