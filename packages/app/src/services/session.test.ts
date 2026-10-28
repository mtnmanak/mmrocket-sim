// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushSession,
  discardSession,
  loadSession,
  peekSession,
  onSessionSaveStateChange,
  saveSessionDebounced,
  sessionPredatesThisBuild,
  sessionSaveFailing,
} from './session.js';
import { APP_VERSION } from '../version.js';
import type { MotorSpec, RocketTree } from '@online-openrocket/engine';
import { kernelSimOptions, type LaunchConditions } from '../components/LaunchPanel.js';
import { conditionsKeyOf } from './simReport.js';
import type { MountMotor } from '../model/design.js';
import { designFingerprint, isDirty, type DesignSnapshot } from './dirtyState.js';
import { findDbMotor } from './motorDb.js';
import { mountMotorFromDb } from './motorMatch.js';
import { autosavedDesignFile } from './autosaveBackup.js';
import { designStateFromSession } from './sessionRestore.js';
import { defaultTree, findNode, motorMounts, normalizeTree } from '../tree/treeModel.js';
import { exToDbEntry, exToMotorSpec, loadExMotorIdentities, type ExMotor } from './exMotors.js';
import { exportConfigs, exportMotorsMap } from './exportAssembly.js';
import { assignedMotorsOf } from './designDerivation.js';
import { exportOrk } from './orkFile.js';
import type { SessionState } from './session.js';
import { MAX_STORED_WARNINGS } from './storedWarnings.js';
import { tierLines } from './importNotes.js';

const restoreTier = (restored: ReturnType<typeof designStateFromSession>, text: string) =>
  tierLines(restored.restoreNotes, restored.restoreNoteTiers).find(note => note.text === text)?.tier;

/** Minimal but loadSession-valid state — the save path never inspects more. */
const state = () => ({
  tree: { name: 'Test', components: [] } as RocketTree,
  launch: {
    launchRodLengthM: 1,
    launchRodAngleDeg: 0,
    windAverage: 2,
    windStdDev: 0.2,
    launchAltitudeM: 0,
    temperatureC: null,
    pressureHPa: null,
    latitudeDeg: 45,
  } as LaunchConditions,
});

describe('closure lane persisted records', () => {
  beforeEach(() => discardSession());
  it.each([7, {}, { toString: 0 }] as unknown[])('repairs unreadable rocket and part names on restore: %j', name => {
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(),
      tree: { name, components: [{ type: 'stage', name, id: 's' }] } }));
    const restored = designStateFromSession(loadSession(), { legacyMaxMotorLengthM: null });
    expect(typeof restored.state.tree.name).toBe('string');
    expect(restored.state.tree.components[0]?.name).not.toEqual(name);
    expect(restored.restoreNotes.join(' ')).toContain('name');
    expect(restored.restoreNoteTiers.some(n => n.tier === 'caution')).toBe(true);
  });
  it.each([{ name: 7 }, { name: {} }, { name: 'Good', motorLoadoutRefusal: {} }])('removes unreadable configuration text: %j', fields => {
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), activeConfigId: 'c',
      savedConfigs: [{ id: 'c', motors: {}, ...fields }] }));
    const loaded = loadSession()!;
    expect(loaded.savedConfigs).toEqual([]);
    expect(loaded.treeRestoreNotes?.join(' ')).toContain('configurations were removed');
    expect(() => designStateFromSession(loaded, { legacyMaxMotorLengthM: null })).not.toThrow();
  });
  it.each([[null], {}, [{ name: 'Bad', configId: 7, data: {} }]])('removes unreadable imported summary records: %j', storedSimulations => {
    const good = { name: 'Good', configId: null, data: { maxAltitude: 100 } };
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(),
      importedDocument: { name: 'Imported', storedSimulations: Array.isArray(storedSimulations) ? [...storedSimulations, good] : storedSimulations } }));
    const loaded = loadSession()!;
    expect(loaded.importedDocument?.storedSimulations).toEqual(Array.isArray(storedSimulations) ? [good] : []);
    expect(loaded.treeRestoreNotes?.join(' ')).toContain('simulation');
  });
  it.each([{ massKg: '0x10', cgM: 0.5 }, {}, { massKg: true, cgM: {} }])('repairs unreadable measured figures: %j', measured => {
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), measured }));
    const loaded = loadSession()!;
    expect(loaded.measured).toEqual({ massKg: null, cgM: measured.cgM === 0.5 ? 0.5 : null });
    expect(loaded.treeRestoreNotes?.join(' ')).toContain('measurement');
  });
  it.each(['motorId', 'exMotorId', 'designation'])('removes unreadable legacy inline motor %s', key => {
    const motor = { designation: 'C6', ejectionDelay: 5, ...(key === 'designation' ? { designation: 7 } : {}) };
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), motor, motorMeta: { [key]: 7 } }));
    const loaded = loadSession()!;
    expect(loaded.motor).toBeUndefined();
    expect(loaded.treeRestoreNotes?.join(' ')).toContain('motor records were removed');
    expect(() => designStateFromSession(loaded, { legacyMaxMotorLengthM: null })).not.toThrow();
  });
  it('revives writer-encoded plugged delay options in both motor sets', () => {
    const motor = { label: 'Test', spec: { designation: 'Test', ejectionDelay: 'Infinity' },
      meta: { availableDelays: [3, 'Infinity'] } };
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), mountMotors: { m: motor },
      savedConfigs: [{ id: 'c', name: 'C', motors: { m: motor } }] }));
    const loaded = loadSession()!;
    expect(loaded.mountMotors?.m?.meta.availableDelays).toEqual([3, Infinity]);
    expect(loaded.savedConfigs![0]!.motors.m?.meta.availableDelays).toEqual([3, Infinity]);
  });
  it.each([
    ['availableDelays', '3,5'], ['availableDelays', 5], ['availableDelays', [3, '5']],
    ['availableDelays', [null]], ['orkType', 5], ['orkManufacturer', {}], ['orkDigest', true],
  ])('removes unreadable motor metadata %s=%j in both sets', (key, value) => {
    const motor = { label: 'Test', spec: { designation: 'Test', ejectionDelay: 5 }, meta: { [key as string]: value } };
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), mountMotors: { m: motor },
      savedConfigs: [{ id: 'c', name: 'C', motors: { m: motor } }] }));
    const loaded = loadSession()!;
    expect(loaded.mountMotors).toEqual({});
    expect(loaded.savedConfigs![0]!.motors).toEqual({});
    expect(loaded.treeRestoreNotes?.join(' ')).toContain('motor records were removed');
  });
  it.each([
    { type: 'freeformfinset', points: [[0, 0], [0.05, '0.02'], [0.1, 0]] },
    { type: 7 },
    { type: 'bodytube', length: -1 },
  ])('offers exact raw recovery bytes after tree normalization repairs %j', part => {
    const raw = JSON.stringify({ ...state(), tree: { name: 'Repair', components: [
      { type: 'stage', id: 's', children: [{ type: 'bodytube', id: 'b', length: 0.2, children: [part] }] },
    ] } });
    localStorage.setItem('online-openrocket.session.v1', raw);
    const recovered = autosavedDesignFile()!;
    expect(recovered.ork).toBe(false);
    expect(recovered.data).toBe(raw);
  });
  it('preserves finite signed imported unmatched references in both sets', () => {
    const ref = { designation: 'Missing', diameter: -0.02, length: -0.1, ignitionDelay: -1 };
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), configLayers: 1,
      unmatchedRefs: { m: ref }, savedConfigs: [{ id: 'c', name: 'C', motors: {}, unmatchedRefs: { m: ref } }] }));
    const loaded = loadSession()!;
    expect(loaded.unmatchedRefs?.m).toEqual(ref);
    expect(loaded.savedConfigs?.[0]?.unmatchedRefs?.m).toEqual(ref);
    expect(loaded.treeRestoreNotes ?? []).toEqual([]);
  });
  it('revives plugged unmatched references in the working and saved configurations', () => {
    const ref = { designation: 'Missing', delay: 'Infinity' };
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), configLayers: 1,
      unmatchedRefs: { m: ref }, savedConfigs: [{ id: 'c', name: 'C', motors: {}, unmatchedRefs: { m: ref } }] }));
    const loaded = loadSession()!;
    expect(loaded.unmatchedRefs?.m?.delay).toBe(Infinity);
    expect(loaded.savedConfigs?.[0]?.unmatchedRefs?.m?.delay).toBe(Infinity);
  });
  it.each(['motorId', 'exMotorId', 'designation'])('removes unreadable motor %s scalars in both sets', key => {
    const motor = { label: 'Test', spec: { designation: 'Test', ejectionDelay: 5 }, meta: {}, ignition: { event: 'automatic', delay: 0 } };
    Object.assign(key === 'designation' ? motor.spec : motor.meta, { [key]: 7 });
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), mountMotors: { m: motor },
      savedConfigs: [{ id: 'c', name: 'C', motors: { m: motor } }] }));
    const loaded = loadSession()!;
    expect(loaded.mountMotors).toEqual({});
    expect(loaded.savedConfigs![0]!.motors).toEqual({});
    expect(loaded.treeRestoreNotes?.join(' ')).toMatch(/motor records were removed/);
  });
  it.each([undefined, 1])('removes malformed references before migration (layers %s)', configLayers => {
    const ref = { designation: 'Missing', manufacturer: 'Other', diameter: 0.02, length: 0.1, delay: 5 };
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), configLayers,
      unmatchedRefs: { null: null, bad: { ...ref, ignitionDelay: 'abc' }, good: ref },
      savedConfigs: [{ id: 'c', name: 'C', motors: {}, unmatchedRefs: { bad: null, good: ref } }] }));
    const loaded = loadSession()!;
    expect(Object.keys(loaded.unmatchedRefs!)).toEqual(['good']);
    expect(Object.keys(loaded.savedConfigs![0]!.unmatchedRefs!)).toEqual(['good']);
    expect(loaded.treeRestoreNotes?.join(' ')).toMatch(/motor references were removed/);
    expect(() => designStateFromSession(loaded, { legacyMaxMotorLengthM: null })).not.toThrow();
  });
  it.each(['motor', 'configuration'])('offers raw recovery bytes when the loader removed a %s', kind => {
    const raw = JSON.stringify({ ...state(), mountMotors: kind === 'motor' ? {
      m: { label: 'C6', spec: { designation: 'C6' }, meta: {}, padMassWeighedWith: true },
    } : {}, savedConfigs: kind === 'configuration' ? [{ id: 'c', motors: {}, nozzles: [] }] : [] });
    localStorage.setItem('online-openrocket.session.v1', raw);
    const recovery = autosavedDesignFile()!;
    expect(recovery.ork).toBe(false);
    expect(recovery.data).toBe(raw);
  });
});

it('repairs oversized saved nozzle diameters before a configuration switch', async () => {
  const { MAX_DIMENSION_M } = await import('../tree/schema.js');
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), nozzleModeVersion: 1,
    savedConfigs: [{ id: 'B', motors: {}, nozzles: { s: MAX_DIMENSION_M * 2 } }] }));
  const s = loadSession()!;
  expect(s.savedConfigs![0]!.nozzles!.s).toBe(MAX_DIMENSION_M);
  expect(s.treeRestoreNotes?.join(' ')).toContain('Saved configuration No motors:');
});

it('bounds saved and restored session warnings', () => {
  localStorage.clear();
  const warnings = Array.from({ length: MAX_STORED_WARNINGS + 1 }, () => ({ key: 'Joint', message: 'Gap' }));
  const abort = { key: 'SIM_ABORT', message: 'Stopped', priority: 'HIGH' as const };
  const snapshot = { ...state(), importedDocument: { name: 'Imported', storedSimulations: [{ name: 'Flight', configId: null, data: { simWarnings: [...warnings, abort] } }] } };
  // The warning reviver covers stored summaries anywhere in the session.
  saveSessionDebounced(snapshot as unknown as Parameters<typeof saveSessionDebounced>[0]);
  flushSession();
  const raw = JSON.parse(localStorage.getItem('online-openrocket.session.v1')!);
  expect(raw.importedDocument.storedSimulations[0].data.simWarnings).toEqual([abort, expect.objectContaining({ key: 'StoredWarningsUnavailable' })]);
  for (const restored of [loadSession(), peekSession()]) {
    expect(restored?.importedDocument?.storedSimulations?.[0]?.data.simWarnings)
      .toEqual([abort, expect.objectContaining({ key: 'StoredWarningsUnavailable' })]);
  }
});

describe('audit 2026-10-11 persisted state', () => {
  it.each(['stageMassOverrides', 'nozzles', 'deployments', 'separations', 'ignitions'])(
    'S7a-g1 retains a pre-v0.160 motorless configuration owning %s', family => {
      const values = { stageMassOverrides: { s: { overrideMass: 2.5 } }, nozzles: { s: 0.01 },
        deployments: { chute: { deployEvent: 'apogee', deployAltitude: 200, deployDelay: 0 } },
        separations: { s: { separationEvent: 'never', separationDelay: 0, separationAltitude: 200 } },
        ignitions: { m: { event: 'never', delay: 0 } } };
      const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [{ type: 'bodytube', id: 'm' }] }] };
      localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), tree,
        savedConfigs: [{ id: 'c', name: null, motors: {}, [family]: values[family as keyof typeof values] }] }));
      const restored = designStateFromSession(loadSession(), { legacyMaxMotorLengthM: null });
      expect(restored.state.savedConfigs).toHaveLength(1);
    },
  );
  it.each([true, 7, {}, []])('S1d-b1 removes motor records with an unreadable weighing identity (%j)', padMassWeighedWith => {
    const bad = { label: 'Test', spec: { designation: 'Test', ejectionDelay: 5 }, meta: {},
      ignition: { event: 'automatic', delay: 0 }, padMassKg: 1, padMassWeighedWith };
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(),
      mountMotors: { bad }, savedConfigs: [{ id: 'c', name: 'C', motors: { bad } }] }));
    const loaded = loadSession()!;
    expect(loaded.mountMotors).toEqual({});
    expect(loaded.savedConfigs![0]!.motors).toEqual({});
    const restored = designStateFromSession(loaded, { legacyMaxMotorLengthM: null });
    expect(restoreTier(restored, 'Unreadable motor records were removed.')).toBe('caution');
  });

  it.each([undefined, 1])('S7d-g1 restores malformed flight tuples with configLayers %s', configLayers => {
    const bad = { label: 'Test', spec: { designation: 'Test', ejectionDelay: 5 }, meta: {} };
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), configLayers,
      tree: { ...state().tree, ignitionDefaults: { m: true } }, mountMotors: { m: bad },
      detachedOverrides: { ignitions: { m: false }, deployments: { chute: { deployEvent: 3 } } },
      savedConfigs: [{ id: 'c', name: 'C', motors: { m: bad }, separations: { s: { separationEvent: false } } }] }));
    const loaded = loadSession()!;
    expect(loaded).not.toBeNull();
    expect(loaded.mountMotors!.m!.ignition).toEqual({ event: 'automatic', delay: 0 });
    expect(loaded.tree.ignitionDefaults).toEqual({});
    expect(loaded.detachedOverrides).toEqual({ ignitions: {}, deployments: {} });
    const restored = designStateFromSession(loaded, { legacyMaxMotorLengthM: null });
    expect(restored.restoreNoteTiers).toContainEqual(expect.objectContaining({ tier: 'caution', kind: 'G04.flight-settings-repaired' }));
  });
  it.each([null, {}, 5, [null, false, []]].map(v => [v]))('S1d-2 keeps the design when configurations are malformed (%j)', savedConfigs => {
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), savedConfigs }));
    const loaded = loadSession();
    expect(loaded?.tree).toEqual(state().tree);
    expect(loaded?.savedConfigs ?? []).toEqual([]);
    expect(loaded?.treeRestoreNotes?.join(' ')).toContain('configuration');
  });

  it('S1d-2 retains readable configuration siblings', () => {
    const cfg = { id: 'kept', name: 'Kept', motors: {} };
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), savedConfigs: [null, cfg] }));
    expect(loadSession()?.savedConfigs).toEqual([cfg]);
  });

  const unreadableConfigs = [
    {},
    { name: 'Bad', motors: {} },
    ...[null, 7, {}, []].map(id => ({ id, name: 'Bad', motors: {} })),
    { id: 'bad', name: 'Bad' },
    ...['motors', 'unmatchedRefs', 'deployments', 'separations', 'ignitions', 'nozzles',
      'stageActiveness', 'stageMassOverrides'].flatMap(key =>
      [null, false, 7, 'bad', []].map(value => ({ id: 'bad', name: 'Bad', motors: {}, [key]: value }))),
  ];

  it.each(unreadableConfigs)('S1d-2 restores valid siblings through App with unreadable configuration %j', bad => {
    const kept = { id: 'kept', name: 'Kept', motors: {} };
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({
      ...state(), savedConfigs: [null, bad, kept], activeConfigId: 'kept',
    }));
    const loaded = loadSession();
    expect(loaded).not.toBeNull();
    const restored = designStateFromSession(loaded, { legacyMaxMotorLengthM: null });
    expect(restored.state.savedConfigs).toEqual([{ ...kept, deployments: {}, separations: {}, ignitions: {} }]);
    expect(restored.state.activeConfigId).toBe('kept');
    expect(restored.state.tree.name).toBe('Test');
    expect(restored.state.launch).toEqual(state().launch);
    expect(restored.restoreNotes.join(' ')).toContain('Unreadable saved configurations were removed.');
  });

  it('S1d-2 restores the design through App when every configuration is unreadable', () => {
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({
      ...state(), savedConfigs: [null, ...unreadableConfigs],
    }));
    const loaded = loadSession();
    expect(loaded).not.toBeNull();
    const restored = designStateFromSession(loaded, { legacyMaxMotorLengthM: null });
    expect(restored.state.savedConfigs).toEqual([]);
    expect(restored.state.tree.name).toBe('Test');
    expect(restored.state.launch).toEqual(state().launch);
    expect(restored.restoreNotes.join(' ')).toContain('Unreadable saved configurations were removed.');
  });

  it('S1d-2 accepts object configuration maps through App without a removal note', () => {
    const kept = { id: 'kept', name: 'Kept', motors: {}, unmatchedRefs: {}, deployments: {},
      separations: {}, nozzles: {}, stageActiveness: {}, stageMassOverrides: {} };
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), savedConfigs: [kept] }));
    const loaded = loadSession();
    expect(loaded).not.toBeNull();
    const restored = designStateFromSession(loaded, { legacyMaxMotorLengthM: null });
    expect(restored.state.savedConfigs).toEqual([{ ...kept, deployments: {}, separations: {}, ignitions: {} }]);
    expect(restored.restoreNotes.join(' ')).not.toContain('Unreadable saved configurations');
  });

  it.each(['x', 1, true, 0, '', false, null, []].map(v => [v]))('S1d-5 restores with empty measurements for %j', measured => {
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), measured }));
    const loaded = loadSession();
    expect(loaded).not.toBeNull();
    expect(loaded?.measured).toBeUndefined();
    expect(designStateFromSession(loaded, { legacyMaxMotorLengthM: null }).state.measured)
      .toEqual({ massKg: null, cgM: null });
  });

  it.each([undefined, '0.070'])('S1d-4 preserves a chosen fine step after one migration (%s)', appVersion => {
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), appVersion,
      launch: { ...state().launch, timeStepS: 0.01 } }));
    const loaded = loadSession()!;
    expect(loaded.launch.timeStepS).toBe(0.05);
    saveSessionDebounced({ ...state(), appVersion: loaded.appVersion,
      launch: { ...loaded.launch, timeStepS: 0.01 } });
    flushSession();
    expect(loadSession()?.launch.timeStepS).toBe(0.01);
    expect(loadSession()?.timeStepWasClamped).not.toBe(true);
  });

  const unreadableMotors = [null, false, 7, 'bad', [], {}, { spec: {} }, { meta: {} }, { spec: null, meta: {} }];

  it.each(unreadableMotors.map(v => [v]))('S1d-2 drops unreadable motor record %j in mountMotors and savedConfigs through designStateFromSession', badMotor => {
    const valid = {
      label: 'C6-5',
      spec: { designation: 'C6', ejectionDelay: 5 },
      meta: { label: 'C6-5', manufacturer: 'Estes' },
      ignition: { event: 'automatic', delay: 0 },
    };
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({
      ...state(),
      mountMotors: { kept: valid, bad: badMotor },
      savedConfigs: [{ id: 'c1', name: 'C1', motors: { kept: valid, bad: badMotor } }],
      activeConfigId: 'c1',
    }));
    const loaded = loadSession();
    expect(loaded).not.toBeNull();
    expect(loaded?.mountMotors).toEqual({ kept: valid });
    expect(loaded?.savedConfigs?.[0]?.motors).toEqual({ kept: valid });
    const restored = designStateFromSession(loaded, { legacyMaxMotorLengthM: null });
    expect(Object.keys(restored.state.mountMotors)).toEqual(['kept']);
    expect(Object.keys(restored.state.savedConfigs[0]!.motors)).toEqual(['kept']);
    expect(restored.restoreNotes.join(' ')).toContain('Unreadable motor records were removed.');
    expect(restoreTier(restored, 'Unreadable motor records were removed.')).toBe('caution');
  });

  it.each([[[null]], ['bad'], [[{ altitude: -1, speed: 5, directionDeg: 0 }]]])('S7b-4 drops unreadable launch.windLevels %j with a caution note', windLevels => {
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({
      ...state(),
      launch: { ...state().launch, windLevels, windProfileSource: 'forecast at launch site' },
    }));
    const loaded = loadSession();
    expect(loaded?.launch.windLevels).toBeUndefined();
    expect(loaded?.launch.windProfileSource).toBeUndefined();
    const restored = designStateFromSession(loaded, { legacyMaxMotorLengthM: null });
    expect(restored.state.launch.windLevels).toBeUndefined();
    expect(restored.state.launch.windProfileSource).toBeUndefined();
    expect(restored.restoreNotes.join(' ')).toContain('Unreadable winds aloft were removed.');
    expect(restoreTier(restored, 'Unreadable winds aloft were removed.')).toBe('caution');
  });

  it.each([0, -1, '0.01', false].map(v => [v]))('S7a-g4 drops non-positive or non-numeric launch.timeStepS (%j) on restore', timeStepS => {
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({
      ...state(),
      appVersion: APP_VERSION,
      launch: { ...state().launch, timeStepS },
    }));
    const loaded = loadSession();
    expect(loaded?.launch.timeStepS).toBeUndefined();
    expect(loaded?.timeStepWasClamped).toBeUndefined();
    const restored = designStateFromSession(loaded, { legacyMaxMotorLengthM: null });
    expect(restoreTier(restored, 'An unreadable time step was reset to the default.')).toBe('caution');
  });

  it.each([undefined, []])('S7b-4 removes an orphaned source with levels %j', windLevels => {
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({
      ...state(), launch: { ...state().launch, windLevels, windProfileSource: { kind: 'ork' } },
    }));
    const restored = designStateFromSession(loadSession(), { legacyMaxMotorLengthM: null });
    expect(restored.state.launch.windProfileSource).toBeUndefined();
    expect(restoreTier(restored, 'Unreadable winds aloft source was removed.')).toBe('caution');
  });

  it('S7b-4 keeps valid levels while removing an unreadable source with a Caution', () => {
    const windLevels = [{ altitude: 0, speed: 2, direction: 0, standardDeviation: 0.2 }];
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({
      ...state(), launch: { ...state().launch, windLevels,
        windProfileSource: { kind: 'open-meteo', place: {}, validUnix: 1, surfaceFromDeg: 0 } },
    }));
    const restored = designStateFromSession(loadSession(), { legacyMaxMotorLengthM: null });
    expect(restored.state.launch.windLevels).toEqual(windLevels);
    expect(restored.state.launch.windProfileSource).toBeUndefined();
    expect(restoreTier(restored, 'Unreadable winds aloft source was removed.')).toBe('caution');
  });

  it('S7a-g4 preserves a blank time step and both saved marks through restore', () => {
    const snapshot: DesignSnapshot = {
      ...designStateFromSession(null, { legacyMaxMotorLengthM: null }).state,
      launch: { ...state().launch, timeStepS: null }, mountMotors: {},
      maxMotorLengthByStage: {}, savedConfigs: [], activeConfigId: null,
      measured: { massKg: null, cgM: null },
    };
    const mark = designFingerprint(snapshot);
    const lossySaved = { mark, flights: 3, format: 'rkt' as const, lossCount: 4 };
    saveSessionDebounced({ ...snapshot, configLayers: 1, savedMark: mark, lossySaved,
      designFile: { name: 'test.rkt', via: 'saved', format: 'rkt' } });
    flushSession();
    const loaded = loadSession()!;
    expect(loaded.launch.timeStepS).toBeNull();
    expect(loaded.lossySaved).toEqual(lossySaved);
    const restored = designStateFromSession(loaded, { legacyMaxMotorLengthM: null });
    expect(isDirty(designFingerprint(restored.state), restored.session?.savedMark ?? null, false)).toBe(false);
  });
});

it.each([{}, { ignitions: { mount: { event: 'launch' as const, delay: 0.4 } } }])('V8/FC-4 round-trips lossy marks with detached overrides %j and drops stale marks', detachedOverrides => {
  const snapshot = { ...state(), detachedOverrides, mountMotors: {}, savedConfigs: [], activeConfigId: null, measured: { massKg: null, cgM: null } };
  const lossySaved = { mark: designFingerprint(snapshot), flights: 3, format: 'rkt' as const, lossCount: 4 };
  const designFile = { name: 'test.rkt', via: 'saved' as const, format: 'rkt' as const };
  saveSessionDebounced({ ...snapshot, lossySaved, designFile }); vi.runAllTimers();
  expect(loadSession()!.lossySaved).toEqual(lossySaved);
  for (const mark of [{ ...lossySaved, mark: 'stale' }, { ...lossySaved, flights: -1 }, { ...lossySaved, lossCount: NaN }]) {
    saveSessionDebounced({ ...snapshot, lossySaved: mark, designFile }); vi.runAllTimers();
    const restored = loadSession()!;
    expect(restored.lossySaved).toBeUndefined();
    expect(restored.designFile).toEqual(designFile);
  }
});

/** Refuse writes the way a full origin does; reads stay real. */
function jamWrites(): void {
  const real = localStorage;
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => real.getItem(k),
    setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); },
    removeItem: (k: string) => real.removeItem(k),
  });
}

/** Queue a save and run out its debounce timer. */
function saveNow(): void {
  saveSessionDebounced(state());
  vi.runAllTimers();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Unstub FIRST, then flush one clean save: the module-level failing flag
  // survives between tests in this file, and a save that sticks resets it.
  vi.unstubAllGlobals();
  saveNow();
  vi.useRealTimers();
  localStorage.clear();
});

describe('storage hardening: session tree', () => {
  it.each(['opened', 'saved', 'downloaded'] as const)('round-trips a design file name (%s)', via => {
    const designFile = { name: 'Mon fusée.ork', via, format: 'ork' as const };
    saveSessionDebounced({ ...state(), designFile });
    flushSession();
    expect(loadSession()?.designFile).toEqual(designFile);
  });

  it.each([null, {}, { name: '', via: 'opened' }, { name: 'file.ork', via: 'other' },
    { name: 'x'.repeat(256), via: 'saved' }])('drops an invalid design file reference (%j)', designFile => {
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), designFile }));
    expect(loadSession()).not.toHaveProperty('designFile');
  });

  const stage = { type: 'stage', id: 'kept', name: 'Sustainer', children: [] };
  const restore = () => designStateFromSession(loadSession(), { legacyMaxMotorLengthM: null });

  it.each([null, 7, 'tree', []].map((v) => [v]))('names a fallback for an unreadable root (%j)', (tree) => {
    const raw = JSON.stringify({ ...state(), tree });
    localStorage.setItem('online-openrocket.session.v1', raw);
    const restored = restore();
    expect(restored.state.tree.name).toBe('My Rocket');
    expect(restored.restoreNotes.join(' ')).toContain('The starter design was opened.');
    expect(peekSession()).toBeNull();
    expect(autosavedDesignFile()).toMatchObject({ ork: false, extension: '.json', data: raw });
    expect(localStorage.getItem('online-openrocket.session.v1')).toBe(raw);
  });

  it.each(['modern', 'legacy'])('detaches the old design from an unreadable root (%s)', (format) => {
    const spec = { designation: 'H100', diameter: 0.029, length: 0.2, cgX: 0.1, ejectionDelay: 10,
      times: [0, 1], thrusts: [0, 0], masses: [0.2, 0.1] };
    const motors = { c4: { label: 'Old motor', spec, meta: { label: 'Old motor' } } };
    const raw = JSON.stringify({ ...state(), tree: null, savedAt: 123, appVersion: APP_VERSION,
      ...(format === 'modern' ? { mountMotors: motors } : { motor: spec, motorLabel: 'Old motor' }),
      mountId: 'c4', activeConfigId: 'old', savedConfigs: [{ id: 'old', motors }],
      unmatchedRefs: { c4: { designation: 'H100' } }, flownAutoDelays: { old: { c4: 5 } },
      measured: { massKg: 10, cgM: 1, padMassKg: 11 }, maxMotorLengthByStage: { c1: 0.5 },
      maxMotorLengthM: 0.5, importedDocument: { name: 'Old flight' }, savedMark: 'old', flownSinceSave: true,
    });
    localStorage.setItem('online-openrocket.session.v1', raw);
    const loaded = loadSession()!;
    expect(Object.keys(loaded).sort()).toEqual([
      'appVersion', 'launch', 'motorLengthLimitsMigrated', 'nozzleModeVersion', 'savedAt', 'tree', 'treeRestoreNotes',
    ]);
    expect(loaded.launch).toEqual(state().launch);
    expect(loaded.savedAt).toBe(123);
    const restored = designStateFromSession(loaded, { legacyMaxMotorLengthM: 0.9 });
    expect(restored.state.mountMotors).toEqual({});
    expect(restored.state.savedConfigs).toEqual([]);
    expect(restored.state.activeConfigId).toBeNull();
    expect(restored.state.unmatchedRefs).toEqual({});
    expect(restored.state.measured).toEqual({ massKg: null, cgM: null });
    expect(restored.preLengthRestore.maxMotorLengthByStage).toEqual({});
    expect(restored.restoreNotes.join(' ')).toContain('motors, configurations, and measurements were not applied.');
    expect(localStorage.getItem('online-openrocket.session.v1')).toBe(raw);
  });

  it.each([null, {}, 'components'].map((v) => [v]))('repairs an unreadable component list (%j)', (components) => {
    const raw = JSON.stringify({ ...state(), tree: { name: 'Kept name', components } });
    localStorage.setItem('online-openrocket.session.v1', raw);
    const restored = restore();
    expect(restored.state.tree.name).toBe('Kept name');
    expect(restored.state.tree.components).toHaveLength(1);
    expect(restored.restoreNotes).toContain('The unreadable component list was removed.');
    expect(localStorage.getItem('online-openrocket.session.v1')).toBe(raw);
  });

  it.each([null, 7, 'node', [], {}, { type: 3 }].map((v) => [v]))('repairs malformed nodes before normalization (%j)', (node) => {
    const raw = JSON.stringify({ ...state(), tree: { components: [node, stage] } });
    localStorage.setItem('online-openrocket.session.v1', raw);
    const restored = restore();
    expect(restored.state.tree.components).toEqual([stage]);
    expect(restored.restoreNotes).toContain('A component that could not be read was removed.');
    expect(localStorage.getItem('online-openrocket.session.v1')).toBe(raw);
  });

  it.each([null, {}, 'children'].map((v) => [v]))('repairs unreadable children (%j)', (children) => {
    const raw = JSON.stringify({ ...state(), tree: { components: [{ ...stage, children }] } });
    localStorage.setItem('online-openrocket.session.v1', raw);
    const restored = restore();
    expect(restored.state.tree.components).toEqual([stage]);
    expect(restored.restoreNotes.join(' ')).toContain('unreadable children were removed');
    expect(localStorage.getItem('online-openrocket.session.v1')).toBe(raw);
  });

  it('removes malformed nested nodes while retaining their siblings', () => {
    const body = { type: 'bodytube', id: 'body', length: 0.3, outerRadius: 0.02, thickness: 0.001 };
    const raw = JSON.stringify({ ...state(), tree: { components: [{ ...stage, children: [null, body] }] } });
    localStorage.setItem('online-openrocket.session.v1', raw);
    const restored = restore();
    expect(restored.state.tree.components[0]!.children).toEqual([body]);
    expect(restored.restoreNotes).toContain('A component that could not be read was removed.');
    expect(localStorage.getItem('online-openrocket.session.v1')).toBe(raw);
  });

  it.each([[null], [[0, 0], null], {}, [[0, null]], [['0', 0]], 'points', null].map((v) => [v]))('repairs malformed fin points (%j)', (points) => {
    const tree = normalizeTree({ components: [{ ...stage, children: [
      { type: 'bodytube', id: 'body', length: 0.3, outerRadius: 0.02, thickness: 0.001, children: [
        { type: 'freeformfinset', id: 'fin', name: 'Airfoil fins', crossSection: 'airfoil', points: [[0, 0], [0.05, 0]] },
      ] },
    ] }] } as RocketTree);
    const expected = structuredClone(tree);
    findNode(expected, 'fin')!['points'] = [[0, 0], [0.025, 0.05], [0.075, 0.05], [0.05, 0]];
    findNode(tree, 'fin')!['points'] = points;
    const raw = JSON.stringify({ ...state(), tree });
    localStorage.setItem('online-openrocket.session.v1', raw);
    const restored = restore();
    expect(restored.state.tree).toEqual({ ...expected, ignitionDefaults: {} });
    expect(restored.restoreNotes.join(' ')).toContain('Fin set "Airfoil fins": its outline was not used');
    expect(restored.restoreNotes.join(' ')).toContain('The set keeps a default outline; redraw it in the fin editor.');
    expect(localStorage.getItem('online-openrocket.session.v1')).toBe(raw);
  });

  it('keeps raw recovery bytes when an exportable fin outline would be replaced', () => {
    const raw = JSON.stringify({ ...state(), tree: { components: [{ ...stage, children: [
      { type: 'freeformfinset', points: [[0, null]] },
    ] }] } });
    localStorage.setItem('online-openrocket.session.v1', raw);
    expect(autosavedDesignFile()).toMatchObject({ extension: '.json', ork: false, data: raw });
    expect(localStorage.getItem('online-openrocket.session.v1')).toBe(raw);
  });

  it('caps depth with a repair note without removing the recovery bytes', () => {
    let node: unknown = { type: 'bodytube' };
    for (let i = 0; i < 130; i++) node = { ...stage, id: 'level-' + i, children: [node] };
    const raw = JSON.stringify({ ...state(), tree: { components: [node] } });
    localStorage.setItem('online-openrocket.session.v1', raw);
    const restored = restore();
    expect(restored.restoreNotes.join(' ')).toContain('children nested beyond 128 levels were removed');
    expect(findNode(restored.state.tree, 'level-0')).toBeNull();
    expect(findNode(restored.state.tree, 'level-1')).not.toBeNull();
    expect(localStorage.getItem('online-openrocket.session.v1')).toBe(raw);
  });

  it('preserves valid rounded and airfoil freeform outlines, including unfinished edits', () => {
    const fins = ['rounded', 'airfoil'].map((crossSection) => ({
      type: 'freeformfinset', crossSection, points: [[0, 0], [-0.01, 0.03], [0.06, 0]],
    })).concat([{ type: 'freeformfinset', crossSection: 'airfoil', points: [] }]);
    const tree = { components: [{ ...stage, children: fins }] };
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), tree }));
    expect(loadSession()?.tree).toEqual(tree);
    const restored = restore();
    expect(restored.state.tree.components[0]!.children).toEqual(fins);
    expect(restored.restoreNotes).toEqual([expect.stringContaining('Reopening the original file')]);
  });
});

describe('empty-configuration marker', () => {
  // Restore drops a dry placeholder only from a session no v0.160+ autosave
  // wrote (sessionRestore); every autosave must therefore carry the marker.
  it('every autosave writes emptyConfigVersion', () => {
    saveNow();
    expect(JSON.parse(localStorage.getItem('online-openrocket.session.v1')!).emptyConfigVersion).toBe(1);
    expect(loadSession()!.emptyConfigVersion).toBe(1);
  });
});

describe('K2 stored stage activeness', () => {
  it('keeps only boolean flags, including unusual string keys, without a repair notice', () => {
    const flags = JSON.parse('{"core":true,"booster":false,"__proto__":false,"constructor":true,"text":"false","number":0,"nil":null,"object":{},"array":[]}') as unknown;
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({
      ...state(), savedConfigs: [{ id: 'cfg', name: null, isDefault: true, motors: {}, stageActiveness: flags }],
    }));
    for (const loaded of [loadSession(), peekSession()]) {
      expect(loaded).not.toBeNull();
      expect(loaded!.savedConfigs![0]!.stageActiveness)
        .toEqual(JSON.parse('{"core":true,"booster":false,"__proto__":false,"constructor":true}'));
      expect(loaded!.treeRestoreNotes ?? []).toEqual([]);
    }
  });

  it.each([null, false, 7, 'false', [false], { bad: 'false' }])('drops corrupt stage activeness %j', (stageActiveness) => {
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({
      ...state(), savedConfigs: [{ id: 'cfg', motors: {}, stageActiveness }, { id: 'legacy', motors: {} }],
    }));
    const loaded = loadSession()!;
    expect(loaded).not.toBeNull();
    if (stageActiveness && typeof stageActiveness === 'object' && !Array.isArray(stageActiveness)) {
      expect(loaded.savedConfigs![0]!.stageActiveness).toEqual({});
      expect(loaded.treeRestoreNotes ?? []).toEqual([]);
    } else {
      // Invalid map shapes now discard the whole configuration (S1d-2 follow-up).
      expect(loaded.savedConfigs).toEqual([{ id: 'legacy', motors: {} }]);
      expect(loaded.treeRestoreNotes?.join(' ')).toContain('Unreadable saved configurations');
    }
    expect(loaded.savedConfigs!.find(c => c.id === 'legacy')).not.toHaveProperty('stageActiveness');
  });
});

describe('session autosave under quota', () => {
  it('migrates legacy configuration zero commands to automatic, but preserves new OFF and tree zero', () => {
    const legacy = { ...state(), savedConfigs: [{ id: 'c', name: 'C', isDefault: true, motors: {}, nozzles: { s: 0, b: 0.02 } }] };
    legacy.tree.components = [{ type: 'stage', id: 's', nozzleExitDiameter: 0 }];
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify(legacy));
    const loaded = loadSession()!;
    expect(loaded.savedConfigs![0]!.nozzles).toEqual({ s: null, b: 0.02 });
    expect(loaded.tree.components[0]!['nozzleExitDiameter']).toBe(0);
    // App does not supply the migration marker; the writer must add it.
    saveSessionDebounced(legacy);
    vi.runAllTimers();
    expect(loadSession()!.savedConfigs![0]!.nozzles).toEqual({ s: 0, b: 0.02 });
  });
  it('preserves separate serial and nested strap-on exits including explicit OFF', () => {
    const current = state();
    current.tree.components = [{ type: 'stage', nozzleExitDiameter: 0, children: [
      { type: 'parallelstage', nozzleExitDiameter: 0.02, children: [
        { type: 'parallelstage', nozzleExitDiameter: 0 },
      ] },
    ] }];
    saveSessionDebounced(current);
    vi.runAllTimers();
    expect(loadSession()?.tree).toEqual(current.tree);
  });
  it('saves after the debounce and reports healthy', () => {
    saveNow();
    expect(loadSession()?.tree.name).toBe('Test');
    expect(sessionSaveFailing()).toBe(false);
  });

  it('a refused write never throws into the timer, but is no longer silent', () => {
    const seen: boolean[] = [];
    const off = onSessionSaveStateChange((f) => seen.push(f));
    jamWrites();
    // runAllTimers would surface an exception thrown by the timer callback.
    expect(() => saveNow()).not.toThrow();
    expect(sessionSaveFailing()).toBe(true);
    expect(seen).toEqual([true]);
    off();
  });

  it('dedupes: continuous editing at quota signals the transition once, not 2.5x/s', () => {
    const seen: boolean[] = [];
    const off = onSessionSaveStateChange((f) => seen.push(f));
    jamWrites();
    for (let i = 0; i < 5; i++) saveNow(); // five refused saves in a row
    expect(seen).toEqual([true]); // the edge, not the level
    expect(sessionSaveFailing()).toBe(true);
    off();
  });

  it('signals the recovery transition when a save sticks again', () => {
    const seen: boolean[] = [];
    const off = onSessionSaveStateChange((f) => seen.push(f));
    jamWrites();
    saveNow();
    vi.unstubAllGlobals(); // quota freed (user cleared runs, etc.)
    saveNow();
    saveNow();
    expect(seen).toEqual([true, false]); // one edge each way
    expect(sessionSaveFailing()).toBe(false);
    expect(loadSession()?.tree.name).toBe('Test');
    off();
  });

  it('unsubscribe stops notifications', () => {
    const seen: boolean[] = [];
    const off = onSessionSaveStateChange((f) => seen.push(f));
    off();
    jamWrites();
    saveNow();
    expect(seen).toEqual([]);
    expect(sessionSaveFailing()).toBe(true); // getter still tells the truth
  });
});

describe('session flight-config presets (Stage B)', () => {
  /** The store never inspects motor internals — a cast partial is enough. */
  const mm = (delay: number) => ({
    label: 'C6-5',
    spec: { designation: 'C6', ejectionDelay: delay },
    meta: { label: 'C6-5' },
    ignition: { event: 'automatic', delay: 0 },
  }) as unknown as MountMotor;

  it('round-trips savedConfigs and activeConfigId', () => {
    saveSessionDebounced({
      ...state(),
      savedConfigs: [{ id: 'cfg-a', name: 'Club field C6', isDefault: true, motors: { m1: mm(5) } }],
      activeConfigId: 'cfg-a',
    });
    vi.runAllTimers();
    const s = loadSession()!;
    expect(s.activeConfigId).toBe('cfg-a');
    expect(s.savedConfigs).toHaveLength(1);
    expect(s.savedConfigs![0]!.name).toBe('Club field C6');
    expect(s.savedConfigs![0]!.isDefault).toBe(true);
    expect(s.savedConfigs![0]!.motors['m1']!.spec.ejectionDelay).toBe(5);
  });

  it('revives plugged (Infinity) delays inside config presets, and null active', () => {
    saveSessionDebounced({
      ...state(),
      savedConfigs: [{ id: 'cfg-a', name: null, isDefault: false, motors: { m1: mm(Infinity) } }],
      activeConfigId: null,
    });
    vi.runAllTimers();
    const s = loadSession()!;
    expect(s.activeConfigId).toBeNull();
    expect(s.savedConfigs![0]!.motors['m1']!.spec.ejectionDelay).toBe(Infinity);
  });

  it('sessions saved before Stage B load clean — the fields simply absent', () => {
    saveNow(); // state() carries neither field
    const s = loadSession()!;
    expect(s.tree.name).toBe('Test');
    expect(s.savedConfigs).toBeUndefined();
    expect(s.activeConfigId).toBeUndefined();
  });
});

describe('a saved design reads saved after the autosave round trip (audit 2026-09-22)', () => {
  it('a catalogue motor that lists no case (motorCase: undefined) does not read as unsaved', () => {
    // The audit's measured case: the Estes C6 has no caseInfo, so
    // mountMotorFromDb writes `motorCase: undefined`; the session's JSON drops
    // the key, and a fingerprint that hashed it as null came back from every
    // reload different from the mark taken before it. dirtyState.stableJson
    // now reads such a key as absent (6f741af); this pins the whole path —
    // the real record, the real save and the real load.
    const db = findDbMotor('C6', undefined, undefined, 'Estes')!;
    const spec = { designation: 'C6', ejectionDelay: 5, masses: [0.0241] } as unknown as MotorSpec;
    const c6 = mountMotorFromDb(db, spec, 5, { event: 'automatic', delay: 0 });
    expect('motorCase' in c6.meta! && c6.meta!.motorCase === undefined).toBe(true);
    const snap: DesignSnapshot = {
      ...state(), mountMotors: { m1: c6 }, maxMotorLengthByStage: {}, savedConfigs: [],
      activeConfigId: null, measured: { massKg: null, cgM: null },
    };
    const mark = designFingerprint(snap);
    saveSessionDebounced({ ...snap, savedMark: mark });
    vi.runAllTimers();
    const s = loadSession()!;
    const reloaded: DesignSnapshot = {
      tree: s.tree, mountMotors: s.mountMotors!, launch: s.launch,
      maxMotorLengthByStage: s.maxMotorLengthByStage!, savedConfigs: s.savedConfigs!,
      activeConfigId: s.activeConfigId!, measured: s.measured!,
    };
    expect('motorCase' in reloaded.mountMotors['m1']!.meta!).toBe(false);
    expect(isDirty(designFingerprint(reloaded), s.savedMark, false)).toBe(false);
  });
});

/**
 * ROD AIM (weather build, step 2) is OPTIONAL, and absent means 0. A session
 * saved before the field restores with no key — nothing fills one in — so the
 * design is the same design (fingerprint, conditions key) and flies the same
 * flight (no rodDirection reaches the kernel). A default-fill here would mark
 * every restored design unsaved, which is the trap the field's doc names.
 */
describe('a session saved before Rod aim', () => {
  it('restores with no aim, the same fingerprint and conditions key, and flies no rod direction', () => {
    // A tilted rod, so "no rod direction" is the aim's doing, not the rod's.
    const launch = { ...state().launch, launchRodAngleDeg: 5 };
    const snap: DesignSnapshot = {
      ...state(), launch, mountMotors: {}, maxMotorLengthByStage: {}, savedConfigs: [],
      activeConfigId: null, measured: { massKg: null, cgM: null },
    };
    const mark = designFingerprint(snap);
    saveSessionDebounced({ ...snap, savedMark: mark });
    vi.runAllTimers();
    const s = loadSession()!;
    expect(s.launch).not.toHaveProperty('launchRodAimDeg');
    expect(kernelSimOptions(s.launch)).not.toHaveProperty('launchRodDirection');
    expect(conditionsKeyOf(s.launch)).toBe(conditionsKeyOf(launch));
    const reloaded: DesignSnapshot = {
      tree: s.tree, mountMotors: s.mountMotors!, launch: s.launch,
      maxMotorLengthByStage: s.maxMotorLengthByStage!, savedConfigs: s.savedConfigs!,
      activeConfigId: s.activeConfigId!, measured: s.measured!,
    };
    expect(isDirty(designFingerprint(reloaded), s.savedMark, false)).toBe(false);
  });
});

/**
 * THE GEODETIC MODEL (GS1) is OPTIONAL, and in a SESSION absent means
 * SPHERICAL — what every flight flew before the field (the kernel was forced to
 * it). That rule is `flownGeodeticMethod`'s. A session saved before the field
 * restores with no key — nothing fills one in — so it is the same design
 * (fingerprint, conditions key) and flies the same flight: no geodeticMethod
 * reaches the kernel. A desktop FILE's absent method is the other rule, flat,
 * and the .ork reader's (orkGeodetic.test.ts).
 */
describe('a session saved before the geodetic model', () => {
  it('restores with no model, the same fingerprint and conditions key, and flies spherical', () => {
    const launch = state().launch;
    const snap: DesignSnapshot = {
      ...state(), launch, mountMotors: {}, maxMotorLengthByStage: {}, savedConfigs: [],
      activeConfigId: null, measured: { massKg: null, cgM: null },
    };
    const mark = designFingerprint(snap);
    saveSessionDebounced({ ...snap, savedMark: mark });
    vi.runAllTimers();
    const s = loadSession()!;
    expect(s.launch).not.toHaveProperty('geodeticMethod');
    expect(kernelSimOptions(s.launch)).not.toHaveProperty('geodeticMethod');
    expect(conditionsKeyOf(s.launch)).toBe(conditionsKeyOf(launch));
    // The same flight as naming it — and not the one a desktop file without it gets.
    expect(conditionsKeyOf(s.launch)).toBe(conditionsKeyOf({ ...launch, geodeticMethod: 'spherical' }));
    expect(conditionsKeyOf(s.launch)).not.toBe(conditionsKeyOf({ ...launch, geodeticMethod: 'flat' }));
    const reloaded: DesignSnapshot = {
      tree: s.tree, mountMotors: s.mountMotors!, launch: s.launch,
      maxMotorLengthByStage: s.maxMotorLengthByStage!, savedConfigs: s.savedConfigs!,
      activeConfigId: s.activeConfigId!, measured: s.measured!,
    };
    expect(isDirty(designFingerprint(reloaded), s.savedMark, false)).toBe(false);
  });

  it('flies a stored value that is not one of the three as spherical, as it keys it', () => {
    // localStorage is anything's to write.
    saveSessionDebounced({ ...state(), launch: { ...state().launch, geodeticMethod: 'Flat' as never } });
    vi.runAllTimers();
    const s = loadSession()!;
    expect(kernelSimOptions(s.launch)).not.toHaveProperty('geodeticMethod');
    expect(conditionsKeyOf(s.launch)).toBe(conditionsKeyOf(state().launch));
  });

  it('keeps a model the user chose', () => {
    saveSessionDebounced({ ...state(), launch: { ...state().launch, geodeticMethod: 'wgs84' } });
    vi.runAllTimers();
    expect(kernelSimOptions(loadSession()!.launch).geodeticMethod).toBe('wgs84');
  });
});

describe('a design restored from autosave remembers which build imported it', () => {
  const KEY = 'online-openrocket.session.v1';
  const rewrite = (patch: (raw: Record<string, unknown>) => void) => {
    const raw = JSON.parse(localStorage.getItem(KEY)!) as Record<string, unknown>;
    patch(raw);
    localStorage.setItem(KEY, JSON.stringify(raw));
  };

  it('stamps the version that saved it', () => {
    saveNow();
    expect(loadSession()!.appVersion).toBe(APP_VERSION);
  });

  it('a session saved by an earlier build is flagged', () => {
    // The tree in localStorage is the PARSED design, not the .ork bytes. An
    // importer fix therefore never reaches a design already open — a tester
    // ran a build that read his stage override correctly and still saw the
    // pre-fix numbers, 8.9 % heavy, because his autosave predated the fix.
    saveNow();
    rewrite((raw) => { raw['appVersion'] = '0.058'; });
    expect(sessionPredatesThisBuild(loadSession()!)).toBe(true);
  });

  it('a session saved before stamping existed is flagged', () => {
    saveNow();
    rewrite((raw) => { delete raw['appVersion']; });
    expect(sessionPredatesThisBuild(loadSession()!)).toBe(true);
  });

  it('a session this build wrote is not flagged', () => {
    saveNow();
    expect(sessionPredatesThisBuild(loadSession()!)).toBe(false);
  });
});

describe('the one-time v0.071 time-step migration fires exactly once', () => {
  const KEY = 'online-openrocket.session.v1';
  /** A session carrying a 0.01 s step, stamped as if written by `version`. */
  const stampFineStep = (version: string | undefined) => {
    saveSessionDebounced({ ...state(), launch: { ...state().launch, timeStepS: 0.01 } });
    vi.runAllTimers();
    const raw = JSON.parse(localStorage.getItem(KEY)!) as Record<string, unknown>;
    // This fixture represents bytes written before the one-shot marker existed.
    delete raw['timeStepMigrationVersion'];
    if (version === undefined) delete raw['appVersion'];
    else raw['appVersion'] = version;
    localStorage.setItem(KEY, JSON.stringify(raw));
  };

  it('a pre-0.071 session is raised to the default, once, with the notice flag', () => {
    stampFineStep('0.070');
    const s = loadSession()!;
    expect(s.launch.timeStepS).toBe(0.05);
    expect(s.timeStepWasClamped).toBe(true);
  });

  it('records the step it replaced — the notice has to be able to name it', () => {
    // The clamp overwrites launch.timeStepS in place, so without this the old
    // value survives nowhere and the notice can only offer "it" back.
    stampFineStep('0.070');
    const s = loadSession()!;
    expect(s.timeStepClampedFromS).toBe(0.01);
  });

  it('leaves no replaced-step value on a session it did not clamp', () => {
    stampFineStep('0.071');
    const s = loadSession()!;
    expect(s.timeStepWasClamped).toBeUndefined();
    expect(s.timeStepClampedFromS).toBeUndefined();
  });

  it('a session with no appVersion at all predates the field — raised', () => {
    stampFineStep(undefined);
    const s = loadSession()!;
    expect(s.launch.timeStepS).toBe(0.05);
    expect(s.timeStepWasClamped).toBe(true);
  });

  it('a 0.071 session keeps a fine step — it was typed into the panel', () => {
    stampFineStep('0.071');
    const s = loadSession()!;
    expect(s.launch.timeStepS).toBe(0.01);
    expect(s.timeStepWasClamped).toBeUndefined();
  });

  it('a session from a LATER build is never re-clamped by an upgrade', () => {
    // The original gate was "appVersion !== the running build", which is true
    // after EVERY release — so a step the user chose in v0.071's panel was
    // clamped back on the v0.072 upgrade, with a notice blaming a design file.
    // '0.100' also guards the compare itself: it must sort after '0.071'
    // numerically, not by string luck.
    for (const v of ['0.072', '0.100']) {
      stampFineStep(v);
      const s = loadSession()!;
      expect(s.launch.timeStepS).toBe(0.01);
      expect(s.timeStepWasClamped).toBeUndefined();
    }
  });

  it('a malformed appVersion is treated as old — migrating is the safe side', () => {
    stampFineStep('not-a-version');
    expect(loadSession()!.launch.timeStepS).toBe(0.05);
  });
});

describe('flushSession closes the debounce window on the way out', () => {
  it('writes a pending save immediately, without running the timer', () => {
    localStorage.clear();
    saveSessionDebounced({ ...state(), tree: { name: 'Unflushed', components: [] } });
    // The debounce has NOT fired: this is the ~400 ms hole a tab close fell into.
    expect(localStorage.getItem('online-openrocket.session.v1')).toBeNull();
    flushSession();
    expect(loadSession()?.tree.name).toBe('Unflushed');
  });

  it('writes the LATEST pending state, not a stale one', () => {
    // The state must live at module level, not in the timer's closure. Cancel
    // the timer without a module-level copy and the flush has nothing to write
    // — worse than no flush at all, because it drops the write silently.
    localStorage.clear();
    saveSessionDebounced({ ...state(), tree: { name: 'First', components: [] } });
    saveSessionDebounced({ ...state(), tree: { name: 'Second', components: [] } });
    flushSession();
    expect(loadSession()?.tree.name).toBe('Second');
  });

  it('does not re-write on a second flush with nothing pending', () => {
    localStorage.clear();
    saveSessionDebounced({ ...state(), tree: { name: 'Once', components: [] } });
    flushSession();
    const first = localStorage.getItem('online-openrocket.session.v1');
    localStorage.removeItem('online-openrocket.session.v1');
    flushSession(); // nothing pending
    expect(localStorage.getItem('online-openrocket.session.v1')).toBeNull();
    expect(first).not.toBeNull();
  });

  it('a flushed save still lands after the timer would have fired', () => {
    localStorage.clear();
    saveSessionDebounced({ ...state(), tree: { name: 'Flushed', components: [] } });
    flushSession();
    vi.runAllTimers(); // the cancelled timer must not resurrect anything
    expect(loadSession()?.tree.name).toBe('Flushed');
  });
});

describe('the design outranks a re-downloadable cache at quota (critic-3)', () => {
  const KEY = 'online-openrocket.session.v1';
  const CACHE = 'tc:samples:v4:';

  /**
   * A store that refuses writes while the disposable cache is present — the
   * shape of the real failure. thrustcurve.ts wrote one `tc:samples:v4:<id>`
   * entry per downloaded curve with no count cap, no size cap and no
   * clear-cache path anywhere in the UI, so a flight day spent browsing motors
   * filled the origin and every debounced autosave after that was refused.
   * `alwaysFull` is the case where freeing the cache is not enough.
   */
  function stubStore(opts: { cacheEntries: number; alwaysFull?: boolean }) {
    const map = new Map<string, string>();
    for (let i = 0; i < opts.cacheEntries; i++) map.set(`${CACHE}m${i}`, '[1,2,3]');
    map.set('tc:samples:v5:future', '[4,5]'); // a later cache version must sweep too
    map.set('online-openrocket.prefs.v1', '{}');
    const full = () => opts.alwaysFull === true
      || [...map.keys()].some((k) => k.startsWith('tc:'));
    vi.stubGlobal('localStorage', {
      get length() { return map.size; },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (full()) throw new DOMException('quota', 'QuotaExceededError');
        map.set(k, v);
      },
      removeItem: (k: string) => { map.delete(k); },
    });
    return map;
  }

  it('spends the thrust-curve cache and retries — the unsaved design survives', () => {
    const map = stubStore({ cacheEntries: 200 });
    const seen: boolean[] = [];
    const off = onSessionSaveStateChange((f) => seen.push(f));
    saveNow();
    expect(map.has(KEY)).toBe(true);        // it landed on the retry
    expect(sessionSaveFailing()).toBe(false);
    expect(seen).toEqual([]);               // never even reported failing
    // Only re-downloadable data was given up — including a future cache
    // version, because the sweep matches the family prefix, not `v4`.
    expect([...map.keys()].filter((k) => k.startsWith('tc:'))).toEqual([]);
    expect(map.has('online-openrocket.prefs.v1')).toBe(true);
    off();
  });

  it('spends remembered empty-curve answers at quota before losing the design', () => {
    const map = stubStore({ cacheEntries: 0 });
    map.delete('tc:samples:v5:future');
    const negativeKey = 'online-openrocket.no-curve.v1';
    map.set(negativeKey, '{"motor":"2026-10-09"}');
    const storage = localStorage;
    vi.stubGlobal('localStorage', {
      get length() { return map.size; },
      key: storage.key, getItem: storage.getItem, removeItem: storage.removeItem,
      setItem: (key: string, value: string) => {
        if (map.has(negativeKey)) throw new DOMException('quota', 'QuotaExceededError');
        map.set(key, value);
      },
    });
    saveNow();
    expect(map.has(negativeKey)).toBe(false);
    expect(map.has(KEY)).toBe(true);
    expect(map.has('online-openrocket.prefs.v1')).toBe(true);
    expect(sessionSaveFailing()).toBe(false);
  });

  it('the sweep is self-limiting: a second refused save frees nothing more', () => {
    const map = stubStore({ cacheEntries: 3, alwaysFull: true });
    saveNow();
    expect(sessionSaveFailing()).toBe(true);          // freeing was not enough
    expect([...map.keys()].filter((k) => k.startsWith('tc:'))).toEqual([]);
    const before = [...map.keys()].sort();
    for (let i = 0; i < 4; i++) saveNow();            // ~2.5 refusals/s while editing
    expect([...map.keys()].sort()).toEqual(before);   // nothing else is ever spent
  });

  it('with nothing disposable to give, it fails honestly and signals ONE edge', () => {
    const map = stubStore({ cacheEntries: 0, alwaysFull: true });
    map.delete('tc:samples:v5:future');
    const seen: boolean[] = [];
    const off = onSessionSaveStateChange((f) => seen.push(f));
    for (let i = 0; i < 5; i++) saveNow();
    expect(sessionSaveFailing()).toBe(true);
    expect(seen).toEqual([true]);                       // the edge, not the level
    expect(map.has('online-openrocket.prefs.v1')).toBe(true);
    off();
  });

  it('leaves the cache alone when the write succeeds', () => {
    const map = stubStore({ cacheEntries: 5 });
    // Not full: the sweep must be a quota response, not a routine cost.
    map.clear();
    map.set(`${CACHE}m0`, '[1]');
    vi.stubGlobal('localStorage', {
      get length() { return map.size; },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v); },
      removeItem: (k: string) => { map.delete(k); },
    });
    saveNow();
    expect(map.has(`${CACHE}m0`)).toBe(true);
    expect(sessionSaveFailing()).toBe(false);
  });
});

/**
 * WHERE APPLIED WEATHER CAME FROM (weather build, step 3) survives a reload,
 * is dropped when it does not check out, and never touches the design.
 */
describe('the weather provenance record in the session', () => {
  const snapshot = () => ({
    v: 1, provider: 'open-meteo', endpoint: 'forecast', model: 'best_match',
    place: { label: 'Gerlach, Nevada, US', latitudeDeg: 40.65157, longitudeDeg: -119.35519, method: 'search' },
    grid: { latitudeDeg: 40.66386, longitudeDeg: -119.35593 },
    demElevationM: 1202, forAltitudeM: 1202, timezone: 'America/Los_Angeles',
    validUnix: Date.UTC(2026, 8, 26, 21) / 1000, retrievedAt: '2026-09-22T18:00:00.000Z',
    fetched: { temperatureC: 23.3, pressureHPa: 877.2, windSpeedMs: 1.75, windGustMs: 4.6, windFromDeg: 294 },
    applied: { temperatureC: 23.3, pressureHPa: 877.2 },
    before: { temperatureC: null, pressureHPa: null },
  } as const);

  it('round-trips a well-formed record', () => {
    saveSessionDebounced({ ...state(), weather: snapshot() as never });
    vi.runAllTimers();
    expect(loadSession()!.weather).toEqual(snapshot());
  });

  it('drops a malformed one — and nothing else', () => {
    saveSessionDebounced({ ...state(), weather: { ...snapshot(), applied: { windStdDev: 2 } } as never });
    vi.runAllTimers();
    const s = loadSession()!;
    expect(s).not.toHaveProperty('weather');
    expect(s.launch.windAverage).toBe(2);
  });

  // What this file can hold: the loader hands back the SAME design fields
  // (tree and launch conditions, byte for byte) whether or not a weather record
  // rides along — it neither fills a launch key in nor takes one away. That a
  // restored record leaves a saved-clean design clean in App itself is
  // App.weather.test.tsx's "does not make a saved-clean design dirty".
  it('a session from before the feature loads with none, and a record changes none of the design it restores', () => {
    saveNow();
    const s = loadSession()!;
    expect(s.weather).toBeUndefined();
    saveSessionDebounced({ ...state(), weather: snapshot() as never });
    vi.runAllTimers();
    const w = loadSession()!;
    expect(w.weather).toBeDefined();
    expect(JSON.stringify(w.launch)).toBe(JSON.stringify(s.launch));
    expect(JSON.stringify(w.tree)).toBe(JSON.stringify(s.tree));
  });
});

it.each([undefined, true, false])('round-trips launch-guide allowance %s in autosave', (allowance) => {
  const saved = state();
  if (allowance !== undefined) saved.launch.launchGuideAllowance = allowance;
  saveSessionDebounced(saved);
  vi.runAllTimers();
  const launch = loadSession()!.launch;
  expect(launch.launchGuideAllowance).toBe(allowance);
  expect(kernelSimOptions(launch).guideAllowance !== false).toBe(allowance !== false);
});

/**
 * K10–K11 (board Tier 2): an opened .CDX1's Mach-Alt table lived in React state
 * only, so a reload lost the Drag analysis "File Mach-Alt table" option and
 * Save .CDX1 wrote an empty <MachAlt>. It now rides in the session.
 */
describe('the file Mach-Alt table in the session', () => {
  it('round-trips a well-formed table', () => {
    const table: [number, number][] = [[0.3, 0], [1.2, 3048], [3, 15240]];
    saveSessionDebounced({ ...state(), fileMachAlt: table });
    vi.runAllTimers();
    expect(loadSession()!.fileMachAlt).toEqual(table);
  });

  it('drops a malformed one, and nothing else', () => {
    saveSessionDebounced({ ...state(), fileMachAlt: [[0.3, 0], [Number.NaN, 1]] as never });
    vi.runAllTimers();
    const s = loadSession()!;
    expect(s).not.toHaveProperty('fileMachAlt');
    expect(s.launch.windAverage).toBe(2);
  });
});

it('lane C S1c-2 uses the shared Mach-Alt limit on session reload', async () => {
  vi.resetModules();
  vi.doMock('./machAltLimits.js', () => ({ MAX_MACH_ALT_ROWS: 2 }));
  try {
    const { validMachAltTable } = await import('./session.js');
    expect(validMachAltTable([[0, 0], [1, 10]])).toEqual([[0, 0], [1, 10]]);
    expect(validMachAltTable([[0, 0], [1, 10], [2, 20]])).toBeNull();
  } finally { vi.doUnmock('./machAltLimits.js'); vi.resetModules(); }
});

/**
 * STORED-STATE HARDENING (cloud session 10). An autosave is anything's to
 * write; one malformed entry must cost that entry, with a restore note, and
 * never the design or a later Save.
 */
describe('stored-state hardening: EX definitions', () => {
  const KEY = 'online-openrocket.session.v1';
  const EX_KEY = 'online-openrocket.ex-motors.v1';
  const definition = (): ExMotor => ({
    motorId: 'ex:stored-c6', designation: 'C6', realManufacturer: 'Stored Test',
    diameter: 18, length: 70, totalWeightG: 24, propWeightG: 10, delays: '5',
    samples: [{ time: 0, thrust: 0 }, { time: 0.1, thrust: 12 }, { time: 0.5, thrust: 6 }, { time: 1.2, thrust: 0 }],
    source: 'eng', addedAt: 1,
  });
  const exMounted = () => {
    const ex = definition();
    return mountMotorFromDb(exToDbEntry(ex), exToMotorSpec(ex, 5), 5, { event: 'automatic', delay: 0 }, { exMotorId: ex.motorId });
  };
  /** What App's Save .ork hands the writer (App.onSaveOrk via exportAssembly). */
  const saveOrk = (loaded: SessionState) => {
    const { state: d } = designStateFromSession(loaded, { legacyMaxMotorLengthM: null });
    return exportOrk({
      name: 'Stored', tree: d.tree, launch: d.launch, measured: d.measured, activeConfigId: d.activeConfigId,
      workingOverrides: d.detachedOverrides, notes: [], onOmittedMotor: () => { throw new Error('omitted a motor'); },
      motors: exportMotorsMap({ assigned: assignedMotorsOf(d.mountMotors, motorMounts(d.tree)), unmatchedRefs: d.unmatchedRefs,
        tree: d.tree, activeConfigId: d.activeConfigId, exLibrary: loadExMotorIdentities }),
      configs: exportConfigs(d.savedConfigs, d.tree, loadExMotorIdentities),
    });
  };
  const noteKinds = (loaded: SessionState) =>
    designStateFromSession(loaded, { legacyMaxMotorLengthM: null }).restoreNoteTiers.map(n => `${n.tier}:${n.kind}`);

  const badDefinitions: [string, (def: Record<string, unknown>, meta: Record<string, unknown>) => unknown][] = [
    ['realManufacturer 7', def => ({ ...def, realManufacturer: 7 })],
    ['realManufacturer {"toString":0}', def => ({ ...def, realManufacturer: { toString: 0 } })],
    ['motorId 7 with no meta.exMotorId', (def, meta) => { delete meta.exMotorId; return { ...def, motorId: 7 }; }],
    ['null', () => null],
    ['"x"', () => 'x'],
    ['[]', () => []],
    ['identity only, no samples', def => ({ motorId: def.motorId, designation: def.designation, realManufacturer: def.realManufacturer })],
    ['samples [null]', def => ({ ...def, samples: [null] })],
  ];
  describe.each(['in the library', 'not in the library'])('with the EX motor %s', library => {
    beforeEach(() => {
      discardSession();
      if (library === 'in the library') localStorage.setItem(EX_KEY, JSON.stringify([definition()]));
    });
    it.each(badDefinitions)('repairs an unreadable stored exDefinition (%s) and keeps the motor', (_name, corrupt) => {
      const tree = defaultTree();
      const mount = motorMounts(tree)[0]!.id!;
      const motor = exMounted() as unknown as { spec: Record<string, unknown>; meta: Record<string, unknown> };
      expect(motor.meta.manufacturer).toBe('EX');
      motor.spec.exDefinition = corrupt(motor.spec.exDefinition as Record<string, unknown>, motor.meta);
      const raw = JSON.stringify({ ...state(), tree, mountMotors: { [mount]: motor },
        savedConfigs: [{ id: 'c', name: 'C', isDefault: true, motors: { [mount]: motor } }] });
      localStorage.setItem(KEY, raw);
      const loaded = loadSession()!;
      for (const kept of [loaded.mountMotors![mount], loaded.savedConfigs![0]!.motors[mount]]) {
        expect(kept).toBeDefined();
        expect(kept!.spec).not.toHaveProperty('exDefinition');
        expect(kept!.spec.thrusts).toEqual(motor.spec.thrusts);
      }
      expect(noteKinds(loaded)).toContain('caution:G04.ex-definition-removed');
      // The archive falls back to the library entry or the loaded snapshot.
      expect(saveOrk(loaded)).toContain('<mmrexmotors');
      expect(localStorage.getItem(KEY)).toBe(raw);
      const recovery = autosavedDesignFile()!;
      expect(recovery.ork).toBe(false);
      expect(recovery.data).toBe(raw);
    });
    it('restores a valid EX definition exactly, with no note, and saves it', () => {
      const tree = defaultTree();
      const mount = motorMounts(tree)[0]!.id!;
      const motor = exMounted();
      const snap: DesignSnapshot = { ...state(), tree, mountMotors: { [mount]: motor }, maxMotorLengthByStage: {},
        savedConfigs: [{ id: 'c', name: null, isDefault: true, motors: { [mount]: motor } }],
        activeConfigId: null, measured: { massKg: null, cgM: null } };
      const raw = JSON.stringify({ ...snap, savedMark: designFingerprint(snap) });
      localStorage.setItem(KEY, raw);
      const loaded = loadSession()!;
      const stored = JSON.parse(raw) as SessionState;
      expect(loaded.mountMotors).toStrictEqual(stored.mountMotors);
      expect(JSON.stringify(loaded.mountMotors)).toBe(JSON.stringify(stored.mountMotors));
      expect(JSON.stringify(loaded.savedConfigs)).toBe(JSON.stringify(stored.savedConfigs));
      expect((loaded.mountMotors![mount]!.spec as { exDefinition?: unknown }).exDefinition).toStrictEqual(definition());
      expect(loaded.treeRestoreNotes ?? []).toEqual([]);
      expect(isDirty(designFingerprint({ ...snap, tree: loaded.tree, mountMotors: loaded.mountMotors!,
        savedConfigs: loaded.savedConfigs! }), loaded.savedMark, false)).toBe(false);
      expect(localStorage.getItem(KEY)).toBe(raw);
      expect(saveOrk(loaded)).toContain('<mmrexmotors');
    });
  });

  // The reference screen (sanitizeSessionFlightLayers) does not read exDefinition:
  // Save treats an unreadable one as no definition, as for a reference stored without one.
  it.each(['working set', 'configuration'])('saves a %s reference with an unreadable exDefinition as one with none', where => {
    discardSession();
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const save = (exDefinition?: unknown) => {
      const ref = { designation: 'C6', exMotorId: 'ex:stored-c6', diameter: 0.018, length: 0.07, delay: 5,
        ...(exDefinition !== undefined ? { exDefinition } : {}) };
      localStorage.setItem(KEY, JSON.stringify({ ...state(), tree, configLayers: 1,
        ...(where === 'working set' ? { unmatchedRefs: { [mount]: ref } }
          : { savedConfigs: [{ id: 'c', name: 'C', isDefault: false, motors: {}, unmatchedRefs: { [mount]: ref } }] }) }));
      const { state: d } = designStateFromSession(loadSession(), { legacyMaxMotorLengthM: null });
      const notes: string[] = [];
      const xml = exportOrk({ name: 'Stored', tree: d.tree, launch: d.launch, notes,
        motors: exportMotorsMap({ assigned: [], unmatchedRefs: d.unmatchedRefs, tree: d.tree, activeConfigId: null, exLibrary: loadExMotorIdentities }),
        configs: exportConfigs(d.savedConfigs, d.tree, loadExMotorIdentities) });
      return { xml: xml.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'uuid'), notes };
    };
    const none = save();
    for (const bad of [7, 'x', [], { ...definition(), realManufacturer: 7 }, { motorId: 7, designation: 'C6' }, { ...definition(), samples: [null] }]) {
      expect(save(bad)).toEqual(none);
    }
  });

});

describe('stored-state hardening: a configuration is screened before its label is read', () => {
  const KEY = 'online-openrocket.session.v1';
  const noteKinds = (loaded: SessionState) =>
    designStateFromSession(loaded, { legacyMaxMotorLengthM: null }).restoreNoteTiers.map(n => `${n.tier}:${n.kind}`);
  beforeEach(() => discardSession());
  it.each([
    ['motors { m: null }', { motors: { m: null } }],
    ['unmatched 5', { motors: {}, unmatched: 5 }],
    ['unmatched {}', { motors: {}, unmatched: {} }],
  ])('restores an unnamed configuration with %s and a nozzle repair, and keeps the slot', async (_name, fields) => {
    const { MAX_DIMENSION_M } = await import('../tree/schema.js');
    const raw = JSON.stringify({ ...state(), nozzleModeVersion: 1,
      savedConfigs: [{ id: 'B', name: null, isDefault: true, ...fields, nozzles: { s: MAX_DIMENSION_M * 2 } }] });
    localStorage.setItem(KEY, raw);
    const loaded = loadSession();
    expect(loaded).not.toBeNull();
    expect(loaded!.savedConfigs).toHaveLength(1);
    expect(loaded!.savedConfigs![0]!.nozzles!.s).toBe(MAX_DIMENSION_M);
    expect(loaded!.treeRestoreNotes?.join(' ')).toContain('Saved configuration No motors:');
    expect(loaded!.treeRestoreNotes?.length).toBeGreaterThan(1);
    // The next autosave writes the restored design, not a starter over it.
    saveSessionDebounced(loaded!);
    vi.runAllTimers();
    expect(JSON.parse(localStorage.getItem(KEY)!).savedConfigs[0].id).toBe('B');
  });
  it.each([5, {}, 'K550W', ['K550W', 7]] as unknown[])('repairs a stored unmatched list %j from the screened references', unmatched => {
    const ref = { designation: 'K550W', diameter: 0.054, length: 0.4, delay: 10 };
    localStorage.setItem(KEY, JSON.stringify({ ...state(), configLayers: 1,
      savedConfigs: [{ id: 'B', name: null, isDefault: true, motors: {}, unmatched, unmatchedRefs: { m: ref } }] }));
    const loaded = loadSession()!;
    expect(loaded.savedConfigs![0]!.unmatched).toEqual(['K550W']);
    expect(noteKinds(loaded)).toContain('caution:G04.unmatched-rebuilt');
  });
  it('drops a stored unmatched list with no references to rebuild it from', () => {
    localStorage.setItem(KEY, JSON.stringify({ ...state(),
      savedConfigs: [{ id: 'B', name: null, isDefault: true, motors: {}, unmatched: 5 }] }));
    const loaded = loadSession()!;
    expect(loaded.savedConfigs![0]).not.toHaveProperty('unmatched');
    expect(noteKinds(loaded)).toContain('caution:G04.unmatched-rebuilt');
    expect(() => designStateFromSession(loaded, { legacyMaxMotorLengthM: null })).not.toThrow();
  });
  it('leaves a valid unnamed configuration unchanged, with no note', () => {
    const ref = { designation: 'K550W', diameter: 0.054, length: 0.4, delay: 10 };
    const raw = JSON.stringify({ ...state(), configLayers: 1, nozzleModeVersion: 1,
      savedConfigs: [{ id: 'B', name: null, isDefault: true, motors: {}, unmatched: ['K550W'], unmatchedRefs: { m: ref } }] });
    localStorage.setItem(KEY, raw);
    const loaded = loadSession()!;
    expect(JSON.stringify(loaded.savedConfigs)).toBe(JSON.stringify(JSON.parse(raw).savedConfigs));
    expect(loaded.treeRestoreNotes ?? []).toEqual([]);
  });
});

/** Sweep pins: SessionState fields the loader keeps unscreened, read only through their own checks. */
describe('stored-state hardening: unscreened session scalars', () => {
  beforeEach(() => discardSession());
  it.each([
    { maxMotorLengthByStage: 5 }, { maxMotorLengthByStage: 'x' }, { maxMotorLengthByStage: [null] },
    { maxMotorLengthM: '0.1' }, { mountId: 7, motor: { designation: 'C6', ejectionDelay: 5 } }, { mountId: {} },
    { activeConfigId: 7, savedConfigs: [{ id: '7', name: 'C', isDefault: true, motors: {} }] },
  ] as Record<string, unknown>[])('restores with %j', fields => {
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...state(), tree: defaultTree(), ...fields }));
    const loaded = loadSession();
    expect(loaded).not.toBeNull();
    const restored = designStateFromSession(loaded, { legacyMaxMotorLengthM: null });
    expect(restored.refused).toBe(false);
    expect(() => designFingerprint({ ...restored.state, maxMotorLengthByStage: {} })).not.toThrow();
  });
});
