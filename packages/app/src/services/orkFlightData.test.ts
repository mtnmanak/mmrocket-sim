// @vitest-environment happy-dom
import { testResolution } from './autoDelay.testSupport.js';
import { describe, expect, it } from 'vitest';
import { flightDataForExport, flownAutoDelays, importedSummaryRuns, planSummaryImport, summaryImportCounts, summaryDocument, summaryOf, type FlightDataForExportInput } from './orkFlightData.js';
import { addRuns, appendImportedRuns, deleteRun, restoreRun, loadRuns, runCapNote, runsEvictedByLastWrite, runsUnsavedByLastWrite } from './simStore.js';
import { designMatchKeyOf, motorDataKeyOf, motorSetKeyOf, runMatchesDesign, type SimRun } from './simReport.js';
import type { MountMotor, SavedConfig } from '../model/design.js';
import { exportOrk, importOrk } from './orkFile.js';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';
import { createLoadedConfig, deleteConfig } from './configSync.js';
import { orkMotorSet } from './orkExportMotors.js';

/**
 * SIX INDEPENDENT REFUSAL RULES, none of which had a test until this function
 * left App.tsx (docs/AUDIT.md, 2026-09-08). Every one of them guards the same
 * thing: desktop OpenRocket renders a `<flightdata>` block indistinguishably
 * from a result it computed itself, so a stale number written there is
 * authoritative-looking and wrong, with nothing on screen to say so. An ABSENT
 * number is honest; a stale one is not.
 *
 * Table-driven from one qualifying baseline, so each case says exactly which
 * rule it is about — change one field, lose the run.
 */

const MOTOR: MountMotor = {
  label: 'H128-M',
  spec: { designation: 'H128W', diameter: 0.029, length: 0.194, ejectionDelay: 7 },
  meta: { label: 'H128-M' },
  ignition: { event: 'automatic', delay: 0 },
} as unknown as MountMotor;

const RUN: SimRun = {
  delayResolution: testResolution([['m1', MOTOR]], [7]),
  id: 'r1',
  flightConfigId: 'c1',
  designKey: 'design-A',
  conditionsKey: 'cond-A',
  motorSetKey: 'set-A',
  motorDataKey: motorDataKeyOf([['m1', MOTOR]]),
  delayS: 7,
  aeroModel: 'supersonic',
  rogersKbf: true,
  nozzleStamp: 'v119',
  maxAltitude: 1234.5,
  maxVelocity: 210.1,
  maxAcceleration: 190.2,
  maxMach: 0.62,
  timeToApogee: 15.9,
  totalFlightTime: 88.4,
  groundHitVelocity: 5.6,
  rodExitVelocity: 19.3,
  velocityAtDeployment: 12.1,
  optimumDelayS: 7,
  recommendedDelayS: 7,
} as unknown as SimRun;

const CONFIG: SavedConfig = {
  id: 'c1', name: 'Main', isDefault: true, motors: { m1: MOTOR },
} as unknown as SavedConfig;

const base = (over: Partial<FlightDataForExportInput> = {}): FlightDataForExportInput => ({
  runs: [RUN],
  savedConfigs: [CONFIG],
  activeConfigId: 'c1',
  assigned: [['m1', MOTOR]],
  mountIds: ['m1'],
  designKey: 'design-A',
  conditionsKey: 'cond-A',
  model: { aeroMode: 'supersonic', effectiveKbf: true, autoSupersonic: false },
  hasNozzle: false,
  motorSetKeyOf: () => 'set-A',
  hardwareDeltaKg: 0,
  primaryMountOf: (mountIds) => mountIds[0] ?? null,
  ...over,
});

const ids = (over: Partial<FlightDataForExportInput> = {}) =>
  Object.keys(flightDataForExport(base(over)));

describe('flightDataForExport — the baseline qualifies', () => {
  it('deleting the active default excludes both its app result and file summary from a reopened file', () => {
    const tree = { name: 'Delete result', components: [{ type: 'stage' as const, id: 'stage', children: [
      { type: 'bodytube' as const, id: 'm1', motorMount: true, length: 0.3, outerRadius: 0.02, thickness: 0.001 },
    ] }] };
    const importedDocument = { name: tree.name, storedSimulations: [
      { name: 'Deleted flight', configId: 'c1', windAverage: 0,
        data: { ...summaryOf(RUN), importedSummary: true as const } },
    ] };
    for (const runs of [[RUN], []]) {
      const input = base({ runs, importedDocument });
      expect(flightDataForExport(input)['c1']).toBeDefined();
      const next = deleteConfig([CONFIG, { ...CONFIG, id: 'keep', isDefault: false }], 'c1', 'c1');
      const data = flightDataForExport({ ...input, ...next });
      expect(data).toEqual({});
      const xml = exportOrk({ name: tree.name, tree, launch: DEFAULT_CONDITIONS,
        configs: next.savedConfigs.map(c => ({ ...c, motors: {} })), activeConfigId: next.activeConfigId,
        motors: { m1: { designation: 'H128W', diameter: 0.029, length: 0.1, delay: 10 } }, flightData: data });
      expect(xml).not.toContain('<flightdata');
      expect(xml).not.toContain('configid="c1"');
      expect(xml).not.toContain('<configid>c1</configid>');
      const reopened = importOrk(xml);
      expect(reopened.configs).toHaveLength(2);
      expect(reopened.storedSimulations ?? []).toHaveLength(0);
    }
  });

  const file = (name: string, altitude: number) => importOrk(exportOrk({ name,
    tree: { name, components: [{ type: 'stage', children: [
      { type: 'bodytube', length: 0.3, outerRadius: 0.02, thickness: 0.001 },
    ] }] }, launch: DEFAULT_CONDITIONS,
    configs: [{ id: 'c1', name: 'Main', isDefault: true, motors: {} }], activeConfigId: 'c1',
    flightData: { c1: { ...summaryOf(RUN), maxAltitude: altitude } },
  }));

  it('historical fallback belongs only to the opened document, never global history', () => {
    const a = file('A', 123);
    const b = file('B', 456);
    const runsA = importedSummaryRuns(a);
    const runs = [...runsA, ...importedSummaryRuns(b, runsA)];
    // Same config AND source run ID, differing summaries. Edits invalidate app flights.
    const input = base({ runs, designKey: 'edited', importedDocument: summaryDocument(b) });
    expect(flightDataForExport(input)['c1']).toMatchObject({ maxAltitude: 456, runId: 'r1', importedSummary: true });
    expect(flightDataForExport({ ...input, importedDocument: summaryDocument(a) })['c1']!.maxAltitude).toBe(123);
    expect(flightDataForExport({ ...input, importedDocument: undefined })).toEqual({});
    expect(flightDataForExport({ ...input, savedConfigs: [] })).toEqual({});
  });

  it.each([' c1 ', '\tc1\r\n'])('preserves exact configuration IDs through provenance and re-export (%j)', (paddedId) => {
    const configs = [
      { id: paddedId, name: 'Padded', isDefault: false, motors: {} },
      { id: 'c1', name: 'Plain', isDefault: true, motors: {} },
    ];
    const xml = exportOrk({ name: 'Exact IDs', tree: file('Tree', 123).tree,
      configs, activeConfigId: 'c1', launch: DEFAULT_CONDITIONS,
      flightData: {
        [paddedId]: { ...summaryOf(RUN), maxAltitude: 123, aeroModel: 'classic', rogersKbf: false },
        c1: { ...summaryOf(RUN), maxAltitude: 456 },
      },
    }).replace(/<launchaltitude>[^<]*<\/launchaltitude>/g, (() => {
      let index = 0;
      return () => `<launchaltitude>${++index * 100}</launchaltitude>`;
    })());
    const imported = importOrk(xml);
    expect(imported.configs.map((c) => c.id)).toEqual([paddedId, 'c1']);
    expect(imported.launch?.launchAltitudeM).toBe(200); // Second simulation matches the default exactly.
    expect(imported.storedSimulations?.map((s) => s.configId)).toEqual([paddedId, 'c1']);
    const runs = importedSummaryRuns(imported);
    expect(runs.map((r) => [r.flightConfigId, r.flightConfig, r.maxAltitude]))
      .toEqual([[paddedId, 'Padded', 123], ['c1', 'Plain', 456]]);
    // Identical source IDs and summaries still belong to distinct configurations.
    const equalSummaries = { ...imported, storedSimulations: imported.storedSimulations!.map((s) => ({
      ...s, data: imported.storedSimulations![0]!.data,
    })) };
    expect(importedSummaryRuns(equalSummaries)).toHaveLength(2);
    expect(importedSummaryRuns(imported, runs)).toEqual([]);
    const document = JSON.parse(JSON.stringify(summaryDocument(imported)));
    const selected = flightDataForExport(base({ runs, savedConfigs: configs, importedDocument: document }));
    expect(Object.keys(selected)).toEqual([paddedId, 'c1']);
    expect(selected[paddedId]).toMatchObject({ maxAltitude: 123, aeroModel: 'classic', importedSummary: true });
    expect(selected.c1).toMatchObject({ maxAltitude: 456, aeroModel: 'supersonic', importedSummary: true });
    const reopened = importOrk(exportOrk({ name: imported.name, tree: imported.tree,
      configs: imported.configs, activeConfigId: 'c1', launch: DEFAULT_CONDITIONS, flightData: selected }));
    expect(reopened.configs.map((c) => c.id)).toEqual([paddedId, 'c1']);
    expect(reopened.storedSimulations).toEqual(imported.storedSimulations);
    expect(importedSummaryRuns(reopened, runs)).toEqual([]);
  });

  it.each(['dedup', 'undo'] as const)('preserves file provenance independently of the fuller report (%s)', (action) => {
    localStorage.clear();
    const original = { ...RUN, maxAltitude: 123 };
    addRuns([original]);
    if (action === 'undo') deleteRun(original.id);
    const imported = file('Original file', 123);
    const document = summaryDocument(imported);
    const plan = planSummaryImport(imported, loadRuns());
    expect(plan.runs).toHaveLength(action === 'undo' ? 1 : 0);
    appendImportedRuns(plan.runs);
    if (action === 'undo') restoreRun(original, null);
    const runs = loadRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.importedSummary).toBeUndefined();
    expect(runs[0]!.designKey).toBe('design-A');
    const selected = flightDataForExport(base({ runs, designKey: 'edited', importedDocument: document }));
    const xml = exportOrk({ name: imported.name, tree: { ...imported.tree, name: 'Edited name' },
      launch: DEFAULT_CONDITIONS, configs: imported.configs, activeConfigId: 'c1', flightData: selected });
    expect(xml).toContain('<simulation status="outdated">');
    expect(xml).not.toContain('notsimulated');
    expect(importOrk(xml).storedSimulations![0]!.data).toEqual(summaryOf(original));
    expect(document!.name).toBe('Original file');
    expect(document!.storedSimulations[0]!.name).toBe(imported.storedSimulations![0]!.name);
    localStorage.clear();
  });

  it('historical summary metadata stays unknown after current motor, delay and conditions change', () => {
    localStorage.clear();
    const original = importOrk(exportOrk({
      name: 'Historical metadata', tree: { name: 'Historical metadata', components: [{ type: 'stage', children: [
        { type: 'bodytube', id: 'm1', motorMount: true, length: 0.3, outerRadius: 0.02, thickness: 0.001 },
      ] }] },
      launch: { ...DEFAULT_CONDITIONS, windAverage: 4.5 },
      motors: { m1: { designation: 'B6', manufacturer: 'Estes', diameter: 0.018, length: 0.07, delay: 4 } },
      configs: [{ id: 'c1', name: 'Main', isDefault: true, motors: { m1: {
        designation: 'B6', manufacturer: 'Estes', diameter: 0.018, length: 0.07, delay: 4,
      } } }], activeConfigId: 'c1', flightData: { c1: { ...summaryOf(RUN), maxAltitude: 123 } },
    }));
    expect(Object.values(original.configs[0]!.motors)[0]).toMatchObject({ designation: 'B6', delay: 4 });
    expect(original.launch?.windAverage).toBe(4.5);
    addRuns(importedSummaryRuns(original));
    const historical = loadRuns();
    const changedConfigs = original.configs.map((c) => ({ ...c, motors: Object.fromEntries(
      Object.entries(c.motors).map(([id, m]) => [id, { ...m, designation: 'C6', delay: 7 }]),
    ) }));
    const reopened = importOrk(exportOrk({ name: original.name, tree: original.tree,
      motors: changedConfigs[0]!.motors,
      configs: changedConfigs, activeConfigId: 'c1', launch: { ...DEFAULT_CONDITIONS, windAverage: 12 },
      flightData: flightDataForExport(base({ runs: historical, importedDocument: summaryDocument(original) })),
    }));
    expect(Object.values(reopened.configs[0]!.motors)[0]).toMatchObject({ designation: 'C6', delay: 7 });
    expect(reopened.launch?.windAverage).toBe(12);
    for (const run of [...historical, ...importedSummaryRuns(reopened)]) {
      expect(run.id).toBe('r1');
      expect(run.maxAltitude).toBe(123);
      expect(run.motor).toBe('');
      expect(Number.isFinite(run.delayS)).toBe(false);
      expect(Number.isFinite(run.windAvg)).toBe(false);
      expect(run.windLevels).toBeUndefined();
      expect(run.conditionsKey).toBeUndefined();
      expect(run.comments).toContain('historical motor, delay, launch conditions');
    }
    localStorage.clear();
  });

  it.each([2, 499, 500])('importing an old duplicate preserves history and export precedence (%s existing)', (count) => {
    localStorage.clear();
    const newer = { ...RUN, id: 'newer', when: 2, maxAltitude: 456 };
    const older = { ...RUN, id: 'older', when: 1, maxAltitude: 123 };
    const history = [newer, ...Array.from({ length: count - 2 }, (_, i) => ({ ...older, id: `old-${i}` })), older];
    addRuns(history);
    const before = loadRuns();
    const selected = flightDataForExport(base({ runs: before }));
    expect(selected['c1']!.maxAltitude).toBe(456);
    const imported = { name: 'File', storedSimulations: [
      ...history.slice(1).map((r) => ({ name: 'Duplicate', configId: 'c1', windAverage: 0, data: summaryOf(r) })),
      ...(count === 500 ? ['first-new'] : ['first-new', 'second-new']).map((runId) => ({ name: 'New', configId: 'c1', windAverage: 0,
        data: { ...summaryOf(older), runId } })),
    ] };
    const plan = planSummaryImport(imported, before);
    const after = appendImportedRuns(plan.runs);
    expect(after.slice(0, count)).toEqual(before);
    expect(after.slice(count).map((r) => r.id)).toEqual(count === 500 ? [] : count === 499 ? ['first-new'] : ['first-new', 'second-new']);
    expect(flightDataForExport(base({ runs: after }))).toEqual(selected);
    expect(summaryImportCounts(plan, after)).toEqual({ added: Math.min(2, 500 - count), alreadySaved: count - 1, notKept: count >= 499 ? 1 : 0 });
    expect(runCapNote(runsEvictedByLastWrite(), runsUnsavedByLastWrite())).toBe('');
    const again = planSummaryImport(imported, loadRuns());
    expect(again.runs).toEqual([]);
    localStorage.clear();
  });

  it.each([
    ['classic', false, 'classic', false],
    ['classic', true, 'classic', false],
    ['supersonic', true, 'supersonic', false],
    ['classic', true, 'auto', false],
    ['auto-supersonic', true, 'auto', true],
    ['hybrid', true, 'hybrid', false],
  ] as const)('saves/loads %s (Kbf=%s) with its aero provenance',
    (aeroModel, rogersKbf, aeroMode, autoSupersonic) => {
      const run = { ...RUN, aeroModel, rogersKbf } as SimRun;
      const flightData = flightDataForExport(base({
        runs: [run], model: { aeroMode, effectiveKbf: rogersKbf, autoSupersonic },
      }));
      expect(flightData['c1']).toEqual(summaryOf(run));
      expect(flightData['c1']!.aeroModel).toBe(aeroModel);
      const xml = exportOrk({
        name: 'Save regression',
        tree: { name: 'Save regression', components: [{ type: 'stage', children: [
          { type: 'bodytube', length: 0.3, outerRadius: 0.02, thickness: 0.001 },
        ] }] },
        launch: { ...DEFAULT_CONDITIONS, windAverage: 4.5 },
        configs: [{ id: 'c1', name: 'Main', isDefault: true, motors: {} }],
        activeConfigId: 'c1', flightData,
      });
      expect(xml).toContain('<simulation status="uptodate">');
      expect(xml).toContain('<calculator>BarrowmanCalculator</calculator>');
      expect(xml).toContain('<flightdata maxaltitude="1234.5" maxvelocity="210.1"'
        + ' maxacceleration="190.2" maxmach="0.62" timetoapogee="15.9" flighttime="88.4"'
        + ' groundhitvelocity="5.6" launchrodvelocity="19.3" deploymentvelocity="12.1" optimumdelay="7"/>');
      expect(xml).toContain(`>${aeroModel}</aeromodel>`);
      const loaded = importOrk(xml);
      expect(loaded.chosenConfigId).toBe('c1');
      expect(loaded.configs.map((c) => c.name)).toEqual(['Main']);
      expect(loaded.launch?.windAverage).toBe(4.5);
      // Run provenance stays separate from the current aero preference.
      expect(loaded).not.toHaveProperty('aeroModel');
      expect(loaded.storedSimulations?.[0]?.data).toEqual(summaryOf(run));
      expect(importedSummaryRuns(loaded, [run])).toEqual([]);
      // A later Save goes through the actual selector, not just summaryOf.
      const summaries = importedSummaryRuns(loaded);
      const preserved = { runs: summaries, importedDocument: summaryDocument(loaded) };
      const savedAgain = flightDataForExport(base(preserved));
      expect(savedAgain['c1']).toEqual({ ...summaryOf(run), importedSummary: true });
      const secondXml = exportOrk({ name: loaded.name, tree: loaded.tree,
        launch: DEFAULT_CONDITIONS, configs: loaded.configs, activeConfigId: 'c1', flightData: savedAgain });
      expect(secondXml).toContain('<simulation status="outdated">');
      const reopened = importedSummaryRuns(importOrk(secondXml));
      expect(summaryOf(reopened[0]!)).toEqual(summaryOf(summaries[0]!));
      for (const key of ['designKey', 'conditionsKey', 'motorSetKey', 'nozzleStages', 'physicsRevision', 'delayResolution'] as const) {
        expect(reopened[0]![key], key).toBeUndefined();
        expect(summaries[0]![key], key).toBeUndefined();
      }
      expect(flownAutoDelays(base(preserved))).toEqual({});
      expect(flightDataForExport(base({ ...preserved, savedConfigs: [] }))).toEqual({});
      expect(flightDataForExport(base({ ...preserved, runs: [...summaries, RUN] }))['c1']).toEqual(summaryOf(RUN));
    });

  it('writes the run for a configuration whose design, conditions, model and motors all match', () => {
    expect(ids()).toEqual(['c1']);
  });

  it('writes the run for a configuration whose id is also a prototype key', () => {
    // Audit 2026-09-22: `out['constructor']` was Object itself, so the run
    // was skipped as "already written" and the .ork saved that configuration
    // as notsimulated. The id is file text, kept verbatim.
    const out = flightDataForExport(base({
      runs: [{ ...RUN, flightConfigId: 'constructor' } as SimRun],
      savedConfigs: [{ ...CONFIG, id: 'constructor' } as SavedConfig],
      activeConfigId: 'constructor',
    }));
    expect(Object.keys(out)).toEqual(['constructor']);
    expect(out['constructor']!.maxAltitude).toBe(1234.5);
  });

  it('writes the ten values desktop OpenRocket stores, in its units', () => {
    const out = flightDataForExport(base());
    expect(out['c1']).toEqual({
      runId: 'r1',
      aeroModel: 'supersonic',
      rogersKbf: true,
      maxAltitude: 1234.5,
      maxVelocity: 210.1,
      maxAcceleration: 190.2,
      maxMach: 0.62,
      timeToApogee: 15.9,
      flightTime: 88.4,
      groundHitVelocity: 5.6,
      launchRodVelocity: 19.3,
      deploymentVelocity: 12.1,
      optimumDelay: 7,
    });
    // The ONE mapping — `summaryOf` sat unreferenced in App.tsx while this
    // function built the identical literal inline, so a units or field-name fix
    // made in the obvious place changed nothing in the file that came out.
    expect(out['c1']).toEqual(summaryOf(RUN));
  });
});

describe('flightDataForExport — each refusal, one at a time', () => {
  it('refuses a run whose DESIGN has changed since it flew', () => {
    expect(ids({ designKey: 'design-B' })).toEqual([]);
  });

  it('refuses a run whose launch CONDITIONS have changed', () => {
    expect(ids({ conditionsKey: 'cond-B' })).toEqual([]);
  });

  it('refuses a run flown on a DIFFERENT aero model', () => {
    expect(ids({ model: { aeroMode: 'classic', effectiveKbf: false, autoSupersonic: false } }))
      .toEqual([]);
  });

  it('refuses a run whose model is UNKNOWN, not just different', () => {
    // A run predating the field. `runMatchesModel` returns null, and null is a
    // refusal here — "I cannot tell" must never be written as "it matches".
    const old = { ...RUN, aeroModel: undefined } as unknown as SimRun;
    expect(ids({ runs: [old] })).toEqual([]);
  });

  it('refuses a run with no pressure-thrust stamp on a nozzle-bearing design', () => {
    // The v0.119 kernel change. None of the design/conditions/model keys can
    // see a KERNEL change, so without this a pre-v0.119 run of a design that
    // carries a nozzle would be written as that configuration's current result.
    const unstamped = { ...RUN, nozzleStamp: undefined } as unknown as SimRun;
    expect(ids({ runs: [unstamped], hasNozzle: true })).toEqual([]);
    // ...and is fine when the design has no nozzle for the term to apply to.
    expect(ids({ runs: [unstamped], hasNozzle: false })).toEqual(['c1']);
  });

  it('refuses a run whose MOTOR SET no longer matches', () => {
    expect(ids({ motorSetKeyOf: () => 'set-B' })).toEqual([]);
  });

  it('refuses a run whose configuration no longer exists', () => {
    expect(ids({ savedConfigs: [] })).toEqual([]);
  });

  it('refuses a run with no configuration id at all', () => {
    const loose = { ...RUN, flightConfigId: undefined } as unknown as SimRun;
    expect(ids({ runs: [loose] })).toEqual([]);
  });
});

describe('flightDataForExport — the rules that are about OTHER configurations', () => {
  const OTHER: SavedConfig = {
    id: 'c2', name: 'Booster test', isDefault: false, motors: { m1: MOTOR },
  } as unknown as SavedConfig;
  const RUN2 = { ...RUN, id: 'r2', flightConfigId: 'c2' } as SimRun;

  it('exports a NON-active configuration’s stored result too', () => {
    // The user has since switched configurations; the others' results are still
    // theirs to save.
    expect(ids({
      runs: [RUN, RUN2], savedConfigs: [CONFIG, OTHER], activeConfigId: 'c1',
    }).sort()).toEqual(['c1', 'c2']);
  });

  it('charges the hardware term ONLY to the active configuration', () => {
    // A non-active configuration's run keeps matching only if it flew with no
    // hardware — refusal is the safe direction for numbers written into a file.
    const keyOf = (_m: [string, MountMotor][], hw: number) => (hw === 0 ? 'set-A' : 'set-hw');
    expect(ids({
      runs: [RUN, RUN2], savedConfigs: [CONFIG, OTHER], activeConfigId: 'c1',
      motorSetKeyOf: keyOf, hardwareDeltaKg: 0.25,
    })).toEqual(['c2']);
  });

  it('ignores a configuration motor whose mount no longer exists', () => {
    // configSync writes the working set verbatim, so a stored config can hold a
    // stale mount id the run's own key never had. Filtering by the live mounts
    // keeps that from costing the configuration its result.
    const stale = {
      ...OTHER, motors: { m1: MOTOR, gone: MOTOR },
    } as unknown as SavedConfig;
    const keyOf = (m: [string, MountMotor][]) => (m.length === 1 ? 'set-A' : 'set-stale');
    expect(ids({
      runs: [RUN2], savedConfigs: [stale], activeConfigId: 'c1',
      mountIds: ['m1'], motorSetKeyOf: keyOf,
    })).toEqual(['c2']);
  });

  it('takes the NEWEST qualifying run per configuration and ignores older ones', () => {
    const newer = { ...RUN, id: 'r0', maxAltitude: 999 } as SimRun;
    const out = flightDataForExport(base({ runs: [newer, RUN] }));
    expect(Object.keys(out)).toEqual(['c1']);
    expect(out['c1']!.maxAltitude).toBe(999);
  });
});

/**
 * THE DELAY A RUN FLEW (audit 2026-09-22). The motor-set key carries each
 * motor's SPEC delay — the one the file's `<delay>` names — never an auto-delay
 * optimum, which is only known after flying. So an auto-delay run matched its
 * configuration, and its flight went into the file under a delay it never
 * flew. Measured on the starter rocket (classic + Kbf, the default) with an
 * Estes C6 whose spec says 3 s: auto flew 5 s, and the file said the chute
 * opened at 3.81 m/s where the 3 s motor it names deploys at 16.81 m/s.
 */
describe('flightDataForExport — the flown delay must be the one the file names', () => {
  const withDelay = (delay: number): MountMotor =>
    ({ ...MOTOR, spec: { ...MOTOR.spec, ejectionDelay: delay } }) as MountMotor;

  it('refuses a fixed-delay run that flew a delay other than its configuration’s', () => {
    // RUN flew 7 s; the configuration's motor now says 3 s, with the same key.
    expect(ids({ assigned: [['m1', withDelay(3)]] })).toEqual([]);
  });

  it('refuses fixed-delay evidence after the configuration switches to Auto at the same number', () => {
    const auto = { ...MOTOR, meta: { ...MOTOR.meta, autoDelay: true } } as MountMotor;
    expect(ids({ assigned: [['m1', auto]] })).toEqual([]);
  });

  it('checks the complete delay vector independently of the scalar primary', () => {
    const booster = withDelay(0);
    const staged = (primary: string) => ids({
      runs: [{ ...RUN, motorDataKey: motorDataKeyOf([['b', booster], ['m1', MOTOR]]),
        delayResolution: testResolution([['b', booster], ['m1', MOTOR]], [0, 7]),
      }],
      assigned: [['b', booster], ['m1', MOTOR]], mountIds: ['b', 'm1'],
      primaryMountOf: () => primary,
    });
    expect(staged('m1')).toEqual(['c1']);
    expect(staged('b')).toEqual(['c1']);
  });

  it('reads a NON-active configuration against its own motors', () => {
    const other = {
      id: 'c2', name: 'Longer delay', isDefault: false, motors: { m1: withDelay(10) },
    } as unknown as SavedConfig;
    const run2 = { ...RUN, id: 'r2', flightConfigId: 'c2' } as SimRun;
    expect(ids({ runs: [run2], savedConfigs: [CONFIG, other] })).toEqual([]);
    expect(ids({ runs: [{ ...run2, delayS: 10,
      delayResolution: testResolution([['m1', withDelay(10)]], [10]),
    } as SimRun], savedConfigs: [CONFIG, other] })).toEqual(['c2']);
  });

  it('refuses legacy scalar evidence even when it equals the fixed delay', () => {
    expect(ids({ runs: [{ ...RUN, delayResolution: undefined }] })).toEqual([]);
  });

  it('writes a plugged motor’s run — Infinity is the delay it flew and the one the file names', () => {
    const plugged = withDelay(Infinity);
    expect(ids({ runs: [{ ...RUN, delayS: Infinity,
      delayResolution: testResolution([['m1', plugged]], [Infinity]),
    } as SimRun], assigned: [['m1', plugged]] })).toEqual(['c1']);
  });
});

/**
 * AUTO DELAY THROUGH A SAVE (seam review of audit 2026-09-22). Neither a .ork
 * nor a .rkt can hold "Auto (optimal)", and a Save wrote the motor's
 * provisional first-flight delay — 0 s for a motor that lists no numeric
 * delay, which reopened firing at burnout. The delay the Auto primary's newest
 * flight of the design as it stands flew is what the file now names, and the
 * flight data written beside it is that flight's.
 */
describe('R7 Batch identity-independent export', () => {
  it.each([
    { autoDelay: false, identity: '/E22' }, { autoDelay: true, identity: '/E22' },
    { autoDelay: false, identity: 'catalogue-id' }, { autoDelay: true, identity: 'catalogue-id' },
  ])('exports recorded delays and flight data for Auto=$autoDelay identity=$identity, rejecting toggles', ({ autoDelay, identity }) => {
    const motor: MountMotor = { ...MOTOR, spec: { ...MOTOR.spec, designation: 'E22', ejectionDelay: 5 },
      meta: { label: 'E22', manufacturer: 'Acme', autoDelay } };
    const assigned: [string, MountMotor][] = [['m1', motor]];
    const resolution = testResolution(assigned, [autoDelay ? 3 : 5]);
    resolution.mounts[0]!.motorIdentity = identity;
    const run: SimRun = JSON.parse(JSON.stringify({ ...RUN, delayS: autoDelay ? 3 : 5,
      motorSetKey: 'm1:Acme/E22:5:automatic:0', motorDataKey: motorDataKeyOf(assigned),
      motorDataKeys: { m1: motorDataKeyOf(assigned) }, delayResolution: resolution }));
    const before = JSON.stringify(run);
    const state = base({ runs: [run], assigned, motorSetKeyOf,
      savedConfigs: [{ ...CONFIG, motors: { m1: motor } }] });
    const flown = flownAutoDelays(state);
    expect(flown).toEqual(autoDelay ? { c1: { m1: 3 } } : {});
    expect(Object.keys(flightDataForExport(state))).toEqual(['c1']);
    const tree = { components: [{ type: 'stage' as const, id: 'stage', children: [
      { type: 'bodytube' as const, id: 'm1', motorMount: true, length: 0.3, outerRadius: 0.02, thickness: 0.001 },
    ] }] };
    const motors = orkMotorSet({ records: { m1: motor }, refs: {}, tree, flown, configKey: 'c1',
      exLibrary: () => [], first: 'records' });
    const xml = exportOrk({ name: 'Historical Batch', tree, launch: DEFAULT_CONDITIONS, motors,
      configs: [{ ...CONFIG, motors }], activeConfigId: 'c1', flightData: flightDataForExport(state) });
    expect(Object.values(importOrk(xml).configs[0]!.motors).map(m => m.delay)).toEqual([autoDelay ? 3 : 5]);
    expect(xml).toContain('<flightdata');
    expect(JSON.stringify(run)).toBe(before);
    const toggled = { ...motor, meta: { ...motor.meta, autoDelay: !autoDelay } };
    const changed = { ...state, assigned: [['m1', toggled]] as [string, MountMotor][] };
    expect(flownAutoDelays(changed)).toEqual({});
    expect(flightDataForExport(changed)).toEqual({});
    const badFingerprint = { ...state, runs: [{ ...run, motorDataKeys: { m1: 'different-curve' } }] };
    expect(flownAutoDelays(badFingerprint)).toEqual({});
    expect(flightDataForExport(badFingerprint)).toEqual({});
  });
});

describe('flownAutoDelays - complete settled vectors', () => {
  const auto = { ...MOTOR, meta: { ...MOTOR.meta, autoDelay: true } } as MountMotor;
  const assigned: [string, MountMotor][] = [['m1', auto], ['side', auto]];
  const run = (delays = [7, 4]): SimRun => ({ ...RUN, motorDataKey: motorDataKeyOf(assigned), delayS: delays[0]!, delayResolution: testResolution(assigned, delays) });
  const input = (over: Partial<FlightDataForExportInput> = {}) => base({
    assigned, mountIds: ['m1', 'side'], runs: [run()], ...over,
  });
  it.each(['create', 'delete', 'create-from-active', 'delete-then-create'] as const)(
    'keeps the flown Auto delay through %s and save without reassigning results', (action) => {
    const tree = { name: 'Auto ownership', components: [{ type: 'stage' as const, id: 'stage', children:
      ['m1', 'side'].map(id => ({ type: 'bodytube' as const, id, motorMount: true,
        length: 0.3, outerRadius: 0.02, thickness: 0.001 })) }] };
    const motors = Object.fromEntries(assigned);
    const history = [{ ...run(), motorSetKey: motorSetKeyOf(assigned, 0), flightConfigId: action === 'create' ? undefined : 'c1' }];
    const before = structuredClone(history);
    const originalMotors = action === 'create-from-active'
      ? { ...motors, m1: { ...auto, spec: { ...auto.spec, designation: 'Old motor' } } } : motors;
    const original = { savedConfigs: [{ ...CONFIG, motors: originalMotors }], activeConfigId: 'c1' };
    const deleted = deleteConfig(original.savedConfigs, 'c1', 'c1');
    const next = action === 'delete' ? deleted
      : createLoadedConfig({ tree, mountMotors: motors, unmatchedRefs: {},
        ...(action === 'create-from-active' ? original : deleted) })!;
    const state = input({ ...next, runs: history, motorSetKeyOf });
    const key = next.activeConfigId ?? '';
    const flown = flownAutoDelays(state);
    expect(flown).toEqual({ [key]: { m1: 7, side: 4 } });
    expect(history).toEqual(before);
    expect(flightDataForExport(state)).toEqual({});
    const map = (records: Record<string, MountMotor>, configKey: string) => orkMotorSet({ records,
      refs: {}, tree, flown, configKey, exLibrary: () => [], first: 'records' });
    const xml = exportOrk({ name: tree.name, tree, launch: DEFAULT_CONDITIONS,
      motors: map(motors, key), configs: next.savedConfigs.map(c => ({ ...c, motors: map(c.motors, c.id) })),
      activeConfigId: next.activeConfigId, flightData: flightDataForExport(state) });
    const reopened = importOrk(xml);
    expect(Object.values(reopened.configs.find(c => c.isDefault)!.motors).map(m => m.delay)).toEqual([7, 4]);
    if (action === 'create-from-active') {
      expect(next.savedConfigs[0]!.motors).toBe(originalMotors);
      expect(Object.values(reopened.configs.find(c => c.id === 'c1')!.motors).map(m => m.designation))
        .toContain('Old motor');
    }
    expect(xml).not.toContain('<flightdata');
    for (const changed of [
      { designKey: 'edited' }, { conditionsKey: 'edited' }, { motorSetKeyOf: () => 'edited' },
      { runs: [{ ...history[0]!, motorDataKey: 'edited' }] },
      { runs: [{ ...history[0]!, nozzleStamp: undefined }], hasNozzle: true },
      { model: { aeroMode: 'classic' as const, effectiveKbf: false, autoSupersonic: false } },
      { runs: [{ ...history[0]!, delayResolution: testResolution(assigned.slice(0, 1), [7]) }] },
    ]) expect(flownAutoDelays({ ...state, ...changed })).toEqual({});
  });

  it('does not count another configuration’s different motor set for the active configuration', () => {
    const other: [string, MountMotor][] = assigned.map(([id, mm]) =>
      [id, { ...mm, spec: { ...mm.spec, designation: 'Different motor' } }]);
    const state = input({ assigned: other, activeConfigId: 'C', motorSetKeyOf,
      runs: [{ ...run(), motorSetKey: motorSetKeyOf(assigned, 0) }], savedConfigs: [
      { ...CONFIG, motors: Object.fromEntries(assigned) },
      { ...CONFIG, id: 'C', motors: Object.fromEntries(other) },
    ] });
    expect(flownAutoDelays(state)).toEqual({ c1: { m1: 7, side: 4 } });
    expect(flightDataForExport(state)['C']).toBeUndefined();
    // Even legacy runs without the curve-data key must pass the motor-set guard.
    expect(flownAutoDelays({ ...state, runs: [{ ...run(), motorDataKey: undefined }],
      motorSetKeyOf: motors => motors[0]?.[1].spec.designation === auto.spec.designation ? 'set-A' : 'set-C',
    })).toEqual({ c1: { m1: 7, side: 4 } });
  });

  it('keeps original Auto evidence and selects the newest matching run independently for each id', () => {
    const state = input({ activeConfigId: 'C', savedConfigs: [
      { ...CONFIG, motors: Object.fromEntries(assigned) },
      { ...CONFIG, id: 'C', motors: Object.fromEntries(assigned) },
    ] });
    expect(flownAutoDelays(state)).toEqual({ c1: { m1: 7, side: 4 }, C: { m1: 7, side: 4 } });
    expect(Object.keys(flightDataForExport(state))).toEqual(['c1']);
    const newer = { ...run([8, 6]), id: 'newer', flightConfigId: 'C' };
    expect(flownAutoDelays({ ...state, runs: [newer, run()] }))
      .toEqual({ C: { m1: 8, side: 6 }, c1: { m1: 7, side: 4 } });
  });
  it('uses every Auto mount from one complete qualifying run, including prototype-key mount IDs', () => {
    expect(flownAutoDelays(input())).toEqual({ c1: { m1: 7, side: 4 } });
    expect(Object.keys(flightDataForExport(input()))).toEqual(['c1']);
    const proto: [string, MountMotor][] = [['constructor', auto]];
    expect(flownAutoDelays(input({ assigned: proto, mountIds: ['constructor'],
      runs: [{ ...RUN, motorDataKey: motorDataKeyOf(proto), delayResolution: testResolution(proto, [7]) }] }))).toEqual({ c1: { constructor: 7 } });
  });
  it('does not assemble partial vectors from unrelated flights or accept old scalar evidence', () => {
    const partial = run(); partial.delayResolution!.mounts.pop();
    const other = run(); other.delayResolution!.mounts.shift();
    expect(flownAutoDelays(input({ runs: [partial, other, RUN] }))).toEqual({});
    expect(flightDataForExport(input({ runs: [partial, other, RUN] }))).toEqual({});
    expect(flownAutoDelays(input({ runs: [partial, run()] }))).toEqual({ c1: { m1: 7, side: 4 } });
  });
  it('compares every exported delay, not only the primary', () => {
    const newer = run([7, 6]); newer.id = 'new'; newer.maxAltitude = 2000;
    const old = run(); old.maxAltitude = 1000;
    expect(flownAutoDelays(input({ runs: [newer, old] }))).toEqual({ c1: { m1: 7, side: 6 } });
    expect(flightDataForExport(input({ runs: [newer, old] }))['c1']!.maxAltitude).toBe(2000);
  });
  it('rejects changed policy, motors, manual neighbours and malformed evidence', () => {
    const fixed: [string, MountMotor][] = [['m1', auto], ['side', MOTOR]];
    const r = { ...RUN, motorDataKey: motorDataKeyOf(fixed), delayResolution: testResolution(fixed, [7, 7]) };
    expect(flownAutoDelays(input({ assigned: fixed, runs: [r] }))).toEqual({ c1: { m1: 7 } });
    expect(flownAutoDelays(input({ runs: [r] }))).toEqual({});
    expect(flownAutoDelays(input({ designKey: 'other' }))).toEqual({});
    expect(flownAutoDelays(input({ motorSetKeyOf: () => 'other' }))).toEqual({});
    expect(flownAutoDelays(input({ runs: [{ ...r, delayResolution: { bad: true } } as unknown as SimRun] }))).toEqual({});
  });
  it('supports inactive and configuration-less flights with the same complete-vector checks', () => {
    const saved = { ...CONFIG, motors: Object.fromEntries(assigned) };
    expect(flownAutoDelays(input({ assigned: [], activeConfigId: 'other', savedConfigs: [saved] })))
      .toEqual({ c1: { m1: 7, side: 4 } });
    expect(flownAutoDelays(input({ activeConfigId: null, savedConfigs: [], runs: [{ ...run(), flightConfigId: undefined }] })))
      .toEqual({ '': { m1: 7, side: 4 } });
  });

  /**
   * BESIDE A MOTOR THE BUILD REFUSED (verifier's review of audit 2026-09-30).
   * Launch leaves a refused motor off the rocket and stores the vector of the
   * mounts it flew (flightRunner.installedMounts). That vector was checked
   * against every motor of the configuration, one mount more than it holds,
   * so the Auto delay a Save, a .rkt or a share link wrote stayed provisional,
   * under a note to "Launch, then save" that no Launch could satisfy.
   */
  describe('beside a motor the build refused', () => {
    const withPod: [string, MountMotor][] = [...assigned, ['pod', MOTOR]];
    const refused = (over: Partial<FlightDataForExportInput> = {}) => input({
      runs: [{ ...run(), motorDataKey: motorDataKeyOf(withPod) }],
      assigned: withPod, mountIds: ['m1', 'side', 'pod'], refusedMountIds: ['pod'], ...over,
    });
    it.each(['build', 'ignition'] as const)('R7 refused %s fixed-to-Auto toggle rejects the whole export vector', (reason) => {
      const pod = reason === 'build' ? MOTOR
        : { ...MOTOR, ignition: { event: 'sideways', delay: 0 } } as unknown as MountMotor;
      const motors: [string, MountMotor][] = [...assigned, ['pod', pod]];
      const matchInput = { physicsKey: 'refused-pod', assigned: motors,
        refusedMountIds: reason === 'build' ? ['pod'] : [], hardwareDeltaKg: 0,
        launch: DEFAULT_CONDITIONS, aeroMode: 'supersonic' as const,
        effectiveKbf: true, autoSupersonic: false, hasNozzle: false };
      const key = designMatchKeyOf(matchInput);
      const saved = { ...run(), designKey: key.designKey, conditionsKey: key.conditionsKey,
        motorSetKey: key.motorSetKey, motorDataKey: key.motorDataKey };
      const toggled: [string, MountMotor][] = [...assigned,
        ['pod', { ...pod, meta: { ...pod.meta, autoDelay: true } }]];
      expect(runMatchesDesign(saved, key)).toBe(true);
      expect(runMatchesDesign(saved, designMatchKeyOf({ ...matchInput, assigned: toggled }))).toBe(false);
      for (const activeConfigId of ['c1', null]) {
        const state = refused({ assigned: motors, refusedMountIds: matchInput.refusedMountIds,
          activeConfigId, savedConfigs: activeConfigId ? [{ ...CONFIG, motors: Object.fromEntries(motors) }] : [],
          runs: [{ ...saved, flightConfigId: activeConfigId ?? undefined }],
          designKey: key.designKey, conditionsKey: key.conditionsKey, motorSetKeyOf });
        // Refused fixed neighbours still allow ALL installed Auto delays to export.
        expect(flownAutoDelays(state)).toEqual({ [activeConfigId ?? '']: { m1: 7, side: 4 } });
        // Summary export has the additional requirement that every named motor flew.
        expect(flightDataForExport(state)).toEqual({});
        const changed = { ...state, assigned: toggled };
        expect(flownAutoDelays(changed)).toEqual({});
        expect(flightDataForExport(changed)).toEqual({});
        expect(flownAutoDelays(state)).toEqual({ [activeConfigId ?? '']: { m1: 7, side: 4 } });
      }
    });
    it('reads the run of the mounts that flew', () => {
      expect(flownAutoDelays(refused())).toEqual({ c1: { m1: 7, side: 4 } });
      // A design with no configurations: the working set, which App built, likewise.
      expect(flownAutoDelays(refused({ activeConfigId: null, savedConfigs: [], runs: [{ ...run(), motorDataKey: motorDataKeyOf(withPod), flightConfigId: undefined }] })))
        .toEqual({ '': { m1: 7, side: 4 } });
      // Only the refusal leaves a mount out: without it the vector is a mount short.
      expect(flownAutoDelays(refused({ refusedMountIds: [] }))).toEqual({});
    });
    it('but writes no flight data for it: the file names the refused motor, and that flight did not carry it', () => {
      // Desktop OpenRocket would show that flight as the result of a
      // configuration with the motor in it. An absent number is the honest one.
      expect(flightDataForExport(refused())).toEqual({});
    });
    it('knows the refusals of the ACTIVE configuration only, the one App built', () => {
      // Another configuration's motors were never built here, so a kernel
      // refusal among them is not known: its run stays unread, the safe direction.
      const saved = { ...CONFIG, motors: Object.fromEntries(withPod) };
      expect(flownAutoDelays(refused({ assigned: [], activeConfigId: 'other', savedConfigs: [saved] }))).toEqual({});
    });
    it('and leaves out an ignition event the kernel does not know in any configuration: the motor set names it', () => {
      const unknown = { ...MOTOR, ignition: { event: 'sideways', delay: 0 } } as unknown as MountMotor;
      const saved = { ...CONFIG, motors: Object.fromEntries([...assigned, ['pod', unknown]]) };
      expect(flownAutoDelays(refused({ assigned: [], activeConfigId: 'other', savedConfigs: [saved], refusedMountIds: [] })))
        .toEqual({ c1: { m1: 7, side: 4 } });
    });
  });
});

it('refuses stale motor physics in new flight data and Auto delays', () => {
  for (const motorDataKey of ['', 'an older curve']) {
    const run = { ...RUN, motorDataKey };
    expect(flightDataForExport(base({ runs: [run] }))).toEqual({});
    const auto = { ...MOTOR, meta: { ...MOTOR.meta, autoDelay: true } } as MountMotor;
    const assigned: [string, MountMotor][] = [['m1', auto]];
    const autoRun = { ...run, delayResolution: testResolution(assigned, [7]) };
    expect(flownAutoDelays(base({ assigned, runs: [autoRun] }))).toEqual({});
  }
});

it('keeps legacy flight data and Auto delays without a motor-data key', () => {
  const legacy = { ...RUN };
  delete legacy.motorDataKey;
  expect(flightDataForExport(base({ runs: [legacy] }))).toEqual(flightDataForExport(base()));
  expect(flightDataForExport(base({ runs: [legacy] })).c1).toBeDefined();
  const auto = { ...MOTOR, meta: { ...MOTOR.meta, autoDelay: true } } as MountMotor;
  const assigned: [string, MountMotor][] = [['m1', auto]];
  const autoRun = { ...legacy, delayResolution: testResolution(assigned, [7]) };
  expect(flownAutoDelays(base({ assigned, runs: [autoRun] }))).toEqual({ c1: { m1: 7 } });
  expect(flightDataForExport(base({ assigned, runs: [autoRun] })).c1).toBeDefined();
});
