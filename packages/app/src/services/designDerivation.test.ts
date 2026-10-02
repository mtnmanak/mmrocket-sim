import { describe, expect, it } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import {
  motorisedStagesWithNozzle, motorMounts, primaryMountOf, stages,
} from '../tree/treeModel.js';
import { padMassSetKey } from './configSync.js';
import {
  assignedMotorsOf, currentSetKeyOf, deriveLaunchInputs, designBuildInputOf, effectiveSupersonicOf, filePrimaryOf,
  hardwareDeltaKgOf, launchPrimaryOf, legacyPadMassStepOf, mountNamesOf, physicsKeyOf, provenanceKeyOf,
  refusedMountIdsOf, type AeroState, type DesignState,
} from './designDerivation.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import type { OrkMotorRef } from './orkFile.js';
import { reconcileLegacyPadMass, type PadMassText } from './padMassReconcile.js';
import { designMatchKeyOf, physicsRevisionsFor, requiresPhysicsRevision } from './simReport.js';
import type { HardwareMassResult } from './hardwareMass.js';

/**
 * WHAT A LAUNCH DERIVES BEFORE IT BUILDS (2026-10-01). Each function is the
 * body of one App memo, moved unchanged so the button and the headless Launch
 * (simulateDesign.ts) derive from one copy. Sharing it means a mutation here
 * moves App and the headless run TOGETHER, which the agreement test cannot see
 * — so each one is pinned here against the expression it replaced, on a
 * fixture where getting it wrong shows.
 */

const motor = (designation: string, extra: Partial<MountMotor> = {}): MountMotor => ({
  label: `${designation}-5`,
  spec: { designation } as MotorSpec,
  meta: { label: `${designation}-5`, manufacturer: 'Estes' },
  ignition: { event: 'automatic', delay: 0 },
  ...extra,
});

/** A sustainer over a booster, each with a named mount; the booster's mount unnamed in one variant. */
const TWO_STAGE: RocketTree = {
  name: 'Two stage',
  components: [
    { type: 'stage', id: 'sus', name: 'Sustainer', children: [
      { type: 'bodytube', id: 'bt1', name: 'Upper tube', length: 0.3, children: [
        { type: 'innertube', id: 'm-sus', name: 'Sustainer MMT', motorMount: true },
      ] },
    ] },
    { type: 'stage', id: 'boo', name: 'Booster', children: [
      { type: 'bodytube', id: 'bt2', children: [{ type: 'innertube', id: 'm-boo', motorMount: true }] },
    ] },
  ] as ComponentNode[],
};

/** One stage with a core mount and a three-pod set, each pod with a mount. */
const PODS: RocketTree = {
  name: 'Pods',
  components: [
    { type: 'stage', id: 's', name: 'Sustainer', children: [
      { type: 'bodytube', id: 'bt', children: [
        { type: 'innertube', id: 'core', motorMount: true },
        { type: 'podset', id: 'pods', instanceCount: 3, children: [
          { type: 'bodytube', id: 'pod-bt', children: [{ type: 'innertube', id: 'pod-mmt', motorMount: true }] },
        ] },
      ] },
    ] },
  ] as ComponentNode[],
};

const AERO: AeroState = { aeroMode: 'classic', effectiveKbf: true, autoSupersonic: false };
const TEXT: PadMassText = { mass: (kg) => `${Math.round(kg * 1000)} g`, motorName: (l) => l.replace(/-\d+$/, '') };

describe('assignedMotorsOf', () => {
  it('keeps only motors whose mount is in the tree, in record order', () => {
    const records = { gone: motor('D12'), 'm-boo': motor('C6'), 'm-sus': motor('B6') };
    expect(assignedMotorsOf(records, motorMounts(TWO_STAGE)))
      .toEqual([['m-boo', records['m-boo']], ['m-sus', records['m-sus']]]);
  });
});

describe('launchPrimaryOf and filePrimaryOf', () => {
  it('the primary is the sustainer’s mount, whichever order the motors were picked in', () => {
    const a = motor('C6');
    const b = motor('B6');
    expect(launchPrimaryOf(TWO_STAGE, [['m-boo', a], ['m-sus', b]])).toBe('m-sus');
    expect(launchPrimaryOf(TWO_STAGE, [['m-sus', b], ['m-boo', a]])).toBe('m-sus');
    expect(launchPrimaryOf(TWO_STAGE, [])).toBeNull();
  });

  it('the FILE’s primary counts an unmatched reference: the sustainer, while the launch primary is the booster', () => {
    const assigned: [string, MountMotor][] = [['m-boo', motor('C6')]];
    const refs = { 'm-sus': { designation: 'K550' } as OrkMotorRef };
    expect(launchPrimaryOf(TWO_STAGE, assigned)).toBe('m-boo');
    expect(filePrimaryOf(TWO_STAGE, assigned, refs)).toBe('m-sus');
    expect(filePrimaryOf(TWO_STAGE, assigned, {})).toBe('m-boo');
  });
});

describe('effectiveSupersonicOf', () => {
  it.each<[AeroState['aeroMode'], boolean, boolean]>([
    ['auto', true, true],
    ['auto', false, false],
    ['supersonic', false, true],
    ['classic', true, false],
    ['hybrid', false, false],
    ['hybrid', true, false],
  ])('%s with Auto upgraded %s flies supersonic: %s', (mode, auto, want) => {
    expect(effectiveSupersonicOf(mode, auto)).toBe(want);
  });
});

describe('physicsKeyOf', () => {
  const base = physicsKeyOf(TWO_STAGE.components);
  const edit = (patch: (n: ComponentNode) => ComponentNode): string => {
    const walk = (ns: ComponentNode[]): ComponentNode[] => ns.map((n) => patch({ ...n, ...(n.children ? { children: walk(n.children) } : {}) }));
    return physicsKeyOf(walk(TWO_STAGE.components));
  };

  it('a rename or a colour change keeps the key — a nested child’s name too', () => {
    expect(edit((n) => (n.id === 'bt1' ? { ...n, name: 'Renamed' } : n))).toBe(base);
    expect(edit((n) => (n.id === 'm-sus' ? { ...n, name: 'Renamed mount' } : n))).toBe(base);
    expect(edit((n) => (n.id === 'bt1' ? { ...n, color: '#ff0000' } as ComponentNode : n))).toBe(base);
  });

  it('a length or a motor-mount flag changes it', () => {
    expect(edit((n) => (n.id === 'bt1' ? { ...n, length: 0.31 } : n))).not.toBe(base);
    expect(edit((n) => (n.id === 'm-boo' ? { ...n, motorMount: false } : n))).not.toBe(base);
  });
});

describe('currentSetKeyOf', () => {
  it('is configSync’s key over the ASSIGNED motors, pod instances multiplied — a stale record left out', () => {
    const records = { core: motor('D12'), 'pod-mmt': motor('C6'), stale: motor('E9') };
    const assigned = assignedMotorsOf(records, motorMounts(PODS));
    expect(currentSetKeyOf(PODS, assigned)).toBe(padMassSetKey(PODS, { core: records.core, 'pod-mmt': records['pod-mmt'] }));
    expect(currentSetKeyOf(PODS, assigned)).not.toBe(padMassSetKey(PODS, records));
    // The pod set's three instances are part of the key.
    const one = { ...PODS, components: [{ ...PODS.components[0]!, children: [{ ...PODS.components[0]!.children![0]!, children: [
      PODS.components[0]!.children![0]!.children![0]!,
      { ...PODS.components[0]!.children![0]!.children![1]!, instanceCount: 1 },
    ] }] }] } as RocketTree;
    expect(currentSetKeyOf(one, assigned)).not.toBe(currentSetKeyOf(PODS, assigned));
  });
});

describe('provenanceKeyOf', () => {
  const withNozzle = (stageId: string): RocketTree => ({
    ...TWO_STAGE,
    components: TWO_STAGE.components.map((s) => (s.id === stageId ? { ...s, nozzleExitDiameter: 0.02 } : s)),
  });
  const handMade = (tree: RocketTree, assigned: [string, MountMotor][]) => designMatchKeyOf({
    physicsKey: physicsKeyOf(tree.components), assigned, hardwareDeltaKg: 0.02, launch: DEFAULT_CONDITIONS,
    aeroMode: 'auto', effectiveKbf: false, autoSupersonic: true,
    hasNozzle: motorisedStagesWithNozzle(tree, assigned).length > 0,
    requiresPhysicsRevision: requiresPhysicsRevision(tree),
    physicsRevisions: physicsRevisionsFor(tree),
  });
  const of = (tree: RocketTree, assigned: [string, MountMotor][]) => provenanceKeyOf({
    physicsKey: physicsKeyOf(tree.components), tree, assigned, hardwareDeltaKg: 0.02, launch: DEFAULT_CONDITIONS,
    aero: { aeroMode: 'auto', effectiveKbf: false, autoSupersonic: true },
  });

  it('is designMatchKeyOf, hand-assembled, with no nozzle', () => {
    const assigned: [string, MountMotor][] = [['m-sus', motor('C6')]];
    expect(of(TWO_STAGE, assigned)).toStrictEqual(handMade(TWO_STAGE, assigned));
    expect(of(TWO_STAGE, assigned).hasNozzle).toBe(false);
  });

  it('a nozzle on a MOTORISED stage counts; one on a stage with no motor does not', () => {
    const assigned: [string, MountMotor][] = [['m-sus', motor('C6')]];
    expect(of(withNozzle('sus'), assigned).hasNozzle).toBe(true);
    expect(of(withNozzle('sus'), assigned)).toStrictEqual(handMade(withNozzle('sus'), assigned));
    expect(of(withNozzle('boo'), assigned).hasNozzle).toBe(false);
    expect(of(withNozzle('boo'), assigned)).toStrictEqual(handMade(withNozzle('boo'), assigned));
  });
});

describe('the small ones', () => {
  it('designBuildInputOf passes every term through, the measured dry mass null or a number', () => {
    const assigned: [string, MountMotor][] = [['m-sus', motor('C6')]];
    const common = { tree: TWO_STAGE, assigned, effectiveKbf: false, effectiveSupersonic: true, primaryMountId: 'm-sus', currentSetKey: 'k' };
    expect(designBuildInputOf({ ...common, measuredDryMassKg: null })).toStrictEqual({
      tree: TWO_STAGE, assigned, kbf: false, supersonic: true, measuredDryMassKg: null, primaryMountId: 'm-sus', currentSetKey: 'k',
    });
    expect(designBuildInputOf({ ...common, measuredDryMassKg: 0.42 }).measuredDryMassKg).toBe(0.42);
  });

  it('hardwareDeltaKgOf is the delta only when the build carries hardware', () => {
    const ok = { state: 'ok', deltaKg: 0.02 } as HardwareMassResult;
    expect(hardwareDeltaKgOf({ hardware: ok })).toBe(0.02);
    expect(hardwareDeltaKgOf({ hardware: { state: 'none', why: 'no-pad-mass' } as HardwareMassResult })).toBe(0);
    expect(hardwareDeltaKgOf({ hardware: { state: 'stale-set', deltaKg: 0.02 } as unknown as HardwareMassResult })).toBe(0);
    expect(hardwareDeltaKgOf(null)).toBe(0);
  });

  it('refusedMountIdsOf names the refused mounts in order', () => {
    expect(refusedMountIdsOf([{ mountId: 'a' }, { mountId: 'b' }])).toEqual(['a', 'b']);
  });

  it('mountNamesOf names an unnamed mount "Motor mount", never by its id', () => {
    expect(mountNamesOf(motorMounts(TWO_STAGE))).toEqual({ 'm-sus': 'Sustainer MMT', 'm-boo': 'Motor mount' });
  });
});

describe('deriveLaunchInputs', () => {
  it('is the functions above composed — one assertion per field, a removed mount’s record included', () => {
    const state: DesignState = {
      tree: TWO_STAGE,
      mountMotors: { 'm-boo': motor('C6'), removed: motor('D12') },
      launch: DEFAULT_CONDITIONS,
      measured: { massKg: null, cgM: null },
      savedConfigs: [],
      activeConfigId: null,
      unmatchedRefs: { 'm-sus': { designation: 'K550' } as OrkMotorRef },
    };
    const aero: AeroState = { aeroMode: 'auto', effectiveKbf: true, autoSupersonic: true };
    const d = deriveLaunchInputs(state, aero);
    const mounts = motorMounts(TWO_STAGE);
    const assigned = assignedMotorsOf(state.mountMotors, mounts);
    expect(d.mounts).toEqual(mounts);
    expect(d.stageList).toEqual(stages(TWO_STAGE));
    expect(d.assigned).toEqual(assigned);
    expect(d.primaryMountId).toBe(primaryMountOf(TWO_STAGE, ['m-boo']));
    expect(d.filePrimaryMountId).toBe('m-sus');
    expect(d.currentSetKey).toBe(currentSetKeyOf(TWO_STAGE, assigned));
    expect(d.effectiveSupersonic).toBe(true);
    expect(d.physicsKey).toBe(physicsKeyOf(TWO_STAGE.components));
    // No unmatched references at all reads as none.
    expect(deriveLaunchInputs({ ...state, unmatchedRefs: undefined }, AERO).filePrimaryMountId).toBe('m-boo');
  });
});

describe('legacyPadMassStepOf', () => {
  it('hands reconcileLegacyPadMass the FILE’s primary and the launch primary apart — so the drop branch is reachable', () => {
    const state = {
      tree: TWO_STAGE,
      mountMotors: { 'm-boo': motor('C6', { padMassKg: 0.3, padMassWeighedWith: 'legacy' }) },
      unmatchedRefs: { 'm-sus': { designation: 'K550' } as OrkMotorRef },
    };
    const derived = { primaryMountId: 'm-boo', filePrimaryMountId: 'm-sus', currentSetKey: 'k' };
    const hardware = { state: 'ok', deltaKg: 0.01 } as HardwareMassResult;
    const step = legacyPadMassStepOf({ state, derived, hardware, text: TEXT });
    expect(step?.kind).toBe('drop');
    expect(step).toStrictEqual(reconcileLegacyPadMass({
      hardware, primaryMountId: 'm-boo', filePrimaryMountId: 'm-sus', motors: state.mountMotors,
      unmatchedRefs: state.unmatchedRefs, tree: TWO_STAGE, currentSetKey: 'k', text: TEXT,
    }));
    // The same record with the file's primary loaded is re-keyed instead.
    expect(legacyPadMassStepOf({ state, derived: { ...derived, filePrimaryMountId: 'm-boo' }, hardware, text: TEXT })?.kind)
      .toBe('rekey');
  });
});
