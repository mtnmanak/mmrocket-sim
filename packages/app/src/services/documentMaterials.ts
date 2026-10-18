import type { RocketTree } from '@online-openrocket/engine';
import type { DocumentMaterial, FlightTree } from '../model/design.js';
import { numOpt } from '../tree/nodeNum.js';
import type { XmlElement } from './xmlParse.js';
import { parseDecimal } from './xmlUtil.js';

export const DOCUMENT_MATERIAL_LIMIT = 256;
const GROUPS = new Set(['Metals', 'Woods', 'Plastics', 'Fabrics', 'PaperProducts', 'Foams',
  'Composites', 'Fibers', 'ThreadsLines', 'Other', 'Custom']);

/** One validator for XML, browser storage and the material picker. Maps never index by name. */
export function cleanDocumentMaterials(raw: unknown, notes?: string[]): DocumentMaterial[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    notes?.push('Document materials: 1 unreadable list was removed; expected a list (limit 256 entries).');
    return [];
  }
  const materials: DocumentMaterial[] = [];
  const seen = new Set<string>();
  let invalid = 0, duplicate = 0, capped = 0, groups = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { invalid++; continue; }
    const m = entry as Record<string, unknown>;
    const kind = m['kind'], name = m['name'], density = numOpt(m, 'density');
    if ((kind !== 'bulk' && kind !== 'surface' && kind !== 'line')
      || typeof name !== 'string' || !name.trim() || name.trim().length > 80
      || density === undefined || density <= 0) { invalid++; continue; }
    const key = JSON.stringify([kind, name.trim(), density]);
    if (seen.has(key)) { duplicate++; continue; }
    if (materials.length >= DOCUMENT_MATERIAL_LIMIT) { capped++; continue; }
    seen.add(key);
    const group = m['group'];
    const knownGroup = typeof group === 'string' && GROUPS.has(group);
    if (group !== undefined && !knownGroup) groups++;
    materials.push({ kind, name: name.trim(), density, ...(knownGroup ? { group } : {}) });
  }
  const entries = (count: number) => count === 1 ? 'entry' : 'entries';
  const repairs = [invalid ? `${invalid} invalid ${entries(invalid)} removed (known kind, 1–80 character name, finite density greater than zero required)` : '',
    duplicate ? `${duplicate} duplicate ${entries(duplicate)} removed` : '',
    capped ? `${capped} ${entries(capped)} omitted past the limit of ${DOCUMENT_MATERIAL_LIMIT}` : '',
    groups ? `${groups} unknown ${groups === 1 ? 'group' : 'groups'} removed` : ''].filter(Boolean);
  if (repairs.length) notes?.push(`Document materials: ${repairs.join('; ')}.`);
  return materials;
}

export function sanitizeDocumentMaterials<T extends RocketTree>(tree: T, notes?: string[]): T {
  const raw = (tree as FlightTree).documentMaterials;
  if (raw === undefined) return tree;
  const documentMaterials = cleanDocumentMaterials(raw, notes);
  // Reordered keys are harmless; retain clean trees by identity, as sanitizeTree does.
  if (Array.isArray(raw) && raw.length === documentMaterials.length && raw.every((m, i) => {
    const clean = documentMaterials[i]!;
    return m && Object.keys(m).length === Object.keys(clean).length
      && m.kind === clean.kind && m.name === clean.name && m.density === clean.density && m.group === clean.group;
  })) return tree;
  return { ...tree, documentMaterials };
}

export function readDocumentMaterials(root: XmlElement, notes: string[]): DocumentMaterial[] {
  if (root.tagName !== 'openrocket') return [];
  const entries = root.querySelector(':scope > docprefs')?.querySelector(':scope > docmaterials')
    ?.querySelectorAll(':scope > material') ?? [];
  return cleanDocumentMaterials(Array.from(entries, el => {
    // Java splits into at most four pieces: the optional group is the remaining text.
    const [type, name, density, ...group] = (el.textContent ?? '').split('|');
    return { kind: type === 'BULK' ? 'bulk' : type === 'SURFACE' ? 'surface' : type === 'LINE' ? 'line' : undefined,
      name, density: parseDecimal(density), ...(group.length ? { group: group.join('|') } : {}) };
  }), notes);
}
