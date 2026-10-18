// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { OrkRocket, resetEngine } from '@online-openrocket/engine';
import type { DocumentMaterial, FlightTree } from '../model/design.js';
import { engineTree, makeNode, normalizeTree } from '../tree/treeModel.js';
import { sanitizeTree } from '../tree/sanitize.js';
import { cleanDocumentMaterials, sanitizeDocumentMaterials } from './documentMaterials.js';
import { exportOrk, importOrk } from './orkFile.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { checkFormatLoss } from './formatLoss.js';
import { flushSession, loadSession, saveSessionDebounced } from './session.js';
import { decodeShareFragment, encodeShareFragment } from './shareLink.js';
import { parseXml } from './xmlParse.js';
import { designMaterials } from './designMaterials.js';

const materials: DocumentMaterial[] = [
  { kind: 'bulk', name: 'My carbon layup', density: 1550, group: 'Composites' },
  { kind: 'surface', name: 'Ripstop 1.1', density: 0.067, group: 'Fabrics' },
];
const tree = (): FlightTree => ({ name: 'Document materials', components: [{ type: 'stage', id: 's', children: [
  { type: 'nosecone', id: 'n', length: 0.1, aftRadius: 0.02 },
  { type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.02, children: [
    { type: 'freeformfinset', id: 'f', crossSection: 'rounded', points: [[0, 0], [0.02, 0.04], [0.06, 0.04], [0.08, 0]] },
  ] },
] }] });
const xml = (t = tree()) => exportOrk({ name: t.name!, tree: t });
const desktop = (entries: string) => '<openrocket version="1.10"><rocket><name>Desktop</name><subcomponents>'
  + '<stage><name>S</name><subcomponents><bodytube><name>Body</name></bodytube></subcomponents></stage>'
  + '</subcomponents></rocket><docprefs><pref key="ignored" type="string">keep out</pref>'
  + `<docmaterials>${entries}</docmaterials></docprefs></openrocket>`;
const entry = (s: string) => `<material>${s}</material>`;
const goodXml = entry('BULK|My carbon layup|1550.0|Composites') + entry('SURFACE|Ripstop 1.1|0.067|Fabrics');
const materialNotes = (notes: string[]) => notes.filter(n => n.startsWith('Document materials:'));
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

it('R1 imports only valid direct-root document materials, deduplicating with one counted note', () => {
  const opened = importOrk(desktop(goodXml + entry('ALIEN|Bad type|4') + entry('BULK|Zero|0')
    + entry('BULK|My carbon layup|1550|Metals')));
  expect(opened.tree.documentMaterials).toEqual(materials);
  expect(materialNotes(opened.notes)).toHaveLength(1);
  expect(materialNotes(opened.notes)[0]).toMatch(/2 invalid entries.*1 duplicate/);
  const clean = importOrk(desktop(goodXml));
  expect(clean.tree.documentMaterials).toEqual(materials);
  expect(materialNotes(clean.notes)).toEqual([]);
  const nested = desktop(goodXml).replace('<docprefs>', '<wrapper><docprefs>').replace('</docprefs>', '</docprefs></wrapper>');
  expect(importOrk(nested).tree.documentMaterials).toBeUndefined();
  const nestedMaterials = desktop(`<wrapper>${entry('BULK|Hidden|5')}</wrapper>`);
  expect(importOrk(nestedMaterials).tree.documentMaterials).toBeUndefined();
  expect(importOrk(desktop(entry('LINE|Harness|0.005'))).tree.documentMaterials)
    .toEqual([{ kind: 'line', name: 'Harness', density: 0.005 }]);
});

it('R1 caps a desktop list at 256 with one counted note', () => {
  const opened = importOrk(desktop(Array.from({ length: 260 }, (_, i) => entry(`BULK|Mix ${i}|1000`)).join('')));
  expect(opened.tree.documentMaterials).toHaveLength(256);
  expect(materialNotes(opened.notes)).toEqual(['Document materials: 4 entries omitted past the limit of 256.']);
});

it('R3 writes only stored OR storable strings last and reopens the list', () => {
  const t = tree();
  t.documentMaterials = [...materials, { kind: 'line', name: 'Cord|<&>', density: 0.005, group: 'ThreadsLines' }];
  Object.assign(t.components[0]!.children![1]!, { materialName: 'App layup', density: 1234 });
  const saved = xml(t);
  const doc = parseXml(saved.replace(/^<\?xml[^?]*\?>/, ''), 'Invalid exported XML');
  expect(Array.from(doc.documentElement!.children).at(-1)?.tagName).toBe('docprefs');
  expect(saved).toContain('<material>BULK|My carbon layup|1550|Composites</material>');
  expect(saved).toContain('<material>SURFACE|Ripstop 1.1|0.067|Fabrics</material>');
  expect(saved).toContain('<material>LINE|Cord &lt;&amp;&gt;|0.005|ThreadsLines</material>');
  expect(saved).not.toContain('<material>BULK|App layup|1234</material>');
  const expected = [...materials, { kind: 'line', name: 'Cord <&>', density: 0.005, group: 'ThreadsLines' }];
  const reopened = importOrk(saved);
  expect(reopened.tree.documentMaterials).toEqual(expected);
  expect(importOrk(xml(reopened.tree)).tree.documentMaterials).toEqual(expected);
  expect(saved).not.toContain('<pref ');
});

it('R3 writes nothing for an empty list or built-in part materials, and avoids duplicates', () => {
  const t = tree();
  t.documentMaterials = [];
  Object.assign(t.components[0]!.children![1]!, { materialName: 'Cardboard', density: 680 });
  expect(xml(t)).not.toContain('<docprefs>');
  t.documentMaterials = [{ kind: 'bulk', name: 'App mix', density: 900 }];
  Object.assign(t.components[0]!.children![1]!, { materialName: 'App mix', density: 900 });
  expect(xml(t).match(/<material>BULK\|App mix\|900<\/material>/g)).toHaveLength(1);
});

it('Round1 export keeps custom canopy, line and fillet materials on parts without creating a document list', () => {
  const t = tree();
  t.components[0]!.children!.push({ type: 'parachute', surfaceMaterialName: 'My cloth', surfaceDensity: 0.04,
    lineMaterialName: 'My thread', lineDensity: 0.002 });
  Object.assign(t.components[0]!.children![1]!.children![0]!, { filletMaterialName: 'My paste', filletDensity: 1100 });
  expect(xml(t)).not.toContain('<docprefs>');
  const reopened = importOrk(xml(t)).tree;
  expect(reopened.documentMaterials).toBeUndefined();
  expect(designMaterials(reopened, 'bulk')).toContainEqual({ name: 'My paste', density: 1100, count: 1 });
  expect(designMaterials(reopened, 'surface')).toEqual([{ name: 'My cloth', density: 0.04, count: 1 }]);
  expect(designMaterials(reopened, 'line')).toEqual([{ name: 'My thread', density: 0.002, count: 1 }]);
});

it('Round1 export Save Open change Save Open leaves no stale or pipe-duplicate part material', () => {
  const t = tree();
  Object.assign(t.components[0]!.children![1]!, { materialName: 'Kraft|0.5mm', density: 900 });
  const reopened = importOrk(xml(t)).tree;
  expect(designMaterials(reopened, 'bulk')).toEqual([{ name: 'Kraft|0.5mm', density: 900, count: 1 }]);
  Object.assign(reopened.components[0]!.children![1]!, { materialName: 'New layup', density: 1234 });
  const saved = xml(reopened);
  expect(saved).not.toContain('<docprefs>');
  expect(designMaterials(importOrk(saved).tree, 'bulk')).toEqual([{ name: 'New layup', density: 1234, count: 1 }]);
});

it.each(['a'.repeat(90), 'constructor', 'prototype', '__proto__', ' Padded mix '])(
  'Round1 export does not validate a part name as document metadata (%s)', async name => {
    const t = tree();
    Object.assign(t.components[0]!.children![1]!, { materialName: name, density: 900 });
    const notes: string[] = [];
    const saved = exportOrk({ name: t.name!, tree: t, notes });
    expect(saved).not.toContain('<docprefs>');
    expect(materialNotes(notes)).toEqual([]);
    expect(importOrk(await decodeShareFragment(await encodeShareFragment(saved))).tree.documentMaterials).toBeUndefined();
  });

it('Round1 export deduplicates stored entries after pipe substitution and trimming without false save notes', () => {
  const t = tree();
  t.documentMaterials = [
    { kind: 'bulk', name: '|Mix|', density: 900, group: 'Composites' },
    { kind: 'bulk', name: '  Mix  ', density: 900 },
  ];
  const notes: string[] = [];
  const saved = exportOrk({ name: t.name!, tree: t, notes });
  expect(importOrk(saved).tree.documentMaterials).toEqual([{ kind: 'bulk', name: 'Mix', density: 900, group: 'Composites' }]);
  expect(materialNotes(notes)).toEqual([]);
});

it('Round1 export does not cap or warn about more than 256 named part materials', () => {
  const t = tree();
  t.components[0]!.children!.push(...Array.from({ length: 257 }, (_, i) => ({
    type: 'bodytube' as const, materialName: `Part mix ${i}`, density: 900,
  })));
  const notes: string[] = [];
  expect(exportOrk({ name: t.name!, tree: t, notes })).not.toContain('<docprefs>');
  expect(materialNotes(notes)).toEqual([]);
});

it('R4 keeps the list in autosave and .ork share links', async () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in this test'); }));
  const t = { ...tree(), documentMaterials: materials };
  saveSessionDebounced({ tree: t, launch: DEFAULT_CONDITIONS }); flushSession();
  expect(loadSession()?.tree.documentMaterials).toEqual(materials);
  const link = await encodeShareFragment(xml(t));
  expect(importOrk(await decodeShareFragment(link)).tree.documentMaterials).toEqual(materials);
});

const hostile: unknown[] = [null, 'bad', {}, { kind: 'alien', name: 'Bad kind', density: 1 },
  { kind: 'bulk', name: '', density: 1 }, { kind: 'bulk', name: 'a'.repeat(81), density: 1 },
  ...[NaN, Infinity, -1, 0, '1550'].map(density => ({ kind: 'bulk', name: 'Bad density', density })),
];
it.each([null, {}, 'bad', 5, [...materials, ...hostile, materials[0]]].map(raw => [raw]))(
  'R4 repairs hostile restored document metadata with one note (%j)', raw => {
    const t = { ...tree(), documentMaterials: raw } as unknown as FlightTree;
    const expected = Array.isArray(raw) ? materials : [];
    for (const restore of [sanitizeTree, normalizeTree]) {
      const notes: string[] = [];
      expect((restore(t, notes) as FlightTree).documentMaterials).toEqual(expected);
      expect(materialNotes(notes)).toHaveLength(1);
    }
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ tree: t, launch: DEFAULT_CONDITIONS }));
    const loaded = loadSession();
    expect(loaded?.tree.documentMaterials).toEqual(expected);
    expect(materialNotes(loaded?.treeRestoreNotes ?? [])).toHaveLength(1);
    expect(loaded?.tree.components).toEqual(t.components);
  });

it('R4 caps a 100,000-entry restore and keeps clean sanitized lists by identity', () => {
  const notes: string[] = [];
  const damaged = { ...tree(), documentMaterials: Array.from({ length: 100_000 }, (_, i) =>
    ({ kind: 'bulk', name: `Mix ${i}`, density: 1000 })) } as FlightTree;
  const repaired = sanitizeDocumentMaterials(damaged, notes);
  expect(repaired.documentMaterials).toHaveLength(256);
  expect(materialNotes(notes)).toEqual(['Document materials: 99744 entries omitted past the limit of 256.']);
  const again: string[] = [];
  expect(sanitizeDocumentMaterials(repaired, again)).toBe(repaired);
  expect(again).toEqual([]);
});

it('R4 repairs hostile share-link materials with one note at the real XML boundary', async () => {
  const bad = entry('BULK||5') + entry('ALIEN|Wrong kind|5') + entry('BULK|Bad|Infinity');
  const link = await encodeShareFragment(desktop(goodXml + bad));
  const opened = importOrk(await decodeShareFragment(link));
  expect(opened.tree.documentMaterials).toEqual(materials);
  expect(materialNotes(opened.notes)).toHaveLength(1);
  expect(materialNotes(opened.notes)[0]).toContain('3 invalid entries');
});

it.each(['rkt', 'cdx1'] as const)('R4 names a non-empty document list in the %s loss report', format => {
  const input = { tree: { ...tree(), documentMaterials: materials }, motors: {}, launch: DEFAULT_CONDITIONS,
    configs: [], activeConfigId: null, measured: { massKg: null, cgM: null }, flightData: {} };
  expect(checkFormatLoss(format, input).losses).toContain('2 document materials are not saved; use .ork to keep them.');
  input.tree.documentMaterials = [];
  expect(checkFormatLoss(format, input).losses.join(' ')).not.toContain('document material');
});

it.each(['rkt', 'cdx1'] as const)('Round2 loss %s counts only document entries the writer cannot carry', format => {
  const t = tree();
  Object.assign(t.components[0]!.children![1]!, { materialName: 'Kraft|0.5mm', density: 900 });
  Object.assign(t.components[0]!.children![1]!.children![0]!, { filletMaterialName: 'My paste', filletDensity: 1100 });
  Object.assign(t.components[0]!.children![0]!, { materialName: 'Cardboard', density: 680 });
  t.components[0]!.children!.push({ type: 'parachute', surfaceMaterialName: 'My cloth', surfaceDensity: 0.04,
    lineMaterialName: 'My thread', lineDensity: 0.002 });
  t.documentMaterials = [
    { kind: 'bulk', name: 'Kraft 0.5mm', density: 900 }, { kind: 'bulk', name: 'My paste', density: 1100 },
    { kind: 'bulk', name: 'Cardboard', density: 680 },
    { kind: 'surface', name: 'My cloth', density: 0.04 }, { kind: 'line', name: 'My thread', density: 0.002 },
  ];
  const input = { tree: t, motors: {}, launch: DEFAULT_CONDITIONS, configs: [], activeConfigId: null,
    measured: { massKg: null, cgM: null }, flightData: {} };
  const report = checkFormatLoss(format, input);
  expect(report.refused).toBeNull();
  expect(report.losses.filter(n => n.includes('document material'))).toEqual([
    format === 'rkt' ? '1 document material is not saved; use .ork to keep it.'
      : '5 document materials are not saved; use .ork to keep them.',
  ]);
  t.documentMaterials.push({ kind: 'bulk', name: 'Unused mix', density: 1500 });
  expect(checkFormatLoss(format, input).losses.filter(n => n.includes('document material'))).toEqual([
    format === 'rkt' ? '2 document materials are not saved; use .ork to keep them.'
      : '6 document materials are not saved; use .ork to keep them.',
  ]);
  t.documentMaterials.push({ kind: 'bulk', name: 'Kraft 0.5mm', density: 901 },
    { kind: 'line', name: 'My cloth', density: 0.04 });
  expect(checkFormatLoss(format, input).losses.filter(n => n.includes('document material'))).toEqual([
    format === 'rkt' ? '4 document materials are not saved; use .ork to keep them.'
      : '8 document materials are not saved; use .ork to keep them.',
  ]);
});

it.each(['fillet', 'railbutton', 'protuberance', 'wrong slot'] as const)(
  'Round2 rkt loss counts a document material used only by %s', usage => {
    const t = tree();
    const body = t.components[0]!.children![1]!;
    if (usage === 'fillet') Object.assign(body.children![0]!, { filletMaterialName: 'My paste', filletDensity: 1100 });
    else if (usage === 'wrong slot') Object.assign(body, { lineMaterialName: 'My paste', lineDensity: 1100 });
    else body.children!.push({ ...makeNode(usage), materialName: 'My paste', density: 1100 });
    t.documentMaterials = [{ kind: usage === 'wrong slot' ? 'line' : 'bulk', name: 'My paste', density: 1100 }];
    const input = { tree: t, motors: {}, launch: DEFAULT_CONDITIONS, configs: [], activeConfigId: null,
      measured: { massKg: null, cgM: null }, flightData: {} };
    const report = checkFormatLoss('rkt', input);
    expect(report.refused).toBeNull();
    expect(report.losses.filter(n => n.includes('document material'))).toEqual([
      '1 document material is not saved; use .ork to keep it.',
    ]);
    // The same pair on an emitted body slot really is carried.
    Object.assign(body, { materialName: 'My paste', density: 1100 });
    if (usage === 'wrong slot') t.documentMaterials[0]!.kind = 'bulk';
    expect(checkFormatLoss('rkt', input).losses.join(' ')).not.toContain('document material');
  });

it('Round1 names prototype-related material names survive XML, autosave, share and picker without a repair note', async () => {
  const expected: DocumentMaterial[] = ['__proto__', 'constructor', 'prototype'].map(name => ({ kind: 'bulk', name, density: 900 }));
  const opened = importOrk(desktop(expected.map(m => entry(`BULK|${m.name}|900`)).join('')));
  expect(opened.tree.documentMaterials).toEqual(expected);
  expect(materialNotes(opened.notes)).toEqual([]);
  saveSessionDebounced({ tree: opened.tree, launch: DEFAULT_CONDITIONS }); flushSession();
  expect(loadSession()?.tree.documentMaterials).toEqual(expected);
  expect(materialNotes(loadSession()?.treeRestoreNotes ?? [])).toEqual([]);
  const link = await encodeShareFragment(xml(opened.tree));
  expect(importOrk(await decodeShareFragment(link)).tree.documentMaterials).toEqual(expected);
  expect(designMaterials(opened.tree, 'bulk').map(m => m.name).sort()).toEqual(expected.map(m => m.name).sort());
});

it.each(['rounded', 'airfoil'])('R5 strips the list before the kernel input, preserving every %s fin input', crossSection => {
  const t = tree();
  t.components[0]!.children![1]!.children![0]!.crossSection = crossSection;
  const annotated = { ...t, documentMaterials: materials };
  expect(JSON.stringify(engineTree(annotated))).toBe(JSON.stringify(engineTree(t)));
  expect(engineTree(annotated)).not.toHaveProperty('documentMaterials');
  expect(annotated.documentMaterials).toEqual(materials);
  // Exercise the bridge directly too: even an unlowered root list is ignored.
  try {
    expect(OrkRocket.buildTree(annotated).staticInfo()).toEqual(OrkRocket.buildTree(t).staticInfo());
  } finally { resetEngine(); }
});

it('R6 documents the document list, the picker and the foreign-format loss', () => {
  const guide = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../user-guide.md'), 'utf8');
  const section = guide.split('### Custom and saved materials\n')[1]!.split('\n## Component presets')[0]!;
  expect(section).toContain('Materials defined in a desktop OpenRocket document appear under **In this design**');
  expect(section).toContain('keeps the list the desktop file brought when you save as `.ork`');
  expect(section).toContain("it does not add the app's own named materials to that list");
  expect(section).toContain('including fin fillets, and materials defined in the opened desktop OpenRocket document)');
  expect(section).toContain('`.rkt` and `.CDX1` do not carry the document materials list');
  expect(section).toContain('Document entries with a built-in name are omitted at every density.');
  expect(section).toContain('A document name with a pipe replaced by a space is merged with the same part material at the same density.');
  expect(section).toContain('`.rkt` omits fillet materials, rail buttons and protuberances; `.CDX1` carries no materials.');
  expect(section).not.toContain('only materials a design uses are in its file');
});

it('validates optional groups without discarding an otherwise readable material', () => {
  const notes: string[] = [];
  expect(cleanDocumentMaterials([{ ...materials[0], group: '__proto__' }], notes)).toEqual([
    { kind: 'bulk', name: 'My carbon layup', density: 1550 },
  ]);
  expect(notes).toEqual(['Document materials: 1 unknown group removed.']);
});

it.each([1, 2])('Round1 notes pluralise each repair count (%i) in one trimmed-name deduplication note', count => {
  const base = Array.from({ length: 256 }, (_, i) => ({ kind: 'bulk', name: `Mix ${i}`, density: 900,
    ...(i < count ? { group: 'Unknown' } : {}) }));
  const raw = [...base, ...Array.from({ length: count }, (_, i) => ({ ...base[i], name: ` Mix ${i} ` })),
    ...Array.from({ length: count }, () => null),
    ...Array.from({ length: count }, (_, i) => ({ kind: 'line', name: `Extra ${i}`, density: 0.01 }))];
  const notes: string[] = [];
  expect(cleanDocumentMaterials(raw, notes)).toHaveLength(256);
  const noun = count === 1 ? 'entry' : 'entries';
  expect(notes).toEqual([`Document materials: ${count} invalid ${noun} removed (known kind, 1–80 character name, finite density greater than zero required); `
    + `${count} duplicate ${noun} removed; ${count} ${noun} omitted past the limit of 256; ${count} unknown ${count === 1 ? 'group' : 'groups'} removed.`]);
});
