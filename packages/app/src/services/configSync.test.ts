// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { MountMotor, SavedConfig } from '../model/design.js';
import type { OrkMotorRef } from './orkFile.js';
import { designFingerprint, type DesignSnapshot } from './dirtyState.js';
import { LEGACY_PAD_MASS_KEY } from './hardwareMass.js';
import {
  adoptsRefPadMass, assignMotorRecord, migrateLegacyPadMass, padMassSetKey, restoreUnmatchedRefs, stripPadMass,
  stripRefPadMass, syncActiveConfig, withActiveConfigSynced, withActiveConfigTreeSynced, withoutStoredRef,
  createLoadedConfig, renameConfig, deleteConfig,
} from './configSync.js';
import { exportOrk, importOrk } from './orkFile.js';
import { orkMotorSet } from './orkExportMotors.js';
import { encodeShareFragment, decodeShareFragment } from './shareLink.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { motorMounts } from '../tree/treeModel.js';
import { planConfigSwitch, planImport, resolveImportMotors } from './importApply.js';

describe('configuration editing', () => {
  const working = () => {
    const tree = twoStage();
    Object.assign(tree.components[0]!, { nozzleExitDiameter: 0.012, overrideMass: 2.5, overrideCGX: 0.4 });
    Object.assign(tree.components[1]!, { separationEvent: 'burnout', separationDelay: 1.5, nozzleExitDiameter: 0 });
    tree.components[0]!.children!.push({ type: 'parachute', id: 'chute', diameter: 0.5,
      deployEvent: 'altitude', deployAltitude: 150, deployDelay: 0.5 });
    return { ...snapshot({ 's-mmt': { ...motor('F67W', 6), ignition: { event: 'launch' as const, delay: 0.5 },
      padMassKg: 3, padMassWeighedWith: 'measured-set' } },
    [cfg('A', { 's-mmt': motor('F67C') }, { stageActiveness: { s2: false }, stageMassOverrides: { s1: {}, s2: {} },
      nozzles: { s1: null, s2: null }, deployments: { chute: { deployEvent: 'apogee' } },
      separations: { s1: { separationEvent: 'ejection' }, s2: { separationEvent: 'ejection' } } })], 'A'),
    tree, unmatchedRefs: { 'b-mmt': ref('Missing') } };
  };

  it('snapshots every per-configuration field, activates it, and leaves the previous active unchanged', () => {
    const state = working();
    const before = structuredClone(state);
    const next = createLoadedConfig(state)!;
    const created = next.savedConfigs[1]!;
    expect(next.savedConfigs[0]).toBe(state.savedConfigs[0]);
    expect(state).toEqual(before);
    expect(created).toEqual({ id: next.activeConfigId, name: null, isDefault: false,
      motors: state.mountMotors, unmatchedRefs: state.unmatchedRefs, unmatched: ['Missing'],
      stageActiveness: { s2: false }, stageMassOverrides: { s1: { overrideMass: 2.5, overrideCGX: 0.4 }, s2: {} },
      nozzles: { s1: 0.012, s2: 0 },
      deployments: { chute: { deployEvent: 'altitude', deployAltitude: 150, deployDelay: 0.5 } },
      separations: { s1: { separationEvent: 'ejection', separationDelay: 0, separationAltitude: 200 },
        s2: { separationEvent: 'burnout', separationDelay: 1.5, separationAltitude: 200 } } });
    expect(created.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    expect(created.motors).not.toBe(state.mountMotors);
    expect(createLoadedConfig(state)!.activeConfigId).not.toBe(created.id);
  });

  it('refuses no motors, orphaned motors, and 256 configurations; permits the 256th', () => {
    const state = working();
    expect(createLoadedConfig({ ...state, mountMotors: {} })).toBeNull();
    expect(createLoadedConfig({ ...state, mountMotors: { deleted: motor('F67W') } })).toBeNull();
    const configs = Array.from({ length: 256 }, (_, i) => cfg(String(i), {}));
    expect(createLoadedConfig({ ...state, savedConfigs: configs })).toBeNull();
    expect(createLoadedConfig({ ...state, savedConfigs: configs.slice(1) })!.savedConfigs).toHaveLength(256);
  });

  it('captures automatic nozzles and the writer separation fallback without inventing values', () => {
    for (const value of [undefined, NaN, Infinity, -0.01]) {
      const state = working();
      state.tree.components[0]!['nozzleExitDiameter'] = value;
      state.tree.components[0]!['separationEvent'] = 7;
      const created = createLoadedConfig(state)!.savedConfigs[1]!;
      expect(created.nozzles?.['s1']).toBeNull();
      expect(created.separations?.['s1']?.separationEvent).toBe('ejection');
    }
  });

  it('rename trims and caps names, and empty means unnamed', () => {
    const state = working();
    expect(renameConfig(state.savedConfigs, 'A', '  Club field  ')[0]!.name).toBe('Club field');
    expect(renameConfig(state.savedConfigs, 'A', ' '.repeat(3))[0]!.name).toBeNull();
    expect(renameConfig(state.savedConfigs, 'A', 'x'.repeat(101))[0]!.name).toHaveLength(100);
  });

  it('unchanged names preserve identity and the dirty fingerprint, including untouched imported names', () => {
    for (const name of [null, 'Club field', '  padded  ', 'x'.repeat(120)]) {
      const state = working();
      state.savedConfigs[0]!.name = name;
      const next = renameConfig(state.savedConfigs, 'A', name ?? '');
      expect(next).toBe(state.savedConfigs);
      expect(designFingerprint({ ...state, savedConfigs: next })).toBe(designFingerprint(state));
    }
    const configs = [cfg('A', {}, { name: null })];
    expect(renameConfig(configs, 'A', '   ')).toBe(configs);
    configs[0]!.name = 'Club';
    expect(renameConfig(configs, 'A', ' Club ')).toBe(configs);
  });

  it('plain stage mass stays design-wide through Create, Apply A, edit, Apply C, Apply A', () => {
    let state: DesignSnapshot & { unmatchedRefs: Record<string, OrkMotorRef> } = working();
    delete state.savedConfigs[0]!.stageMassOverrides;
    state = { ...state, ...createLoadedConfig(state)! };
    const createdId = state.activeConfigId!;
    const apply = (id: string) => {
      const plan = planConfigSwitch(state, state.savedConfigs.find(c => c.id === id)!,
        { mass: kg => `${kg} kg`, length: m => `${m} m` });
      state = { ...state, ...plan };
    };
    apply('A');
    state.tree = structuredClone(state.tree);
    state.tree.components[0]!.overrideMass = 1.2;
    apply(createdId);
    expect(state.tree.components[0]!.overrideMass).toBe(1.2);
    apply('A');
    expect(state.tree.components[0]!.overrideMass).toBe(1.2);
    expect(state.savedConfigs.every(c => c.stageMassOverrides === undefined)).toBe(true);
  });

  it.each(['nozzles', 'deployments', 'separations'] as const)(
    'unowned %s stay design-wide through Create, Apply A, edit, Apply C, Apply A', (family) => {
      for (const empty of [undefined, {}]) {
        let state: DesignSnapshot & { unmatchedRefs: Record<string, OrkMotorRef> } = working();
        state.savedConfigs[0]![family] = empty;
        state = { ...state, ...createLoadedConfig(state)! };
        const createdId = state.activeConfigId!;
        const apply = (id: string) => {
          state = { ...state, ...planConfigSwitch(state, state.savedConfigs.find(c => c.id === id)!,
            { mass: kg => `${kg} kg`, length: m => `${m} m` }) };
        };
        const settings = (tree: RocketTree) => family === 'deployments'
          ? tree.components[0]!.children!.find(n => n.id === 'chute')!
          : tree.components[family === 'separations' ? 1 : 0]!;
        const edit = family === 'nozzles' ? { nozzleExitDiameter: 0.02 }
          : family === 'deployments' ? { deployEvent: 'altitude', deployAltitude: 300, deployDelay: 2 }
          : { separationEvent: 'apogee', separationDelay: 3, separationAltitude: 400 };
        apply('A');
        state.tree = structuredClone(state.tree);
        Object.assign(settings(state.tree), edit);
        apply(createdId);
        expect(settings(state.tree)).toMatchObject(edit);
        apply('A');
        expect(settings(state.tree)).toMatchObject(edit);
        expect(state.savedConfigs.every(c => Object.keys(c[family] ?? {}).length === 0)).toBe(true);
      }
    });

  it.each(['nozzles', 'deployments', 'separations'] as const)(
    'new components keep shared %s through Create, Apply A, edit, Apply C, Apply A', (family) => {
      for (const firstCreated of [false, true]) {
        let state: DesignSnapshot & { unmatchedRefs: Record<string, OrkMotorRef> } = working();
        if (firstCreated) {
          state.savedConfigs = [];
          state.activeConfigId = null;
          state = { ...state, ...createLoadedConfig(state)! };
        }
        const originalId = state.activeConfigId!;
        const newId = family === 'deployments' ? 'ch2' : 's3';
        if (family === 'deployments') state.tree.components[0]!.children!.push({
          type: 'parachute', id: newId, deployEvent: 'apogee', deployAltitude: 200,
        });
        else state.tree.components.push({ type: 'stage', id: newId, children: [],
          separationEvent: 'burnout', separationDelay: 1, nozzleExitDiameter: 0.012,
          overrideMass: 2, overrideCGX: 0.4 });
        state = { ...state, ...createLoadedConfig(state)! };
        const createdId = state.activeConfigId!;
        const apply = (id: string) => {
          state = { ...state, ...planConfigSwitch(state, state.savedConfigs.find(c => c.id === id)!,
            { mass: kg => `${kg} kg`, length: m => `${m} m` }) };
        };
        const added = () => family === 'deployments'
          ? state.tree.components[0]!.children!.find(n => n.id === newId)!
          : state.tree.components.find(n => n.id === newId)!;
        const edit = family === 'deployments' ? { deployEvent: 'altitude', deployAltitude: 300, deployDelay: 2 }
          : family === 'separations' ? { separationEvent: 'apogee', separationDelay: 3, separationAltitude: 400 }
            : { nozzleExitDiameter: 0.02 };
        apply(originalId);
        state.tree = structuredClone(state.tree);
        Object.assign(added(), edit);
        apply(createdId);
        expect(added()).toMatchObject(edit);
        apply(originalId);
        expect(added()).toMatchObject(edit);
        expect(state.savedConfigs.every(c => !Object.hasOwn(c[family] ?? {}, newId))).toBe(true);
      }
    });

  it.each(['nozzles', 'deployments', 'separations'] as const)(
    'Create takes the union of component IDs for %s', (family) => {
      const state = working();
      state.tree.components[0]!.children!.push({ type: 'streamer', id: 'ch2', deployAltitude: 300 });
      const b = cfg('B', {}, { nozzles: { s2: 0 }, separations: { s2: { separationEvent: 'burnout' } },
        stageMassOverrides: { s2: {} }, deployments: { ch2: { deployEvent: 'apogee' } } });
      state.savedConfigs[0]!.nozzles = { s1: null };
      state.savedConfigs[0]!.separations = { s1: { separationEvent: 'ejection' } };
      state.savedConfigs[0]!.stageMassOverrides = { s1: {} };
      state.savedConfigs.push(b);
      const created = createLoadedConfig(state)!.savedConfigs[2]!;
      expect(Object.keys(created[family]!).sort()).toEqual(family === 'deployments' ? ['ch2', 'chute'] : ['s1', 's2']);
    });

  it('round 5: Create snapshots every stage when an existing stage-mass map is empty', () => {
    const state = working();
    state.savedConfigs[0]!.stageMassOverrides = {};
    const created = createLoadedConfig(state)!.savedConfigs[1]!;
    expect(created.stageMassOverrides).toEqual({ s1: { overrideMass: 2.5, overrideCGX: 0.4 }, s2: {} });
    expect(state.savedConfigs[0]!.stageMassOverrides).toEqual({});
  });

  it.each(['nozzles', 'deployments', 'separations', 'stageMassOverrides'] as const)(
    'Create snapshots %s when another existing configuration owns it', (family) => {
      const state = working();
      const expected = createLoadedConfig(state)!.savedConfigs[1]![family];
      const owner = { ...state.savedConfigs[0]!, id: 'B' };
      delete state.savedConfigs[0]![family];
      state.savedConfigs.push(owner);
      const created = createLoadedConfig(state)!.savedConfigs[2]!;
      expect(Object.keys(expected ?? {}).length).toBeGreaterThan(0);
      expect(created[family]).toEqual(expected);
      expect(state.savedConfigs[0]![family]).toBeUndefined();
    });

  it('the first Create snapshots recovery, separation and nozzles, keeping stage mass design-wide', () => {
    const state = { ...working(), savedConfigs: [], activeConfigId: null };
    const created = createLoadedConfig(state)!.savedConfigs[0]!;
    expect(created.deployments?.['chute']).toMatchObject({ deployEvent: 'altitude', deployAltitude: 150 });
    expect(created.separations?.['s2']).toMatchObject({ separationEvent: 'burnout', separationDelay: 1.5 });
    expect(created.nozzles).toEqual({ s1: 0.012, s2: 0 });
    expect(created.stageMassOverrides).toBeUndefined();
  });

  it('Create on a plain design writes no stage-mass extension or warning', () => {
    const state = { ...working(), tree: twoStage(), savedConfigs: [], activeConfigId: null };
    const next = createLoadedConfig(state)!;
    const notes: string[] = [];
    const xml = exportOrk({ name: 'Plain', tree: state.tree, launch: DEFAULT_CONDITIONS,
      configs: next.savedConfigs.map(c => ({ ...c, motors: {} })), activeConfigId: next.activeConfigId, notes });
    expect(next.savedConfigs[0]!.stageMassOverrides).toBeUndefined();
    expect(xml).not.toContain('stagemassconfiguration');
    expect(notes.join(' ')).not.toContain('Per-configuration stage mass');
  });

  it('create, rename, and delete each change the unsaved-work fingerprint', () => {
    const state = working();
    for (const next of [createLoadedConfig(state)!,
      { savedConfigs: renameConfig(state.savedConfigs, 'A', 'Club field') },
      deleteConfig(state.savedConfigs, state.activeConfigId, 'A')]) {
      expect(designFingerprint({ ...state, ...next })).not.toBe(designFingerprint(state));
    }
  });

  const write = (state: ReturnType<typeof working>) => {
    const map = (motors: Record<string, MountMotor>, refs = {}) => orkMotorSet({ records: motors,
      refs, tree: state.tree, flown: {}, configKey: '', exLibrary: () => [], first: 'records' });
    return exportOrk({ name: 'Configs', tree: state.tree, launch: DEFAULT_CONDITIONS,
      activeConfigId: state.activeConfigId, motors: map(state.mountMotors, state.unmatchedRefs),
      configs: state.savedConfigs.map(c => ({ ...c, motors: map(c.motors, c.unmatchedRefs) })) });
  };

  it('two creates with different motors survive save and a share link with names, IDs, and active default', async () => {
    let state = { ...working(), savedConfigs: [] as SavedConfig[], activeConfigId: null as string | null };
    state.mountMotors = { 's-mmt': motor('F67C') };
    state = { ...state, ...createLoadedConfig(state)! };
    const firstId = state.activeConfigId;
    state.mountMotors = { 's-mmt': motor('F67W') };
    state = { ...state, ...createLoadedConfig(state)! };
    const name = 'Club <field> & "Été"';
    state.savedConfigs = renameConfig(state.savedConfigs, state.activeConfigId!, name);
    const xml = write(state as ReturnType<typeof working>);
    for (const payload of [xml, await decodeShareFragment(await encodeShareFragment(xml))]) {
      const reopened = importOrk(payload);
      expect(reopened.configs.map(c => c.id)).toEqual([firstId, state.activeConfigId]);
      expect(reopened.configs.map(c => c.name)).toEqual([null, name]);
      expect(reopened.configs.map(c => c.isDefault)).toEqual([false, true]);
      expect(Object.values(reopened.configs[0]!.motors).map(m => m.designation)).toContain('F67C');
      expect(Object.values(reopened.configs[1]!.motors).map(m => m.designation)).toContain('F67W');
    }
  });

  it('round 7: opening an app-written dry file then creating two motor sets keeps exactly two configurations', async () => {
    const launch = { ...DEFAULT_CONDITIONS, launchRodLengthM: 2.4, windAverage: 4, launchAltitudeM: 1350 };
    const dry = exportOrk({ name: 'Dry', tree: twoStage(), motors: {}, launch });
    expect(dry.match(/<motorconfiguration /g)).toHaveLength(1);
    expect(dry.match(/<simulation /g)).toHaveLength(1);
    const imported = importOrk(dry);
    const plan = planImport(imported, await resolveImportMotors(imported), { launch: DEFAULT_CONDITIONS,
      text: { mass: n => `${n} kg`, length: n => `${n} m` } });
    let state = { ...plan.snapshot, unmatchedRefs: plan.unmatchedRefs };
    expect(state.savedConfigs).toEqual([]);
    expect(state.activeConfigId).toBeNull();
    expect(state.launch).toMatchObject({ launchRodLengthM: 2.4, windAverage: 4, launchAltitudeM: 1350 });
    const mountId = motorMounts(state.tree)[0]!.id!;
    for (const designation of ['F67C', 'F67W']) {
      state = { ...state, mountMotors: { [mountId]: motor(designation) } };
      state = { ...state, ...createLoadedConfig(state)! };
    }
    expect(state.savedConfigs).toHaveLength(2);
    const reopened = importOrk(write(state as ReturnType<typeof working>));
    expect(reopened.configs.map(c => Object.values(c.motors).map(m => m.designation)))
      .toEqual([['F67C'], ['F67W']]);
    expect(reopened.configs.map(c => c.id)).toEqual(state.savedConfigs.map(c => c.id));
    expect(reopened.chosenConfigId).toBe(state.activeConfigId);
  });

  it('deletes the active default without touching working settings; save appends an unnamed default', () => {
    const state = working();
    const before = structuredClone(state);
    const survivor = cfg('B', { 's-mmt': motor('F67C') });
    state.savedConfigs.push(survivor);
    const next = deleteConfig(state.savedConfigs, 'A', 'A');
    expect(next).toEqual({ savedConfigs: [survivor], activeConfigId: null });
    expect(survivor.isDefault).toBe(false);
    const result = { ...state, ...next };
    expect(result.mountMotors).toEqual(before.mountMotors);
    expect(result.tree).toEqual(before.tree);
    expect(result.unmatchedRefs).toEqual(before.unmatchedRefs);
    const reopened = importOrk(write(result as ReturnType<typeof working>));
    expect(reopened.configs).toHaveLength(2);
    expect(reopened.configs.map(c => c.id)).not.toContain('A');
    expect(reopened.configs.find(c => c.isDefault)?.name).toBeNull();
    const unloaded = importOrk(write({ ...result, mountMotors: {}, unmatchedRefs: {} } as ReturnType<typeof working>));
    expect(unloaded.configs).toMatchObject([{ id: 'B', isDefault: true }]);
    expect(deleteConfig(state.savedConfigs, 'A', 'B').activeConfigId).toBe('A');
  });
});

/**
 * The working motor set written back into its flight configuration (v0.118).
 * Until now `savedConfigs` was written only at init / New / import, so a
 * delay edit — and now the weighed pad mass — was lost on A→B→A and reached
 * the file only when saved with its own configuration on screen; and the
 * working set's unmatched references were not persisted, so a reload's only
 * copy was the configuration's. Every case here is one of those lifecycles.
 */

const motor = (designation: string, delay = 10): MountMotor => ({
  label: `${designation}-${delay}`,
  spec: {
    designation, diameter: 0.054, length: 0.41, cgX: 0.2, ejectionDelay: delay,
    times: [0, 1], thrusts: [0, 0], masses: [1.084, 0.6],
  },
  meta: { label: designation, manufacturer: 'AeroTech' },
  ignition: { event: 'automatic', delay: 0 },
});

const ref = (designation: string): OrkMotorRef => ({
  designation, manufacturer: 'Loki', diameter: 0.075, length: 0.6, delay: 0, digest: `d-${designation}`,
});

const cfg = (id: string, motors: Record<string, MountMotor>, extra: Partial<SavedConfig> = {}): SavedConfig => ({
  id, name: id, isDefault: id === 'A', motors, ...extra,
});

/** Two stages: sustainer mount 's-mmt' (stage 0), booster mount 'b-mmt' (stage 1). */
const twoStage = (): RocketTree => ({
  name: 'two',
  components: [
    {
      type: 'stage', id: 's1', name: 'Sustainer',
      children: [{
        type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.025, thickness: 0.0005,
        children: [{
          type: 'innertube', id: 's-mmt', length: 0.4, outerRadius: 0.038, thickness: 0.0005, motorMount: true,
        } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode,
    {
      type: 'stage', id: 's2', name: 'Booster',
      children: [{
        type: 'bodytube', id: 'b2', length: 0.5, outerRadius: 0.025, thickness: 0.0005,
        children: [{
          type: 'innertube', id: 'b-mmt', length: 0.4, outerRadius: 0.038, thickness: 0.0005, motorMount: true,
        } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode,
  ],
});

const snapshot = (
  mountMotors: Record<string, MountMotor>, savedConfigs: SavedConfig[], activeConfigId: string | null,
): DesignSnapshot => ({
  tree: twoStage(),
  mountMotors,
  launch: { windAvg: 3, timeStepS: 0.01 } as unknown as DesignSnapshot['launch'],
  maxMotorLengthByStage: {},
  savedConfigs,
  activeConfigId,
  measured: { massKg: null, cgM: null },
});

const KEY = '[["s-mmt","AeroTech/J540R",1]]';

describe('withActiveConfigSynced', () => {
  it('writes the working set into the active configuration and leaves the others by identity', () => {
    const A = cfg('A', { 's-mmt': motor('J540R') }, {
      separations: { s2: { event: 'launch', delay: 0 } } as unknown as SavedConfig['separations'],
      deployments: { chute: { event: 'apogee' } } as unknown as SavedConfig['deployments'],
      nozzles: { s1: 0.05 },
    });
    const B = cfg('B', { 's-mmt': motor('I284W') });
    const configs = [A, B];
    // A delay edit and a pad mass typed on A.
    const working: Record<string, MountMotor> = {
      's-mmt': { ...motor('J540R', 7), padMassKg: 10.574, padMassWeighedWith: KEY },
    };
    const out = withActiveConfigSynced(configs, 'A', working, {});
    expect(out).not.toBe(configs);
    expect(out[0]!.motors).toBe(working);             // verbatim, not copied
    expect(out[0]!.motors['s-mmt']!.spec.ejectionDelay).toBe(7);
    expect(out[0]!.motors['s-mmt']!.padMassKg).toBe(10.574);
    // Everything else on the row survives: id, name, default, separations, deployments, nozzles.
    expect(out[0]).toMatchObject({ id: 'A', name: 'A', isDefault: true });
    expect(out[0]!.separations).toBe(A.separations);
    expect(out[0]!.deployments).toBe(A.deployments);
    expect(out[0]!.nozzles).toBe(A.nozzles);
    // The other row is the SAME object, and the input array is untouched.
    expect(out[1]).toBe(B);
    expect(configs[0]).toBe(A);
    expect(A.motors['s-mmt']!.spec.ejectionDelay).toBe(10);
    // A record for a mount the tree no longer has rides along verbatim — an
    // undo-restored mount keeps its motor; the export gate ignores it.
    const withStale = { ...working, gone: motor('G80') };
    expect(withActiveConfigSynced(configs, 'A', withStale, {})[0]!.motors).toBe(withStale);
  });

  it('returns the input by identity when the active configuration already equals the working set (designFingerprint equality)', () => {
    const A = cfg('A', { 's-mmt': motor('J540R'), 'b-mmt': motor('I284W') });
    const configs = [A, cfg('B', { 's-mmt': motor('I284W') })];
    // A structurally equal working set built in the OTHER key order — an
    // import writes file order, editing writes click order.
    const working: Record<string, MountMotor> = {};
    working['b-mmt'] = { ...motor('I284W') };
    working['s-mmt'] = { ...motor('J540R') };
    expect(Object.keys(working).join()).not.toBe(Object.keys(A.motors).join());
    expect(withActiveConfigSynced(configs, 'A', working, {})).toBe(configs);
    expect(designFingerprint(snapshot(working, withActiveConfigSynced(configs, 'A', working, {}), 'A')))
      .toBe(designFingerprint(snapshot(working, configs, 'A')));
    // Stored refs equal to the working refs: identity too.
    const withRefs = [cfg('A', { 's-mmt': motor('J540R') }, { unmatched: ['K1100T'], unmatchedRefs: { 'b-mmt': ref('K1100T') } })];
    expect(withActiveConfigSynced(withRefs, 'A', { 's-mmt': motor('J540R') }, { 'b-mmt': { ...ref('K1100T') } })).toBe(withRefs);
    // A row imported with `unmatched: []` and no refs is "already equal" to an
    // empty working set: absent and empty are the same stored fact.
    const emptyList = [cfg('A', { 's-mmt': motor('J540R') }, { unmatched: [] })];
    expect(withActiveConfigSynced(emptyList, 'A', { 's-mmt': motor('J540R') }, {})).toBe(emptyList);
  });

  it('replaces unmatched/unmatchedRefs: deletes both when the working refs are empty, derives unmatched in insertion order otherwise', () => {
    const A = cfg('A', { 's-mmt': motor('J540R') }, { unmatched: ['K1100T'], unmatchedRefs: { 'b-mmt': ref('K1100T') } });
    // The K1100T was loaded since: the working refs are empty, so BOTH keys
    // go — a `...c` spread alone would have left `unmatched: ['K1100T']`
    // beside nothing, and the applied note would still name it.
    const loaded = withActiveConfigSynced([A], 'A', { 's-mmt': motor('J540R'), 'b-mmt': motor('K1100T') }, {});
    expect('unmatched' in loaded[0]!).toBe(false);
    expect('unmatchedRefs' in loaded[0]!).toBe(false);
    // Two working refs, written booster-first: `unmatched` follows that order,
    // the order applyImported wrote them.
    const refs: Record<string, OrkMotorRef> = {};
    refs['b-mmt'] = ref('K1100T');
    refs['a-mmt'] = ref('J350W');
    const two = withActiveConfigSynced([A], 'A', { 's-mmt': motor('J540R') }, refs);
    expect(two[0]!.unmatched).toEqual(['K1100T', 'J350W']);
    expect(two[0]!.unmatchedRefs).toBe(refs);
  });

  it('a reload does not cost a configuration its unmatched references (restoreUnmatchedRefs + sync round trip)', () => {
    const A = cfg('A', { 's-mmt': motor('J540R') }, { unmatched: ['K1100T'], unmatchedRefs: { 'b-mmt': ref('K1100T') } });
    const configs = [A];
    // v0.117: the working refs were `useState({})` after a reload. Syncing THAT
    // back would have wiped the stored references — the file's only copy of
    // the K1100T and its <digest>.
    const wiped = withActiveConfigSynced(configs, 'A', A.motors, {});
    expect(wiped[0]!.unmatchedRefs).toBeUndefined();
    // v0.118: the working set is seeded from the active configuration, so the
    // write-back is a no-op and the configuration keeps its references.
    const restored = restoreUnmatchedRefs(configs, 'A', A.motors);
    expect(restored).toEqual({ 'b-mmt': ref('K1100T') });
    expect(withActiveConfigSynced(configs, 'A', A.motors, restored)).toBe(configs);
    // A mount that has a record now is not restored as unmatched: the motor
    // assigned after the import superseded the reference.
    expect(restoreUnmatchedRefs(configs, 'A', { ...A.motors, 'b-mmt': motor('K1100T') })).toEqual({});
    // Nothing to restore from: no configs, no active id, an id that names none, no refs.
    expect(restoreUnmatchedRefs(undefined, 'A', {})).toEqual({});
    expect(restoreUnmatchedRefs(configs, null, {})).toEqual({});
    expect(restoreUnmatchedRefs(configs, undefined, {})).toEqual({});
    expect(restoreUnmatchedRefs(configs, 'Z', {})).toEqual({});
    expect(restoreUnmatchedRefs([cfg('C', {})], 'C', {})).toEqual({});
  });

  /**
   * Audit 2026-09-22. A configuration-less import (a .rkt naming a motor the
   * catalogue lacks) has no configuration to hold its unresolved references,
   * so the working set was their only copy and a reload lost them — Save then
   * wrote the mount empty. The session now carries them, and its copy wins.
   */
  it('restores the session’s own copy of the working references when it carries one', () => {
    const rkt = { 'b-mmt': { ...ref('K1100T'), delay: Infinity } };
    // No configurations at all: the fallback has nothing to read.
    expect(restoreUnmatchedRefs(undefined, null, {})).toEqual({});
    expect(restoreUnmatchedRefs(undefined, null, {}, rkt)).toEqual(rkt);
    // Still minus a mount that has a record now.
    expect(restoreUnmatchedRefs(undefined, null, { 'b-mmt': motor('K1100T') }, rkt)).toEqual({});
    // The session's copy is the working set's truth, even with an active
    // configuration that still stores a reference the user has since removed.
    const A = cfg('A', { 's-mmt': motor('J540R') }, { unmatched: ['K1100T'], unmatchedRefs: { 'b-mmt': ref('K1100T') } });
    expect(restoreUnmatchedRefs([A], 'A', A.motors, {})).toEqual({});
    // A session written before the field: the active configuration's, as v0.118.
    expect(restoreUnmatchedRefs([A], 'A', A.motors, undefined)).toEqual({ 'b-mmt': ref('K1100T') });
  });

  it('returns the input by identity when there is no active configuration', () => {
    const configs = [cfg('A', { 's-mmt': motor('J540R') })];
    const working = { 's-mmt': motor('I284W') };
    expect(withActiveConfigSynced(configs, null, working, {})).toBe(configs);
    // An id no configuration has (a preset deleted under it) is the same as none.
    expect(withActiveConfigSynced(configs, 'nope', working, {})).toBe(configs);
    const none: SavedConfig[] = [];
    expect(withActiveConfigSynced(none, 'A', working, {})).toBe(none);
  });
});

describe('migrateLegacyPadMass', () => {
  it('attaches a v0.116 session’s pad mass to the in-tree primary with the legacy key, ignores a record for a deleted mount, reports dropped when no in-tree mount has a motor, and returns a session without one by identity', () => {
    const tree = twoStage();
    // Booster first in the record, a stale record for a mount long deleted:
    // the primary is still the sustainer's, and the stale id never sorts first.
    const motors: Record<string, MountMotor> = {
      'b-mmt': motor('I284W'), gone: motor('G80'), 's-mmt': motor('J540R'),
    };
    const m = migrateLegacyPadMass(motors, 10.574, tree);
    expect(m.outcome).toBe('attached');
    expect(m.mountId).toBe('s-mmt');
    expect(m.kg).toBe(10.574);
    expect(m.motors['s-mmt']).toEqual({ ...motor('J540R'), padMassKg: 10.574, padMassWeighedWith: LEGACY_PAD_MASS_KEY });
    expect(m.motors['b-mmt']).toBe(motors['b-mmt']);
    expect(m.motors['gone']).toBe(motors['gone']);
    expect('padMassKg' in motors['s-mmt']!).toBe(false);          // the input is untouched
    // Only the stale record, or no record at all (the motor was unloaded —
    // Eric's first screenshot): nothing to belong to. Dropped, input by identity.
    const stale = { gone: motor('G80') };
    expect(migrateLegacyPadMass(stale, 7.48, tree)).toEqual({ motors: stale, outcome: 'dropped', kg: 7.48 });
    expect(migrateLegacyPadMass(stale, 7.48, tree).motors).toBe(stale);
    const none = {};
    expect(migrateLegacyPadMass(none, 7.48, tree)).toEqual({ motors: none, outcome: 'dropped', kg: 7.48 });
    // An in-tree id that is not a motor mount (the body tube) is no home either.
    expect(migrateLegacyPadMass({ b1: motor('G80') }, 7.48, tree).outcome).toBe('dropped');
    // A booster-only set attaches to the booster: it is the topmost mount WITH a motor.
    expect(migrateLegacyPadMass({ 'b-mmt': motor('I284W') }, 7.48, tree).mountId).toBe('b-mmt');
    // No legacy value, in every shape a session can carry: identity, 'none'.
    for (const v of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '7.48', {}]) {
      const r = migrateLegacyPadMass(motors, v, tree);
      expect(r.motors, String(v)).toBe(motors);
      expect(r, String(v)).toEqual({ motors, outcome: 'none' });
    }
  });
});

describe('stripPadMass and stripRefPadMass', () => {
  it('remove the keys everywhere and return the input by identity when none carries one', () => {
    // Scale: the rocket that was weighed no longer exists.
    const plain = { 's-mmt': motor('J540R'), 'b-mmt': motor('I284W') };
    expect(stripPadMass(plain)).toBe(plain);
    const weighed: Record<string, MountMotor> = {
      's-mmt': { ...motor('J540R'), padMassKg: 10.574, padMassWeighedWith: KEY }, 'b-mmt': motor('I284W'),
    };
    const out = stripPadMass(weighed);
    expect(out).not.toBe(weighed);
    expect(out['s-mmt']).toEqual(motor('J540R'));
    expect('padMassKg' in out['s-mmt']!).toBe(false);
    expect('padMassWeighedWith' in out['s-mmt']!).toBe(false);
    expect(out['b-mmt']).toBe(weighed['b-mmt']);                  // untouched records keep identity
    expect(weighed['s-mmt']!.padMassKg).toBe(10.574);             // the input is untouched
    // Half a record — never written, cleared all the same.
    expect(stripPadMass({ 's-mmt': { ...motor('J540R'), padMassWeighedWith: KEY } })['s-mmt']).toEqual(motor('J540R'));

    const refs = { 'b-mmt': ref('K1100T') };
    expect(stripRefPadMass(refs)).toBe(refs);
    const refsWeighed: Record<string, OrkMotorRef> = {
      'b-mmt': { ...ref('K1100T'), padMassKg: 10.574 }, 'a-mmt': ref('J350W'),
    };
    const o2 = stripRefPadMass(refsWeighed);
    expect(o2).not.toBe(refsWeighed);
    expect(o2['b-mmt']).toEqual(ref('K1100T'));
    expect('padMassKg' in o2['b-mmt']!).toBe(false);
    expect(o2['a-mmt']).toBe(refsWeighed['a-mmt']);
    expect(refsWeighed['b-mmt']!.padMassKg).toBe(10.574);
  });
});

describe('assignMotorRecord — how a weighing survives loading a motor', () => {
  const ctx = (over: Partial<Parameters<typeof assignMotorRecord>[3]> = {}) => ({
    tree: twoStage(), primaryMountId: null as string | null, droppedRef: undefined, remainingRefs: {}, ...over,
  });

  it('the same motor re-picked for a different delay keeps both keys; a different motor starts blank', () => {
    // 2026-09-08 review: the card's delay controls spread the record, but a
    // re-pick through the browser (J460T-10 → J460T-14) replaced it and the
    // field went blank against the guide's "a delay change keeps the weighing".
    const prev: Record<string, MountMotor> = {
      's-mmt': { ...motor('J460T', 10), padMassKg: 7.48, padMassWeighedWith: KEY },
    };
    const same = assignMotorRecord(prev, 's-mmt', motor('J460T', 14), ctx({ primaryMountId: 's-mmt' }));
    expect(same['s-mmt']).toEqual({ ...motor('J460T', 14), padMassKg: 7.48, padMassWeighedWith: KEY });
    expect(same['s-mmt']!.spec.ejectionDelay).toBe(14);
    // A pending legacy value rides along too — the reconcile effect decides it.
    const legacy = { 's-mmt': { ...motor('J460T'), padMassKg: 7.48, padMassWeighedWith: LEGACY_PAD_MASS_KEY } };
    expect(assignMotorRecord(legacy, 's-mmt', motor('J460T', 7), ctx())['s-mmt']!.padMassWeighedWith)
      .toBe(LEGACY_PAD_MASS_KEY);
    // Another motor: a fresh record, no keys — the weighing belonged to the J460T.
    const other = assignMotorRecord(prev, 's-mmt', motor('J350W'), ctx({ primaryMountId: 's-mmt' }));
    expect(other['s-mmt']).toEqual(motor('J350W'));
    expect('padMassKg' in other['s-mmt']!).toBe(false);
    // The input is untouched and other records keep identity.
    expect(prev['s-mmt']!.spec.ejectionDelay).toBe(10);
    const withBooster = { ...prev, 'b-mmt': motor('I284W') };
    expect(assignMotorRecord(withBooster, 's-mmt', motor('J460T', 14), ctx())['b-mmt']).toBe(withBooster['b-mmt']);
  });

  it('the file’s own motor adopts the pad mass the file left on its reference, keyed to the post-assignment set', () => {
    // A .ork whose sustainer K550W could not be matched kept its pad mass on
    // the reference; the card said "Load that motor to use it". Loading it
    // must deliver — before this, the value was deleted and the note told the
    // user to re-weigh with the motor they had just loaded.
    const ref550 = { ...ref('K550W'), padMassKg: 10.574 };
    expect(adoptsRefPadMass(ref550, 'K550W')).toBe(10.574);
    expect(adoptsRefPadMass(ref550, 'k550w')).toBe(10.574);                // findDbMotor's rank-0 rule
    expect(adoptsRefPadMass(ref550, 'J350W')).toBeUndefined();
    expect(adoptsRefPadMass(ref('K550W'), 'K550W')).toBeUndefined();     // no value on the reference
    expect(adoptsRefPadMass({ ...ref('K550W'), padMassKg: 0 }, 'K550W')).toBeUndefined();
    expect(adoptsRefPadMass(undefined, 'K550W')).toBeUndefined();

    // Single mount: the value lands on the new record, keyed to that one motor.
    const alone = assignMotorRecord({}, 's-mmt', motor('K550W'), ctx({ droppedRef: ref550 }));
    expect(alone['s-mmt']!.padMassKg).toBe(10.574);
    expect(alone['s-mmt']!.padMassWeighedWith).toBe('[["s-mmt","AeroTech/K550W",1]]');
    // Staged, booster loaded: the key holds both mounts, so it equals what
    // App's currentSetKey will compute and the value applies at once.
    const booster = { 'b-mmt': motor('I284W') };
    const staged = assignMotorRecord(booster, 's-mmt', motor('K550W'),
      ctx({ primaryMountId: 'b-mmt', droppedRef: ref550 }));
    expect(staged['s-mmt']!.padMassWeighedWith).toBe('[["b-mmt","AeroTech/I284W",1],["s-mmt","AeroTech/K550W",1]]');
    expect(staged['b-mmt']).toBe(booster['b-mmt']);
    // Another reference still unmatched rides in as a sentinel, so the line
    // reads "load it to use the pad mass" instead of applying against a
    // sustainer-only catalogue sum; a reference for a mount the tree no
    // longer has is ignored, as the export ignores it.
    const half = assignMotorRecord({}, 's-mmt', motor('K550W'),
      ctx({ droppedRef: ref550, remainingRefs: { 'b-mmt': ref('J350W'), gone: ref('G80') } }));
    expect(half['s-mmt']!.padMassWeighedWith).toBe('[["b-mmt","unmatched:J350W",1],["s-mmt","AeroTech/K550W",1]]');
    // A different motor on that mount: fresh record, nothing adopted — the
    // caller drops the reference and says which motor the file weighed with.
    const other = assignMotorRecord({}, 's-mmt', motor('J350W'), ctx({ droppedRef: ref550 }));
    expect(other['s-mmt']).toEqual(motor('J350W'));
  });

  /**
   * A mount inside a POD SET fires once per pod, and App's `currentSetKey`
   * counts it that way (`mountMotorCount`). The adopted key used the cluster
   * alone, so a file's own motor adopting its pad mass in a three-pod design
   * wrote count 1 against a live key of 3 and read 'stale-set' at once (audit
   * 2026-09-22, row 351).
   */
  it('keys an adopted pad mass with the pod count App’s own set key uses', () => {
    const pods: RocketTree = {
      name: 'pods',
      components: [{
        type: 'stage', id: 's1', name: 'Sustainer',
        children: [{
          type: 'bodytube', id: 'b1', length: 0.5, outerRadius: 0.05, thickness: 0.0005,
          children: [{
            type: 'podset', id: 'pods', instanceCount: 3,
            children: [{
              type: 'bodytube', id: 'pb', length: 0.4, outerRadius: 0.03, thickness: 0.0005,
              children: [{
                type: 'innertube', id: 'p-mmt', length: 0.4, outerRadius: 0.028, thickness: 0.0005, motorMount: true,
              } as ComponentNode],
            } as ComponentNode],
          } as ComponentNode],
        } as ComponentNode],
      } as ComponentNode],
    };
    const ref550 = { ...ref('K550W'), padMassKg: 10.574 };
    const out = assignMotorRecord({}, 'p-mmt', motor('K550W'),
      ctx({ tree: pods, droppedRef: ref550 }));
    expect(out['p-mmt']!.padMassKg).toBe(10.574);
    expect(out['p-mmt']!.padMassWeighedWith).toBe('[["p-mmt","AeroTech/K550W",3]]');
  });

  it('the primary’s unmatched: sentinel for the loaded mount is rewritten to the loaded identity, count kept', () => {
    const key = '[["b-mmt","unmatched:I284W",2],["s-mmt","AeroTech/J540R",1]]';
    const prev: Record<string, MountMotor> = {
      's-mmt': { ...motor('J540R'), padMassKg: 11.158, padMassWeighedWith: key },
    };
    const out = assignMotorRecord(prev, 'b-mmt', motor('I284W'), ctx({ primaryMountId: 's-mmt' }));
    expect(out['s-mmt']!.padMassWeighedWith).toBe('[["b-mmt","AeroTech/I284W",2],["s-mmt","AeroTech/J540R",1]]');
    expect(out['s-mmt']!.padMassKg).toBe(11.158);
    expect(out['b-mmt']).toEqual(motor('I284W'));
    // Case-insensitive, as findDbMotor matches.
    expect(assignMotorRecord(prev, 'b-mmt', motor('i284w'), ctx({ primaryMountId: 's-mmt' }))['s-mmt']!.padMassWeighedWith)
      .toBe('[["b-mmt","AeroTech/i284w",2],["s-mmt","AeroTech/J540R",1]]');
    // A different motor there leaves the sentinel: the line will say the
    // file's motor is not loaded (stale-set 'changed').
    expect(assignMotorRecord(prev, 'b-mmt', motor('J350W'), ctx({ primaryMountId: 's-mmt' }))['s-mmt']).toBe(prev['s-mmt']);
    // A legacy key is never parsed.
    const legacy = { 's-mmt': { ...motor('J540R'), padMassKg: 11.158, padMassWeighedWith: LEGACY_PAD_MASS_KEY } };
    expect(assignMotorRecord(legacy, 'b-mmt', motor('I284W'), ctx({ primaryMountId: 's-mmt' }))['s-mmt']).toBe(legacy['s-mmt']);
  });
});

describe('withoutStoredRef', () => {
  it('assign → remove → reload does not resurrect the file’s motor on a mount the user emptied', () => {
    // 2026-09-08 review: assignMotor dropped the WORKING reference only; the
    // stored row kept it until a switch or save synced the two, and
    // restoreUnmatchedRefs reads the stored row — so a reload put the file's
    // K1100T back on a mount the user had assigned over and then emptied,
    // and Save wrote it.
    const A = cfg('A', { 's-mmt': motor('J540R') }, { unmatched: ['K1100T'], unmatchedRefs: { 'b-mmt': ref('K1100T') } });
    const configs = [A];
    // Assign a motor to b-mmt: the working ref goes, and now the stored one.
    const assigned = withoutStoredRef(configs, 'A', 'b-mmt');
    expect(assigned).not.toBe(configs);
    expect('unmatched' in assigned[0]!).toBe(false);
    expect('unmatchedRefs' in assigned[0]!).toBe(false);
    expect(assigned[0]!.motors).toBe(A.motors);                        // the rest of the row untouched
    expect(A.unmatchedRefs!['b-mmt']).toBeDefined();                    // the input is untouched
    // ✕ Remove on b-mmt, then a reload: nothing to seed the working set from.
    expect(restoreUnmatchedRefs(assigned, 'A', { 's-mmt': motor('J540R') })).toEqual({});
    // Whereas the un-dropped row would have brought it back.
    expect(restoreUnmatchedRefs(configs, 'A', { 's-mmt': motor('J540R') })).toEqual({ 'b-mmt': ref('K1100T') });
  });

  it('keeps the other references in order, and returns the input by identity when there is nothing to drop', () => {
    const refs: Record<string, OrkMotorRef> = {};
    refs['b-mmt'] = ref('K1100T');
    refs['a-mmt'] = ref('J350W');
    const A = cfg('A', { 's-mmt': motor('J540R') }, { unmatched: ['K1100T', 'J350W'], unmatchedRefs: refs });
    const B = cfg('B', {});
    const out = withoutStoredRef([A, B], 'A', 'b-mmt');
    expect(out[0]!.unmatched).toEqual(['J350W']);
    expect(out[0]!.unmatchedRefs).toEqual({ 'a-mmt': ref('J350W') });
    expect(out[1]).toBe(B);
    // Identity: no active row, an id no row has, a row without refs, a mount the row has no ref for.
    const configs = [A, B];
    expect(withoutStoredRef(configs, null, 'b-mmt')).toBe(configs);
    expect(withoutStoredRef(configs, 'Z', 'b-mmt')).toBe(configs);
    expect(withoutStoredRef(configs, 'B', 'b-mmt')).toBe(configs);
    expect(withoutStoredRef(configs, 'A', 's-mmt')).toBe(configs);
  });
});

/**
 * THE TREE'S HALF OF THE WRITE-BACK (audit 2026-09-22). Only the motors went
 * back into the configuration being left, so a deployment, separation or nozzle
 * changed in the app while A was active was overwritten by B's on the switch
 * and by A's FILE values on the way back — and a Save while B was active wrote
 * A's stale copy, because the .ork writer replays every non-active
 * configuration from what it stores.
 */
describe('withActiveConfigTreeSynced', () => {
  /** twoStage() plus a chute under the sustainer, a booster separation and a nozzle. */
  const live = (patch: { chute?: Record<string, unknown>; booster?: Record<string, unknown> } = {}): RocketTree => {
    const t = twoStage();
    const sus = t.components[0]!;
    sus.children![0]!.children = [...(sus.children![0]!.children ?? []),
      { type: 'parachute', id: 'chute', deployEvent: 'apogee', deployAltitude: 200, deployDelay: 0, ...patch.chute } as ComponentNode];
    Object.assign(t.components[1]!, { nozzleExitDiameter: 0.0254, ...patch.booster });
    return t;
  };
  const A = cfg('A', { 's-mmt': motor('J540R') }, {
    deployments: { chute: { deployEvent: 'apogee', deployAltitude: 200, deployDelay: 0 } },
    separations: { s2: { separationEvent: 'ejection', separationDelay: 0 } },
    nozzles: { s2: 0.0254 },
  });

  it('returns the input by identity when the tree still says what the configuration stores', () => {
    const configs = [A, cfg('B', {})];
    expect(withActiveConfigTreeSynced(configs, 'A', live())).toBe(configs);
    // A node carrying NO separation fields flies the fallbacks — 'ejection', 0 —
    // which is what A stores: still identity (the importer leaves defaults off).
    expect(live().components[1]!['separationEvent']).toBeUndefined();
    expect(withActiveConfigTreeSynced(configs, 'A', live())).toBe(configs);
    // No active row, or an id nothing has.
    expect(withActiveConfigTreeSynced(configs, null, live({ chute: { deployAltitude: 90 } }))).toBe(configs);
    expect(withActiveConfigTreeSynced(configs, 'Z', live({ chute: { deployAltitude: 90 } }))).toBe(configs);
  });

  it('captures a deployment, a separation and a nozzle edited in the app', () => {
    const B = cfg('B', {});
    const out = withActiveConfigTreeSynced([A, B], 'A', live({
      chute: { deployEvent: 'altitude', deployAltitude: 150 },
      booster: { separationEvent: 'never', separationDelay: 2, nozzleExitDiameter: 0.03 },
    }));
    expect(out[0]!.deployments).toEqual({ chute: { deployEvent: 'altitude', deployAltitude: 150, deployDelay: 0 } });
    // separationAltitude was not governed and the node flies the fallback: still not governed.
    expect(out[0]!.separations).toEqual({ s2: { separationEvent: 'never', separationDelay: 2 } });
    expect(out[0]!.nozzles).toEqual({ s2: 0.03 });
    expect(out[0]!.motors).toBe(A.motors);
    expect(out[1]).toBe(B);
    expect(A.deployments!['chute']!.deployAltitude).toBe(200); // the input is untouched
  });

  it('adds a field the configuration did not govern only when the node carries a non-fallback value', () => {
    const out = withActiveConfigTreeSynced([A], 'A', live({ booster: { separationAltitude: 350 } }));
    expect(out[0]!.separations).toEqual({ s2: { separationEvent: 'ejection', separationDelay: 0, separationAltitude: 350 } });
    const same = [A];
    expect(withActiveConfigTreeSynced(same, 'A', live({ booster: { separationAltitude: 200 } }))).toBe(same);
  });

  it('writes blank as null, preserving explicit zero separately', () => {
    const t = live();
    delete t.components[1]!['nozzleExitDiameter'];
    expect(withActiveConfigTreeSynced([A], 'A', t)[0]!.nozzles).toEqual({ s2: null });
    t.components[1]!['nozzleExitDiameter'] = 0;
    expect(withActiveConfigTreeSynced([A], 'A', t)[0]!.nozzles).toEqual({ s2: 0 });
  });

  it('keeps the stored entry for a node the tree no longer has, and leaves ungoverned nodes out', () => {
    const t = live({ chute: { deployAltitude: 90 } });
    // The chute is gone from the tree; the configuration keeps what it stored.
    t.components[0]!.children![0]!.children = t.components[0]!.children![0]!.children!.filter((n) => n.id !== 'chute');
    const configs = [A];
    expect(withActiveConfigTreeSynced(configs, 'A', t)).toBe(configs);
    // A configuration that governs no nozzle (an .ork) does not grow one.
    const ork = cfg('A', {}, { deployments: A.deployments! });
    expect(withActiveConfigTreeSynced([ork], 'A', live())[0]!).toBe(ork);
  });

  it('A→B→A through syncActiveConfig keeps the deployment edited on A', () => {
    const B = cfg('B', {}, { deployments: { chute: { deployEvent: 'apogee', deployAltitude: 300, deployDelay: 1 } } });
    const edited = live({ chute: { deployAltitude: 120 } });
    const leavingA = syncActiveConfig([A, B], 'A', { motors: A.motors, unmatchedRefs: {}, tree: edited });
    expect(leavingA[0]!.deployments!['chute']!.deployAltitude).toBe(120);
    // Before the fix the stored copy was still the file's 200, so coming back
    // to A flew 200, and a Save while B was active wrote 200 for A.
    expect(leavingA[1]).toBe(B);
  });
});

/**
 * ONE PAD-MASS KEY RULE (audit 2026-09-22, extraction #3). The key a weighing
 * is stored under must be the key the set on screen is compared with — App's
 * `currentSetKey`, configSync.padMassSetKey — or hardwareMass reads the value
 * as weighed with another set ('stale-set') and carries none of it. The file's
 * pad mass adopted by its own motor was keyed with the mount's CLUSTER count
 * while the set on screen counts the KERNEL's motors, so on a mount inside a
 * pod set of two the adopted weighing never applied.
 */
describe('assignMotorRecord keys an adopted pad mass by the on-screen rule', () => {
  const podTree = (): RocketTree => ({
    name: 'pods',
    components: [{
      type: 'stage', id: 's1', name: 'Sustainer', children: [{
        type: 'bodytube', id: 'b1', length: 0.5, outerRadius: 0.03, thickness: 0.001, children: [{
          type: 'podset', id: 'pods', instanceCount: 2, radiusOffset: 0.05, children: [{
            type: 'bodytube', id: 'pt', length: 0.3, outerRadius: 0.016, thickness: 0.001, children: [{
              type: 'innertube', id: 'p-mmt', length: 0.2, outerRadius: 0.015, thickness: 0.0005, motorMount: true,
            } as ComponentNode],
          } as ComponentNode],
        } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode],
  });

  it('on a mount inside a pod set of two, the adopted key is the key the set on screen has', () => {
    const tree = podTree();
    const fresh = motor('J540R');
    const next = assignMotorRecord({}, 'p-mmt', fresh, {
      tree, primaryMountId: null, droppedRef: { ...ref('J540R'), padMassKg: 2.4 }, remainingRefs: {},
    });
    expect(next['p-mmt']!.padMassKg).toBe(2.4);
    expect(next['p-mmt']!.padMassWeighedWith).toBe(padMassSetKey(tree, next));
  });
});
