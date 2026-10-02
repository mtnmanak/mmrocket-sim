// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  ComponentNode, FlightResult, IgnitionEvent, MotorSpec, RocketTree, StaticInfo,
} from '@online-openrocket/engine';
import { savedConfigLabel, type MountMotor, type SavedConfig } from '../model/design.js';
import {
  addChild, addStage, defaultTree, isOnLaunchStage, motorisedStagesWithNozzle, motorMounts, mountMotorCount,
} from '../tree/treeModel.js';
import { buildDesign, KERNEL_HANDLES, type BuiltDesign } from './buildDesign.js';
import { padMassSetKey } from './configSync.js';
import {
  deriveLaunchInputs, designBuildInputOf, hardwareDeltaKgOf, provenanceKeyOf, type AeroState, type DesignState,
} from './designDerivation.js';
import { aeroModelFor, rogersKbfFor, stageMotorInfo } from './flightPipeline.js';
import { flyLaunch, type FlightHandle } from './flightRunner.js';
import { catalogueMotorMass, type HardwareMassResult } from './hardwareMass.js';
import { planImport, resolveImportMotors } from './importApply.js';
import { DEFAULT_CONDITIONS, kernelSimOptions, type LaunchConditions } from './launchConditions.js';
import { loadCatalogueMotor } from './motorMatch.js';
import { importOrk } from './orkFile.js';
import { buildSimRun, type DesignMatchKey, type FreshSimRun } from './simReport.js';
import { comparable } from './simulate.testSupport.js';
import { flyBuiltDesign, type BuiltLaunchInput } from './simulateDesign.js';
import { statedWeightTextFor } from './unitText.js';
import { INITIAL_UNITS } from '../prefs/units.js';

/**
 * WHAT THE LAUNCH BUTTON HANDS THE KERNEL AND THE REPORT (2026-10-01).
 *
 * `flyBuiltDesign` is onLaunch's flight and report, moved out of App.tsx so a
 * caller with no React flies what the button flies. App and simulateDesign BOTH
 * call it, so App.simulate.test.tsx — which holds the two to the same bytes —
 * cannot see a mistake made inside it: both sides would carry the same wrong
 * number. This file is the guard for the inside:
 *
 *  1. ARGUMENTS. Every value flyLaunch and buildSimRun receive is pinned
 *     against what onLaunch passed at 78d3015, on a recording handle — the
 *     refusals, the hardware, the conditions, the model stamps, the
 *     configuration's name, the cluster count, the nozzle stages.
 *  2. AN ORACLE FOR THE NUMBERS. `referenceLaunch` below is a FROZEN COPY of
 *     onLaunch's body as it stood at 78d3015 (App.tsx:1716 and 1743-1817),
 *     calling flyLaunch and buildSimRun directly. On four real designs —
 *     a weighed pad mass, a refused pod motor, Auto aero with Auto delay, a
 *     two-configuration .ork — flyBuiltDesign's run must equal the frozen
 *     body's, field for field, floats included, each on a fresh build.
 *
 * The duplication lives only here, which is where an oracle belongs. If
 * onLaunch's behaviour is ever changed ON PURPOSE, change flyBuiltDesign, see
 * this fail, and update the oracle in the same commit with the reason.
 */

vi.mock('./flightRunner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./flightRunner.js')>();
  return { ...real, flyLaunch: vi.fn(real.flyLaunch) };
});
vi.mock('./simReport.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./simReport.js')>();
  return { ...real, buildSimRun: vi.fn(real.buildSimRun) };
});

/** The real buildSimRun: every test starts on it, and the argument tests stub it out. */
let realBuildSimRun: typeof buildSimRun;
beforeAll(async () => {
  realBuildSimRun = (await vi.importActual<typeof import('./simReport.js')>('./simReport.js')).buildSimRun;
});
beforeEach(() => {
  vi.mocked(flyLaunch).mockClear();
  vi.mocked(buildSimRun).mockReset();
  vi.mocked(buildSimRun).mockImplementation((i) => realBuildSimRun(i));
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
});
afterEach(() => { vi.unstubAllGlobals(); });

// ---------------------------------------------------------------------------
// 1. The arguments, on a recording handle.
// ---------------------------------------------------------------------------

/** A handle that answers every flight from `mach`, and logs nothing it is not asked. */
function recordingHandle(mach: number): FlightHandle {
  return {
    setMotorById: () => {},
    setMotorIgnitionById: (_id: string, _e: IgnitionEvent) => {},
    setSupersonicAero: () => {},
    setRogersModifiedBarrowman: () => {},
    simulate: () => ({
      summary: { maxMachNumber: mach, optimumDelay: 6, maxAltitude: 321 }, events: [], series: {},
    }) as unknown as FlightResult,
  };
}

const SPEC: MotorSpec = {
  designation: 'H128', diameter: 0.029, length: 0.194,
  times: [0, 0.1, 1.5], thrusts: [0, 150, 0], masses: [0.2, 0.19, 0.1], cgX: 0.097, ejectionDelay: 10,
};
const mm = (label: string, over: Partial<MountMotor> = {}): MountMotor => ({
  label, spec: { ...SPEC, designation: label }, meta: { label, manufacturer: 'AeroTech' },
  ignition: { event: 'automatic', delay: 0 }, ...over,
});

/**
 * A sustainer whose mount sits in a two-pod set (so the cluster count is 2,
 * not 1) and carries a nozzle, over a booster whose mount has no name.
 */
const TREE: RocketTree = {
  name: 'Recorded',
  components: [
    { type: 'stage', id: 'sus', name: 'Sustainer', nozzleExitDiameter: 0.02, children: [
      { type: 'bodytube', id: 'bt1', children: [
        { type: 'podset', id: 'pods', instanceCount: 2, children: [
          { type: 'bodytube', id: 'pod-bt', children: [
            { type: 'innertube', id: 'm-sus', name: 'Pod MMT', motorMount: true },
          ] },
        ] },
      ] },
    ] },
    { type: 'stage', id: 'boo', name: 'Booster', children: [
      { type: 'bodytube', id: 'bt2', children: [
        { type: 'innertube', id: 'm-boo', motorMount: true },
        { type: 'innertube', id: 'm-ref', name: 'Refused MMT', motorMount: true },
      ] },
    ] },
  ] as ComponentNode[],
};

function recorded(over: { mach?: number; aeroMode?: AeroState['aeroMode']; supersonic?: boolean; activeConfigId?: string | null } = {}) {
  const assigned: [string, MountMotor][] = [
    ['m-sus', mm('H128-10', { ignition: { event: 'burnout', delay: 1 } })],
    ['m-boo', mm('J350-14')],
    ['m-ref', mm('G80-7')],
  ];
  const hardware = { state: 'ok', appliedTo: 'm-sus', deltaKg: 0.02 } as HardwareMassResult;
  const built: BuiltDesign<FlightHandle & { staticInfo: () => StaticInfo }> = {
    rocket: { ...recordingHandle(over.mach ?? 0.4), staticInfo: () => ({}) as StaticInfo },
    info: { mass: 1.5 } as StaticInfo,
    motorFailures: [{ mountId: 'm-ref', text: 'refused' }],
    flownRecovery: { chute: { name: 'Chute' } } as unknown as BuiltDesign['flownRecovery'],
    hardware,
  };
  const configs: SavedConfig[] = [
    { id: 'c1', name: null, isDefault: true, motors: { 'm-sus': assigned[0]![1] } },
    { id: 'c2', name: 'Windy day', isDefault: false, motors: {} },
  ];
  const launch: LaunchConditions = { ...DEFAULT_CONDITIONS, windSpeedAvg: 4 } as LaunchConditions;
  const input: BuiltLaunchInput<FlightHandle & { staticInfo: () => StaticInfo }> = {
    built,
    tree: TREE,
    derived: {
      mounts: motorMounts(TREE),
      stageList: TREE.components,
      assigned,
      effectiveSupersonic: over.supersonic ?? false,
      primaryMountId: 'm-sus',
    },
    launch,
    aero: { aeroMode: over.aeroMode ?? 'classic', effectiveKbf: false },
    activeConfigId: over.activeConfigId === undefined ? 'c1' : over.activeConfigId,
    savedConfigs: configs,
    provenance: { designKey: 'design-key', motorSetKey: 'motor-set-key' },
    onSupersonicUpgrade: vi.fn(),
  };
  return input;
}

const flyArg = () => vi.mocked(flyLaunch).mock.calls[0]![1];
const runArg = () => vi.mocked(buildSimRun).mock.calls[0]![0];

describe('flyBuiltDesign hands flyLaunch what onLaunch handed it', () => {
  // The recording handle's flight is not one the report can read: stubbed.
  beforeEach(() => { vi.mocked(buildSimRun).mockImplementation(() => ({ id: 'stub' }) as FreshSimRun); });

  it('the handle, the build’s refusals and hardware, the conditions, the model and the names', async () => {
    const input = recorded({ supersonic: true, aeroMode: 'supersonic' });
    await flyBuiltDesign(input);
    expect(vi.mocked(flyLaunch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(flyLaunch).mock.calls[0]![0]).toBe(input.built.rocket);
    const a = flyArg();
    expect(a.assigned).toBe(input.derived.assigned);
    expect(a.hardware).toBe(input.built.hardware);
    expect(a.refusedMountIds).toEqual(['m-ref']);
    expect(a.primaryMountId).toBe('m-sus');
    expect(a.simOptions).toStrictEqual(kernelSimOptions(input.launch));
    expect(a.aeroMode).toBe('supersonic');
    expect(a.supersonic).toBe(true);
    expect(a.mountNames).toEqual({ 'm-sus': 'Pod MMT', 'm-boo': 'Motor mount', 'm-ref': 'Refused MMT' });
    expect(a.isOnLaunchStage('m-boo')).toBe(isOnLaunchStage(TREE, 'm-boo'));
    expect(a.isOnLaunchStage('m-boo')).toBe(true);
    expect(a.isOnLaunchStage('m-sus')).toBe(false);
    expect(a.onSupersonicUpgrade).toBe(input.onSupersonicUpgrade);
    // App passes no signal and no clock: the keys are absent, not undefined.
    expect('signal' in a).toBe(false);
    expect('now' in a).toBe(false);
    expect(Object.keys(a)).toEqual(['assigned', 'mountNames', 'refusedMountIds', 'hardware', 'primaryMountId',
      'simOptions', 'aeroMode', 'supersonic', 'isOnLaunchStage', 'onSupersonicUpgrade']);
  });

  it('the model the design is on now, whatever the mode — Auto already upgraded flies supersonic', async () => {
    await flyBuiltDesign(recorded({ supersonic: false, aeroMode: 'classic' }));
    expect(flyArg().supersonic).toBe(false);
    vi.mocked(flyLaunch).mockClear();
    // App's `effectiveSupersonic` after an earlier Launch crossed Mach 0.9 on
    // Auto: the mode alone says 'auto', the design flies supersonic.
    await flyBuiltDesign(recorded({ supersonic: true, aeroMode: 'auto' }));
    expect(flyArg().supersonic).toBe(true);
    expect(flyArg().aeroMode).toBe('auto');
  });

  it('a signal and a clock, when a headless caller passes them', async () => {
    const signal = new AbortController().signal;
    const now = () => 0;
    await flyBuiltDesign({ ...recorded(), signal, now });
    expect(flyArg().signal).toBe(signal);
    expect(flyArg().now).toBe(now);
  });
});

describe('flyBuiltDesign hands buildSimRun what onLaunch handed it', () => {
  beforeEach(() => { vi.mocked(buildSimRun).mockImplementation(() => ({ id: 'stub' }) as FreshSimRun); });

  /** What the frozen onLaunch body (below) passes buildSimRun, for a recorded input and its flight. */
  const expected = (input: ReturnType<typeof recorded>, flight: Awaited<ReturnType<typeof flyLaunch>>) => {
    const { tree, derived: { assigned, stageList, primaryMountId }, built, aero, activeConfigId, savedConfigs } = input;
    const primary = assigned.find(([id]) => id === primaryMountId)![1];
    const activeConfig = activeConfigId === null ? undefined : savedConfigs.find((c) => c.id === activeConfigId);
    return {
      result: flight.result,
      delayResolution: flight.delayResolution, primaryMountId,
      info: built.info,
      motor: { ...primary.spec, ejectionDelay: flight.flownDelayS },
      meta: { ...primary.meta, motorCount: mountMotorCount(tree, primaryMountId) },
      launch: input.launch,
      rocketName: tree.name ?? 'Rocket',
      execMs: flight.execMs,
      stageMotorInfo: stageMotorInfo(tree, assigned, stageList),
      boosterMotors: assigned.filter(([id]) => id !== primaryMountId).map(([, m]) => m.label),
      aeroModel: aeroModelFor(aero.aeroMode, flight.usedSupersonic),
      rogersKbf: rogersKbfFor(aero.effectiveKbf, flight.usedSupersonic),
      ...(activeConfig ? { flightConfig: savedConfigLabel(activeConfig) } : {}),
      ...(activeConfigId !== null ? { flightConfigId: activeConfigId } : {}),
      designKey: input.provenance.designKey,
      motorSetKey: input.provenance.motorSetKey,
      flownRecovery: built.flownRecovery,
      nozzleStages: motorisedStagesWithNozzle(tree, assigned).map((s) => s.name),
    };
  };

  it.each<[string, number]>([['flown on the classic model', 0.4], ['upgraded by Auto past Mach 0.9', 1.2]])(
    'every field, %s', async (_what, mach) => {
      const input = recorded({ mach, aeroMode: 'auto' });
      const { flight } = await flyBuiltDesign(input);
      expect(flight.usedSupersonic).toBe(mach > 0.9);
      expect(runArg()).toStrictEqual(expected(input, flight));
      // The pieces a stub would most easily get wrong, named.
      expect(runArg().aeroModel).toBe(mach > 0.9 ? 'auto-supersonic' : 'classic');
      expect(runArg().meta?.motorCount).toBe(2);
      expect(runArg().flightConfig).toBe(savedConfigLabel(input.savedConfigs[0]!));
      expect(runArg().flightConfigId).toBe('c1');
      expect(runArg().nozzleStages).toEqual(['Sustainer']);
      expect(runArg().boosterMotors).toEqual(['J350-14', 'G80-7']);
      expect(runArg().info).toBe(input.built.info);
      expect(runArg().flownRecovery).toBe(input.built.flownRecovery);
    });

  it('no active configuration: neither configuration key', async () => {
    const input = recorded({ activeConfigId: null });
    await flyBuiltDesign(input);
    expect('flightConfig' in runArg()).toBe(false);
    expect('flightConfigId' in runArg()).toBe(false);
  });

  it('a named configuration is named', async () => {
    const input = recorded({ activeConfigId: 'c2' });
    await flyBuiltDesign(input);
    expect(runArg().flightConfig).toBe('Windy day');
  });
});

// ---------------------------------------------------------------------------
// 2. The numbers, against a frozen copy of 78d3015's onLaunch.
// ---------------------------------------------------------------------------

/**
 * FROZEN COPY of App.tsx's onLaunch body at 78d3015 (lines 1716 and
 * 1743-1817), with the closure's values passed in. Do not edit it to follow a
 * change in flyBuiltDesign: it is the record of what the button flew before the
 * extraction, and the point of this test is that the two agree.
 */
async function referenceLaunch(x: {
  built: BuiltDesign; tree: RocketTree; mounts: ComponentNode[]; stageList: ComponentNode[];
  assigned: [string, MountMotor][]; mountMotors: Record<string, MountMotor>; primaryMountId: string;
  refusedMountIds: string[]; launch: LaunchConditions; aeroMode: AeroState['aeroMode']; effectiveKbf: boolean;
  effectiveSupersonic: boolean; activeConfigId: string | null; savedConfigs: SavedConfig[];
  provenanceKey: DesignMatchKey; onUpgrade: () => void;
}) {
  const {
    built, tree, mounts, stageList, assigned, mountMotors, primaryMountId, refusedMountIds, launch, aeroMode,
    effectiveKbf, effectiveSupersonic, activeConfigId, savedConfigs, provenanceKey,
  } = x;
  const primary = mountMotors[primaryMountId]!;
  const { result: res, flownDelayS: flownDelay, usedSupersonic, execMs, delayResolution } = await flyLaunch(built.rocket, {
    assigned,
    mountNames: Object.fromEntries(mounts.map((m) => [m.id!, m.name ?? 'Motor mount'])),
    refusedMountIds,
    hardware: built.hardware,
    primaryMountId,
    simOptions: kernelSimOptions(launch),
    aeroMode,
    supersonic: effectiveSupersonic,
    isOnLaunchStage: (id) => isOnLaunchStage(tree, id),
    onSupersonicUpgrade: () => { x.onUpgrade(); },
  });
  const branchMotors = stageMotorInfo(tree, assigned, stageList);
  const activeConfig = activeConfigId === null ? undefined
    : savedConfigs.find((c) => c.id === activeConfigId);
  const run = buildSimRun({
    result: res,
    delayResolution, primaryMountId,
    info: built.info,
    motor: { ...primary.spec, ejectionDelay: flownDelay },
    meta: {
      ...primary.meta,
      motorCount: mountMotorCount(tree, primaryMountId),
    },
    launch,
    rocketName: tree.name ?? 'Rocket',
    execMs,
    stageMotorInfo: branchMotors,
    boosterMotors: assigned
      .filter(([id]) => id !== primaryMountId)
      .map(([, mm]) => mm.label),
    aeroModel: aeroModelFor(aeroMode, usedSupersonic),
    rogersKbf: rogersKbfFor(effectiveKbf, usedSupersonic),
    ...(activeConfig ? { flightConfig: savedConfigLabel(activeConfig) } : {}),
    ...(activeConfigId !== null ? { flightConfigId: activeConfigId } : {}),
    designKey: provenanceKey.designKey,
    motorSetKey: provenanceKey.motorSetKey,
    flownRecovery: built.flownRecovery,
    nozzleStages: motorisedStagesWithNozzle(tree, assigned).map((s) => s.name),
  });
  return { res, run, usedSupersonic, flownDelay };
}

/** A fresh kernel build of `state` under `aero`, with what App's memos derive from it. */
function prepare(state: DesignState, aero: AeroState) {
  const d = deriveLaunchInputs(state, aero);
  const built = buildDesign(designBuildInputOf({
    tree: state.tree, assigned: d.assigned, effectiveKbf: aero.effectiveKbf,
    effectiveSupersonic: d.effectiveSupersonic, measuredDryMassKg: state.measured.massKg,
    primaryMountId: d.primaryMountId, currentSetKey: d.currentSetKey,
  }), KERNEL_HANDLES);
  if ('error' in built) throw new Error(built.error);
  const provenance = provenanceKeyOf({
    physicsKey: d.physicsKey, tree: state.tree, assigned: d.assigned, hardwareDeltaKg: hardwareDeltaKgOf(built),
    launch: state.launch, aero,
  });
  return { d, built, provenance };
}

async function bothWays(state: DesignState, aero: AeroState) {
  const a = prepare(state, aero);
  let refUpgraded = false;
  const ref = await referenceLaunch({
    built: a.built, tree: state.tree, mounts: a.d.mounts, stageList: a.d.stageList, assigned: a.d.assigned,
    mountMotors: state.mountMotors, primaryMountId: a.d.primaryMountId!,
    refusedMountIds: a.built.motorFailures.map((f) => f.mountId), launch: state.launch, aeroMode: aero.aeroMode,
    effectiveKbf: aero.effectiveKbf, effectiveSupersonic: a.d.effectiveSupersonic, activeConfigId: state.activeConfigId,
    savedConfigs: state.savedConfigs, provenanceKey: a.provenance, onUpgrade: () => { refUpgraded = true; },
  });
  const b = prepare(state, aero);
  let upgraded = false;
  const out = await flyBuiltDesign({
    built: b.built, tree: state.tree, derived: { ...b.d, primaryMountId: b.d.primaryMountId! },
    launch: state.launch, aero, activeConfigId: state.activeConfigId, savedConfigs: state.savedConfigs,
    provenance: b.provenance, onSupersonicUpgrade: () => { upgraded = true; },
  });
  expect(upgraded).toBe(refUpgraded);
  expect(comparable(out.run)).toStrictEqual(comparable(ref.run));
  // The frozen Launch must catch lost series and branches too (2026-10-01).
  // Both builds use the same tree, so no node id needs normalising here.
  expect(out.flight.result).toStrictEqual(ref.res);
  return { out, ref, built: b.built, upgraded };
}

const CLASSIC: AeroState = { aeroMode: 'classic', effectiveKbf: true, autoSupersonic: false };
const blank = (tree: RocketTree, mountMotors: Record<string, MountMotor>, over: Partial<DesignState> = {}): DesignState => ({
  tree, mountMotors, launch: DEFAULT_CONDITIONS, measured: { massKg: null, cgM: null }, savedConfigs: [],
  activeConfigId: null, unmatchedRefs: {}, ...over,
});

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'version.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}
const fixture = (name: string): ArrayBuffer => {
  const buf = readFileSync(join(repoRoot(), 'packages', 'app', 'src', 'services', '__fixtures__', name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

describe('flyBuiltDesign flies what 78d3015’s onLaunch flew, number for number', () => {
  it('a weighed pad mass: the hardware flies, and the set key carries it', async () => {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const c6 = (await loadCatalogueMotor('Estes', 'C6', 5))!;
    const state = blank(tree, { [mount]: {
      ...c6, padMassKg: 0.1 + catalogueMotorMass(tree, [[mount, c6]])! + 0.02,
      padMassWeighedWith: padMassSetKey(tree, { [mount]: c6 }),
    } }, { measured: { massKg: 0.1, cgM: null } });
    const { built } = await bothWays(state, CLASSIC);
    expect(built.hardware.state).toBe('ok'); // else nothing about the hardware was compared
  }, 30000);

  it('a pod motor the kernel refused: left off the handle and out of the delay vector', async () => {
    const base = defaultTree();
    const body = base.components[0]!.children!.find((n) => n.type === 'bodytube')!;
    const tree = addChild(base, body.id!, {
      type: 'podset', id: 'pods', name: 'Side pods', instanceCount: 2, children: [{
        type: 'bodytube', id: 'pod-bt', name: 'Pod tube', length: 0.1, outerRadius: 0.01, thickness: 0.0005,
        children: [{ type: 'innertube', id: 'pod-mmt', name: 'Pod MMT', motorMount: true,
          length: 0.07, outerRadius: 0.0095, thickness: 0.0003 } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode);
    const core = motorMounts(tree).find((m) => m.id !== 'pod-mmt')!.id!;
    const c6 = (await loadCatalogueMotor('Estes', 'C6', 5))!;
    const refused = { ...c6, spec: { ...c6.spec, masses: c6.spec.masses.map((m, i, all) => (i === all.length - 1 ? -0.001 : m)) } };
    const { built, out } = await bothWays(blank(tree, { [core]: c6, 'pod-mmt': refused }), CLASSIC);
    expect(built.motorFailures.map((f) => f.mountId)).toEqual(['pod-mmt']);
    expect(out.run.delayResolution?.mounts.map((m) => m.mountId)).toEqual([core]);
  }, 30000);

  it('Auto aero with Auto delay: the probe upgrades it, and the delay is re-solved in the same budget', async () => {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const f67 = (await loadCatalogueMotor('AeroTech', 'F67', 6))!;
    const auto = { ...f67, meta: { ...f67.meta, autoDelay: true } };
    const { out, upgraded } = await bothWays(blank(tree, { [mount]: auto }),
      { aeroMode: 'auto', effectiveKbf: true, autoSupersonic: false });
    expect(upgraded).toBe(true);
    expect(out.run.aeroModel).toBe('auto-supersonic');
    expect(out.run.delayResolution?.probes).toBeGreaterThan(0);
  }, 30000);

  /**
   * THE PRIMARY IS NOT WHICHEVER MOTOR WAS PICKED FIRST (verify-step1 finding
   * 2). `assigned` is in record order — the order the motors were picked — and
   * the sustainer is the primary wherever it sits in it. Every other case here
   * has the primary first, so "the first assigned record" would pass them all
   * while the report named the booster's motor over the sustainer's flight.
   */
  it('a two-stage design whose booster motor was picked first: the report names the sustainer’s', async () => {
    const base = defaultTree();
    const sustainer = motorMounts(base)[0]!.id!;
    const { tree: staged, newId } = addStage(base);
    const tree = addChild(staged, newId, {
      type: 'bodytube', id: 'boo-bt', name: 'Booster tube', length: 0.1, outerRadius: 0.0124, thickness: 0.0003,
      children: [{ type: 'innertube', id: 'boo-mmt', name: 'Booster MMT', motorMount: true,
        length: 0.07, outerRadius: 0.0095, thickness: 0.0003 } as ComponentNode],
    } as ComponentNode);
    const b6 = (await loadCatalogueMotor('Estes', 'B6', 0))!;
    const c6 = (await loadCatalogueMotor('Estes', 'C6', 5))!;
    const state = blank(tree, { 'boo-mmt': b6, [sustainer]: c6 });
    const d = deriveLaunchInputs(state, CLASSIC);
    expect(d.assigned.map(([id]) => id)).toEqual(['boo-mmt', sustainer]); // the primary is NOT first
    expect(d.primaryMountId).toBe(sustainer);
    const { out } = await bothWays(state, CLASSIC);
    expect(out.run.motor).toBe(c6.spec.designation);
    expect(out.run.boosterMotors).toEqual([b6.label]);
  }, 30000);

  it('a two-configuration .ork: the active configuration is named on the run', async () => {
    const imported = importOrk(fixture('lemiv-motors.ork'));
    const resolved = await resolveImportMotors(imported);
    const plan = planImport(imported, resolved, { launch: DEFAULT_CONDITIONS, text: statedWeightTextFor(INITIAL_UNITS) });
    const { out } = await bothWays({ ...plan.snapshot, unmatchedRefs: plan.unmatchedRefs }, CLASSIC);
    expect(out.run.flightConfig).toBeDefined();
    expect(out.run.flightConfigId).toBe(plan.snapshot.activeConfigId);
  }, 30000);
});
