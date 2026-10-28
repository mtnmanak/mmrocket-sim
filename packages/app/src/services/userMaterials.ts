import { INITIAL_UNITS, noticeQuantity, type UnitSelection } from '../prefs/units.js';
import { csvCell, unescapeCsvText } from './csvUtil.js';
import { parseDecimal } from './xmlUtil.js';
import { numOpt } from '../tree/nodeNum.js';
import { MAX_BULK_DENSITY } from '../tree/schema.js';
import { backUpUnreadableStore } from './storeBackup.js';
import { builtInMaterial, materialNameKey, MATERIAL_UNITS, usableMaterialDensity, type MaterialKind } from './designMaterials.js';

export interface UserMaterial { kind: MaterialKind; name: string; density: number }
export const USER_MATERIALS_KEY = 'online-openrocket.user-materials.v1';
export const USER_MATERIALS_CHANGED = 'user-materials-changed';
export const USER_MATERIALS_LIMIT = 500;
export const userMaterialKey = (m: Pick<UserMaterial, 'kind' | 'name'>): string => `${m.kind}:${materialNameKey(m.name)}`;

export function materialProblem(value: unknown, units: UnitSelection = INITIAL_UNITS): string | null {
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
  if (m.kind === 'bulk' && density > MAX_BULK_DENSITY) return `Bulk material density has a limit of ${noticeQuantity('density', MAX_BULK_DENSITY, units)}`;
  return null;
}

function normalized(value: unknown): UserMaterial {
  const m = value as UserMaterial;
  return { kind: m.kind, name: m.name.trim(), density: m.density };
}

/** A stored library the app cannot read is copied aside by the next write (see writeUserMaterials). */
const UNREADABLE_KEPT = 'The next save keeps a copy of it in this browser and starts a new list.';
/** Why a My materials write was refused: the store could not be read, and could not be copied aside. */
export const USER_MATERIALS_UNREADABLE = 'My materials could not be read from browser storage, so the app left them unchanged.';
/** Said after a write that copied an unreadable store aside (storeBackup.ts) and started a new list. */
export const USER_MATERIALS_BACKED_UP = 'My materials could not be read. The app kept a copy of them in this browser and started a new list.';

/** The stored entries the library shows: valid ones, the last of each key winning, at most the newest 500. */
function screenUserMaterials(data: readonly unknown[]): { materials: UserMaterial[]; refused: number; overflow: number } {
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
  return { materials: all.slice(-USER_MATERIALS_LIMIT), refused, overflow };
}

export function readUserMaterials(): { materials: UserMaterial[]; note: string } {
  let raw: string | null;
  try { raw = localStorage.getItem(USER_MATERIALS_KEY); }
  catch { return { materials: [], note: 'Browser storage is blocked here, so My materials is unavailable.' }; }
  try {
    if (!raw) return { materials: [], note: '' };
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return { materials: [], note: `My materials could not be read: expected a list. ${UNREADABLE_KEPT}` };
    const { materials, refused, overflow } = screenUserMaterials(data);
    const note = [refused ? `${refused} invalid My materials entries were ignored.` : '',
      overflow ? `My materials has a limit of 500 entries; ${overflow} older entries were ignored.` : ''].filter(Boolean).join(' ');
    return { materials, note };
  } catch {
    return { materials: [], note: `My materials could not be read from browser storage. ${UNREADABLE_KEPT}` };
  }
}

export const loadUserMaterials = (): UserMaterial[] => readUserMaterials().materials;

/**
 * THE LIBRARY A WRITE STARTS FROM (cloud session 20, the My parts rule of audit
 * S7-3). readUserMaterials drops invalid entries and those past the 500 limit,
 * and reads a non-list as empty; every writer saved what it returned, so one
 * save erased them. A write now replaces only what the library SHOWED: every
 * stored entry it could not show (invalid, a newer build's, past the limit) is
 * kept verbatim, ahead of the list, and an entry the caller left unchanged is
 * written as it was stored. An entry shadowed by a later one with the same
 * name is dropped with it, so a deleted material cannot come back. A stored
 * value that is not a readable list is copied to its side key first and the
 * write starts a new list ('backed-up'); 'unreadable' only when that copy
 * cannot be made, and then nothing is written.
 */
export function writeUserMaterials(materials: readonly UserMaterial[]): 'saved' | 'backed-up' | 'unreadable' | 'failed' {
  if (materials.length > USER_MATERIALS_LIMIT || materials.some(m => materialProblem(m))) return 'failed';
  let raw: string | null;
  try { raw = localStorage.getItem(USER_MATERIALS_KEY); } catch { return 'failed'; }
  let data: unknown;
  try { data = raw ? JSON.parse(raw) : []; } catch { data = undefined; }
  const backedUp = !Array.isArray(data);
  if (backedUp) {
    if (raw === null || !backUpUnreadableStore(USER_MATERIALS_KEY, raw)) return 'unreadable';
    data = [];
  }
  if (!Array.isArray(data)) return 'unreadable';
  const shown = new Set(screenUserMaterials(data).materials.map(userMaterialKey));
  const storedAs = new Map<string, unknown>();
  const kept = data.filter(entry => {
    if (materialProblem(entry)) return true;
    const key = userMaterialKey(normalized(entry));
    storedAs.set(key, entry);
    return !shown.has(key);
  });
  const byKey = new Map<string, unknown>();
  for (const m of materials) {
    const next = normalized(m), key = userMaterialKey(next);
    const was = storedAs.get(key);
    const same = was !== undefined && shown.has(key) && JSON.stringify(normalized(was)) === JSON.stringify(next);
    byKey.set(key, same ? was : next);
  }
  try {
    localStorage.setItem(USER_MATERIALS_KEY, JSON.stringify([...kept, ...byKey.values()]));
  } catch { return 'failed'; }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(USER_MATERIALS_CHANGED));
  return backedUp ? 'backed-up' : 'saved';
}

/** No UI changes its saved state unless storage accepted the whole library. */
export const saveUserMaterials = (materials: readonly UserMaterial[]): boolean => {
  const written = writeUserMaterials(materials);
  return written === 'saved' || written === 'backed-up';
};

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

export function importUserMaterialsCsv(csv: string, existing: readonly UserMaterial[], units: UnitSelection = INITIAL_UNITS) {
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
    let problem = cells.length !== 4 ? 'Expected four columns' : materialProblem(entry, units);
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
