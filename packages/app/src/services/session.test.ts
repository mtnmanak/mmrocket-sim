// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushSession,
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
import { findNode, normalizeTree } from '../tree/treeModel.js';

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
    expect(restored.state.tree).toEqual(expected);
    expect(restored.restoreNotes.join(' ')).toContain('Fin set "Airfoil fins": its outline was not used');
    expect(restored.restoreNotes.join(' ')).toContain('The set keeps a default outline; redraw it in the fin editor.');
    expect(localStorage.getItem('online-openrocket.session.v1')).toBe(raw);
  });

  it('keeps an ork recovery download available for previously exportable fin points', () => {
    const raw = JSON.stringify({ ...state(), tree: { components: [{ ...stage, children: [
      { type: 'freeformfinset', points: [[0, null]] },
    ] }] } });
    localStorage.setItem('online-openrocket.session.v1', raw);
    expect(autosavedDesignFile()).toMatchObject({ extension: '.ork', ork: true });
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
    expect(restored.restoreNotes).toEqual([]);
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
    } else {
      expect(loaded.savedConfigs![0]).not.toHaveProperty('stageActiveness');
    }
    expect(loaded.savedConfigs![1]).not.toHaveProperty('stageActiveness');
    expect(loaded.treeRestoreNotes ?? []).toEqual([]);
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
