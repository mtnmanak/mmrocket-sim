import { describe, expect, it } from 'vitest';
import type { DeploymentTuple, FlightTree, LayeredSavedConfig, MountMotor } from '../model/design.js';
import { holdsOverrides, overrideFor, resetOverride, resolveFlightState, setOverride, sparsify, useOverrideEverywhere,
  workingSettingsOwnOverrides, snapshotFlightOverrides } from './flightState.js';
import { sameDeployment } from './deployOverrideNote.js';
import { snapshotLoadedConfig } from './configSnapshot.js';

const own: DeploymentTuple = { deployEvent: 'apogee', deployAltitude: 91.44, deployDelay: 0 };
const other: DeploymentTuple = { ...own, deployEvent: 'ejection' };
const motor = { label: 'F67', spec: { designation: 'F67', ejectionDelay: Infinity }, meta: {},
  ignition: { event: 'automatic', delay: 0 } } as MountMotor;
const tree = (): FlightTree => ({ name: 'Layers', ignitionDefaults: { mount: { event: 'launch', delay: 2 } },
  components: [{ type: 'stage', id: 'stage', separationEvent: 'never', separationDelay: 1,
    separationAltitude: 400, nozzleExitDiameter: 0, overrideMass: 2, children: [
      { type: 'parachute', id: 'chute', ...own }, { type: 'streamer', id: 'streamer', ...own },
      { type: 'innertube', id: 'mount' },
      { type: 'freeformfinset', id: 'fins', crossSection: 'rounded', points: [[0, 0], [1, 1], [1, 0]] },
    ] }] });
const config = (rest: Partial<LayeredSavedConfig> = {}): LayeredSavedConfig =>
  ({ id: 'A', name: null, isDefault: true, motors: {}, ...rest });

describe('flight-state layer algebra (FC-1)', () => {
  it('snapshots owned __proto__ recovery, separation and nozzle entries', () => {
    const input = tree();
    input.components[0]!.id = '__proto__';
    input.components[0]!.children![0]!.id = '__proto__';
    const direct = snapshotLoadedConfig(input, {});
    for (const map of [direct.deployments, direct.separations, direct.nozzles]) {
      expect(Object.keys(map)).toContain('__proto__');
      expect(Object.hasOwn(JSON.parse(JSON.stringify(map)), '__proto__')).toBe(true);
    }
    const deployment = { ...own, deployEvent: 'altitude' };
    const separation = { separationEvent: 'burnout', separationDelay: 3, separationAltitude: 500 };
    const overrides = snapshotFlightOverrides(input, [], null, {
      deployments: { ['__proto__']: deployment }, separations: { ['__proto__']: separation },
    }, {});
    expect(overrides.deployments).toEqual({ ['__proto__']: deployment });
    expect(overrides.separations).toEqual({ ['__proto__']: separation });
  });
  it.each(['constructor', 'toString'])('does not snapshot an inherited default for %s', id => {
    expect(snapshotFlightOverrides({ components: [], ignitionDefaults: {} }, [], null, {}, { [id]: motor }).ignitions)
      .toEqual({});
  });
  it('inherits defaults without materializing recovery fields and uses the supplied working motors', () => {
    const input = tree();
    const result = resolveFlightState(input, [config()], 'A', {}, { mount: motor });
    expect(result.tree).toBe(input);
    expect(result.mountMotors.mount).toEqual({ ...motor, ignition: { event: 'launch', delay: 2 } });
    expect(result.mountMotors.mount!.spec.ejectionDelay).toBe(Infinity);
    expect(motor.ignition).toEqual({ event: 'automatic', delay: 0 });
  });

  it('stores the whole tuple for one changed field, retaining dormant altitude exactly', () => {
    expect(sparsify(own, { ...own })).toBeUndefined();
    const dormant = { ...own, deployAltitude: own.deployAltitude + 1e-8 };
    expect(sameDeployment(own, dormant)).toBe(true);
    expect(sparsify(own, dormant)).toEqual(dormant);
    expect(setOverride({}, 'chute', own, other)).toEqual({ chute: other });
    expect(setOverride({ chute: other }, 'chute', own, own)).toEqual({});
    expect(sparsify(own, { ...own, deployDelay: 1e-12 })).toBeDefined();
  });

  it('keeps event spelling and unknown events; only the explanatory comparison folds case', () => {
    const mixed = { ...own, deployEvent: 'APOGEE' };
    expect(sameDeployment(own, mixed)).toBe(true);
    expect(sparsify(own, mixed)).toEqual(mixed);
    const unknown = { ...own, deployEvent: 'lowerstageseparation' };
    const result = resolveFlightState(tree(), [config({ deployments: { chute: unknown } })], 'A', {}, {});
    expect(result.tree.components[0]!.children![0]).toMatchObject(unknown);
  });

  it('resolves complete recovery and separation tuples without changing defaults, nozzles, mass or geometry', () => {
    const input = tree();
    const before = structuredClone(input);
    const sep = { separationEvent: 'burnout', separationDelay: 0, separationAltitude: 200 };
    const c = config({ deployments: { chute: other, streamer: other }, separations: { stage: sep },
      nozzles: { stage: 0.04 }, stageMassOverrides: { stage: {} }, stageActiveness: { stage: false } });
    const result = resolveFlightState(input, [c], 'A', {}, {});
    expect(result.tree.components[0]).toMatchObject({ ...sep, nozzleExitDiameter: 0, overrideMass: 2 });
    expect(result.tree.components[0]!.children!.slice(0, 2)).toEqual([
      { ...input.components[0]!.children![0], ...other }, { ...input.components[0]!.children![1], ...other },
    ]);
    expect(result.tree.components[0]!.children![3]).toBe(input.components[0]!.children![3]);
    expect(input).toEqual(before);
  });

  it('default edits cannot leak into a whole-tuple override; reset restores inheritance', () => {
    const input = tree();
    input.components[0]!.children![0]!.deployAltitude = 800;
    const maps = { chute: other };
    expect(overrideFor(maps, 'chute')).toEqual(other);
    const resolved = resolveFlightState(input, [config({ deployments: maps })], 'A', {}, {});
    expect(resolved.tree.components[0]!.children![0]!.deployAltitude).toBe(91.44);
    const reset = resetOverride(maps, 'chute');
    expect(reset).toEqual({});
    expect(maps).toEqual({ chute: other });
    expect(resolveFlightState(input, [config({ deployments: reset })], 'A', {}, {}).tree).toBe(input);
  });

  it('use everywhere adopts the tuple and clears every entry, including detached and removed ids', () => {
    const maps: Record<string, DeploymentTuple>[] = [{ chute: other, gone: own }, { chute: own }, { chute: other }];
    const result = useOverrideEverywhere('chute', other, maps);
    expect(result).toEqual({ defaultTuple: other, overrideMaps: [{ gone: own }, {}, {}] });
    expect(maps[0]!.chute).toBe(other);
  });

  it('retains removed-device entries for undo but does not invent components or motor records', () => {
    const c = config({ deployments: { gone: other }, ignitions: { absentMount: { event: 'never', delay: 3 } } });
    const input = tree();
    expect(resolveFlightState(input, [c], 'A', {}, {}).tree).toBe(input);
    expect(resolveFlightState(input, [c], 'A', {}, {}).mountMotors).toEqual({});
    input.components[0]!.children!.push({ type: 'parachute', id: 'gone', ...own });
    expect(resolveFlightState(input, [c], 'A', {}, {}).tree.components[0]!.children!.at(-1)).toMatchObject(other);
    expect(c.deployments!.gone).toEqual(other);
  });

  it.each([null, 'deleted'])('uses detached overrides with no matching active configuration (%s)', active => {
    const detached = { deployments: { chute: other }, ignitions: { mount: { event: 'never' as const, delay: 5 } } };
    const result = resolveFlightState(tree(), [config()], active, detached, { mount: motor });
    expect(result.tree.components[0]!.children![0]).toMatchObject(other);
    expect(result.mountMotors.mount!.ignition).toEqual(detached.ignitions.mount);
    expect(resolveFlightState(tree(), [config()], 'A', detached, { mount: motor }).mountMotors.mount!.ignition)
      .toEqual({ event: 'launch', delay: 2 });
  });

  it('ignition overrides replace the default tuple and reset exposes it; pre-layer motors keep their fallback', () => {
    const tuple = { event: 'burnout' as const, delay: 4 };
    const c = config({ ignitions: { mount: tuple } });
    expect(resolveFlightState(tree(), [c], 'A', {}, { mount: motor }).mountMotors.mount!.ignition).toEqual(tuple);
    c.ignitions = resetOverride(c.ignitions, 'mount');
    expect(resolveFlightState(tree(), [c], 'A', {}, { mount: motor }).mountMotors.mount!.ignition)
      .toEqual({ event: 'launch', delay: 2 });
    const oldTree = { components: tree().components };
    const motors = { mount: motor };
    expect(resolveFlightState(oldTree, [], null, {}, motors).mountMotors).toBe(motors);
  });

  it('the working settings own an override layer with no active configuration while saved ones exist or they hold one (review of CFG-2)', () => {
    const c = config();
    const held = { deployments: { chute: other } };
    expect(holdsOverrides({})).toBe(false);
    expect(holdsOverrides({ deployments: {}, separations: {}, ignitions: {} })).toBe(false);
    expect(holdsOverrides(held)).toBe(true);
    // An active configuration owns its overrides; the working settings own none.
    expect(workingSettingsOwnOverrides([c], 'A', held)).toBe(false);
    // Detached, with a saved configuration left: owner even with no override held.
    expect(workingSettingsOwnOverrides([c], null, {})).toBe(true);
    expect(workingSettingsOwnOverrides([c], 'deleted', { deployments: {} })).toBe(true);
    // No saved configuration: owner only while holding an override.
    expect(workingSettingsOwnOverrides([], null, {})).toBe(false);
    expect(workingSettingsOwnOverrides([], null, held)).toBe(true);
  });
});
