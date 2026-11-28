import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrkRocket, resetEngine } from '@online-openrocket/engine';
import { engineTree } from '../tree/treeModel.js';
import type { FlightTree, SavedConfig } from '../model/design.js';
import { testMotor, testResolution } from './autoDelay.testSupport.js';
import { prepareOrkExport, exportConfigs, exportMotorsMap, flightExportInput, type ExportHardwareCache } from './exportAssembly.js';
import * as designBuild from './buildDesign.js';
import * as dirtyState from './dirtyState.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { physicsKeyOf, provenanceKeyOf } from './designDerivation.js';
import { flightDataForExport, flownAutoDelays } from './orkFlightData.js';
import { withFlownNozzles } from './flownNozzles.js';
import { stageMotors } from './nozzleFollow.js';
import { PHYSICS_REVISION, motorDataKeyOf, type SimRun } from './simReport.js';
import { addExMotors, deleteExMotor, exToMotorSpec, parseEng } from './exMotors.js';

const motor = testMotor(true, 4);
const tree: FlightTree = { name: 'Layers', ignitionDefaults: { a: { event: 'launch', delay: 2 } }, components: [
  { type: 'stage', id: 's', separationEvent: 'never', children: [
    { type: 'innertube', id: 'a', motorMount: true }, { type: 'innertube', id: 'b', motorMount: true },
    { type: 'parachute', id: 'chute', deployEvent: 'apogee', deployAltitude: 100, deployDelay: 0 },
  ] },
] };
const config = (over: Partial<SavedConfig> = {}): SavedConfig => ({ id: 'A', name: 'A', isDefault: true, motors: { a: motor }, ...over });
const exLibrary = () => [];
afterEach(() => resetEngine());

describe('export assembly (S2-8)', () => {
  it('prepares matching fields and delay notes for Save, share and bundle from one design', () => {
    const input = { snapshot: { tree, launch: DEFAULT_CONDITIONS, activeConfigId: 'A',
      savedConfigs: [config({ motors: { a: testMotor(false, 11) } })], mountMotors: { a: motor },
      measured: { massKg: 1, cgM: 0.2 }, detachedOverrides: {} },
      assigned: [['a', motor]] as [string, typeof motor][], unmatchedRefs: {}, exLibrary,
      flown: { A: { a: 7 } }, flightData: {} };
    const save = prepareOrkExport(input);
    const share = prepareOrkExport({ ...input, context: 'share' });
    const bundle = prepareOrkExport(input);
    expect(save.design).toEqual(bundle.design);
    expect(save.design).toEqual(share.design);
    expect(save.design.motors?.a?.delay).toBe(7);
    expect(save.design.configs?.[0]?.motors.a?.delay).toBe(7);
    expect(save.design.notes).toHaveLength(1);
    expect(save.design.notes?.[0]).toContain('Auto (optimal)');
    expect(save.savedConfigs[0]?.motors.a).toEqual(motor);
    // A provisional delay has route-specific advice, retained by the seam.
    const provisionalSave = prepareOrkExport({ ...input, flown: {} });
    const provisionalShare = prepareOrkExport({ ...input, flown: {}, context: 'share' });
    expect(provisionalSave.design.notes?.join(' ')).toContain('Launch, then save');
    expect(provisionalShare.design.notes?.join(' ')).toContain('Launch, then copy the share link again');
    expect(input.snapshot.savedConfigs[0]?.motors.a?.spec.ejectionDelay).toBe(11);
  });
  it('does not build inactive hardware for stale design, conditions or model', () => {
    const savedConfigs = [config(), config({ id: 'B', motors: { a: { ...motor, padMassKg: 0.75 } } })];
    const aero = { aeroMode: 'classic' as const, effectiveKbf: false, autoSupersonic: false };
    const hardwareCache: ExportHardwareCache = new Map();
    const assemble = (currentTree = tree) => flightExportInput({ tree: currentTree, runs: [], savedConfigs,
      activeConfigId: 'A', assigned: [['a', motor]], mountMotors: { a: motor }, detachedOverrides: {},
      mounts: tree.components[0]!.children!.slice(0, 2), hardwareDeltaKg: 0, launch: DEFAULT_CONDITIONS,
      provenanceKey: provenanceKeyOf({ tree: currentTree, physicsKey: physicsKeyOf(currentTree.components),
        assigned: [['a', motor]], hardwareDeltaKg: 0, launch: DEFAULT_CONDITIONS, aero }), ...aero }, hardwareCache);
    const original = assemble();
    const owner = original.configurationState!('B');
    const run = { id: 'old', flightConfigId: 'B', designKey: owner.designKey,
      conditionsKey: original.conditionsKey, aeroModel: 'classic', rogersKbf: false,
      physicsRevision: PHYSICS_REVISION } as SimRun;
    hardwareCache.clear();
    const buildSpy = vi.spyOn(designBuild, 'buildDesign');
    try {
      const edited = assemble({ ...tree, components: [{ ...tree.components[0]!, length: 0.8 }] });
      expect(edited.configurationState!('B').designKey).not.toBe(run.designKey);
      edited.runs = [run];
      expect(flownAutoDelays(edited)).toEqual({});
      expect(flightDataForExport(edited)).toEqual({});
      expect(buildSpy).not.toHaveBeenCalled();
      const changedConditions = assemble();
      changedConditions.runs = [{ ...run, conditionsKey: 'old-conditions' }];
      expect(flownAutoDelays(changedConditions)).toEqual({});
      expect(flightDataForExport(changedConditions)).toEqual({});
      expect(buildSpy).not.toHaveBeenCalled();
      const changedModel = assemble();
      changedModel.runs = [{ ...run, aeroModel: 'supersonic' }];
      expect(flownAutoDelays(changedModel)).toEqual({});
      expect(flightDataForExport(changedModel)).toEqual({});
      expect(buildSpy).not.toHaveBeenCalled();
    } finally { buildSpy.mockRestore(); }
  });
  it('does not rebuild inactive hardware when only a name, colour or comment changes', () => {
    const savedConfigs = [config(), config({ id: 'B', motors: { a: { ...motor, padMassKg: 0.75 } } })];
    const aero = { aeroMode: 'classic' as const, effectiveKbf: false, autoSupersonic: false };
    const hardwareCache: ExportHardwareCache = new Map();
    const assemble = (currentTree = tree) => flightExportInput({ tree: currentTree, runs: [], savedConfigs,
      activeConfigId: 'A', assigned: [['a', motor]], mountMotors: { a: motor }, detachedOverrides: {},
      mounts: tree.components[0]!.children!.slice(0, 2), hardwareDeltaKg: 0, launch: DEFAULT_CONDITIONS,
      provenanceKey: provenanceKeyOf({ tree: currentTree, physicsKey: physicsKeyOf(currentTree.components),
        assigned: [['a', motor]], hardwareDeltaKg: 0, launch: DEFAULT_CONDITIONS, aero }), ...aero }, hardwareCache);
    const buildSpy = vi.spyOn(designBuild, 'buildDesign');
    try {
      assemble().configurationState!('B').getHardwareDeltaKg!();
      expect(buildSpy).toHaveBeenCalledTimes(1);
      const renamed = { ...tree, components: [{ ...tree.components[0]!, name: 'Renamed', comment: 'note', color: '#123456' }] };
      const owner = assemble(renamed).configurationState!('B');
      expect(owner.designKey).toBe(assemble().configurationState!('B').designKey);
      const serialize = vi.spyOn(dirtyState, 'stableJson');
      owner.getHardwareDeltaKg!();
      const calls = serialize.mock.calls.length;
      owner.getHardwareDeltaKg!();
      owner.getHardwareDeltaKg!();
      expect(serialize).toHaveBeenCalledTimes(calls);
      serialize.mockRestore();
      expect(buildSpy).toHaveBeenCalledTimes(1);
    } finally { buildSpy.mockRestore(); }
  });
  it.each([0, NaN])('memoizes even a cached hardware result of %s', delta => {
    const aero = { aeroMode: 'classic' as const, effectiveKbf: false, autoSupersonic: false };
    const hardwareCache: ExportHardwareCache = new Map();
    const assemble = () => flightExportInput({ tree, runs: [], savedConfigs: [config({ id: 'B',
      motors: { a: { ...motor, padMassKg: 0.75 } } })], activeConfigId: 'A',
      assigned: [['a', motor]], mountMotors: { a: motor }, detachedOverrides: {},
      mounts: tree.components[0]!.children!.slice(0, 2), hardwareDeltaKg: 0, launch: DEFAULT_CONDITIONS,
      provenanceKey: provenanceKeyOf({ tree, physicsKey: physicsKeyOf(tree.components),
        assigned: [['a', motor]], hardwareDeltaKg: 0, launch: DEFAULT_CONDITIONS, aero }), ...aero }, hardwareCache);
    assemble().configurationState!('B').getHardwareDeltaKg!();
    hardwareCache.get('B')!.delta = delta;
    const owner = assemble().configurationState!('B');
    const serialize = vi.spyOn(dirtyState, 'stableJson');
    try {
      expect(owner.getHardwareDeltaKg!()).toBe(delta);
      expect(owner.getHardwareDeltaKg!()).toBe(delta);
      expect(owner.getHardwareDeltaKg!()).toBe(delta);
      expect(serialize).toHaveBeenCalledOnce();
    } finally { serialize.mockRestore(); }
  });
  it('matches an inactive flight against its actual hardware including a refused zero delta', () => {
    const mounts = tree.components[0]!.children!;
    const physicalTree = { ...tree, components: [{ ...tree.components[0]!, children: [{
      type: 'bodytube' as const, id: 'body', length: 0.5, outerRadius: 0.05, thickness: 0.002,
      children: mounts,
    }] }] };
    const aero = { aeroMode: 'classic' as const, effectiveKbf: false, autoSupersonic: false };
    const savedConfigs = [config(), config({ id: 'B' })];
    const activeHandle = OrkRocket.buildTree(engineTree(physicalTree));
    const activeInfo = activeHandle.staticInfo();
    const hardwareCache: ExportHardwareCache = new Map();
    const assemble = (launch = DEFAULT_CONDITIONS) => flightExportInput({ tree: physicalTree, runs: [], savedConfigs, activeConfigId: 'A', assigned: [['a', motor]],
      measuredDryMassKg: 0.5,
      mountMotors: { a: motor }, detachedOverrides: {}, mounts: [tree.components[0]!.children![0]!],
      provenanceKey: provenanceKeyOf({ tree, physicsKey: physicsKeyOf(tree.components), assigned: [['a', motor]],
        hardwareDeltaKg: 0, launch, aero }), hardwareDeltaKg: 0, launch, ...aero }, hardwareCache);
    const input = assemble();
    const owner = input.configurationState!('B');
    const run = { id: 'old', flightConfigId: 'B', designKey: owner.designKey, conditionsKey: input.conditionsKey,
      motorSetKey: input.motorSetKeyOf(owner.motors, 0), motorDataKey: motorDataKeyOf(owner.motors),
      delayResolution: testResolution(owner.motors, [8]), physicsRevision: PHYSICS_REVISION,
      aeroModel: 'classic', rogersKbf: false, maxAltitude: 100 } as SimRun;
    input.runs = [run];
    expect(flownAutoDelays(input)).toHaveProperty('B', { a: 8 });
    expect(flightDataForExport(input)).toHaveProperty('B');
    savedConfigs[1]!.motors = { a: { ...motor, padMassKg: 100 } };
    const weighed = { ...assemble(), runs: [run] };
    // This weight exceeds the airframe ceiling, so Launch applies zero.
    expect(weighed.configurationState!('B').getHardwareDeltaKg!()).toBe(0);
    expect(flownAutoDelays(weighed)).toHaveProperty('B');
    expect(flightDataForExport(weighed)).toHaveProperty('B');
    weighed.runs = [{ ...run, motorSetKey: weighed.motorSetKeyOf(owner.motors, 0.1) }];
    expect(flownAutoDelays(weighed)).not.toHaveProperty('B');
    expect(flightDataForExport(weighed)).not.toHaveProperty('B');
    savedConfigs[1]!.motors = { a: { ...motor, padMassKg: 0.75 } };
    const positive = assemble();
    const state = positive.configurationState!('B');
    expect(state.getHardwareDeltaKg!()).toBeCloseTo(0.05, 10);
    const buildSpy = vi.spyOn(designBuild, 'buildDesign');
    try {
      const edited = assemble({ ...DEFAULT_CONDITIONS, launchAltitudeM: 123 });
      expect(edited.configurationState!('B').getHardwareDeltaKg!()).toBeCloseTo(0.05, 10);
      expect(buildSpy).not.toHaveBeenCalled();
      expect(edited.conditionsKey).not.toBe(positive.conditionsKey);
    } finally { buildSpy.mockRestore(); }
    positive.runs = [{ ...run, motorSetKey: positive.motorSetKeyOf(state.motors, state.getHardwareDeltaKg!()) }];
    expect(flownAutoDelays(positive)).toHaveProperty('B');
    expect(flightDataForExport(positive)).toHaveProperty('B');
    expect(activeHandle.staticInfo()).toEqual(activeInfo);
    for (const pad of [{ padMassKg: 0.69999 }, { padMassKg: 0.1 },
      { padMassKg: 0.75, padMassWeighedWith: 'stale' }]) {
      savedConfigs[1]!.motors = { a: { ...motor, ...pad } };
      const zero = assemble();
      zero.runs = [run];
      expect(zero.configurationState!('B').getHardwareDeltaKg!()).toBe(0);
      expect(flownAutoDelays(zero)).toHaveProperty('B');
      expect(flightDataForExport(zero)).toHaveProperty('B');
    }
  });
  it('keeps working records first and stored references first when tied mounts carry pad weights', () => {
    const weighted = { ...motor, padMassKg: 2 };
    const refs = { b: { mountId: 'b', designation: 'missing', manufacturer: 'Test', diameter: 0.029,
      length: 0.1, delay: 5, padMassKg: 3, digest: 'original' } };
    const working = exportMotorsMap({ assigned: [['a', weighted]], unmatchedRefs: refs, tree, activeConfigId: 'A', exLibrary }, { A: { a: 7 } });
    expect(Object.keys(working)).toEqual(['a', 'b']);
    expect(working.a).toMatchObject({ padMassKg: 2, delay: 7 });
    expect(working.b).not.toHaveProperty('padMassKg');
    expect(working.b).toMatchObject({ designation: 'missing', digest: 'original' });
    const stored = exportConfigs([config({ motors: { a: weighted }, unmatchedRefs: refs })], tree, exLibrary, { A: { a: 9 } });
    expect(Object.keys(stored[0]!.motors)).toEqual(['b', 'a']);
    expect(stored[0]!.motors.b).toHaveProperty('padMassKg', 3);
    expect(stored[0]!.motors.a).not.toHaveProperty('padMassKg');
    expect(stored[0]!.motors.a).toHaveProperty('delay', 9);
  });

  it('preserves sparse Option C layers, activeness, mass and refusal without materializing defaults', () => {
    const row = config({ ignitions: { a: { event: 'burnout', delay: 1 } },
      deployments: { chute: { deployEvent: 'ejection', deployAltitude: 800, deployDelay: 2 } },
      separations: { s: { separationEvent: 'never', separationAltitude: 20, separationDelay: 3 } },
      stageMassOverrides: { s: { overrideMass: 1 } }, nozzles: { s: null },
      stageActiveness: { s: false }, motorLoadoutRefusal: 'ambiguous' });
    const before = structuredClone(row);
    expect(exportConfigs([row], tree, exLibrary)[0]).toMatchObject({ ...row, motors: { a: expect.any(Object) } });
    const bare = exportConfigs([config()], tree, exLibrary)[0]!;
    for (const key of ['ignitions', 'deployments', 'separations', 'stageActiveness', 'nozzles']) expect(bare).not.toHaveProperty(key);
    expect(row).toEqual(before);
  });

  it('resolves live, inactive and detached flight owners using their own layers and motor sets', () => {
    const savedConfigs = [config(), config({ id: 'B', motors: { b: motor },
      ignitions: { b: { event: 'burnout', delay: 4 } },
      deployments: { chute: { deployEvent: 'ejection', deployAltitude: 800, deployDelay: 2 } } })];
    const aero = { aeroMode: 'classic' as const, effectiveKbf: false, autoSupersonic: false };
    const assigned: [string, typeof motor][] = [['a', motor]];
    const provenanceKey = provenanceKeyOf({ tree, physicsKey: physicsKeyOf(tree.components), assigned,
      hardwareDeltaKg: 0.3, launch: DEFAULT_CONDITIONS, aero });
    const input = flightExportInput({ tree, runs: [], savedConfigs, activeConfigId: 'A', assigned,
      mountMotors: { a: motor }, detachedOverrides: { ignitions: { a: { event: 'ejectioncharge', delay: 5 } } },
      refusedMountIds: ['a'], mounts: tree.components[0]!.children!.slice(0, 2), provenanceKey,
      hardwareDeltaKg: 0.3, launch: DEFAULT_CONDITIONS, ...aero });
    expect(input.mountIds).toEqual(['a', 'b']);
    expect(input.refusedMountIds).toEqual(['a']);
    expect(input.primaryMountOf(['b', 'a'])).toBe('b');
    const live = input.configurationState!('A');
    const inactive = input.configurationState!('B');
    expect(input.configurationState!('A')).toBe(live);
    expect(input.configurationState!('B')).toBe(inactive);
    const detached = input.configurationState!(null);
    expect(live.motors[0]![1].ignition).toEqual({ event: 'launch', delay: 2 });
    expect(inactive.motors.map(([id]) => id)).toEqual(['b']);
    expect(inactive.motors[0]![1].ignition).toEqual({ event: 'burnout', delay: 4 });
    expect(inactive.designKey).not.toBe(live.designKey);
    expect(detached.motors[0]![1].ignition).toEqual({ event: 'ejectioncharge', delay: 5 });
    expect(tree.components[0]!.children![2]!.deployEvent).toBe('apogee');
    expect(motor.ignition).toEqual({ event: 'automatic', delay: 0 });
  });
});

it('J23-N an inactive blank configuration keeps its own flown exit and export key', () => {
  const first = { ...motor, meta: { ...motor.meta, motorId: 'first' } };
  const second = { ...motor, meta: { ...motor.meta, motorId: 'second' },
    ignition: { event: 'launch' as const, delay: 2 } };
  const aero = { aeroMode: 'classic' as const, effectiveKbf: true, autoSupersonic: false };
  const lookup = (id: string) => id === 'first' ? 0.01 : 0.02;
  const flownTree = withFlownNozzles(tree, stageMotors(tree, [['a', second]]), lookup).tree;
  const expected = provenanceKeyOf({ tree: flownTree, physicsKey: physicsKeyOf(flownTree.components),
    assigned: [['a', second]], hardwareDeltaKg: 0, launch: DEFAULT_CONDITIONS, aero });
  const assembled = flightExportInput({ tree, runs: [], savedConfigs: [
    config({ motors: { a: first }, nozzles: { s: null } }),
    config({ id: 'B', motors: { a: second }, nozzles: { s: null } }),
  ], activeConfigId: 'A', assigned: [['a', first]], mountMotors: { a: first },
    detachedOverrides: {}, mounts: tree.components[0]!.children!.slice(0, 2),
    hardwareDeltaKg: 0, launch: DEFAULT_CONDITIONS, provenanceKey: expected, publishedExit: lookup, ...aero });
  expect(assembled.configurationState!('B').designKey).toBe(expected.designKey);
  expect(assembled.configurationState!('A').designKey).not.toBe(expected.designKey);
  expect(assembled.hasNozzle).toBe(true);
  expect(tree.components[0]!['nozzleExitDiameter']).toBeUndefined();
  const run = { id: 'inactive', flightConfigId: 'B', designKey: expected.designKey,
    conditionsKey: expected.conditionsKey, motorSetKey: expected.motorSetKey, motorDataKey: expected.motorDataKey,
    delayResolution: testResolution([['a', second]], [8]), physicsRevision: PHYSICS_REVISION,
    aeroModel: 'classic', rogersKbf: true, nozzleStages: ['Stage'], maxAltitude: 100 } as SimRun;
  assembled.runs = [run];
  expect(flightDataForExport(assembled)).toHaveProperty('B');
});

it('J23N r5 configurations use the live EX library, retaining owner exits only after deletion', () => {
  const ex = { ...parseEng('G100 18 70 5 0.01 0.025 Home\n0 0\n0.1 100\n1 0\n')[0]!, exitDiameterM: 0.008 };
  const first = { ...motor, spec: exToMotorSpec(ex, 5), meta: { label: 'EX', exMotorId: ex.motorId } };
  const second = { ...first, spec: exToMotorSpec({ ...ex, exitDiameterM: 0.009 }, 5) };
  addExMotors([{ ...ex, exitDiameterM: 0.012 }]);
  const aero = { aeroMode: 'classic' as const, effectiveKbf: true, autoSupersonic: false };
  const expected = (mm: typeof first, exit: number) => {
    const flown = withFlownNozzles(tree, stageMotors(tree, [['a', mm]]), () => exit).tree;
    return provenanceKeyOf({ tree: flown, physicsKey: physicsKeyOf(flown.components), assigned: [['a', mm]],
      hardwareDeltaKg: 0, launch: DEFAULT_CONDITIONS, aero });
  };
  const assemble = () => flightExportInput({ tree, runs: [], savedConfigs: [
    config({ motors: { a: first }, nozzles: { s: null } }),
    config({ id: 'B', motors: { a: second }, nozzles: { s: null } }),
  ], activeConfigId: 'A', assigned: [['a', first]], mountMotors: { a: first }, detachedOverrides: {},
    mounts: tree.components[0]!.children!.slice(0, 2), hardwareDeltaKg: 0, launch: DEFAULT_CONDITIONS,
    provenanceKey: expected(first, ex.exitDiameterM), ...aero });
  const assembled = assemble();
  expect(assembled.configurationState!('A').designKey).toBe(expected(first, 0.012).designKey);
  expect(assembled.configurationState!('B').designKey).toBe(expected(second, 0.012).designKey);
  deleteExMotor(ex.motorId);
  const retained = assemble();
  expect(retained.configurationState!('A').designKey).toBe(expected(first, 0.008).designKey);
  expect(retained.configurationState!('B').designKey).toBe(expected(second, 0.009).designKey);
});

it('J23N r3 inactive nozzle keys and Auto-delay evidence exclude that run\'s refused motors', () => {
  const accepted = { ...motor, meta: { ...motor.meta, motorId: 'accepted' }, ignition: { event: 'launch' as const, delay: 2 } };
  const refused = { ...motor, meta: { ...motor.meta, motorId: 'refused', autoDelay: false }, ignition: { event: 'launch' as const, delay: 0 } };
  const motors: [string, typeof motor][] = [['a', accepted], ['b', refused]];
  const lookup = (id: string) => id === 'accepted' ? 0.006 : 0.008;
  const aero = { aeroMode: 'classic' as const, effectiveKbf: true, autoSupersonic: false };
  const flownTree = withFlownNozzles(tree, stageMotors(tree, motors, ['b']), lookup).tree;
  const key = provenanceKeyOf({ tree: flownTree, physicsKey: physicsKeyOf(flownTree.components), assigned: motors,
    hardwareDeltaKg: 0, launch: DEFAULT_CONDITIONS, aero });
  const run = { id: 'refused-owner', flightConfigId: 'B', ...key,
    delayResolution: testResolution([['a', accepted]], [8]), refusedMountIds: ['b'],
    physicsRevision: PHYSICS_REVISION, aeroModel: 'classic', rogersKbf: true,
    nozzleStages: ['Stage'], maxAltitude: 100 } as unknown as SimRun;
  const assembled = flightExportInput({ tree, runs: [run], savedConfigs: [config(), config({ id: 'B',
    motors: Object.fromEntries(motors), nozzles: { s: null } })], activeConfigId: 'A', assigned: [['a', motor]],
    mountMotors: { a: motor }, detachedOverrides: {}, mounts: tree.components[0]!.children!.slice(0, 2),
    hardwareDeltaKg: 0, launch: DEFAULT_CONDITIONS, provenanceKey: key, publishedExit: lookup, ...aero });
  expect(flownAutoDelays(assembled)).toHaveProperty('B', { a: 8 });
  // The flown Auto input survives; a partial flight must still not represent both motors.
  expect(flightDataForExport(assembled)).not.toHaveProperty('B');
  const state = assembled.configurationState! as (id: string, refused?: readonly string[]) => { designKey: string };
  expect(state('B', ['b']).designKey).toBe(key.designKey);
  expect(state('B', []).designKey).not.toBe(key.designKey);
});

it('J23N r3 a typed nozzle on an inactive refused-only stage needs no flown nozzle stamp', () => {
  const typed = { ...tree, components: [{ ...tree.components[0]!, nozzleExitDiameter: 0.01 }] };
  const aero = { aeroMode: 'classic' as const, effectiveKbf: true, autoSupersonic: false };
  const key = provenanceKeyOf({ tree: typed, physicsKey: physicsKeyOf(typed.components), assigned: [['a', motor]],
    hardwareDeltaKg: 0, launch: DEFAULT_CONDITIONS, aero });
  const input = flightExportInput({ tree: typed, runs: [], savedConfigs: [config(), config({ id: 'B' })],
    activeConfigId: 'A', assigned: [['a', motor]], mountMotors: { a: motor }, detachedOverrides: {},
    mounts: tree.components[0]!.children!.slice(0, 2), hardwareDeltaKg: 0, launch: DEFAULT_CONDITIONS,
    provenanceKey: key, ...aero });
  expect(input.configurationState!('B', ['a']).hasNozzle).toBe(false);
  expect(input.configurationState!('B', []).hasNozzle).toBe(true);
});
