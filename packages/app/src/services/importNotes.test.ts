// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import presetsJson from '../data/presets.json';
import type { MountMotor } from '../model/design.js';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';
import {
  carryFlags, cautionNote, changesText, flagNote, highestTier, noteFlags, orderedLines, plainLines, renameNote, tierLines,
  type ImportNote,
} from './importNotes.js';
import { importOrk } from './orkFile.js';
import { importRkt } from './rocksimFile.js';
import { importCdx1 } from './rasaeroFile.js';
import { applyPresetLinks, type Preset } from './presets.js';
import { addExMotors, restoreExMotors, type ExMotor } from './exMotors.js';
import { importLaunchValue } from './launchConditions.js';
import { OVERRIDE_INCLUDES_MOTOR, reconcileAllIncludedMotors } from './statedLaunchWeight.js';
import { loadSession } from './session.js';
import { designStateFromSession } from './sessionRestore.js';
import { planImport, resolveImportMotors, type ImportedDesign } from './importApply.js';
import { designNotices, type NoticeInput } from './notices.js';
import { restoredPadMassNote } from './padMassReconcile.js';

/**
 * NOTES-2 (D7 §4, Eric 2026-10-12, ruling 3): every file-open and restore
 * line carries the tier its PRODUCER set where the condition is known —
 * Caution for a dropped, replaced or substituted flight input, Information
 * for a receipt or a faithful translation — and nothing reads the English to
 * decide. One Caution and one Information case per producer.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, '__fixtures__', name), 'utf8');
const LEM = join(here, '../../../../docs/User files/atestani files/LEM-1-2026_2.ork');
const arrayBuffer = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** The lines a reader result shows, each with its tier. */
const tiered = (r: { notes: string[]; noteTiers?: ImportNote[] }) => tierLines(r.notes, r.noteTiers ?? []);
const tierOf = (lines: ImportNote[], pattern: RegExp) => {
  const hit = lines.filter(l => pattern.test(l.text));
  expect(hit, String(pattern)).toHaveLength(1);
  return hit[0]!.tier;
};

const orkXml = (body: string, version = '1.10'): string => `<?xml version='1.0' encoding='utf-8'?>
<openrocket version="${version}" creator="OpenRocket 24.12"><rocket><name>T</name><subcomponents>
  <stage><name>Sustainer</name><subcomponents>${body}</subcomponents></stage>
</subcomponents></rocket></openrocket>`;
const TUBE = (thickness = '0.001') => '<bodytube><name>Tube</name><length>0.3</length>'
  + `<radius>0.025</radius><thickness>${thickness}</thickness></bodytube>`;

describe('the line record (services/importNotes.ts)', () => {
  it('joins 100k reversed records with linear record reads and preserves occurrence order', () => {
    let reads = 0;
    const records: ImportNote[] = Array.from({ length: 100_000 }, (_, i) => ({
      kind: `k${i}`, tier: 'caution', get text() {
        if (++reads > 200_000) throw new Error('record join exceeded linear read budget');
        return `line${i}`;
      },
    }));
    const texts = Array.from({ length: records.length }, (_, i) => `line${records.length - i - 1}`);
    const result = tierLines(texts, records);
    expect(result[0]).toBe(records.at(-1));
    expect(result.at(-1)).toBe(records[0]);
    expect(reads).toBeLessThanOrEqual(records.length * 2);
    const a: ImportNote = { kind: 'first', tier: 'caution', text: 'same' };
    const b: ImportNote = { kind: 'second', tier: 'danger', text: 'same' };
    expect(tierLines(['same', 'same', 'same'], [a, b])).toEqual([a, b, { kind: 'note', tier: 'information', text: 'same' }]);
  }, 30_000);
  it('joins each record to ITS line once; an unrecorded line is Information whatever it says', () => {
    const notes: string[] = [];
    // Bland words, Caution: the producer knew the input was replaced.
    flagNote(notes, { kind: 'test.replaced', tier: 'caution', text: 'All fine.' });
    // Alarming words, Information: nobody flagged it.
    notes.push('Danger: refused — not applied, failed, dropped.');
    cautionNote(notes, 'test.twice', 'Same words');
    notes.push('Same words');
    expect(tierLines(notes, noteFlags(notes)).map(l => [l.tier, l.text])).toEqual([
      ['caution', 'All fine.'],
      ['information', 'Danger: refused — not applied, failed, dropped.'],
      ['caution', 'Same words'],
      ['information', 'Same words'],
    ]);
  });

  it('keeps the tier when the producer rewords a line it already pushed', () => {
    const notes = ['Loaded “x”.'];
    cautionNote(notes, 'test.label', 'Configuration “[old]” overrides recovery.');
    renameNote(notes, 1, 'Configuration “[F67C]” overrides recovery.');
    expect(tierLines(notes, noteFlags(notes))[1]).toEqual(
      { kind: 'test.label', tier: 'caution', text: 'Configuration “[F67C]” overrides recovery.' });
  });

  it('carries records onto a copy, and reads old plain text as Information', () => {
    const from: string[] = [];
    cautionNote(from, 'k', 'a');
    const copy = carryFlags([...from], noteFlags(from));
    expect(tierLines(copy, noteFlags(copy))[0]!.tier).toBe('caution');
    expect(plainLines('one\n\ntwo').map(l => l.tier)).toEqual(['information', 'information']);
  });

  it('orders Danger, Caution, Information, stable within a tier; the highest tier wins; counts changes', () => {
    const l = (tier: ImportNote['tier'], text: string): ImportNote => ({ kind: 'k', tier, text });
    const lines = [l('information', 'i1'), l('caution', 'c1'), l('danger', 'd1'), l('information', 'i2'), l('caution', 'c2')];
    expect(orderedLines(lines).map(x => x.text)).toEqual(['d1', 'c1', 'c2', 'i1', 'i2']);
    expect(highestTier(lines)).toBe('danger');
    expect(highestTier([l('information', 'i')])).toBe('information');
    expect(highestTier([])).toBe('information');
    expect([changesText(1), changesText(3)]).toEqual(['1 change', '3 changes']);
  });
});

describe('the .ork reader (orkFile.ts, sanitize, deployOverrideNote)', () => {
  it('Caution for a value the file held and the import replaced; Information for a newer-format advisory', () => {
    const lines = tiered(importOrk(orkXml(TUBE('abc'), '1.11')));
    expect(tierOf(lines, /invalid <thickness> value/)).toBe('caution');
    expect(tierOf(lines, /from a newer OpenRocket/)).toBe('information');
  });

  it('the v0.183 recovery override note is Caution; the opened-configuration receipt is Information', () => {
    const chute = (name: string) => `<parachute><name>${name}</name><diameter>0.9144</diameter><cd>auto</cd>
      <deployevent>altitude</deployevent><deployaltitude>91.44</deployaltitude><deploydelay>0.0</deploydelay>
      <deploymentconfiguration configid="cfg-a"><deployevent>ejection</deployevent><deployaltitude>200.0</deployaltitude>
      <deploydelay>0.0</deploydelay></deploymentconfiguration></parachute>`;
    const xml = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket><name>LEM</name>
      <motorconfiguration configid="cfg-a" default="true"><stage number="0" active="true"/></motorconfiguration>
      <motorconfiguration configid="cfg-b"><stage number="0" active="true"/></motorconfiguration>
      <subcomponents><stage><name>Sustainer</name><subcomponents>
      <bodytube><name>B</name><length>0.4</length><thickness>0.006</thickness><radius>0.044</radius>
        <subcomponents>${chute('Parachute')}${chute('Parachute')}</subcomponents></bodytube>
      </subcomponents></stage></subcomponents></rocket></openrocket>`;
    const lines = tiered(importOrk(xml));
    expect(tierOf(lines, /^Recovery: .*overrides the deployment setting/)).toBe('caution');
  });

  it.skipIf(!existsSync(LEM))('LEM-1-2026_2.ork: the override note is Caution and leads the open', async () => {
    const imported: ImportedDesign = { ...importOrk(arrayBuffer(readFileSync(LEM))), sourceFormat: 'ork' };
    const loaded: MountMotor = {
      label: 'F67C-8', meta: { label: 'F67C', manufacturer: 'AeroTech', motorId: 'db-F67C' },
      ignition: { event: 'automatic', delay: 0 },
      spec: { designation: 'F67C', diameter: 0.029, length: 0.1, cgX: 0.05, ejectionDelay: 8,
        times: [0, 1], thrusts: [0, 0], masses: [0.1, 0.05] },
    };
    const resolved = await resolveImportMotors(imported, async () => ({ motor: loaded, note: '' }));
    const plan = planImport(imported, resolved, { launch: DEFAULT_CONDITIONS, text: { mass: (kg: number) => `${kg} kg`, length: (m: number) => `${m} m` } });
    const [lead] = orderedLines(plan.note.group.lines);
    expect(lead!.tier).toBe('caution');
    expect(lead!.kind).toBe('I10.config-override');
    expect(lead!.text).toMatch(/^Recovery: Flight configuration “.*” overrides the deployment setting — Parachute \(×2\)/);
    expect(plan.note.group.heading).toBe(plan.note.text.split('\n')[0]);
    expect(plan.note.group.lines.find(l => /^Opened “/.test(l.text))!.tier).toBe('information');
  });
});

describe('simulation extensions (orkExtensions.ts, I02)', () => {
  const extXml = (simBody: string, rootAttrs = '') => `<openrocket version="1.10" creator="OpenRocket 24.12"${rootAttrs}><rocket><name>X</name>
    <motorconfiguration configid="A" default="true"><name>A</name></motorconfiguration>
    <subcomponents><stage><name>Sustainer</name><subcomponents>${TUBE()}</subcomponents></stage></subcomponents></rocket>
    <simulations><simulation status="notsimulated"><name>A</name><conditions><configid>A</configid></conditions>${simBody}</simulation></simulations></openrocket>`;
  const air = '<extension extensionid="info.openrocket.core.simulation.extension.example.AirStart">'
    + '<entry key="launchAltitude" type="double">100.0</entry></extension>';
  const text = { mass: (kg: number) => `${kg} kg`, length: (m: number) => `${m} m` };

  it('a direct extension the app keeps but does not run is Caution, and stays Caution through the open', async () => {
    const imported: ImportedDesign = { ...importOrk(extXml(air)), sourceFormat: 'ork' };
    expect(tierOf(tiered(imported), /simulation extension/)).toBe('caution');
    const resolved = await resolveImportMotors(imported, async () => ({ note: '' }));
    const plan = planImport(imported, resolved, { launch: DEFAULT_CONDITIONS, text });
    const line = plan.note.group.lines.find(l => /simulation extension/.test(l.text))!;
    expect(line).toMatchObject({ kind: 'I02.not-run', tier: 'caution' });
    expect(orderedLines(plan.note.group.lines)[0]!.kind).toBe('I02.not-run');
  });

  it('a nested extension dropped on save is Caution', () => {
    const lines = tiered(importOrk(extXml(`<wrapper>${air}</wrapper>`)));
    expect(lines.find(l => /nested simulation extension/.test(l.text))).toMatchObject({ kind: 'I02.nested-dropped', tier: 'caution' });
  });

  it('an extension whose XML cannot stand alone is Caution', () => {
    const bound = '<extension extensionid="custom.Ns"><x:entry/></extension>';
    const lines = tiered(importOrk(extXml(bound, ' xmlns:x="urn:example"')));
    expect(lines.find(l => /cannot stand alone/.test(l.text))).toMatchObject({ kind: 'I02.not-standalone', tier: 'caution' });
  });
});

describe('the RockSim reader (rocksimFile.ts)', () => {
  it('Caution for an airfoil fin mass pinned over future edits; Information for a point mass placed as stated', () => {
    const lines = tiered(importRkt(fixture('rocksimTestRocket2.rkt')));
    expect(tierOf(lines, /airfoil fin sets? took the mass/)).toBe('caution');
    expect(tierOf(lines, /mass objects? placed at the exact point/)).toBe('information');
  });

  it('Caution for a refused loadout; Information for its opened-with-no-motors receipt', () => {
    const lines = tiered(importRkt(fixture('ambiguous-motor-mounts.rkt')));
    expect(tierOf(lines, /^Launch refused/)).toBe('caution');
    expect(tierOf(lines, /was opened with no motors loaded/)).toBe('information');
  });
});

describe('the RASAero reader (rasaeroFile.ts)', () => {
  it('Caution for an out-of-range pressure replaced by the standard day; Information for its stored prediction', () => {
    const lines = tiered(importCdx1(fixture('Show-off.CDX1')));
    expect(tierOf(lines, /^Launch site: this file's pressure/)).toBe('caution');
    expect(tierOf(lines, /^RASAero’s stored prediction/)).toBe('information');
  });

  it('the same "Ignored" sentence is Information for RASAero’s own <CP> output and Caution for anything else', () => {
    const quiet = tiered(importCdx1(fixture('Wildman_Mach 2 this one.CDX1')));
    expect(tierOf(quiet, /^Ignored RASAero elements: CP\.$/)).toBe('information');
    const xml = fixture('Wildman_Mach 2 this one.CDX1').replace('<CP>', '<Mystery>1</Mystery><CP>');
    const loud = tiered(importCdx1(xml));
    expect(tierOf(loud, /^Ignored RASAero elements: /)).toBe('caution');
  });
});

describe('the parts catalogue (presets.ts)', () => {
  const db = (presetsJson as { presets: Preset[] }).presets;
  it('Caution when the catalogue supplied a missing value; Information when it filled nothing', () => {
    const node = { type: 'parachute', id: 'p1', name: 'Main', diameter: 2.4384, lineCount: 6 } as ComponentNode;
    const first: string[] = [];
    applyPresetLinks([{ node, manufacturer: 'Fruity Chutes', partNo: '29185' }], db, first);
    expect(tierOf(tierLines(first, noteFlags(first)), /matched the parts catalogue/)).toBe('caution');
    // The same part again: everything the row carries is now stated.
    const again: string[] = [];
    applyPresetLinks([{ node, manufacturer: 'Fruity Chutes', partNo: '29185' }], db, again);
    expect(tierOf(tierLines(again, noteFlags(again)), /matched the parts catalogue/)).toBe('information');
  });
});

describe('embedded EX motors (exMotorArchive.ts, exMotors.ts)', () => {
  const motor = (): ExMotor => ({ motorId: 'ex:notes2', designation: 'C6', realManufacturer: 'Notes 2',
    diameter: 18, length: 70, totalWeightG: 24, propWeightG: 10, delays: '3,5,P',
    samples: [{ time: 0, thrust: 0 }, { time: 0.1, thrust: 12 }, { time: 0.5, thrust: 6 }, { time: 1.2, thrust: 0 }],
    source: 'eng', addedAt: 1 });
  beforeEach(() => localStorage.clear());
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it('Caution for an archive the open refused', () => {
    const lines = tiered(importOrk(orkXml(TUBE()).replace('<name>T</name>', '<name>T</name><mmrexmotors version="9">[]</mmrexmotors>')));
    expect(tierOf(lines, /^Embedded EX motors were refused/)).toBe('caution');
  });

  it('Information for a same-name library motor kept beside it; Caution when it lives for this session only', () => {
    addExMotors([motor()]);
    const differs = { ...motor(), motorId: 'ex:notes2-b', samples: motor().samples.map(s => ({ ...s, thrust: s.thrust * 2 })) };
    const kept: string[] = [];
    restoreExMotors([differs], kept);
    expect(tierOf(tierLines(kept, noteFlags(kept)), /same name; both were kept/)).toBe('information');
    localStorage.clear();
    const full = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full'); });
    const session: string[] = [];
    try {
      restoreExMotors([motor()], session);
    } finally {
      full.mockRestore();
    }
    expect(tierOf(tierLines(session, noteFlags(session)), /available for this session but were not saved/)).toBe('caution');
  });
});

describe('launch conditions and the stated launch weight', () => {
  it('importLaunchValue: Caution for a clamped value; nothing to say for one in range', () => {
    const say = { what: 'rod angle', field: 'Rod angle', show: (x: number) => `${x}°` };
    const notes: string[] = [];
    expect(importLaunchValue(5, [0, 20], say, notes)).toBe(5);
    expect(notes).toEqual([]);
    expect(importLaunchValue(40, [0, 20], say, notes)).toBe(20);
    expect(tierLines(notes, noteFlags(notes))[0]!.tier).toBe('caution');
  });

  it('reconcileAllIncludedMotors: Caution for a cleared override; Information for an exact back-out', () => {
    const marked = (): RocketTree => ({ components: [{
      type: 'stage', id: 'st', name: 'Sustainer', overrideMass: 2, overrideSubcomponentsMass: true,
      overrideCGX: 0.5, overrideSubcomponentsCG: true, [OVERRIDE_INCLUDES_MOTOR]: 'M787',
      children: [{ type: 'bodytube', id: 'bt', length: 1, outerRadius: 0.04, thickness: 0.002 }],
    } as ComponentNode] });
    const text = { mass: (kg: number) => `${kg} kg`, length: (m: number) => `${m} m` };
    const motor = (kg: number) => ({ designation: 'M787', launchMassKg: kg, lengthM: 0.3, cgXFromFrontM: 0.15 });
    const cleared = reconcileAllIncludedMotors(marked(), { bt: motor(2.5) }, text);
    expect(cleared.severity).toBe('warn');
    expect(tierLines(cleared.notes, noteFlags(cleared.notes)).map(l => l.tier)).toEqual(['caution']);
    const backedOut = reconcileAllIncludedMotors(marked(), { bt: motor(1) }, text);
    expect(backedOut.severity).toBe('info');
    expect(backedOut.notes.length).toBeGreaterThan(0);
    expect(tierLines(backedOut.notes, noteFlags(backedOut.notes)).every(l => l.tier === 'information')).toBe(true);
  });
});

describe('restore (session.ts, sessionRestore.ts, treeModel.ts, padMassReconcile.ts, notices.ts)', () => {
  beforeEach(() => localStorage.clear());
  const launch = { launchRodLengthM: 1, launchRodAngleDeg: 0, windAverage: 2, windStdDev: 0.2, launchAltitudeM: 0,
    temperatureC: null, pressureHPa: null, latitudeDeg: 45 };

  it('Caution for configurations the restore removed (G04)', () => {
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({
      tree: { name: 'Test', components: [] }, launch, savedConfigs: [null, { id: 'kept', name: 'Kept', motors: {} }] }));
    const restored = designStateFromSession(loadSession(), { legacyMaxMotorLengthM: null });
    expect(tierOf(tierLines(restored.restoreNotes, restored.restoreNoteTiers), /^Unreadable saved configurations were removed\.$/))
      .toBe('caution');
  });

  it('Caution for a removed component; Information for a fin outline moved to the origin unchanged', () => {
    const fin = { type: 'freeformfinset', id: 'f', name: 'Fins', points: [[0.01, 0], [0.03, 0.05], [0.06, 0]] };
    const session = { tree: { name: 'R', components: [{ type: 'stage', id: 's', name: 'Sustainer', children: [
      { type: 'bodytube', id: 'b', name: 'B', length: 0.3, outerRadius: 0.02, thickness: 0.001, children: [fin, 7] },
    ] }] } as unknown as RocketTree, launch, savedAt: 1 };
    const restored = designStateFromSession(session as never, { legacyMaxMotorLengthM: null });
    const lines = tierLines(restored.restoreNotes, restored.restoreNoteTiers);
    expect(tierOf(lines, /^A component that could not be read was removed\.$/)).toBe('caution');
    expect(tierOf(lines, /points were moved to the origin/)).toBe('information');
  });

  it('a session note written as plain text (no record) reads as Information', () => {
    const restored = designStateFromSession({ tree: { name: 'Old', components: [] }, launch, savedAt: 1,
      treeRestoreNotes: ['An older build wrote this line.'] } as never, { legacyMaxMotorLengthM: null });
    expect(tierOf(tierLines(restored.restoreNotes, restored.restoreNoteTiers), /older build/)).toBe('information');
  });

  it('pad mass: Caution when a weighing was dropped; Information is untiered', () => {
    const text = { mass: (kg: number) => `${kg} kg`, motorName: (l: string) => l };
    const dropped = restoredPadMassNote({ outcome: 'dropped', kg: 1 }, null, { tree: { components: [] }, motors: {}, text });
    expect(dropped?.tier).toBe('caution');
    expect(restoredPadMassNote(null, null, { tree: { components: [] }, motors: {}, text })).toBeNull();
  });

  it('the time-step migration and a held pad-mass note keep their tiers on the bar', () => {
    const input: NoticeInput = {
      error: null, buildFailed: false, motorFailures: [], tree: { components: [] }, assigned: [],
      restoredByOlderBuild: true, timeStepMigrated: true, timeStepMigratedFrom: null,
      padMassNote: { text: 'moved', severity: 'info', tier: 'caution' }, fileNote: null,
      runsCapped: { evicted: 0, unsaved: 0 }, lengthText: m => `${m} m`,
    };
    const none = () => {};
    const out = designNotices(input, { simError: none, staleSession: none, timeStep: none, padMassNote: none, fileNote: none, runsCapped: none });
    expect(out.find(n => n.id === 'timestep-migrated')?.tier).toBe('caution');
    expect(out.find(n => n.id === 'pad-mass-moved')?.tier).toBe('caution');
    expect(out.find(n => n.id === 'stale-session')?.tier).toBeUndefined();
  });

  it('carries a file note’s group to the bar, without the legacy-position line', () => {
    const group = { heading: 'Loaded “x”.', lines: [{ kind: 'k', tier: 'caution' as const, text: 'c' }] };
    const out = designNotices({
      error: null, buildFailed: false, motorFailures: [], tree: { components: [] }, assigned: [],
      restoredByOlderBuild: false, timeStepMigrated: false, timeStepMigratedFrom: null, padMassNote: null,
      fileNote: { text: 'Loaded “x”.\nc', severity: 'info', group }, runsCapped: { evicted: 0, unsaved: 0 }, lengthText: m => `${m}`,
    }, { simError: () => {}, staleSession: () => {}, timeStep: () => {}, padMassNote: () => {}, fileNote: () => {}, runsCapped: () => {} });
    expect(out.find(n => n.id === 'file-note')?.group).toEqual(group);
  });
});

describe('the open itself (importApply.ts: motor-match, pad mass, retained conditions)', () => {
  const text = { mass: (kg: number) => `${kg} kg`, length: (m: number) => `${m} m` };
  const tree: RocketTree = { name: 'R', components: [{ type: 'stage', id: 's', name: 'Sustainer', children: [
    { type: 'bodytube', id: 'm1', name: 'MMT', length: 0.2, outerRadius: 0.015, thickness: 0.001, motorMount: true },
  ] } as ComponentNode] };
  const design = (over: Partial<ImportedDesign> = {}): ImportedDesign => ({
    name: 'x', tree, notes: [], motors: { m1: { designation: 'Z9', manufacturer: 'AeroTech', diameter: 0.029, length: 0.2, delay: 5 } },
    ...over,
  });

  it('Caution for a motor that did not load; Information for a confirmed match', () => {
    const lost = planImport(design(), { working: { m1: { note: 'Motor “Z9” matched nothing.' } }, configs: {} }, { launch: DEFAULT_CONDITIONS, text });
    expect(lost.note.group.lines).toEqual([{ kind: 'I12.motor-not-loaded', tier: 'caution', text: 'Motor “Z9” matched nothing.' }]);
    const motor = { label: 'Z9', meta: { label: 'Z9', manufacturer: 'EX', motorId: 'ex:z9' }, ignition: { event: 'automatic', delay: 0 },
      spec: { designation: 'Z9', diameter: 0.029, length: 0.2, cgX: 0.1, ejectionDelay: 5, times: [0, 1], thrusts: [0, 0], masses: [0.2, 0.1] } } as MountMotor;
    const confirmed = planImport(design(), { working: { m1: { motor, note: '', infoNote: 'Motor Z9: the file’s own EX motor.' } }, configs: {} },
      { launch: DEFAULT_CONDITIONS, text });
    expect(confirmed.note.group.lines).toEqual([{ kind: 'note', tier: 'information', text: 'Motor Z9: the file’s own EX motor.' }]);
    expect(confirmed.note.group.heading).toBe('Loaded “x”.');
  });

  it('Caution for conditions kept from the previous design (.rkt); Information for a step the file states', () => {
    const kept = planImport(design({ motors: {}, sourceFormat: 'rkt' }), { working: {}, configs: {} },
      { launch: { ...DEFAULT_CONDITIONS, timeStepS: 0.05 }, text });
    expect(tierOf(kept.note.group.lines, /^From a \.rkt the app reads only the launch site/)).toBe('caution');
    const stated = planImport(design({ motors: {}, launch: { timeStepS: 0.02 } }), { working: {}, configs: {} },
      { launch: { ...DEFAULT_CONDITIONS, timeStepS: 0.05 }, text });
    expect(tierOf(stated.note.group.lines, /^Flights here now use a 0\.02 s/)).toBe('information');
    const reset = planImport(design({ motors: {} }), { working: {}, configs: {} },
      { launch: { ...DEFAULT_CONDITIONS, timeStepS: 0.02 }, text });
    expect(tierOf(reset.note.group.lines, /^The simulation time step is back to/)).toBe('caution');
  });

  it('rewording a line after the motors are known (configuration label) keeps its tier', () => {
    // The reader wrote the label it could see; the open rewrites it to the
    // label the panel shows once motors are known (FC-4 fixup). The words
    // change; the record — and so the tier — goes with them.
    const notes: string[] = [];
    const said = 'Flight configuration “[Z9]” overrides recovery.';
    cautionNote(notes, 'I10.config-override', said);
    const plan = planImport(design({
      motors: {}, notes, noteTiers: noteFlags(notes),
      configs: [{ id: 'a', name: null, isDefault: true, motors: {}, deployments: {}, separations: {} }],
      chosenConfigId: 'a', configLabelNotes: [{ text: said, configId: 'a', label: '[Z9]' }],
    }), { working: {}, configs: {} }, { launch: DEFAULT_CONDITIONS, text });
    expect(plan.note.group.lines).toEqual([
      { kind: 'I10.config-override', tier: 'caution', text: 'Flight configuration “No motors” overrides recovery.' }]);
  });

  it('a reader line keeps its producer tier through the open, and the text stays as it was', () => {
    const notes: string[] = [];
    cautionNote(notes, 'test.reader', 'Reader replaced a value.');
    notes.push('Reader receipt.');
    const plan = planImport(design({ motors: {}, notes, noteTiers: noteFlags(notes) }), { working: {}, configs: {} },
      { launch: DEFAULT_CONDITIONS, text });
    expect(plan.note.text).toBe('Loaded “x”.\nReader replaced a value.\nReader receipt.');
    expect(plan.note.group.lines.map(l => l.tier)).toEqual(['caution', 'information']);
  });
});
