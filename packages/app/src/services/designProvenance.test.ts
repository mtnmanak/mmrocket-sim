// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import type { FlightTree } from '../model/design.js';
import { exportOrk, importOrk } from './orkFile.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { checkFormatLoss } from './formatLoss.js';
import { designFingerprint } from './dirtyState.js';
import { physicsKeyOf } from './designDerivation.js';
import { flushSession, loadSession, saveSessionDebounced } from './session.js';
import { decodeShareFragment, encodeShareFragment } from './shareLink.js';
import { defaultTree, engineTree, motorMounts, normalizeTree, updateNode } from '../tree/treeModel.js';
import { exportCdx1, importCdx1 } from './rasaeroFile.js';
import { sanitizeDesignProvenance } from './designProvenance.js';
import { loadCatalogueMotor } from './motorMatch.js';
import { simulateDesign } from './simulateDesign.js';
import { comparable } from './simulate.testSupport.js';

const provenance = {
  designer: 'Eric & Zoë <builder>', kitName: '钛 Kit', kitManufacturer: 'Maker & Co', kitPartNumber: 'BT-2+',
  comment: 'Measured <twice>\nKeep this line & spaces  ', revision: 'Rev B\nDesktop text', designType: 'commercialkit',
  revisions: [{ date: '2026-10-13', text: 'Rounded fins\n<&> 钛' }, { date: '2026-10-14', text: 'Weighed again' }],
};
const tree = (): FlightTree => ({ name: 'Notes', provenance, components: [{ type: 'stage', id: 's', children: [
  { type: 'nosecone', id: 'n', length: 0.1, aftRadius: 0.02 },
  { type: 'bodytube', id: 'b', length: 0.3, outerRadius: 0.02, comment: 'Part only', children: [
    { type: 'freeformfinset', id: 'f', points: [[0, 0], [0.02, 0.04], [0.06, 0.04], [0.08, 0]], crossSection: 'airfoil' },
  ] },
] }] });
const xml = (t = tree(), notes?: string[]) => exportOrk({ name: t.name!, tree: t, notes });
const bytes = (s: string) => new TextEncoder().encode(s).buffer;
afterEach(() => localStorage.clear());

it.each(['rounded', 'airfoil'])('design metadata preserves the real C6 flight report with %s freeform fins', async crossSection => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  try {
    let airframe = defaultTree();
    const body = airframe.components[0]!.children!.find(n => n.type === 'bodytube')!;
    const fin = body.children!.find(n => n.type === 'trapezoidfinset')!;
    airframe = updateNode(airframe, fin.id!, { type: 'freeformfinset', crossSection,
      points: [[0, 0], [0.02, 0.04], [0.07, 0.04], [0.1, 0]] });
    const annotated: FlightTree = { ...airframe, provenance };
    const motor = (await loadCatalogueMotor('Estes', 'C6', 5))!;
    const state = { tree: airframe, launch: DEFAULT_CONDITIONS, mountMotors: { [motorMounts(airframe)[0]!.id!]: motor },
      savedConfigs: [], activeConfigId: null, measured: { massKg: null, cgM: null }, unmatchedRefs: {} };
    const before = await simulateDesign(state);
    const after = await simulateDesign({ ...state, tree: annotated });
    // Differential in one runtime: no hard-coded kernel floats or widened tolerances.
    expect(comparable(after.run)).toEqual(comparable(before.run));
  } finally { vi.unstubAllGlobals(); }
});

it('reads desktop root fields without confusing them with part comments', () => {
  const desktop = '<openrocket version="1.10"><rocket><name>Desktop</name><designer>Zoë &amp; Eric</designer>'
    + '<kitname>Kit &lt;A&gt;</kitname><designtype>kitbashkit</designtype><revision>R1\nR2  </revision>'
    + '<comment>Design\ncomment  </comment><subcomponents><stage><name>S</name><comment>Stage</comment>'
    + '<subcomponents><bodytube><name>Body</name><comment>Part</comment></bodytube></subcomponents></stage></subcomponents>'
    + '</rocket></openrocket>';
  const opened = importOrk(bytes(desktop));
  expect(opened.tree.provenance).toEqual({ designer: 'Zoë & Eric', kitName: 'Kit <A>', designType: 'kitbashkit',
    revision: 'R1\nR2  ', comment: 'Design\ncomment  ' });
  expect(opened.tree.components[0]!.comment).toBe('Stage');
  expect(opened.tree.components[0]!.children![0]!.comment).toBe('Part');
});

it('writes native desktop fields, escapes metadata, and round-trips every note unchanged', () => {
  const notes: string[] = [];
  const saved = xml(tree(), notes);
  expect(saved).toContain('<designer>Eric &amp; Zoë &lt;builder&gt;</designer>');
  expect(saved).toContain('<kitname>钛 Kit</kitname>');
  expect(saved).toContain('<revision>Rev B\nDesktop text</revision>');
  expect(saved).toContain('<comment>Measured &lt;twice&gt;\nKeep this line &amp; spaces  </comment>');
  expect(saved).toContain('<designtype>commercialkit</designtype>');
  const reopened = importOrk(bytes(saved)).tree;
  expect(reopened.provenance).toEqual(provenance);
  expect(reopened.components[0]!.children![1]!.comment).toBe('Part only');
  expect(importOrk(bytes(xml(reopened))).tree.provenance).toEqual(provenance);
  expect(notes.join(' ')).toMatch(/Desktop OpenRocket.*(ignores|does not keep)/);
});

it('keeps notes in browser autosave and sharing, and marks edits dirty without changing the physics key', async () => {
  const t = tree();
  const snapshot = { tree: t, launch: DEFAULT_CONDITIONS, mountMotors: {}, savedConfigs: [],
    activeConfigId: null, measured: { massKg: null, cgM: null } };
  saveSessionDebounced({ ...snapshot, savedMark: designFingerprint(snapshot) }); flushSession();
  expect(loadSession()?.tree.provenance).toEqual(provenance);
  expect(loadSession()?.savedMark).toBe(designFingerprint({ ...snapshot, tree: loadSession()!.tree }));
  const link = await encodeShareFragment(xml());
  expect(importOrk(bytes(await decodeShareFragment(link))).tree.provenance).toEqual(provenance);
  const changed = { ...t, provenance: { ...provenance, designer: 'Another builder' } };
  expect(designFingerprint({ ...snapshot, tree: changed })).not.toBe(designFingerprint(snapshot));
  expect(physicsKeyOf(changed.components)).toBe(physicsKeyOf(t.components));
  expect(engineTree(changed).components).toEqual(engineTree(t).components);
  const reopened = importOrk(bytes(xml())).tree;
  // Each import mints component ids. Compare the notes against the same physical tree.
  const reopenedMetadata: FlightTree = { ...t, provenance: reopened.provenance };
  expect(designFingerprint({ ...snapshot, tree: reopenedMetadata })).toBe(designFingerprint(snapshot));
});

it('keeps valid reordered stored notes by identity without claiming any notes were removed', () => {
  const t: FlightTree = { ...tree(), provenance: { revisions: provenance.revisions.map(e => ({ text: e.text, date: e.date })),
    comment: provenance.comment, designer: provenance.designer } };
  const notes: string[] = [];
  expect(sanitizeDesignProvenance(t, notes)).toBe(t);
  expect(notes).toEqual([]);
});

it.each([null, 7, 'bad', [], { comment: [] }, { revisions: 'bad' }, { revisions: [null, { date: '2026-10-13', text: {} }] }].map(value => [value]))('restores the physical tree when provenance is malformed (%j)', raw => {
    const damaged = { ...tree(), provenance: raw } as unknown as FlightTree;
    expect((normalizeTree(damaged) as FlightTree).provenance).toBeUndefined();
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ tree: damaged, launch: DEFAULT_CONDITIONS }));
    const loaded = loadSession();
    expect(loaded).not.toBeNull();
    expect(loaded?.tree.provenance).toBeUndefined();
    expect(loaded?.tree.components).toEqual(damaged.components);
  });

it.each(['rkt', 'cdx1'] as const)('%s lists only populated provenance fields in the existing lossy-save report', format => {
  const input = { tree: tree(), motors: {}, launch: DEFAULT_CONDITIONS, configs: [], activeConfigId: null,
    measured: { massKg: null, cgM: null }, flightData: {} };
  const report = checkFormatLoss(format, input);
  expect(report.refused).toBeNull();
  const line = report.losses.find(s => s.startsWith('Design notes'))!;
  for (const label of ['Designer', 'Kit name', 'Kit manufacturer', 'Kit part number', 'Revision', 'Revision log']) expect(line).toContain(label);
  expect(line.includes('Design comments')).toBe(format === 'rkt');
  expect(report.losses.some(s => s.startsWith('Part comments'))).toBe(true);
  const empty = { ...input, tree: { ...input.tree, provenance: undefined } };
  expect(checkFormatLoss(format, empty).losses.some(s => s.startsWith('Design notes'))).toBe(false);
});

it('uses RASAero native Comments verbatim and warns when they also determine the reopened rocket name', () => {
  const t = tree();
  const saved = exportCdx1({ name: t.name!, tree: t });
  expect(saved).toContain('<Comments>Measured &lt;twice&gt;\nKeep this line &amp; spaces  </Comments>');
  const reopened = importCdx1(saved);
  expect(reopened.tree.provenance?.comment).toBe(provenance.comment);
  expect(reopened.name).toBe('Measured <twice>');
  const losses = checkFormatLoss('cdx1', { tree: t, motors: {}, launch: DEFAULT_CONDITIONS, configs: [], activeConfigId: null,
    measured: { massKg: null, cgM: null }, flightData: {} }).losses;
  expect(losses.join(' ')).toContain('Rocket name');
  const without = { ...t, provenance: undefined };
  expect(exportCdx1({ name: 'Notes', tree: without })).toContain('<Comments>Notes</Comments>');
});

it('keeps the existing CDX1 name rule with leading blank lines while retaining untrimmed comments', () => {
  const t: FlightTree = { ...tree(), name: 'First line', provenance: { comment: '\n  First line\nKeep trailing spaces  ' } };
  const reopened = importCdx1(exportCdx1({ name: t.name!, tree: t }));
  expect(reopened.name).toBe('First line');
  expect(reopened.tree.provenance?.comment).toBe(t.provenance?.comment);
  const report = checkFormatLoss('cdx1', { tree: t, motors: {}, launch: DEFAULT_CONDITIONS, configs: [], activeConfigId: null,
    measured: { massKg: null, cgM: null }, flightData: {} });
  expect(report.losses.some(line => line.startsWith('Rocket name'))).toBe(false);
});

it('drops malformed stored fields and dates while keeping readable metadata and geometry', () => {
  const damaged = { ...tree(), provenance: { designer: 12, kitName: 'Keep', comment: {}, revisions: [null,
    { date: '2026-02-30', text: 'Impossible' }, { date: '2026-10-13', text: 'Valid' }, { date: 'bad', text: 'Bad' }],
  } } as unknown as FlightTree;
  const clean = normalizeTree(damaged) as FlightTree;
  expect(clean.provenance).toEqual({ kitName: 'Keep', revisions: [{ date: '2026-10-13', text: 'Valid' }] });
  expect(clean.components).toEqual(damaged.components);
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ tree: damaged, launch: DEFAULT_CONDITIONS }));
  expect(loadSession()?.tree.provenance).toEqual(clean.provenance);
  const notes: string[] = [];
  const corrupt = xml().replace(/<mmrsimprovenance[^>]*>[\s\S]*?<\/mmrsimprovenance>/, '<mmrsimprovenance version="1">{bad</mmrsimprovenance>');
  const opened = importOrk(bytes(corrupt));
  expect(opened.tree.provenance?.designer).toBe(provenance.designer);
  expect(opened.tree.provenance?.revisions).toBeUndefined();
  notes.push(...opened.notes);
  expect(notes.join(' ')).toContain('design notes');
});
