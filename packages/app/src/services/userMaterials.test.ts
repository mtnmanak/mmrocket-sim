// @vitest-environment happy-dom
import { afterEach, onTestFinished, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  importUserMaterialsCsv, loadUserMaterials, materialProblem, readUserMaterials, saveUserMaterials,
  USER_MATERIALS_KEY, userMaterialsToCsv, type UserMaterial,
} from './userMaterials.js';

const valid: UserMaterial = { kind: 'bulk', name: 'My laminate', density: 1234 };
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
it.each([
  null, [], 3, 'bad', {}, { ...valid, kind: 'solid' }, { ...valid, name: 1 },
  { ...valid, name: '  ' }, { ...valid, name: 'x'.repeat(81) }, { ...valid, density: '1234' },
  { ...valid, density: null }, { ...valid, density: -1 }, { ...valid, density: 0 }, { ...valid, density: 30001 },
  { kind: 'surface', name: 'Zero cloth', density: 0 }, { kind: 'line', name: 'Zero cord', density: 0 },
  { ...valid, name: 'bAlSa' }, { kind: 'surface', name: 'MYLAR', density: 0.1 },
  { ...valid, name: ' cUsToM ' },
  { kind: 'line', name: 'Thread (heavy-duty)', density: 0.1 },
])('drops an invalid stored entry %j and keeps the valid one', bad => {
  localStorage.setItem(USER_MATERIALS_KEY, JSON.stringify([valid, bad]));
  expect(loadUserMaterials()).toEqual([valid]);
  expect(readUserMaterials().note).toMatch(/1 invalid/);
});
it('refuses nonfinite input and built-in names on save as well as load', () => {
  for (const density of [NaN, Infinity, -Infinity]) expect(materialProblem({ ...valid, density })).toMatch(/finite/);
  expect(saveUserMaterials([{ ...valid, name: 'BALSA' }])).toBe(false);
  expect(localStorage.getItem(USER_MATERIALS_KEY)).toBeNull();
  expect(materialProblem({ ...valid, density: 30001 })).toMatch(/limit of 30000 kg\/m³/);
});
it('trims and deduplicates by kind and case-insensitive name, last wins, keeping kinds separate', () => {
  const data = [valid, { ...valid, name: ' MY LAMINATE ', density: 900 },
    { kind: 'surface', name: 'My laminate', density: 0.1 }, { kind: 'line', name: 'My laminate', density: 0.001 }];
  localStorage.setItem(USER_MATERIALS_KEY, JSON.stringify(data));
  expect(loadUserMaterials()).toEqual([
    { ...valid, name: 'MY LAMINATE', density: 900 },
    { kind: 'surface', name: 'My laminate', density: 0.1 }, { kind: 'line', name: 'My laminate', density: 0.001 },
  ]);
});
it('caps at 500 with a readable note, refuses an oversized save, and reports quota failures', () => {
  const many = Array.from({ length: 501 }, (_, i) => ({ ...valid, name: `Mix ${i}` }));
  localStorage.setItem(USER_MATERIALS_KEY, JSON.stringify(many));
  expect(loadUserMaterials()).toHaveLength(500);
  expect(readUserMaterials().note).toMatch(/limit of 500/);
  expect(saveUserMaterials(many)).toBe(false);
  const spy = storageSpy('setItem').mockImplementation(() => { throw new DOMException('Quota', 'QuotaExceededError'); });
  expect(saveUserMaterials([valid])).toBe(false);
  expect(spy).toHaveBeenCalled();
});
it.each(['{broken', '{}', 'null', '1'])('recovers from corrupt storage %s without throwing', raw => {
  localStorage.setItem(USER_MATERIALS_KEY, raw);
  expect(loadUserMaterials()).toEqual([]);
  expect(readUserMaterials().note).toMatch(/could not be read/);
});
it('reports blocked reads without stopping the panel', () => {
  storageSpy('getItem').mockImplementation(() => { throw Error('blocked'); });
  expect(loadUserMaterials()).toEqual([]);
  expect(readUserMaterials().note).toBe('Browser storage is blocked here, so My materials is unavailable.');
  expect(readUserMaterials().note).not.toContain('Import');
});
describe('materials CSV', () => {
  it.each(['\n', '\r\n', '\r'])('accepts exactly 20000 physical rows with a final newline %j', newline => {
    const csv = ['kind,name,density,unit', ...Array<string>(19998).fill(''), 'bulk,My mix,1,kg/m3'].join(newline) + newline;
    const result = importUserMaterialsCsv(csv, []);
    expect(result.refused).toBe(0);
    expect(result.materials).toEqual([{ kind: 'bulk', name: 'My mix', density: 1 }]);
    expect(importUserMaterialsCsv(csv + newline, []).refused).toBeGreaterThan(0);
  });
  it.each(["'-1", "'+5"])('keeps a handwritten numeric-looking material name %s', name => {
    expect(importUserMaterialsCsv(`kind,name,density,unit\nbulk,${name},1,kg/m3`, []).materials[0]?.name).toBe(name);
  });
  it.each(['0x10', '0b110', '0o7'])('refuses nondecimal density %s', density => {
    const result = importUserMaterialsCsv(`kind,name,density,unit\nbulk,Foam mix,${density},kg/m3`, []);
    expect(result.added).toBe(0);
    expect(result.refused).toBe(1);
  });
  it.each(['\n'.repeat(20001), 'bulk,Mix,1,kg/m3\n'.repeat(20001)])('refuses excessive CSV records without partial import', rows => {
    const result = importUserMaterialsCsv(`kind,name,density,unit\n${rows}`, [valid]);
    expect(result.materials).toEqual([valid]);
    expect(result.refused).toBeGreaterThan(0);
    expect(result.reasons.join(' ')).toMatch(/limit.*rows/i);
  });
  it.each(['\n', '\r\n', '\r'])('reports physical starting lines after blank and multiline records (%j)', newline => {
    const csv = ['kind,name,density,unit', '', 'bulk,Balsa,170,kg/m3',
      'surface,"Two', 'lines",0.1,kg/m2', 'bulk,Other,0,kg/m3'].join(newline);
    const result = importUserMaterialsCsv(csv, []);
    expect(result.reasons).toEqual([
      expect.stringMatching(/^Row 3: Balsa is in the built-in list/),
      'Row 6: Density must be a finite number greater than zero',
    ]);
    const multilineRefusal = importUserMaterialsCsv(['kind,name,density,unit', '',
      'bulk,"Bad', 'mix",0,kg/m3'].join(newline), []);
    expect(multilineRefusal.reasons).toEqual(['Row 3: Density must be a finite number greater than zero']);
  });
  it('counts distinct changes against the original library and lets the last duplicate row win', () => {
    const csv = 'kind,name,density,unit\nbulk,New,1,kg/m3\nbulk,NEW,2,kg/m3\nbulk,My laminate,3,kg/m3\nbulk,MY LAMINATE,4,kg/m3';
    const result = importUserMaterialsCsv(csv, [valid]);
    expect(result).toEqual({ materials: [{ ...valid, name: 'MY LAMINATE', density: 4 },
      { kind: 'bulk', name: 'NEW', density: 2 }], added: 1, replaced: 1, refused: 0, reasons: [] });
  });
  it('uses formula-safe cells and round-trips a formula lead, quoted comma, newline and all units', () => {
    const data: UserMaterial[] = [
      { ...valid, name: '=My "mix", strong' }, { kind: 'surface', name: 'Thin\ncloth', density: 0.01 },
      { kind: 'line', name: 'My cord', density: 0.002 },
      { ...valid, name: "'=Literal" }, { ...valid, name: "''=Two apostrophes" },
    ];
    const csv = userMaterialsToCsv(data);
    expect(csv).toContain('"\'=My ""mix"", strong"');
    expect(csv).toContain('kg/m3');
    expect(importUserMaterialsCsv(csv, [])).toEqual({ materials: data, added: 5, replaced: 0, refused: 0, reasons: [] });
  });
  it('merges by kind/name, counts additions/replacements/refusals and names each reason', () => {
    const result = importUserMaterialsCsv('kind,name,density,unit\nbulk,MY LAMINATE,1000,kg/m3\nline,Cord,0.001,kg/m\nbulk,Balsa,170,kg/m3\nbulk,Other,,kg/m3\nsurface,Cloth,1,kg/m\n', [valid]);
    expect(result).toMatchObject({ added: 1, replaced: 1, refused: 3 });
    expect(result.materials).toEqual([{ ...valid, name: 'MY LAMINATE', density: 1000 }, { kind: 'line', name: 'Cord', density: 0.001 }]);
    expect(result.reasons.join(' ')).toMatch(/Balsa.*built-in/);
    expect(result.reasons.join(' ')).toMatch(/finite/);
    expect(result.reasons.join(' ')).toMatch(/Unit must be kg\/m2/);
  });
  it('refuses new entries at the 500 limit while permitting replacements', () => {
    const data = Array.from({ length: 500 }, (_, i) => ({ ...valid, name: `Mix ${i}` }));
    const result = importUserMaterialsCsv('kind,name,density,unit\nbulk,New,1,kg/m3\nbulk,Mix 0,2,kg/m3', data);
    expect(result).toMatchObject({ added: 0, replaced: 1, refused: 1 });
    expect(result.reasons[0]).toMatch(/limit of 500/);
  });
  it.each(['kind,name,density,unit\nbulk,"oops,1,kg/m3', 'kind,name,density,unit\nbulk,"ok"bad,1,kg/m3', 'name,density\nx,1'])('refuses malformed CSV without merging a partial file', csv => {
    const result = importUserMaterialsCsv(csv, [valid]);
    expect(result.materials).toEqual([valid]);
    expect(result.refused).toBeGreaterThan(0);
    expect(result.added).toBe(0);
  });
});
it('documents the material controls, browser-only storage, file boundary and site-data backup', () => {
  const guide = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../user-guide.md'), 'utf8');
  const section = guide.split('### Custom and saved materials\n')[1]?.split('\n## Component presets')[0] ?? '';
  for (const words of ['built-in list', '**In this design**', '**My materials**', '**Material name**',
    '**500 entries**', 'kg/m³', 'kg/m²', 'kg/m', '**My materials lives in this browser only.**',
    '**⬇ Export CSV**', '**⬆ Import CSV**', 'kind,name,density,unit', 'Desktop OpenRocket reads',
    'Typing a bulk or fillet density afterwards removes the name; set the density first.',
    "For canopy and line materials, the name applies to the part's current density, which the hint under the name field states.",
    'Canopy and line densities come only from the material picked; to set a custom value, edit a saved entry in **My materials**, then pick that entry again.',
    'An `.ork` keeps an explicit zero surface or line density (canopies, streamers, parachute lines and shock cords)',
    "the app's `.rkt` importer still discards such zeros",
    "cannot read desktop OpenRocket's own material database"]) expect(section).toContain(words);
  expect(guide).not.toContain('names stay when');
  expect(section).not.toContain('choose **Custom**, enter its density');
  const clear = guide.split('- **Clear cookies and site data**')[1]?.split('\n\n')[0] ?? '';
  expect(clear).toContain('My materials');
  expect(clear).toContain('**⬇ Export CSV** in **My materials…**');
});

// happy-dom binds Storage methods; restore the instance through its proxy.
function storageSpy(key: 'getItem' | 'setItem') {
  const own = localStorage[key];
  onTestFinished(() => { Object.defineProperty(localStorage, key, { configurable: true, value: own }); });
  return vi.spyOn(localStorage, key);
}
