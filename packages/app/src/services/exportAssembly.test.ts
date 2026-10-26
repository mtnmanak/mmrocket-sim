import { describe, expect, it } from 'vitest';
import type { FlightTree, SavedConfig } from '../model/design.js';
import { testMotor } from './autoDelay.testSupport.js';
import { exportConfigs, exportMotorsMap, flightExportInput } from './exportAssembly.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { physicsKeyOf, provenanceKeyOf } from './designDerivation.js';

const motor = testMotor(true, 4);
const tree: FlightTree = { name: 'Layers', ignitionDefaults: { a: { event: 'launch', delay: 2 } }, components: [
  { type: 'stage', id: 's', separationEvent: 'never', children: [
    { type: 'innertube', id: 'a', motorMount: true }, { type: 'innertube', id: 'b', motorMount: true },
    { type: 'parachute', id: 'chute', deployEvent: 'apogee', deployAltitude: 100, deployDelay: 0 },
  ] },
] };
const config = (over: Partial<SavedConfig> = {}): SavedConfig => ({ id: 'A', name: 'A', isDefault: true, motors: { a: motor }, ...over });
const exLibrary = () => [];

describe('export assembly (S2-8)', () => {
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
      stageMassOverrides: { s: { overrideMass: 1 } }, stageActiveness: { s: false }, motorLoadoutRefusal: 'ambiguous' });
    const before = structuredClone(row);
    expect(exportConfigs([row], tree, exLibrary)[0]).toMatchObject({ ...row, motors: { a: expect.any(Object) } });
    const bare = exportConfigs([config()], tree, exLibrary)[0]!;
    for (const key of ['ignitions', 'deployments', 'separations', 'stageActiveness']) expect(bare).not.toHaveProperty(key);
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
