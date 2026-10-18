// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { FlightTree, LayeredSavedConfig, MountMotor } from '../model/design.js';
import { defaultTree, findNode, motorMounts, updateNode } from '../tree/treeModel.js';
import { createLoadedConfig, deleteConfig, syncActiveConfig } from './configSync.js';
import { planConfigSwitch } from './importApply.js';
import { resolveFlightState, snapshotFlightOverrides } from './flightState.js';
import { designStateFromSession } from './sessionRestore.js';
import { autosaveToOrk } from './autosaveBackup.js';
import { importOrk } from './orkFile.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { designFingerprint } from './dirtyState.js';
import { loadCatalogueMotor } from './motorMatch.js';
import { simulateDesign } from './simulateDesign.js';
import { padMassTextFor } from './unitText.js';
import { INITIAL_UNITS } from '../prefs/units.js';
import { restoreMotorLabels } from './motorLabels.js';

const own = { deployEvent: 'altitude', deployAltitude: 91.44, deployDelay: 0 };
const override = { deployEvent: 'ejection', deployAltitude: 200, deployDelay: 0 };
function fixture() {
  let tree: FlightTree = defaultTree();
  const chute = (() => {
    const visit = (nodes: typeof tree.components): string | undefined => {
      for (const n of nodes) { if (n.type === 'parachute') return n.id; const id = visit(n.children ?? []); if (id) return id; }
      return undefined;
    };
    return visit(tree.components)!;
  })();
  tree = updateNode(tree, chute, own);
  const mount = motorMounts(tree)[0]!.id!;
  const motor: MountMotor = { label: 'C6', spec: { designation: 'C6', diameter: 0.018, length: 0.07,
    ejectionDelay: 5, times: [0, 1, 2], thrusts: [0, 6, 0], masses: [0.024, 0.018, 0.012], cgX: 0.035 },
    meta: { label: 'C6', manufacturer: 'Estes', type: 'SU' }, ignition: { event: 'automatic', delay: 0 } };
  tree = { ...tree, ignitionDefaults: { [mount]: { event: 'automatic', delay: 0 } } };
  const a: LayeredSavedConfig = { id: 'a', name: 'A', isDefault: true, motors: { [mount]: motor },
    deployments: { [chute]: override }, ignitions: { [mount]: { event: 'launch', delay: 0.4 } } };
  const b: LayeredSavedConfig = { id: 'b', name: 'B', isDefault: false, motors: a.motors };
  const state = { tree, mountMotors: a.motors, savedConfigs: [a, b], activeConfigId: 'a',
    detachedOverrides: {}, unmatchedRefs: {}, launch: DEFAULT_CONDITIONS, measured: { massKg: null, cgM: null } };
  return { state, a, b, chute, mount };
}

describe('FC-4 layer boundaries', () => {
  it('Apply changes effective deployment without writing defaults or capturing defaults into overrides', () => {
    const { state, a, b, chute } = fixture();
    const synced = syncActiveConfig(state.savedConfigs, 'a', { tree: state.tree, motors: state.mountMotors, unmatchedRefs: {} });
    expect(synced[0]!.deployments).toEqual(a.deployments);
    const switched = planConfigSwitch({ ...state, activeConfigId: 'b' }, a, { ...padMassTextFor(INITIAL_UNITS), length: (v: number) => String(v) });
    expect(findNode(switched.tree, chute)).toMatchObject(own);
    expect(resolveFlightState(switched.tree, [a, b], 'a', {}, switched.mountMotors).tree)
      .not.toEqual(switched.tree);
  });
  it('New sparsely copies effective choices and Delete detaches them', () => {
    const { state, a, chute } = fixture();
    // App restores catalogue labels before editing; a switch must not be the
    // first label migration in this saved-mark regression.
    state.mountMotors = restoreMotorLabels(state.mountMotors);
    for (const config of state.savedConfigs) config.motors = state.mountMotors;
    const next = createLoadedConfig(state)!;
    expect(next.savedConfigs.at(-1)!.deployments).toEqual(a.deployments);
    expect(next.savedConfigs.at(-1)!.ignitions).toEqual(a.ignitions);
    expect(next.savedConfigs.at(-1)!.separations ?? {}).toEqual({});
    const deleted = deleteConfig(state.savedConfigs, 'a', 'a', state.detachedOverrides);
    expect(deleted.detachedOverrides.deployments).toEqual(a.deployments);
    expect(findNode(resolveFlightState(state.tree, deleted.savedConfigs, null, deleted.detachedOverrides, state.mountMotors).tree, chute))
      .toMatchObject(override);
    expect(findNode(resolveFlightState(state.tree, deleted.savedConfigs, null, {}, {}).tree, chute)).toMatchObject(own);
    expect(designFingerprint({ ...state, ...deleted })).not.toBe(designFingerprint({ ...state, ...deleted, detachedOverrides: {} }));
    const created = { ...state, ...deleted, ...createLoadedConfig({ ...state, ...deleted })! };
    expect(created.savedConfigs.at(-1)!.deployments).toEqual(a.deployments);
    const mark = designFingerprint(created);
    const text = { ...padMassTextFor(INITIAL_UNITS), length: (v: number) => String(v) };
    const away = planConfigSwitch(created, created.savedConfigs[0]!, text);
    const back = planConfigSwitch({ ...created, ...away }, created.savedConfigs.at(-1)!, text);
    // applyConfigSwitchPlan clears the detached layer at each switch.
    expect(designFingerprint({ ...created, ...back, detachedOverrides: {} })).toBe(mark);
  });
  it('restores legacy layers once and migrates the independent backup path', () => {
    const { state, a, b, chute } = fixture();
    const legacy = { ...state, tree: updateNode(state.tree, chute, override), savedAt: 1,
      // The active live setting changed since its snapshot: migration must
      // capture it before the layered writer stops baking the working tree.
      savedConfigs: [{ ...a, deployments: { [chute]: own } }, { ...b, deployments: { [chute]: own } }] };
    const restored = designStateFromSession(legacy, { legacyMaxMotorLengthM: null });
    expect(restored.state.configLayers).toBe(1);
    expect(restored.restoreNotes.join(' ')).toContain('Reopening the original file');
    expect(restored.state.savedConfigs[0]!.deployments).toEqual({});
    const reopened = importOrk(autosaveToOrk(legacy));
    expect(reopened.configs.find(c => c.id === 'a')!.deployments).toEqual({});
    const other = reopened.configs.find(c => c.id === 'b')!;
    expect(Object.values(other.deployments ?? {})).toEqual([own]);
    expect(designStateFromSession({ ...legacy, ...restored.state }, { legacyMaxMotorLengthM: null }).restoreNotes)
      .not.toContain(expect.stringContaining('Reopening the original file'));
  });
  it('New retains ignition overrides on unloaded mounts and detached save survives absent families', () => {
    const { state, mount, a } = fixture();
    expect(snapshotFlightOverrides(state.tree, state.savedConfigs, 'a', {}, {}).ignitions).toEqual(a.ignitions);
    const deleted = deleteConfig([{ ...a, deployments: undefined, separations: undefined }], 'a', 'a', {});
    const reopened = importOrk(autosaveToOrk({ ...state, ...deleted, configLayers: 1, savedAt: 1 }));
    expect(Object.values(reopened.configs[0]!.ignitions!)).toEqual([a.ignitions![mount]]);
  });
  it('headless resolves deployment and ignition before kernel construction and returns editable defaults', async () => {
    const { state, mount, chute } = fixture();
    const motor = (await loadCatalogueMotor('Estes', 'C6', 5))!;
    state.mountMotors = { [mount]: motor };
    const resolved = resolveFlightState(state.tree, state.savedConfigs, state.activeConfigId, {}, state.mountMotors);
    const expected = await simulateDesign({ ...state, ...resolved, tree: { ...resolved.tree, ignitionDefaults: undefined }, savedConfigs: [], activeConfigId: null });
    const actual = await simulateDesign(state);
    expect(actual.provenance).toEqual(expected.provenance);
    expect(actual.result.events).toEqual(expected.result.events);
    expect(findNode(actual.state.tree, chute)).toMatchObject(own);
  }, 30000);
});
