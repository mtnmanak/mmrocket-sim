// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { MountMotor, SavedConfig } from '../model/design.js';
import type { SessionState } from './session.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { designFingerprint } from './dirtyState.js';
import { configOntoTree } from './importApply.js';
import { syncActiveConfig } from './configSync.js';
import { resolveFlightState } from './flightState.js';
import { migrateConfigLayers } from './configLayersMigration.js';

const deployment = { deployEvent: 'apogee', deployAltitude: 91.44, deployDelay: 0 };
const separation = { separationEvent: 'never', separationDelay: 1, separationAltitude: 400 };
const motor = (delay = 0): MountMotor => ({ label: 'F67', spec: { designation: 'F67', ejectionDelay: Infinity },
  meta: {}, ignition: { event: 'launch', delay } }) as MountMotor;
const cfg = (id: string, extra: Partial<SavedConfig> = {}): SavedConfig => ({ id, name: id, isDefault: id === 'A',
  motors: { mount: motor(id === 'A' ? 0 : 2) }, deployments: { chute: { ...deployment } },
  separations: { stage: { ...separation } }, ...extra });
const session = (): SessionState => ({ savedAt: 123, appVersion: '0.181', nozzleModeVersion: 1,
  tree: { components: [{ type: 'stage', id: 'stage', ...separation, children: [
    { type: 'parachute', id: 'chute', ...deployment }, { type: 'innertube', id: 'mount' },
  ] }] }, mountMotors: { mount: motor() }, savedConfigs: [cfg('A'), cfg('B', {
    deployments: { chute: { ...deployment, deployEvent: 'ejection', deployAltitude: 200 } },
    separations: { stage: { ...separation, separationEvent: 'burnout' } },
  })], activeConfigId: 'A', launch: DEFAULT_CONDITIONS, measured: { massKg: null, cgM: null } });
const mark = (s: SessionState) => designFingerprint({ ...s, mountMotors: s.mountMotors ?? {},
  savedConfigs: s.savedConfigs ?? [], activeConfigId: s.activeConfigId ?? null,
  measured: s.measured ?? { massKg: null, cgM: null } });

describe('configuration-layer migration (FC-1)', () => {
  it('sparsifies full legacy maps with identical per-configuration effective inputs', () => {
    const input = session();
    const before = structuredClone(input);
    const { state, note } = migrateConfigLayers(input);
    expect(state.configLayers).toBe(1);
    expect(state.savedConfigs[0]!.deployments).toEqual({});
    expect(state.savedConfigs[0]!.separations).toEqual({});
    expect(state.savedConfigs[0]!.ignitions).toEqual({});
    expect(state.savedConfigs[1]!.ignitions).toEqual({ mount: { event: 'launch', delay: 2 } });
    const legacy = syncActiveConfig(input.savedConfigs!, input.activeConfigId!, {
      tree: input.tree, motors: input.mountMotors!, unmatchedRefs: {},
    });
    for (const c of legacy) {
      const resolved = resolveFlightState(state.tree, state.savedConfigs, c.id, state.detachedOverrides, c.motors);
      expect(resolved.tree.components).toEqual(configOntoTree(input.tree, c).components);
      expect(resolved.mountMotors).toEqual(c.motors);
    }
    expect(note).toContain('autosave');
    expect(note).toContain('original file');
    expect(input).toEqual(before);
    expect(state.appVersion).toBe('0.181');
  });

  it('captures unsynced active edits and working unmatched refs before choosing the baseline', () => {
    const s = session();
    s.tree.components[0]!.children![0]!.deployDelay = 7;
    s.mountMotors!.mount!.ignition = { event: 'burnout', delay: 3 };
    s.unmatchedRefs = { missing: { designation: 'EX', manufacturer: '', diameter: 0.029, length: 0.1,
      delay: Infinity, ignitionEvent: 'never', ignitionDelay: 4 } };
    const { state } = migrateConfigLayers(s);
    expect(state.savedConfigs[0]!.deployments).toEqual({});
    expect(state.tree.ignitionDefaults).toMatchObject({ mount: { event: 'burnout', delay: 3 }, missing: { event: 'never', delay: 4 } });
    expect(state.savedConfigs[0]!.motors).toEqual(s.mountMotors);
    expect(state.savedConfigs[0]!.unmatchedRefs).toEqual(s.unmatchedRefs);
    expect(state.savedConfigs[0]!.unmatched).toEqual(['EX']);
    expect(state.savedConfigs[1]!.deployments!.chute!.deployDelay).toBe(0);
  });

  it('is idempotent by identity and emits the note only once', () => {
    const first = migrateConfigLayers(session());
    expect(migrateConfigLayers(first.state)).toEqual({ state: first.state, note: null });
    expect(migrateConfigLayers(first.state).state).toBe(first.state);
  });

  it.each([null, 'deleted'])('keeps the working flight with active id %s', activeConfigId => {
    const s = session();
    s.activeConfigId = activeConfigId;
    s.mountMotors!.mount!.ignition = { event: 'never', delay: 9 };
    const { state } = migrateConfigLayers(s);
    expect(state.activeConfigId).toBeNull();
    expect(state.detachedOverrides).toEqual({});
    const resolved = resolveFlightState(state.tree, state.savedConfigs, state.activeConfigId, state.detachedOverrides, state.mountMotors);
    expect(resolved.tree.components).toEqual(s.tree.components);
    expect(resolved.mountMotors).toEqual(s.mountMotors);
    expect(state.savedConfigs[0]!.ignitions!.mount).toEqual({ event: 'launch', delay: 0 });
  });

  it('freezes partial legacy maps to the baseline and names that limitation', () => {
    const s = session();
    s.savedConfigs![1]!.deployments = { chute: { deployEvent: 'ejection' } };
    s.savedConfigs![1]!.separations = { stage: { separationDelay: 9 } };
    const { state, note } = migrateConfigLayers(s);
    expect(state.savedConfigs[1]!.deployments!.chute).toEqual({ ...deployment, deployEvent: 'ejection' });
    expect(state.savedConfigs[1]!.separations!.stage).toEqual({ ...separation, separationDelay: 9 });
    expect(note).toContain('Missing');
    expect(note).toContain('restored');
    const projected = resolveFlightState(state.tree, state.savedConfigs, 'B', {}, state.savedConfigs[1]!.motors);
    expect(projected.tree.components).toEqual(configOntoTree(s.tree, s.savedConfigs![1]!).components);
  });

  it('retains dormant altitude, mixed-case recovery and normalized legacy separation behavior', () => {
    const s = session();
    s.savedConfigs![1]!.deployments = { chute: { ...deployment, deployEvent: 'APOGEE', deployAltitude: 200 } };
    s.savedConfigs![1]!.separations = { stage: { ...separation, separationEvent: 'UPPER_IGNITION' } };
    const { state } = migrateConfigLayers(s);
    expect(state.savedConfigs[1]!.deployments!.chute).toMatchObject({ deployEvent: 'APOGEE', deployAltitude: 200 });
    expect(state.savedConfigs[1]!.separations!.stage!.separationEvent).toBe('upperignition');
  });

  it('keeps removed-device records and leaves nozzle, stage-mass and activeness maps unchanged', () => {
    const s = session();
    const c = s.savedConfigs![1]!;
    c.deployments!.gone = { ...deployment };
    c.nozzles = { stage: 0, other: null };
    c.stageMassOverrides = { stage: {} };
    c.stageActiveness = { stage: false };
    const { state } = migrateConfigLayers(s);
    expect(state.savedConfigs[1]!.deployments!.gone).toEqual(deployment);
    expect(state.savedConfigs[1]!.nozzles).toEqual(c.nozzles);
    expect(state.savedConfigs[1]!.stageMassOverrides).toEqual(c.stageMassOverrides);
    expect(state.savedConfigs[1]!.stageActiveness).toEqual(c.stageActiveness);
  });

  it('preserves revived plugged delays and Infinity in working, stored and unmatched motors', () => {
    const s = session();
    s.savedConfigs![1]!.unmatchedRefs = { other: { designation: 'EX', manufacturer: '', diameter: 0.029, length: 0.1, delay: Infinity,
      ignitionEvent: 'burnout', ignitionDelay: 5 } };
    const { state } = migrateConfigLayers(s);
    expect(state.mountMotors.mount!.spec.ejectionDelay).toBe(Infinity);
    expect(state.savedConfigs[1]!.motors.mount!.spec.ejectionDelay).toBe(Infinity);
    expect(state.savedConfigs[1]!.unmatchedRefs!.other!.delay).toBe(Infinity);
    expect(state.savedConfigs[1]!.ignitions!.other).toEqual({ event: 'burnout', delay: 5 });
  });

  it('rekeys only an actually clean mark, retains flown dirtiness, and invalidates lossy and Auto-delay qualifications', () => {
    const s = session();
    s.savedMark = mark(s);
    s.flownSinceSave = true;
    s.lossySaved = { mark: s.savedMark, flights: 1, format: 'rkt', lossCount: 1 };
    s.flownAutoDelays = { A: { mount: 5 } };
    const { state } = migrateConfigLayers(s);
    expect(state.savedMark).toBe(mark(state));
    expect(state.flownSinceSave).toBe(true);
    expect(state.lossySaved).toBeUndefined();
    expect(state.flownAutoDelays).toBeUndefined();
    const dirty = session();
    dirty.savedMark = 'old-dirty-mark';
    expect(migrateConfigLayers(dirty).state.savedMark).toBe('old-dirty-mark');
    delete dirty.savedMark;
    expect(migrateConfigLayers(dirty).state.savedMark).toBeUndefined();
  });

  it('lets FC-4 supply its layered fingerprint when rekeying a proven clean mark', () => {
    const s = session();
    s.savedMark = mark(s);
    expect(migrateConfigLayers(s, () => 'layered-mark').state.savedMark).toBe('layered-mark');
  });

  it('matches legacy active capture when a node lacks an event but its stored record has one', () => {
    const s = session();
    delete s.tree.components[0]!.children![0]!.deployEvent;
    const legacy = syncActiveConfig(s.savedConfigs!, 'A', { tree: s.tree, motors: s.mountMotors!, unmatchedRefs: {} });
    expect(legacy[0]!.deployments!.chute!.deployEvent).toBe('apogee');
    const { state } = migrateConfigLayers(s);
    expect(state.savedConfigs[0]!.deployments!.chute!.deployEvent).toBe('apogee');
    expect(resolveFlightState(state.tree, state.savedConfigs, 'A', {}, state.mountMotors).tree.components)
      .toEqual(configOntoTree(s.tree, legacy[0]!).components);
  });

  it.each(['UPPER_IGNITION', 'unknown'])('matches legacy separation normalization for active %s', event => {
    const s = session();
    s.tree.components[0]!.separationEvent = event;
    const legacy = syncActiveConfig(s.savedConfigs!, 'A', { tree: s.tree, motors: s.mountMotors!, unmatchedRefs: {} });
    const { state } = migrateConfigLayers(s);
    expect(resolveFlightState(state.tree, state.savedConfigs, 'A', {}, state.mountMotors).tree.components)
      .toEqual(configOntoTree(s.tree, legacy[0]!).components);
  });

  it('treats absent configuration and motor collections as an empty working session', () => {
    const s = session();
    delete s.savedConfigs;
    delete s.mountMotors;
    delete s.activeConfigId;
    const { state } = migrateConfigLayers(s);
    expect(state.savedConfigs).toEqual([]);
    expect(state.mountMotors).toEqual({});
    expect(state.activeConfigId).toBeNull();
    expect(state.tree.components).toBe(s.tree.components);
  });

  it('does not accidentally bless a dirty mark that happens to equal the new representation', () => {
    const s = session();
    s.savedMark = 'new-mark';
    expect(migrateConfigLayers(s, () => 'new-mark').state.savedMark).toBeUndefined();
  });
});
