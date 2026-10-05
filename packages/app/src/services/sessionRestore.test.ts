import { describe, expect, it } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import { savedConfigLabel } from '../model/design.js';
import { restoreMotorLabels, motorTooltip } from './motorLabels.js';
import { MOTOR_DB } from './motorDb.js';
import { exToMotorSpec, parseEng } from './exMotors.js';
import type { MountMotor, SavedConfig } from '../model/design.js';
import { normalizeTree, freshId, addStage } from '../tree/treeModel.js';
import { applyStageMass, captureStageMass } from './stageMassOverrides.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import type { OrkMotorRef } from './orkFile.js';
import type { SessionState } from './session.js';
import { designStateFromSession } from './sessionRestore.js';

/**
 * A STORED SESSION, RESTORED (2026-10-01). Every migration App's state
 * initializers made inline is one function now, and each changes what flies:
 * a v0.117 pad mass is hardware the kernel carries, a migrated motor length
 * moves the design's physics key, a pad mass on a pod's record is flown on the
 * core's. App's initializers and anything that flies a stored session
 * (simulateDesign; App.simulate.test.tsx's session cases) call it, so the two
 * restore one design. Each migration is pinned here by what it does; App's own
 * restore is pinned by App.render.test.tsx (the v0.117 session) and
 * App.simulate.test.tsx (the Launch button against this function's output).
 */

const NO_LIMIT = { legacyMaxMotorLengthM: null };
const spec = (designation: string) => ({ designation, ejectionDelay: 5 } as MotorSpec);
const motor = (designation: string, pad?: { kg: number; key: string }): MountMotor => ({
  label: `${designation}-5`, spec: spec(designation), meta: { label: `${designation}-5`, manufacturer: 'Estes' },
  ignition: { event: 'automatic', delay: 0 },
  ...(pad ? { padMassKg: pad.kg, padMassWeighedWith: pad.key } : {}),
});

/** One stage, a core mount and a two-pod set — already normalized, so ids survive the restore. */
const PODS: RocketTree = normalizeTree({
  name: 'Pods',
  components: [{ type: 'stage', id: 's', name: 'Sustainer', children: [
    { type: 'bodytube', id: 'bt', length: 0.3, outerRadius: 0.02, thickness: 0.0005, children: [
      { type: 'innertube', id: 'core', motorMount: true, length: 0.07, outerRadius: 0.0095, thickness: 0.0003 },
      { type: 'podset', id: 'pods', instanceCount: 2, children: [
        { type: 'bodytube', id: 'pod-bt', length: 0.1, outerRadius: 0.01, thickness: 0.0005, children: [
          { type: 'innertube', id: 'pod-mmt', motorMount: true, length: 0.07, outerRadius: 0.0095, thickness: 0.0003 },
        ] },
      ] },
    ] },
  ] } as ComponentNode],
});

const session = (over: Partial<SessionState>): SessionState => ({
  tree: PODS, launch: DEFAULT_CONDITIONS, savedAt: 0, ...over,
});

describe('designStateFromSession', () => {
  it('round 2: deleted stage snapshots cannot land on newly created stages after reload', () => {
    const deletedNumber = Number(freshId().slice(1)) + 100;
    const deletedId = `c${deletedNumber}`;
    const c: SavedConfig = { id: 'B', name: 'B', isDefault: false, motors: {},
      stageMassOverrides: { [deletedId]: { overrideMass: 31, overrideCGX: 1.2 } } };
    const surviving = { ...PODS, components: [{ ...PODS.components[0]!, id: `c${deletedNumber - 1}` }] };
    const restored = designStateFromSession(session({ tree: surviving, savedConfigs: [c] }), NO_LIMIT).state;
    const { tree, newId } = addStage(restored.tree);
    expect(captureStageMass(applyStageMass(tree, restored.savedConfigs[0]!.stageMassOverrides)
      .components.at(-1)!)).toEqual({});
    expect(newId).not.toBe(deletedId);
    expect(restored.savedConfigs[0]!.stageMassOverrides).toEqual({});
  });

  it('round 2: restore reserves every retained configuration node reference before minting ids', () => {
    const base = Number(freshId().slice(1)) + 100;
    const keys = ['motors', 'unmatchedRefs', 'deployments', 'separations', 'nozzles',
      'stageActiveness', 'stageMassOverrides'] as const;
    for (const [i, key] of keys.entries()) {
      const id = `c${base + i * 100}`;
      const c = { id: 'B', name: 'B', isDefault: false, motors: {},
        [key]: { [id]: key === 'motors' ? motor('C6') : {} } } as SavedConfig;
      designStateFromSession(session({ savedConfigs: [c] }), NO_LIMIT);
      expect(Number(freshId().slice(1)), key).toBeGreaterThan(Number(id.slice(1)));
    }
    const referencedOnlyInWeighing = `c${base + 1000}`;
    designStateFromSession(session({ savedConfigs: [{ id: 'B', name: null, isDefault: true,
      motors: { core: motor('C6', { kg: 1, key: JSON.stringify([[referencedOnlyInWeighing, 'C6', 1]]) }) },
    }] }), NO_LIMIT);
    expect(Number(freshId().slice(1))).toBeGreaterThan(Number(referencedOnlyInWeighing.slice(1)));
  });
  it('no session: the starter rocket, no motors, the default conditions and an empty Measured box', () => {
    const r = designStateFromSession(null, NO_LIMIT);
    expect(r.state.tree.name).toBe('My Rocket');
    expect(r.state.mountMotors).toEqual({});
    expect(r.state.launch).toBe(DEFAULT_CONDITIONS);
    expect(r.state.measured).toEqual({ massKg: null, cgM: null });
    expect(r.state.savedConfigs).toEqual([]);
    expect(r.state.activeConfigId).toBeNull();
    expect(r.state.unmatchedRefs).toEqual({});
    // The starter's first mount, where the starter motor lands.
    expect(r.defaultMountId).toBeDefined();
    expect(r.legacyPadMass).toBeNull();
  });

  it('keeps a stored design’s ids, so a second restore of the same session keys onto the same mounts', () => {
    const s = session({ mountMotors: { core: motor('C6') } });
    expect(designStateFromSession(s, NO_LIMIT).state.tree).toEqual(designStateFromSession(s, NO_LIMIT).state.tree);
    expect(Object.keys(designStateFromSession(s, NO_LIMIT).state.mountMotors)).toEqual(['core']);
  });

  it('moves a v0.117 Measured-box pad mass onto the primary as a LEGACY value, and strips the third key', () => {
    const measured = { massKg: 0.1, cgM: null, padMassKg: 0.25 } as SessionState['measured'];
    const r = designStateFromSession(session({ mountMotors: { core: motor('C6') }, measured }), NO_LIMIT);
    expect(r.state.mountMotors['core']).toMatchObject({ padMassKg: 0.25, padMassWeighedWith: 'legacy' });
    expect(r.state.measured).toEqual({ massKg: 0.1, cgM: null });
    expect(r.legacyPadMass?.outcome).toBe('attached');
  });

  it('a Measured box with no third key comes back by identity — it fingerprints exactly as stored', () => {
    const measured = { massKg: 0.1, cgM: 0.2 };
    expect(designStateFromSession(session({ mountMotors: {}, measured }), NO_LIMIT).state.measured).toBe(measured);
  });

  it('moves a weighing saved on a pod’s record onto the core’s, in the working set and in every configuration', () => {
    const podFirst = { 'pod-mmt': motor('C6', { kg: 0.25, key: 'set' }), core: motor('D12') };
    const config: SavedConfig = { id: 'cfg', name: 'One', isDefault: true, motors: podFirst };
    const r = designStateFromSession(session({ mountMotors: podFirst, savedConfigs: [config] }), NO_LIMIT);
    expect(r.state.mountMotors['core']).toMatchObject({ padMassKg: 0.25 });
    expect('padMassKg' in r.state.mountMotors['pod-mmt']!).toBe(false);
    expect(r.rankedPadMass).toMatchObject({ from: 'pod-mmt', to: 'core', kg: 0.25 });
    expect(r.state.savedConfigs[0]!.motors['core']).toMatchObject({ padMassKg: 0.25 });
    // The stored shapes, kept for the saved mark's one re-take.
    expect(r.preRankRestore?.motors).toBe(podFirst);
    expect(r.preRankRestore?.configs[0]).toBe(config);
  });

  it('a configuration nothing moves in is kept by identity, and nothing is recorded to re-take', () => {
    const config: SavedConfig = { id: 'cfg', name: 'One', isDefault: true, motors: { core: motor('C6') } };
    const r = designStateFromSession(session({ mountMotors: { core: motor('C6') }, savedConfigs: [config] }), NO_LIMIT);
    expect(r.state.savedConfigs[0]).toBe(config);
    expect(r.preRankRestore).toBeNull();
  });

  it('restores the unmatched references — from the active configuration when the session predates storing them', () => {
    const ref = { designation: 'K550' } as OrkMotorRef;
    const config = { id: 'cfg', name: 'One', motors: {}, unmatchedRefs: { 'pod-mmt': ref } } as unknown as SavedConfig;
    const stored = designStateFromSession(session({ mountMotors: {}, unmatchedRefs: { core: ref } }), NO_LIMIT);
    expect(stored.state.unmatchedRefs).toEqual({ core: ref });
    const fallback = designStateFromSession(
      session({ mountMotors: {}, savedConfigs: [config], activeConfigId: 'cfg' }), NO_LIMIT);
    expect(fallback.state.unmatchedRefs).toEqual({ 'pod-mmt': ref });
    expect(fallback.state.activeConfigId).toBe('cfg');
    // A mount that has a record keeps its motor; its reference is not restored.
    const covered = designStateFromSession(
      session({ mountMotors: { core: motor('C6') }, unmatchedRefs: { core: ref } }), NO_LIMIT);
    expect(covered.state.unmatchedRefs).toEqual({});
  });

  it('puts a pre-per-mount session’s one motor on its mount', () => {
    const r = designStateFromSession(session({ motor: spec('C6'), motorLabel: 'C6-5', mountId: 'core' }), NO_LIMIT);
    expect(Object.keys(r.state.mountMotors)).toEqual(['core']);
    expect(r.state.mountMotors['core']).toMatchObject({ label: 'C6-5', ignition: { event: 'automatic', delay: 0 } });
  });

  it('migrates an older session’s rocket-level motor length onto every mount, keeping the tree as stored for the mark', () => {
    const r = designStateFromSession(session({ mountMotors: {}, maxMotorLengthM: 0.07 }), NO_LIMIT);
    const mount = (t: RocketTree, id: string) => t.components[0]!.children![0]!.children!
      .flatMap((n) => [n, ...(n.children ?? []).flatMap((k) => [k, ...(k.children ?? [])])]).find((n) => n.id === id);
    expect(mount(r.state.tree, 'core')?.['maxMotorLength']).toBe(0.07);
    expect(mount(r.preLengthRestore.tree, 'core')?.['maxMotorLength']).toBeUndefined();
    // The pre-v0.005 motor-browser filter stands in when the session names none.
    const legacy = designStateFromSession(session({ mountMotors: {} }), { legacyMaxMotorLengthM: 0.05 });
    expect(mount(legacy.state.tree, 'core')?.['maxMotorLength']).toBe(0.05);
  });
});

describe('stored motor designation labels', () => {
  it.each([9, 2.5, Infinity])('restores catalogue labels in the working set and unnamed configurations at %s s', (delay) => {
    const entry = MOTOR_DB.find(m => m.designation === 'F67C')!;
    const old = motor('F67C');
    old.label = 'F67-9';
    old.meta.label = 'F67-9';
    old.meta.motorId = entry.motorId;
    old.spec.ejectionDelay = delay;
    const unknown = { ...motor('unknown'), label: 'keep this' };
    const motors = { core: old, unknown };
    const config = { id: 'A', name: null, isDefault: true, motors };
    const input = session({ mountMotors: motors, savedConfigs: [config] });
    const before = structuredClone(input);
    const got = designStateFromSession(input, NO_LIMIT).state;
    const expected = 'F67C-' + (Number.isFinite(delay) ? delay : 'P');
    expect(got.mountMotors['core']?.label).toBe(expected);
    expect(got.mountMotors['core']?.meta.label).toBe(expected);
    expect(got.mountMotors['core']?.spec).toBe(old.spec);
    expect(got.mountMotors['unknown']).toBe(unknown);
    expect(savedConfigLabel(got.savedConfigs[0]!)).toBe('[' + expected + ', keep this]');
    expect(input).toEqual(before);
  });
  it('keeps Auto and its provisional delay, and resolves an embedded EX motor', () => {
    const ex = parseEng('F67 29 100 9 0.02 0.05 Home\n0 0\n0.5 67\n1 0\n')[0]!;
    const old = { ...motor('F67'), spec: exToMotorSpec(ex, 9), meta: { label: 'old', exMotorId: ex.motorId, autoDelay: true } };
    const got = designStateFromSession(session({ mountMotors: { core: old } }), NO_LIMIT).state.mountMotors['core']!;
    expect(got.label).toBe('F67 (auto delay)');
    expect(got.meta.autoDelay).toBe(true);
    expect(got.spec).toBe(old.spec);
  });
});

it('label restoration keeps unresolved ids, resolves exact legacy identities, and is idempotent', () => {
  const old = motor('F67C');
  old.meta.manufacturer = 'AeroTech';
  old.label = 'F67-5';
  const unresolved = { ...old, meta: { ...old.meta, motorId: 'missing-id' } };
  const missingEx = { ...old, meta: { ...old.meta, exMotorId: 'ex:missing' } };
  const restored = restoreMotorLabels({ old, unresolved, missingEx });
  expect(restored['old']!.label).toBe('F67C-5');
  expect(restored['unresolved']).toBe(unresolved);
  expect(restored['missingEx']).toBe(missingEx);
  expect(restoreMotorLabels(restored)).toBe(restored);
});
it('the tooltip keeps the full designation and label behind an abbreviated strip value', () => {
  const mm = motor('1013J453-16A');
  mm.meta.manufacturer = 'Cesaroni';
  mm.label = 'J453-5';
  expect(motorTooltip(mm)).toBe('Cesaroni 1013J453-16A, 5 s delay (J453-5)');
});
