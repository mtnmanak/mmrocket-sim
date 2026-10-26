import { csvCell, unescapeCsvText } from './csvUtil.js';
import { parseDecimal } from './xmlUtil.js';
import { numOpt } from '../tree/nodeNum.js';
import { MAX_BULK_DENSITY } from '../tree/schema.js';
import { builtInMaterial, materialNameKey, MATERIAL_UNITS, usableMaterialDensity, type MaterialKind } from './designMaterials.js';

export interface UserMaterial { kind: MaterialKind; name: string; density: number }
export const USER_MATERIALS_KEY = 'online-openrocket.user-materials.v1';
export const USER_MATERIALS_CHANGED = 'user-materials-changed';
export const USER_MATERIALS_LIMIT = 500;
export const userMaterialKey = (m: Pick<UserMaterial, 'kind' | 'name'>): string => `${m.kind}:${materialNameKey(m.name)}`;

export function materialProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'Expected a material entry';
  const m = value as { kind?: unknown; name?: unknown; density?: unknown };
  if (m.kind !== 'bulk' && m.kind !== 'surface' && m.kind !== 'line') return 'Kind must be bulk, surface or line';
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.trim().length > 80) return 'Material name must contain 1–80 characters';
  if (materialNameKey(m.name) === 'custom') return 'Custom is reserved for unnamed materials. Choose another name.';
  if (builtInMaterial(m.kind, m.name)) return `${m.name.trim()} is in the built-in list — pick it from the list`;
  const density = numOpt(m, 'density');
  if (density === undefined || !usableMaterialDensity(density)) {
    return 'Density must be a finite number greater than zero';
  }
  if (m.kind === 'bulk' && density > MAX_BULK_DENSITY) return `Bulk material density has a limit of ${MAX_BULK_DENSITY} kg/m³`;
  return null;
}

function normalized(value: unknown): UserMaterial {
  const m = value as UserMaterial;
  return { kind: m.kind, name: m.name.trim(), density: m.density };
}

export function readUserMaterials(): { materials: UserMaterial[]; note: string } {
  let raw: string | null;
  try { raw = localStorage.getItem(USER_MATERIALS_KEY); }
  catch { return { materials: [], note: 'Browser storage is blocked here, so My materials is unavailable.' }; }
  try {
    if (!raw) return { materials: [], note: '' };
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return { materials: [], note: 'My materials could not be read: expected a list. Import a saved CSV to restore it.' };
    const byKey = new Map<string, UserMaterial>();
    let refused = 0;
    for (const entry of data) {
      if (materialProblem(entry)) { refused++; continue; }
      const m = normalized(entry);
      byKey.delete(userMaterialKey(m));
      byKey.set(userMaterialKey(m), m);
    }
    const all = [...byKey.values()];
    const overflow = Math.max(0, all.length - USER_MATERIALS_LIMIT);
    const note = [refused ? `${refused} invalid My materials entries were ignored.` : '',
      overflow ? `My materials has a limit of 500 entries; ${overflow} older entries were ignored.` : ''].filter(Boolean).join(' ');
    return { materials: all.slice(-USER_MATERIALS_LIMIT), note };
  } catch {
    return { materials: [], note: 'My materials could not be read from browser storage. Import a saved CSV to restore it.' };
  }
}

export const loadUserMaterials = (): UserMaterial[] => readUserMaterials().materials;

/** No UI changes its saved state unless storage accepted the whole library. */
export function saveUserMaterials(materials: readonly UserMaterial[]): boolean {
  if (materials.length > USER_MATERIALS_LIMIT || materials.some(m => materialProblem(m))) return false;
  const byKey = new Map<string, UserMaterial>();
  for (const m of materials) byKey.set(userMaterialKey(m), normalized(m));
  try {
    localStorage.setItem(USER_MATERIALS_KEY, JSON.stringify([...byKey.values()]));
  } catch { return false; }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(USER_MATERIALS_CHANGED));
  return true;
}

export function userMaterialsToCsv(materials: readonly UserMaterial[]): string {
  return 'kind,name,density,unit\n' + materials.map(m =>
    // Escape a literal apostrophe before a formula lead too, so the guard is reversible.
    [m.kind, /^'+[=+\-@\t\r]/.test(m.name) ? `'${m.name}` : m.name, m.density,
      m.kind === 'bulk' ? 'kg/m3' : m.kind === 'surface' ? 'kg/m2' : 'kg/m'].map(csvCell).join(','),
  ).join('\n') + '\n';
}

/** Strict RFC-4180 records: malformed quotes refuse the import, never a partial row. */
function csvRecords(csv: string): { cells: string[]; line: number }[] {
  const rows: { cells: string[]; line: number }[] = [];
  let line = 1, startLine = 1;
  let row: string[] = [], cell = '', quoted = false, closed = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    if (ch === '\r' || (ch === '\n' && csv[i - 1] !== '\r')) line++;
    if (line > 20000 && !(line === 20001 && (i === csv.length - 1
      || (ch === '\r' && i === csv.length - 2 && csv[i + 1] === '\n')))) {
      throw new Error('CSV has a limit of 20000 physical rows');
    }
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else cell += ch;
    } else if (ch === ',' || ch === '\n' || ch === '\r') {
      row.push(cell); cell = ''; closed = false;
      if (ch !== ',') {
        if (row.some(c => c.trim())) rows.push({ cells: row, line: startLine });
        row = []; startLine = line;
        if (ch === '\r' && csv[i + 1] === '\n') i++;
      }
    } else if (ch === '"' && cell === '' && !closed) quoted = true;
    else {
      if (closed || ch === '"') throw new Error('Malformed CSV quoting');
      cell += ch;
    }
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (cell || row.length || closed) { row.push(cell); rows.push({ cells: row, line: startLine }); }
  return rows.filter(r => r.cells.some(c => c.trim()));
}

export function importUserMaterialsCsv(csv: string, existing: readonly UserMaterial[]) {
  const result = { materials: [...existing], added: 0, replaced: 0, refused: 0, reasons: [] as string[] };
  const originalKeys = new Set(existing.map(userMaterialKey));
  const importedKeys = new Set<string>();
  let rows: ReturnType<typeof csvRecords>;
  try { rows = csvRecords(csv.replace(/^\uFEFF/, '')); }
  catch (error) { return { ...result, refused: 1, reasons: [error instanceof Error && error.message.includes('limit')
    ? error.message : 'Malformed CSV: check quotes and separators'] }; }
  if (rows[0]?.cells.join(',') !== 'kind,name,density,unit') {
    return { ...result, refused: Math.max(1, rows.length - 1), reasons: ['CSV columns must be kind,name,density,unit'] };
  }
  for (const { cells, line } of rows.slice(1)) {
    const [kind, rawName = '', density = '', unit] = cells;
    // Undo precisely the formula guard written by csvCell, including quoted commas.
    const name = unescapeCsvText(rawName);
    const entry = { kind, name, density: parseDecimal(density) };
    let problem = cells.length !== 4 ? 'Expected four columns' : materialProblem(entry);
    if (!problem) {
      const m = entry as UserMaterial;
      const expected = m.kind === 'bulk' ? 'kg/m3' : m.kind === 'surface' ? 'kg/m2' : 'kg/m';
      if (unit !== expected && unit !== MATERIAL_UNITS[m.kind]) problem = `Unit must be ${expected}`;
      else {
        const index = result.materials.findIndex(old => userMaterialKey(old) === userMaterialKey(m));
        if (index >= 0) { result.materials[index] = normalized(m); }
        else if (result.materials.length >= USER_MATERIALS_LIMIT) problem = 'My materials has a limit of 500 entries';
        else { result.materials.push(normalized(m)); }
        if (!problem && !importedKeys.has(userMaterialKey(m))) {
          if (originalKeys.has(userMaterialKey(m))) result.replaced++;
          else result.added++;
          importedKeys.add(userMaterialKey(m));
        }
      }
    }
    if (problem) { result.refused++; result.reasons.push(`Row ${line}: ${problem}`); }
  }
  return result;
}
