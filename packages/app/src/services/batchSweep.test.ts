import * as flightRunner from './flightRunner.js';
import { notePluggedAtOptimum } from './batchSweep.js';
import type { SimRun } from './simReport.js';

it('H1 per-mount plugged advice preserves warning levels with separators in names', () => {
  const run = { comments: 'Danger', commentLevels: ['warning'], delayS: 3,
    delayResolution: { mounts: [{ mountName: 'Core | Left', flownDelay: 3, exception: 'plugged-on-charge' }] } } as unknown as SimRun;
  notePluggedAtOptimum(run, 2);
  expect(commentLevelsAlign(run)).toBe(true);
  expect(commentsOf(run)[0]?.level).toBe('warning');
  expect(run.comments).toContain('Core / Left');
});
import { flyLaunch } from './flightRunner.js';
import { simulateDesign } from './simulateDesign.js';
import { readFileSync } from 'node:fs';
import { probeFlight } from './autoDelay.testSupport.js';
import { canReplayDelays } from './autoDelaySolver.js';
import { flightDataForExport, flownAutoDelays } from './orkFlightData.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrkRocket, type ComponentNode, type MotorSpec, type RocketTree } from '@online-openrocket/engine';
import { DEFAULT_CONDITIONS, kernelSimOptions } from '../components/LaunchPanel.js';
import { applyStageNozzles, defaultTree, engineTree, motorMounts, splitClusterPairsTree, splitClusterTree } from '../tree/treeModel.js';
import { MOTOR_DB, MOTOR_DB_DATE, setCatalogueOverlay, type MotorDbEntry } from './motorDb.js';
import { labelMotor } from './motorLabels.testSupport.js';
import * as motorDb from './motorDb.js';
import { diffCatalogue } from './catalogueOverlay.js';
import type { NozzleEntry } from './nozzleDb.js';
import { defaultDelay, delayOptions, fetchMotorSpec } from './thrustcurve.js';
import { changedSinceRun, commentLevelsAlign, commentsOf, motorDataKeyOf, motorSetKeyOf, recommendDelay, runMatchesDesign, storedSimCost } from './simReport.js';
import { deriveLaunchInputs, designBuildInputOf, hardwareDeltaKgOf, physicsKeyOf, provenanceKeyOf, type DesignState } from './designDerivation.js';
import { buildDesign, KERNEL_HANDLES } from './buildDesign.js';
import { flownSpec, LEGACY_PAD_MASS_KEY, motorIdentity } from './hardwareMass.js';
import { padMassSetKey } from './configSync.js';
import { stageMotors } from './nozzleFollow.js';
import { historyMotorLabel } from '../components/SimResults.js';
import { batchMountDisclosure } from './batchMountDisclosure.js';
import { batchRingSplits } from './batchRing.js';
import { batchLoadoutText } from './batchLoadout.js';
import { runsToCsv, runsToTable } from './simStore.js';
import { matchingRecoveryEvents } from './recoveryFlight.js';
import { IMPERIAL_UNITS, INITIAL_UNITS, uiToSi } from '../prefs/units.js';
import { designPrintHtml } from './designPrintReport.js';
import type { MountMotor } from '../model/design.js';
import { resolveFlightState } from './flightState.js';
import { strFromU8, unzipSync } from 'fflate';
import { buildFlightDataBundle } from './flightDataBundle.js';
import type { WeatherSnapshot } from './weatherSnapshot.js';
import {
  batchMotorIds, batchMotorNames, batchRowKey, batchSolverFlights, deploysOnEjectionCharge, listsNoDelay,
  provisionalDelay, runBatchSweep, type BatchMountOption, type BatchRow, type BatchSweepDeps, type BatchSweepInput,
} from './batchSweep.js';

/**
 * services/batchSweep.ts — the batch sweep out of its component (audit
 * 2026-09-22), flown here on the REAL TeaVM kernel. Only the network (the
 * thrust-curve download) and the lazy nozzle table are stubbed, so what these
 * pin is the sweep itself: which delay, which nozzle, which rows, which keys.
 */

afterEach(() => { vi.restoreAllMocks(); });

/** One 45 cm long, 42 mm diameter airframe; options change only what each test is about. */
function rocket(opts: {
  deployEvent?: string; nozzleExitDiameter?: number; sideMount?: boolean;
} = {}): RocketTree {
  return {
    name: 'Sweep bird',
    components: [{
      type: 'stage', id: 'st0', name: 'Sustainer',
      ...(opts.nozzleExitDiameter !== undefined ? { nozzleExitDiameter: opts.nozzleExitDiameter } : {}),
      children: [
        { type: 'nosecone', id: 'nc', length: 0.15, aftRadius: 0.0208, thickness: 0.002, shape: 'ogive' } as ComponentNode,
        {
          type: 'bodytube', id: 'bt', length: 0.6, outerRadius: 0.0208, thickness: 0.0008,
          children: [
            { type: 'trapezoidfinset', id: 'fins', finCount: 3, rootChord: 0.08, tipChord: 0.04, sweep: 0.04, height: 0.05, thickness: 0.003 },
            { type: 'innertube', id: 'mount', length: 0.2, outerRadius: 0.0165, thickness: 0.0005, motorMount: true },
            ...(opts.sideMount
              ? [{ type: 'innertube', id: 'side', length: 0.2, outerRadius: 0.0125, thickness: 0.0005, motorMount: true } as ComponentNode]
              : []),
            {
              type: 'parachute', id: 'chute', name: 'Main', diameter: 0.45,
              ...(opts.deployEvent ? { deployEvent: opts.deployEvent } : {}),
            } as ComponentNode,
          ],
        } as ComponentNode,
      ],
    }],
  };
}

/** An 80 mm airframe around a 24 mm cluster mount — the shape the combination passes serve. */
function clusterRocket(cluster: '4-ring' | '6-ring', deployEvent?: string): RocketTree {
  return {
    name: 'Cluster bird',
    components: [{
      type: 'stage', id: 'st0', name: 'Sustainer',
      children: [
        { type: 'nosecone', id: 'nc', length: 0.3, aftRadius: 0.04, thickness: 0.002, shape: 'ogive' } as ComponentNode,
        {
          type: 'bodytube', id: 'bt', length: 0.9, outerRadius: 0.04, thickness: 0.001,
          children: [
            { type: 'trapezoidfinset', id: 'fins', finCount: 4, rootChord: 0.15, tipChord: 0.07, sweep: 0.08, height: 0.1, thickness: 0.004 },
            { type: 'innertube', id: 'mount', length: 0.2, outerRadius: 0.0125, thickness: 0.0005, motorMount: true, cluster },
            { type: 'parachute', id: 'chute', name: 'Main', diameter: 0.8, ...(deployEvent ? { deployEvent } : {}) } as ComponentNode,
          ],
        } as ComponentNode,
      ],
    }],
  };
}

/** A 50 mm airframe around a 38 mm mount, for the catalogue motors that need one. */
function fiftyMm(): RocketTree {
  return {
    name: 'Parity bird',
    components: [{
      type: 'stage', id: 'st0', name: 'Sustainer',
      children: [
        { type: 'nosecone', id: 'nc', length: 0.25, aftRadius: 0.025, thickness: 0.002, shape: 'ogive' } as ComponentNode,
        {
          type: 'bodytube', id: 'bt', length: 0.8, outerRadius: 0.025, thickness: 0.001,
          children: [
            { type: 'trapezoidfinset', id: 'fins', finCount: 3, rootChord: 0.1, tipChord: 0.05, sweep: 0.05, height: 0.06, thickness: 0.003 },
            { type: 'innertube', id: 'mount', length: 0.35, outerRadius: 0.0195, thickness: 0.0005, motorMount: true },
            { type: 'parachute', id: 'chute', name: 'Main', diameter: 0.6 } as ComponentNode,
          ],
        } as ComponentNode,
      ],
    }],
  };
}

/** A small E-class curve; `k` scales the thrust so two candidates differ. */
const curve = (designation: string, k = 1): MotorSpec => ({
  designation, diameter: 0.024, length: 0.07,
  times: [0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0],
  thrusts: [0, 48, 24, 20.4, 19.6, 19.2, 18, 0].map((t) => t * k),
  masses: [0.07, 0.068, 0.062, 0.057, 0.047, 0.037, 0.031, 0.03],
  cgX: 0.035, ejectionDelay: 5,
});

const entry = (motorId: string, manufacturerAbbrev: string, designation: string, delays: string): MotorDbEntry => ({
  motorId, manufacturerAbbrev, designation, commonName: designation, impulseClass: 'E', diameter: 24, length: 70,
  type: 'SU', avgThrustN: 20, maxThrustN: 48, totImpulseNs: 40, burnTimeS: 2, totalWeightG: 70, propWeightG: 40,
  delays, availability: 'regular',
});

const MOUNT: BatchMountOption = { id: 'mount', label: 'Motor mount', diameterMm: 32, motorCount: 1, maxMotorLengthM: null };

/** A fetch that honours the requested delay exactly as the real one does. */
const fetchFrom = (specs: Record<string, MotorSpec>): BatchSweepDeps['fetchSpec'] =>
  async (m, delay) => ({ ...specs[m.motorId]!, ejectionDelay: delay });
const nozzles = (exits: Record<string, number>): BatchSweepDeps['nozzleFor'] =>
  async (id) => (id !== undefined && exits[id] !== undefined ? ({ exitDiameterM: exits[id] } as NozzleEntry) : null);
const noYield = async () => {};

function input(tree: RocketTree, over: Partial<BatchSweepInput> = {}): BatchSweepInput {
  return {
    tree,
    info: OrkRocket.buildTree(engineTree(tree)).staticInfo(),
    mounts: [MOUNT], target: MOUNT, candidates: [], splits: [],
    assignedMountMotors: {}, assignedMotors: {}, assignedMotorIds: {}, assignedIgnitions: {},
    model: 'kbf', autoDelay: true, launch: DEFAULT_CONDITIONS, rocketName: 'Sweep bird',
    ...over,
  };
}

const sweep = (inp: BatchSweepInput, deps: Partial<BatchSweepDeps>, signal = new AbortController().signal) =>
  runBatchSweep(inp, { signal }, { yieldToUi: noYield, ...deps });

it('Round 5 reserves split-group names against kept design mounts on every disclosure surface', async () => {
  const tree = clusterRocket('4-ring');
  const body = tree.components[0]!.children![1]!;
  body.children!.find(m => m.id === 'mount')!.name = 'Cluster';
  body.children!.push({ type: 'innertube', id: 'side', name: 'Cluster (pair A)', length: 0.2,
    outerRadius: 0.0125, thickness: 0.0005, motorMount: true });
  const target = { ...MOUNT, motorCount: 4 };
  const mounts = [target, { ...MOUNT, id: 'side' }];
  const assignedMotors = { side: curve('E20') };
  const metadata = { side: { spec: assignedMotors.side, label: 'E20',
    ignition: { event: 'automatic' as const, delay: 0 }, meta: { label: '', manufacturer: 'Acme', motorId: 'a' } } };
  const out = await sweep(input(tree, { mounts, target, candidates: [entry('a', 'Acme', 'E20', '5'), entry('b', 'Bolt', 'E22', '5')],
    splits: [splitClusterTree(tree, 'mount')!], autoDelay: false, assignedMotors, assignedMountMotors: metadata,
    assignedMotorIds: { side: 'a' },
  }), { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({}) });
  expect(out.rows).toHaveLength(3);
  expect(batchMountDisclosure(tree, mounts, target, assignedMotors, metadata, { side: 'a' }, {}).text)
    .toContain('Cluster (pair A) keeps E20');
  for (const row of out.rows) {
    expect(row.error).toBeUndefined();
    const run = row.run!;
    expect(run.batchMounts!.find(m => m.role === 'kept')?.mountName).toBe('Cluster (pair A)');
    const candidateNames = row.combo ? ['Cluster (pair A) 2', 'Cluster (pair B)'] : ['Cluster'];
    expect(run.batchMounts!.filter(m => m.role === 'candidate').map(m => m.mountName)).toEqual(candidateNames);
    if (row.combo) expect(run.delayResolution!.mounts.filter(m => m.mountId !== 'side').map(m => m.mountName)).toEqual(candidateNames);
    expect(batchLoadoutText(run)).toContain('in Cluster (pair A)');
    expect(runsToTable([run]).rows[0]!.slice(-2)).toEqual([candidateNames.join('; '), 'E20 in Cluster (pair A)']);
    expect(runsToCsv([run])).toContain(`${candidateNames.join('; ')},E20 in Cluster (pair A)`);
  }
}, 60_000);

it('Round 5 discards an entire new record vector with an oversized resolved name', async () => {
  const tree = rocket({ sideMount: true });
  const candidate = entry('ex:oversized-round5', 'EX', 'K'.repeat(1_000_000), '5');
  const out = await sweep(input(tree, { candidates: [candidate], autoDelay: false }), {
    fetchSpec: fetchFrom({ [candidate.motorId]: curve('E20') }), nozzleFor: nozzles({}),
  });
  expect(out.rows[0]?.error).toBeUndefined();
  expect(out.rows[0]?.run).toBeDefined();
  expect(out.rows[0]?.run?.batchMounts).toBeUndefined();
}, 60_000);

it.each([{ diameter: 1001 }, { masses: [1e16] }])('Round 4 refuses the whole row for an over-limit background spec: %j', async invalid => {
  const out = await sweep(input(rocket({ sideMount: true }), { autoDelay: false,
    candidates: [entry('a', 'Acme', 'E20', '5')], assignedMotors: { side: { ...curve('Refused'), ...invalid } },
  }), { fetchSpec: fetchFrom({ a: curve('E20') }), nozzleFor: nozzles({}) });
  expect(out.rows[0]?.error).toContain('the motor was left off the rocket');
  expect(out.rows[0]?.run).toBeUndefined();
}, 60_000);

it('Round 4 groups a legacy kept catalogue motor with the same swept motor', async () => {
  const candidate = entry('round7-delayed', 'Cesaroni', '381I224-15A', '5');
  vi.spyOn(motorDb, 'getCatalogue').mockReturnValue([candidate]);
  const spec = curve(candidate.designation);
  const out = await sweep(input(rocket({ sideMount: true }), { autoDelay: false, candidates: [candidate],
    assignedMotors: { side: spec }, assignedMountMotors: { side: {
      spec, label: '', meta: { label: '', manufacturer: candidate.manufacturerAbbrev }, ignition: { event: 'automatic', delay: 0 },
    } },
  }), { fetchSpec: fetchFrom({ [candidate.motorId]: spec }), nozzleFor: nozzles({}) });
  expect(out.rows[0]?.error).toBeUndefined();
  expect(out.rows[0]?.run?.batchMounts?.map(m => m.motor)).toEqual(['I224', 'I224']);
  expect(batchLoadoutText(out.rows[0]!.run!)).toBe('I224 in Motor mount 1, Motor mount 2');
}, 60_000);

it('Round 7 preserves typographic quotes in frozen records and both export columns', async () => {
  const tree = rocket({ sideMount: true });
  const mounts = motorMounts(tree);
  mounts[0]!.name = '3” MMT';
  mounts[1]!.name = '54mm “main” tube';
  const candidate = entry('round7-quotes', 'Home', '“Candidate”', '5');
  const spec = curve(candidate.designation);
  const out = await sweep(input(tree, { autoDelay: false, candidates: [candidate],
    assignedMotors: { side: curve('“Kept”') },
  }), { fetchSpec: fetchFrom({ [candidate.motorId]: spec }), nozzleFor: nozzles({}) });
  expect(out.rows[0]?.error).toBeUndefined();
  const run = out.rows[0]!.run!;
  expect(run.batchMounts?.map(m => [m.mountName, m.motor])).toEqual([
    ['3” MMT', '“Candidate”'], ['54mm “main” tube', '“Kept”'],
  ]);
  expect(batchLoadoutText(run)).toBe('“Candidate” in 3” MMT; “Kept” in 54mm “main” tube');
  expect(runsToTable([run]).rows[0]!.slice(-2)).toEqual(['3” MMT', '“Kept” in 54mm “main” tube']);
  expect(runsToCsv([run])).toContain('3” MMT,\u201cKept\u201d in 54mm “main” tube');
}, 60_000);

it('Round 4 records the uncatalogued candidate designation from the actual sweep', async () => {
  const candidate = entry('0123456789abcdef01234567', 'Uncatalogued', 'Candidate42', '5');
  expect(MOTOR_DB.some(m => m.motorId === candidate.motorId)).toBe(false);
  const out = await sweep(input(rocket({ sideMount: true }), { autoDelay: false, candidates: [candidate] }), {
    fetchSpec: fetchFrom({ [candidate.motorId]: curve(candidate.designation) }), nozzleFor: nozzles({}),
  });
  expect(out.rows[0]?.error).toBeUndefined();
  expect(out.rows[0]?.run?.batchMounts?.find(m => m.role === 'candidate')?.motor).toBe(candidate.designation);
}, 60_000);

it('Round 3 freezes design numbering for ordinary rows, split groups and the picker', async () => {
  const tree = clusterRocket('4-ring');
  const body = tree.components[0]!.children![1]!;
  body.children!.find(m => m.id === 'mount')!.name = 'Inner Tube';
  for (const id of ['side', 'side2']) body.children!.push({ type: 'innertube', id, name: 'Inner Tube', length: 0.2,
    outerRadius: 0.0125, thickness: 0.0005, motorMount: true });
  const target = { ...MOUNT, motorCount: 4 };
  const mounts = [target, { ...MOUNT, id: 'side' }, { ...MOUNT, id: 'side2' }];
  const assignedMotors = { side: curve('E20'), side2: curve('E20') };
  const metadata = Object.fromEntries(['side', 'side2'].map(id => [id, {
    spec: assignedMotors[id as keyof typeof assignedMotors], label: 'E20', ignition: { event: 'automatic' as const, delay: 0 },
    meta: { label: '', manufacturer: 'Acme', motorId: 'a' },
  }]));
  const out = await sweep(input(tree, { mounts, target, candidates: [entry('a', 'Acme', 'E20', '5'), entry('b', 'Bolt', 'E22', '5')],
    splits: [splitClusterTree(tree, 'mount')!], autoDelay: false, assignedMotors, assignedMountMotors: metadata,
    assignedMotorIds: { side: 'a', side2: 'a' },
  }), { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({}) });
  expect(out.rows).toHaveLength(3);
  for (const row of out.rows) {
    expect(row.error).toBeUndefined();
    expect(row.run!.batchMounts!.filter(m => m.role === 'kept').map(m => m.mountName)).toEqual(['Inner Tube 2', 'Inner Tube 3']);
    expect(row.run!.batchMounts!.filter(m => m.role === 'candidate').map(m => m.mountName))
      .toEqual(row.combo ? ['Inner Tube 1 (pair A)', 'Inner Tube 1 (pair B)'] : ['Inner Tube 1']);
  }
  expect(batchMountDisclosure(tree, mounts, target, assignedMotors, metadata, { side: 'a', side2: 'a' }, {}).text)
    .toContain('Inner Tube 2 and Inner Tube 3 keep E20');
  expect(batchLoadoutText(out.rows[0]!.run!)).toBe('E20 ×4 in Inner Tube 1, ×1 in Inner Tube 2, ×1 in Inner Tube 3');
}, 60_000);

it('Round 3 names both roles together and never exports the imported real maker', async () => {
  const tree = rocket({ sideMount: true });
  const candidates = [entry('a', 'Acme', 'E20', '5'), entry('b', 'Bolt', 'E20', '5'),
    { ...entry('ex:round3', 'EX', 'E22', '5'), realManufacturer: 'Private maker' }];
  const out = await sweep(input(tree, { candidates, autoDelay: false,
    assignedMotors: { side: curve('E20') }, assignedMotorIds: { side: 'a' },
    assignedMountMotors: { side: { spec: curve('E20'), label: 'E20', ignition: { event: 'automatic', delay: 0 },
      meta: { label: '', manufacturer: 'Acme', motorId: 'a' } } },
  }), { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E20'), 'ex:round3': curve('E22') }), nozzleFor: nozzles({}) });
  expect(out.rows).toHaveLength(3);
  for (const row of out.rows) expect(row.error).toBeUndefined();
  expect(out.rows.map(row => row.run!.batchMounts!.map(m => m.motor))).toEqual([
    ['E20', 'E20'], ['Bolt E20', 'Acme E20'], ['E22', 'E20'],
  ]);
  expect(JSON.stringify(out.rows.map(row => row.run!.batchMounts))).not.toContain('Private maker');
}, 60_000);

it('records actual ordinary and mixed loadouts in tree order, including kept-never and empty mounts', async () => {
  const tree = clusterRocket('4-ring');
  const body = tree.components[0]!.children![1]!;
  body.children!.push({ type: 'innertube', id: 'side', name: 'Other mount', length: 0.2,
    outerRadius: 0.0125, thickness: 0.0005, motorMount: true },
  { type: 'innertube', id: 'empty', name: 'Empty mount', length: 0.2,
    outerRadius: 0.0125, thickness: 0.0005, motorMount: true });
  const target = { ...MOUNT, label: 'Picker label (⌀ 24 mm ×4)', motorCount: 4 };
  const split = splitClusterTree(tree, 'mount')!;
  const out = await sweep(input(tree, { target, mounts: [target, { ...MOUNT, id: 'side', label: 'Other mount' }],
    candidates: [entry('a', 'Acme', 'E20', '5'), entry('b', 'Bolt', 'E22', '5')], splits: [split], autoDelay: false,
    assignedMotors: { side: curve('Side') }, assignedIgnitions: { side: { event: 'never', delay: 0 } },
  }), { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22', 1.1) }), nozzleFor: nozzles({}) });
  expect(out.rows).toHaveLength(3);
  for (const row of out.rows) {
    expect(row.error).toBeUndefined();
    const records = row.run!.batchMounts!;
    expect(records.map(m => m.mountId)).toEqual(motorMounts(row.combo ? split.tree : tree).map(m => m.id));
    expect(records.find(m => m.mountId === 'side')).toEqual({ mountId: 'side', mountName: 'Other mount',
      role: 'kept', motor: 'Side', count: 1, ignition: 'never' });
    expect(records.find(m => m.mountId === 'empty')).toEqual({ mountId: 'empty', mountName: 'Empty mount',
      role: 'empty', motor: null, count: 1 });
    const candidates = records.filter(m => m.role === 'candidate');
    if (!row.combo) expect(candidates[0]?.mountName).not.toContain('Picker label');
    expect(candidates.map(m => [m.motor, m.count])).toEqual(row.combo ? [['E20', 2], ['E22', 2]] : [[row.entry.designation, 4]]);
  }
}, 60_000);

it('does not claim a background motor with a refused ignition event was kept', async () => {
  const tree = rocket({ sideMount: true });
  const out = await sweep(input(tree, { autoDelay: false, candidates: [entry('a', 'Acme', 'E20', '5')],
    assignedMotors: { side: curve('Refused') },
    assignedIgnitions: { side: { event: 'bogus' as never, delay: 0 } },
  }), { fetchSpec: fetchFrom({ a: curve('E20') }), nozzleFor: nozzles({}) });
  expect(out.rows[0]?.error).toBeUndefined();
  expect(out.rows[0]?.run?.batchMounts?.find(m => m.mountId === 'side')).toMatchObject({ role: 'empty', motor: null });
}, 60_000);
it.each(['toString', 'constructor', '__proto__'])('flies a loaded legacy sibling without inherited motor metadata: %s', async id => {
  const tree = rocket({ sideMount: true });
  tree.components[0]!.children![1]!.children!.find(n => n.id === 'side')!.id = id;
  const out = await sweep(input(tree, { mounts: [MOUNT, { ...MOUNT, id }],
    assignedMotors: { [id]: curve('E20') },
    assignedMotorIds: { [id]: undefined },
    candidates: [entry('a', 'Acme', 'E20', '5')], autoDelay: false }),
    { fetchSpec: fetchFrom({ a: curve('E20') }), nozzleFor: async motorId => motorId === 'a' ? {
      motorId, designation: 'E20', manufacturer: 'Acme', exitDiameterM: 0.012, confidence: 'high', drawings: [],
    } : null });
  expect(out.rows).toHaveLength(1);
  expect(out.rows[0]?.error).toBeUndefined();
  expect(out.rows[0]?.run).toBeDefined();
  expect(out.rows[0]?.run?.nozzleStages).toEqual(['Sustainer']);
});
it.each(['constructor', 'toString', '__proto__'])('ignores an unloaded sibling id %s when looking up nozzle exits', async id => {
  const tree = rocket({ sideMount: true });
  tree.components[0]!.children![1]!.children!.find(n => n.id === 'side')!.id = id;
  const requested: unknown[] = [];
  const out = await sweep(input(tree, { mounts: [MOUNT, { ...MOUNT, id }], candidates: [entry('a', 'Acme', 'E20', '5')], autoDelay: false }),
    { fetchSpec: fetchFrom({ a: curve('E20') }), nozzleFor: async motorId => { requested.push(motorId); return null; } });
  expect(out.rows).toHaveLength(1);
  expect(requested.every(value => typeof value === 'string')).toBe(true);
});

it.each(['constructor', 'toString', '__proto__'])('sweeps beside legacy motor %s without inherited IDs or ignition', async id => {
  const tree = rocket({ sideMount: true });
  motorMounts(tree).find(m => m.id === 'side')!.id = id;
  const requested: unknown[] = [];
  const result = await sweep(input(tree, { autoDelay: false, candidates: [entry('a', 'Acme', 'E20', '5')],
    mounts: [MOUNT, { ...MOUNT, id }], assignedMotors: { [id]: curve('Side') },
  }), { fetchSpec: fetchFrom({ a: curve('E20') }), nozzleFor: async motorId => {
    requested.push(motorId);
    if (motorId !== undefined && typeof motorId !== 'string') throw new Error('Non-string motor ID');
    return null;
  } });
  expect(requested.every(v => v === undefined || typeof v === 'string')).toBe(true);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]!.error).toBeUndefined();
  expect(result.rows[0]!.run!.delayResolution!.mounts.map(m => m.mountId)).toContain(id);
});

it('bundle metadata freezes scalar weather before single and mixed batch flights without changing their numbers', async () => {
  const tree = clusterRocket('4-ring');
  const target = { ...MOUNT, motorCount: 4 };
  const launch = { ...DEFAULT_CONDITIONS, latitudeDeg: 61.234567, longitudeDeg: -149.765432,
    temperatureC: 12, pressureHPa: 1000, windAverage: 4 };
  const weather: WeatherSnapshot = {
    v: 1, provider: 'open-meteo', endpoint: 'forecast', model: 'best_match',
    place: { label: '61.234567, -149.765432', latitudeDeg: 61.234567, longitudeDeg: -149.765432, method: 'coordinates' },
    grid: { latitudeDeg: 61.2, longitudeDeg: -149.7 }, demElevationM: 100, forAltitudeM: 100,
    timezone: 'America/Anchorage', validUnix: 1700000000, retrievedAt: '2026-10-13T00:00:00Z',
    fetched: { temperatureC: 12, pressureHPa: 1000, windSpeedMs: 4, windGustMs: 7, windFromDeg: 20 },
    applied: { temperatureC: 12, pressureHPa: 1000, windAverage: 4 },
    before: { temperatureC: null, pressureHPa: null, windAverage: 0 },
  };
  const expected = structuredClone(weather);
  const baseline = input(tree, { model: 'eb', autoDelay: false, launch, target, mounts: [target],
    splits: [splitClusterTree(tree, 'mount')!],
    candidates: [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')] });
  const deps = { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({}) };
  const plain = await sweep(baseline, deps);
  const withWeather = await sweep({ ...baseline, weatherSnapshot: weather }, { ...deps,
    fetchSpec: async (...args) => {
      // Edits after the sweep starts must not rewrite either pass's receipt.
      weather.fetched.windSpeedMs = 99;
      weather.applied.temperatureC = 99;
      weather.before.windAverage = 99;
      weather.place.label = 'Changed during sweep';
      return deps.fetchSpec(...args);
    },
  });
  expect(withWeather.rows).toHaveLength(3);
  expect(withWeather.rows.map(row => row.combo)).toEqual([false, false, true]);
  for (const [i, row] of withWeather.rows.entries()) {
    expect(row.error).toBeUndefined();
    const run = row.run!;
    expect(run.exportContext?.weather).toEqual(expected);
    expect(run.exportContext?.launch).toEqual(launch);
    expect(run.windLevels).toBeUndefined();
    expect(plain.rows[i]!.run!.exportContext?.weather).toBeNull();
    // Same kernel/runtime/inputs: metadata must not move even the last bit.
    expect(run.maxAltitude).toBe(plain.rows[i]!.run!.maxAltitude);
    expect(run.maxVelocity).toBe(plain.rows[i]!.run!.maxVelocity);
    expect(run.conditionsKey).toBe(plain.rows[i]!.run!.conditionsKey);
    for (const includeCoordinates of [false, true]) {
      const files = unzipSync(buildFlightDataBundle({ design: { name: tree.name!, tree, launch }, run,
        changedSince: [], includeCoordinates,
        measurements: { altimeterType: '', apogeeM: null, maxVelocityMs: null, liftoffMassKg: null, notes: '' },
      }).bytes);
      const context = JSON.parse(strFromU8(files['launch-and-weather.json']!));
      expect(context.weather.fetched.windSpeedMs).toBe(4);
      expect(context.weather.applied.temperatureC).toBe(12);
      expect(context.weather.before.windAverage).toBe(0);
      expect(JSON.parse(strFromU8(files['manifest.json']!)).weatherCredit.source.href).toBe('https://open-meteo.com/');
      if (includeCoordinates) expect(context.weather).toEqual(expected);
      else {
        expect(context.weather.place).toBeUndefined();
        expect(context.weather.grid).toBeUndefined();
        const all = Object.values(files).map(file => strFromU8(file)).join('\n');
        expect(all).not.toContain('61.234567');
        expect(all).not.toContain('-149.765432');
      }
    }
  }
}, 30_000);

it('N003 mixed zero-delay rows keep the recovery caution for both temporary group mounts', async () => {
  const tree = clusterRocket('4-ring', 'ejection');
  const split = splitClusterTree(tree, 'mount')!;
  const { rows } = await sweep(input(tree, { autoDelay: false, splits: [split],
    candidates: [entry('a', 'Acme', 'E20', '0'), entry('b', 'Acme', 'E22', '0')], units: IMPERIAL_UNITS,
    advisoryLimits: { maxAirspeedMs: uiToSi('velocity', 'ft/s', 1) },
  }), { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({ a: 0.005, b: 0.006 }) });
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.error).toBeUndefined();
    expect(row.run!.comments).toContain('1 ft/s (0.3 m/s)');
    const notes = commentsOf(row.run!).filter(c => c.text.includes('zero-second'));
    expect(notes).toHaveLength(row.combo ? 2 : 1);
    expect(notes.every(c => c.level === 'caution' && c.text.includes('Main'))).toBe(true);
    if (row.combo) {
      expect(row.run!.delayResolution!.mounts.every(m => m.mountName.includes('Mount') || m.mountName.includes('mount'))).toBe(true);
      expect(notes.some(c => c.text.includes('E20'))).toBe(true);
      expect(notes.some(c => c.text.includes('E22'))).toBe(true);
    }
  }
}, 30_000);

it('W2-WARN freezes advisory limits on single and mixed rows without changing their flight numbers', async () => {
  const tree = clusterRocket('4-ring');
  const split = splitClusterTree(tree, 'mount')!;
  const baseline = input(tree, { autoDelay: false, splits: [split],
    candidates: [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')] });
  const deps = { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({}) };
  const plain = await sweep(baseline, deps);
  const limits = { maxMach: 0.001 };
  const advised = await sweep({ ...baseline, advisoryLimits: limits }, deps);
  limits.maxMach = 99;
  expect(advised.rows).toHaveLength(3);
  for (const [i, row] of advised.rows.entries()) {
    expect(row.run?.advisoryLimits).toEqual({ maxMach: 0.001 });
    expect(row.run?.comments).toContain('your maximum');
    // Same runtime and same inputs: advisory data must not move even the last bit.
    expect(row.run?.maxAltitude).toBe(plain.rows[i]?.run?.maxAltitude);
    expect(row.run?.maxVelocity).toBe(plain.rows[i]?.run?.maxVelocity);
  }
}, 30_000);

it('RES-1 freezes base configuration and overrides on single and mixed batch rows', async () => {
  const tree = clusterRocket('4-ring');
  const split = splitClusterTree(tree, 'mount')!;
  const configuration: NonNullable<BatchSweepInput['configuration']> = {
    flightConfig: 'Club base', flightConfigId: 'club', flightOverrides: [{ family: 'recovery', kind: 'parachute', partName: 'Main',
      flies: { deployEvent: 'ejection', deployAltitude: 0, deployDelay: 0 },
      own: { deployEvent: 'apogee', deployAltitude: 0, deployDelay: 0 } }],
  };
  const expected = structuredClone(configuration);
  const { rows } = await sweep(input(tree, { configuration, autoDelay: false, splits: [split],
    candidates: [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')],
  }), { fetchSpec: async (motor, delay) => {
    configuration.flightConfig = 'Renamed during sweep';
    configuration.flightOverrides![0]!.partName = 'Renamed part';
    return { ...curve(motor.designation), ejectionDelay: delay };
  }, nozzleFor: nozzles({}) });
  expect(rows).toHaveLength(3);
  expect(rows.some(r => r.combo)).toBe(true);
  for (const row of rows) expect(row.run).toMatchObject({ ...expected, batch: true });
}, 30_000);

it('S7a-5: the live combo probe uses split mounts and drops the replaced motor', async () => {
  const tree = clusterRocket('4-ring');
  const split = splitClusterTree(tree, 'mount')!;
  const target = { ...MOUNT, motorCount: 4 };
  const slow = { ...curve('E20'), times: curve('E20').times.map((t) => t * 4.5) };
  const flights = vi.spyOn(OrkRocket.prototype, 'simulate');
  let atComboStart = -1;
  const out = await runBatchSweep(input(tree, {
    model: 'auto', autoDelay: false, mounts: [target], target, splits: [split],
    candidates: [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')],
    assignedMotors: { mount: { ...slow, times: [0, 15, 30], thrusts: [0, 10, 0], masses: [0.07, 0.05, 0.03] } },
  }), {
    signal: new AbortController().signal,
    onProgress: (p) => { if (p.done === 2) atComboStart = flights.mock.calls.length; },
  }, { fetchSpec: fetchFrom({ a: slow, b: { ...slow, designation: 'E22' } }), nozzleFor: nozzles({}), yieldToUi: noYield });
  expect(out.rows).toHaveLength(3);
  expect(out.rows.map((r) => r.error)).toEqual([undefined, undefined, undefined]);
  expect(atComboStart).toBeGreaterThan(0);
  // A 9 s synthetic burn plus the 3 s probe margin; no exact kernel float.
  expect(flights.mock.calls[atComboStart]![0]!.maxTime).toBe(12);
}, 30_000);

it('S7a-1 keeps explicit nozzle OFF for the loaded candidate only', async () => {
  const { rows } = await sweep(input(rocket({ nozzleExitDiameter: 0 }), {
    candidates: [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')],
    assignedMotorIds: { mount: 'a' }, autoDelay: false,
  }), { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({ a: 0.01, b: 0.012 }) });
  expect(rows[0]?.error).toBeUndefined();
  expect(rows[0]?.exitM).toBe(0);
  expect(rows[0]?.run).toBeDefined();
  expect(rows[0]?.run?.nozzleStages).toBeUndefined();
  expect(rows[1]?.exitM).toBeCloseTo(0.012, 12);
}, 30_000);

it('rail-needed sweep timing control: three fixed-delay motors, one flight each', async () => {
  const inp = input(rocket(), {
    candidates: [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5'), entry('c', 'Acme', 'E24', '5')],
    autoDelay: false,
    launch: { ...DEFAULT_CONDITIONS, launchRodLengthM: 3 },
  });
  const flights = vi.spyOn(OrkRocket.prototype, 'simulate');
  const start = performance.now();
  const result = await sweep(inp, {
    fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22', 1.1), c: curve('E24', 1.2) }),
    nozzleFor: nozzles({}),
  });
  console.log(`Rail-needed sweep: ${(performance.now() - start).toFixed(1)} ms; ${flights.mock.calls.length} flights`);
  expect(result.rows).toHaveLength(3);
  expect(result.rows.every((r) => r.run && !r.error)).toBe(true);
  expect(flights).toHaveBeenCalledTimes(3);
}, 30000);

describe('per-mount policy plumbing', () => {
  function fakeTelemetry() {
    const baseline = OrkRocket.buildTree(engineTree(rocket()));
    baseline.setMotorById('mount', curve('E20'));
    const normal = baseline.simulate(kernelSimOptions(DEFAULT_CONDITIONS));
    const installed = new Map<OrkRocket, Map<string, MotorSpec>>();
    const vectors: Record<string, number>[] = [];
    const realWrite = OrkRocket.prototype.setMotorById;
    vi.spyOn(OrkRocket.prototype, 'setMotorById').mockImplementation(function (this: OrkRocket, id, spec) {
      const state = installed.get(this) ?? new Map<string, MotorSpec>();
      state.set(id, spec); installed.set(this, state);
      return realWrite.call(this, id, spec);
    });
    let refused = false;
    vi.spyOn(OrkRocket.prototype, 'simulate').mockImplementation(function (this: OrkRocket, o) {
      const state = installed.get(this)!;
      if (o?.delayProbe) {
        vectors.push(Object.fromEntries([...state].map(([id, spec]) => [id, spec.ejectionDelay])));
        const p = probeFlight([...state.keys()]);
        if (refused) delete p.delayProbe;
        return p;
      }
      return normal;
    });
    return { vectors, refuse: (value: boolean) => { refused = value; } };
  }

  it('carries background Auto, resets each row and leaves plugged neighbours alone', async () => {
    const { vectors } = fakeTelemetry();
    const cands = [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')];
    const inp = input(rocket({ sideMount: true }), { candidates: cands, autoDelay: false,
      assignedMotors: { side: { ...curve('background'), ejectionDelay: 0 } }, assignedAutoDelays: { side: true },
      mounts: [MOUNT, { ...MOUNT, id: 'side', label: 'Side' }],
    });
    const { rows } = await sweep(inp, { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({}) });
    expect(rows.every((r) => r.run)).toBe(true);
    expect(vectors.map((v) => v['side'])).toEqual([0, 10, 0, 10]);
    expect(rows[1]!.run!.delayResolution!.mounts.find((m) => m.mountId === 'side')!.flownDelay).toBe(10);
    expect(vectors.every((v) => v['mount'] === 5)).toBe(true);
    const plugged = await sweep({ ...inp, candidates: [cands[0]!], assignedAutoDelays: {},
      assignedMotors: { side: { ...curve('background'), ejectionDelay: Infinity } } },
    { fetchSpec: fetchFrom({ a: curve('E20') }), nozzleFor: nozzles({}) });
    expect(plugged.rows[0]!.run!.delayResolution!.mounts.find((m) => m.mountId === 'side')!.flownDelay).toBe('plugged');
  });

  it('solves a no-listed-delay leg in a mixed combination while its fixed leg stays fixed', async () => {
    fakeTelemetry();
    const t = clusterRocket('4-ring'); const split = splitClusterTree(t, 'mount')!;
    const cands = [entry('a', 'Acme', 'E20', ''), entry('b', 'Acme', 'E22', '5')];
    const { rows } = await sweep(input(t, { candidates: cands, splits: [split], autoDelay: false }),
      { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({}) });
    const records = rows.find((r) => r.combo)!.run!.delayResolution!.mounts;
    expect(records.map((m) => m.mode).sort()).toEqual(['auto', 'manual']);
    expect(records.find((m) => m.mode === 'manual')!.flownDelay).toBe(5);
    expect(records.find((m) => m.mode === 'auto')!.status).toBe('resolved');
  });

  it('records a named failed row and continues to the next candidate', async () => {
    const telemetry = fakeTelemetry(); telemetry.refuse(true);
    const cands = [entry('a', 'Acme', 'E20', ''), entry('b', 'Acme', 'E22', '')];
    const rows = await runBatchSweep(input(rocket(), { candidates: cands }), {
      signal: new AbortController().signal, onRows: () => telemetry.refuse(false),
    }, { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({}), yieldToUi: noYield });
    expect(rows.rows[0]!.error).toMatch(/Motor mount.*telemetry/);
    expect(rows.rows[0]!.run).toBeUndefined(); expect(rows.rows[1]!.run).toBeDefined();
  });

  /**
   * WHICH FLIGHTS SEARCH FOR THEIR DELAY (review of the batch cap,
   * 2026-10-01). The dialog's estimate prices a flight that runs the delay
   * solver at several times one at a fixed delay, and "optimal delay per
   * motor" unticked does not mean that no flight searches. batchSolverFlights
   * counts them by rule; these fly the sweep and count them from each run's
   * own delay record.
   */
  describe('batchSolverFlights', () => {
    // One motor that lists no delay, two sold plugged only and one with a
    // delay: every case, alone and in each of the six 2+2 pairs.
    const cands = [
      entry('nd', 'Acme', 'E20', ''), entry('p1', 'Acme', 'E21', 'P'), entry('p2', 'Acme', 'E22', 'P'),
      entry('f', 'Acme', 'E23', '5'),
    ];
    const specs = { nd: curve('E20'), p1: curve('E21'), p2: curve('E22'), f: curve('E23') };
    const searched = (rows: readonly BatchRow[]) =>
      rows.filter((r) => r.run!.delayResolution!.mounts.some((m) => m.mode === 'auto')).length;

    it.each([
      ['waits for the motor’s charge', 'ejection', 7],
      ['deploys at apogee', 'apogee', 4],
    ])('counts the flights an unticked sweep searches, when the recovery %s', async (_, deployEvent, expected) => {
      fakeTelemetry();
      const t = clusterRocket('4-ring', deployEvent); const split = splitClusterTree(t, 'mount')!;
      const { rows } = await sweep(input(t, { candidates: cands, splits: [split], autoDelay: false }),
        { fetchSpec: fetchFrom(specs), nozzleFor: nozzles({}) });
      expect(rows.every((r) => r.run)).toBe(true);
      expect(rows).toHaveLength(4 + 6);
      expect(searched(rows)).toBe(expected);
      expect(batchSolverFlights({
        candidates: cands, groups: [split.mountIds.length], autoDelay: false,
        deploysOnCharge: deploysOnEjectionCharge(t), othersAuto: false,
      })).toBe(expected);
    });

    it('counts every flight when the box is ticked, or another mount’s motor is on Auto', async () => {
      fakeTelemetry();
      const t = rocket({ sideMount: true });
      const base = input(t, { candidates: cands, mounts: [MOUNT, { ...MOUNT, id: 'side', label: 'Side' }] });
      const deps = { fetchSpec: fetchFrom(specs), nozzleFor: nozzles({}) };
      const ticked = await sweep(base, deps);
      expect(searched(ticked.rows)).toBe(4);
      expect(batchSolverFlights({ candidates: cands, groups: [], autoDelay: true, deploysOnCharge: true, othersAuto: false }))
        .toBe(4);
      const beside = await sweep({ ...base, autoDelay: false,
        assignedMotors: { side: { ...curve('background'), ejectionDelay: 0 } }, assignedAutoDelays: { side: true } }, deps);
      expect(searched(beside.rows)).toBe(4);
      expect(batchSolverFlights({ candidates: cands, groups: [], autoDelay: false, deploysOnCharge: true, othersAuto: true }))
        .toBe(4);
    });
  });
});

it('Batch builds and flies the switched recovery tree and retains the existing plugged policy', async () => {
  const config = (deployEvent: string, deployAltitude = 200) => ({
    motors: {}, deployments: { chute: { deployEvent, deployAltitude, deployDelay: 0 } }, separations: {},
  });
  const base = rocket();
  const ejection = resolveFlightState(base, [], null, config('ejection'), {}).tree;
  const back = resolveFlightState(base, [], null, config('altitude', 50), {}).tree;
  const f13 = MOTOR_DB.find((m) => m.manufacturerAbbrev === 'AeroTech' && m.designation === 'F13-RCT')!;
  for (const [tree, charge] of [[ejection, true], [back, false]] as const) {
    expect(deploysOnEjectionCharge(tree)).toBe(charge);
    const inp = input(tree, { candidates: [f13], autoDelay: false });
    const build = vi.spyOn(OrkRocket, 'buildTree');
    const result = await sweep(inp, { fetchSpec: fetchMotorSpec, nozzleFor: nozzles({}) });
    expect(result.rows[0]!.error).toBeUndefined();
    expect(result.rows[0]!.optimumForPlugged === true).toBe(charge);
    expect(Number.isFinite(result.rows[0]!.run!.delayS)).toBe(charge);
    expect(build.mock.calls.length).toBeGreaterThan(0);
    for (const [builtTree] of build.mock.calls) {
      expect(JSON.stringify(builtTree)).toContain(`"deployEvent":"${charge ? 'ejection' : 'altitude'}"`);
    }
    build.mockRestore();
  }
  // Flies real kernel flights, now through the per-mount Auto solver's probes as
  // well: CI's Node 22 is slower than a laptop, and 5 s timed out (the v0.143
  // K9 tests' lesson, b82402c).
}, 60_000);

it('the shipped engine deploys at the switched altitude or delayed charge', () => {
  const base = rocket();
  for (const [deployEvent, deployAltitude, deployDelay] of [['altitude', 50, 0], ['ejection', 200, 2]] as const) {
    const tree = resolveFlightState(base, [], null, { separations: {},
      deployments: { chute: { deployEvent, deployAltitude, deployDelay } } }, {}).tree;
    const handle = OrkRocket.buildTree(engineTree(tree));
    handle.setMotorById('mount', curve('E20'));
    const flight = handle.simulate({ launchRodLength: 1, windAverage: 0 });
    const deployed = flight.events.find((e) => e.type === 'RECOVERY_DEVICE_DEPLOYMENT')!;
    expect(deployed).toBeDefined();
    if (deployEvent === 'ejection') {
      const charge = flight.events.find((e) => e.type === 'EJECTION_CHARGE')!;
      // Adaptive event stepping can cross a scheduled time by one step (< 0.05 s).
      expect(Math.abs(deployed.time - charge.time - 2)).toBeLessThan(0.05);
    } else {
      const apogee = flight.events.find((e) => e.type === 'APOGEE')!;
      expect(deployed.time).toBeGreaterThan(apogee.time);
      // The altitude event fires on the first recorded row at or below the requested
      // 50 m, not a row earlier or later. A fixed metres allowance does not hold: this
      // calm vertical flight tumbles after apogee (OR #3183) and the tumble stepper's
      // rows are ~0.5 s / ~5 m apart, so the crossing row can sit anywhere in that span.
      const { time, altitude } = flight.series;
      const fromApogee = time.findIndex((t) => t >= apogee.time);
      const cross = altitude.findIndex((a, i) => i > fromApogee && a <= 50);
      expect(cross).toBeGreaterThan(fromApogee);
      expect(altitude[cross - 1]!).toBeGreaterThan(50);
      expect(deployed.time).toBeGreaterThanOrEqual(time[cross]!);
      expect(deployed.time - time[cross]!).toBeLessThan(0.01);
    }
  }
});

describe('provisionalDelay — what a candidate flies before any optimum is known', () => {
  it('is the longest prescribed delay in either mode', () => {
    for (const auto of [false, true]) {
      expect(provisionalDelay(entry('a', 'X', 'A', '3,5,7'), auto)).toBe(7);
      expect(provisionalDelay(entry('a', 'X', 'A', '6,10,P'), auto)).toBe(10);
      // No listed delay (delayOptions → [] since the row-363 fix): the first
      // flight is at 0 in both modes, and flyLegs then re-flies it at the
      // optimum — the browser's "Auto (optimal)" default for such a motor.
      expect(provisionalDelay(entry('a', 'X', 'A', ''), auto)).toBe(0);
      expect(listsNoDelay(entry('a', 'X', 'A', ''))).toBe(true);
      expect(listsNoDelay(entry('a', 'X', 'A', '6,10,P'))).toBe(false);
      expect(listsNoDelay(entry('a', 'X', 'A', 'P'))).toBe(false);
    }
  });

  it('flies a plugged-only motor plugged unticked, and at 0 under auto delay — as the design page does', () => {
    // The audit's case: unticked, `?? 0` flew this with a charge at burnout.
    expect(provisionalDelay(entry('a', 'X', 'A', 'P'), false)).toBe(Infinity);
    // Under auto delay 0 is only the FIRST flight, re-flown at the optimum.
    expect(provisionalDelay(entry('a', 'X', 'A', 'P'), true)).toBe(0);
  });

  /**
   * The motor browser is where the design page's first flight comes from, and
   * the batch has to start from the same one in the same mode (v0.135). Its two
   * expressions are pinned in its source, then held against every motor in the
   * shipped catalogue.
   */
  it("matches the motor browser's first flight in both modes, for every motor in the shipped catalogue", () => {
    const browser = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../components/MotorBrowser.tsx'), 'utf8');
    // Its default pick (defaultDelay, or "Auto (optimal)" for a motor that
    // lists no delay), and what its auto load flies before App re-flies at the optimum.
    expect(browser).toContain("if (picked) setDelay(defaultDelay(picked) ?? 'auto');");
    expect(browser).toContain("const chosen = delay === 'auto' ? finite[finite.length - 1] ?? 0");
    let pluggedOnly = 0;
    for (const m of MOTOR_DB) {
      const opts = delayOptions(m);
      const finite = opts.filter((d) => Number.isFinite(d));
      if (finite.length === 0 && opts.includes(Infinity)) pluggedOnly++;
      // Unticked, the browser starts from defaultDelay; a null default is its
      // "Auto" pick, whose first flight is the auto load's.
      const pick = defaultDelay(m);
      expect(provisionalDelay(m, false), m.designation).toBe(pick ?? (finite[finite.length - 1] ?? 0));
      expect(provisionalDelay(m, true), m.designation).toBe(finite[finite.length - 1] ?? 0);
    }
    expect(pluggedOnly).toBeGreaterThan(100);
  });
});

describe('deploysOnEjectionCharge', () => {
  it("reads a device with no event as the kernel's default, the ejection charge", () => {
    expect(deploysOnEjectionCharge(rocket())).toBe(true);
    expect(deploysOnEjectionCharge(rocket({ deployEvent: 'ejection' }))).toBe(true);
  });

  it('is false when every device deploys on electronics', () => {
    expect(deploysOnEjectionCharge(rocket({ deployEvent: 'apogee' }))).toBe(false);
    expect(deploysOnEjectionCharge(rocket({ deployEvent: 'altitude' }))).toBe(false);
  });

  it('finds a streamer on the charge beside an apogee chute, and says false for no device at all', () => {
    const t = rocket({ deployEvent: 'apogee' });
    const bt = t.components[0]!.children![1]!;
    bt.children!.push({ type: 'streamer', id: 's', stripLength: 1, stripWidth: 0.05 } as ComponentNode);
    expect(deploysOnEjectionCharge(t)).toBe(true);
    bt.children = bt.children!.filter((c) => c.type !== 'parachute' && c.type !== 'streamer');
    expect(deploysOnEjectionCharge(t)).toBe(false);
  });
});

describe('batchMotorNames and batchRowKey — rows that can be told apart', () => {
  it('names the manufacturer, and falls back to the raw designation only where two candidates would read alike', () => {
    const cti = ['229H255-14A', '315H255-14A'].map(d => labelMotor(d, 'Cesaroni'));
    expect(cti.map((m) => m.designation).sort()).toEqual(['229H255-14A', '315H255-14A']);
    const other = labelMotor('F13-RCT', 'AeroTech');
    const names = batchMotorNames([...cti, other]);
    expect(names.get(other.motorId)).toBe('AeroTech F13-RCT');
    expect(names.get(cti[0]!.motorId)).toBe(`Cesaroni ${cti[0]!.designation}`);
    expect(new Set(names.values()).size).toBe(3);
    // Alone in a sweep, the Cesaroni motor keeps its display designation.
    expect(batchMotorNames([cti[0]!]).get(cti[0]!.motorId)).toBe('Cesaroni H255-14A');
  });

  it('keys a row on its configuration and the multiset of motor ids it flew', () => {
    expect(batchRowKey('mixed 4+2', ['b', 'a', 'a'])).toBe('mixed 4+2:a+a+b');
    expect(batchRowKey('mixed 4+2', ['a', 'b', 'b'])).not.toBe(batchRowKey('mixed 4+2', ['a', 'a', 'b']));
    expect(batchRowKey('mixed 3+3', ['a', 'b'])).not.toBe(batchRowKey('single', ['a', 'b']));
  });
});

describe('the sweep, flown on the real kernel', () => {
  /**
   * AUDIT 2026-09-22, MEASURED THERE ON THE F13-RCT: with "optimal delay per
   * motor" unticked a plugged-only motor flew `?? 0`, deploying at burnout —
   * 32.6 % low, graded "too low" and ranked last. This flies the real
   * catalogue row through the real (bundled, offline) curve.
   */
  const f13 = MOTOR_DB.find((m) => m.manufacturerAbbrev === 'AeroTech' && m.designation === 'F13-RCT')!;

  it('the F13-RCT is still plugged-only in the shipped catalogue', () => {
    expect(f13.delays).toBe('P');
  });

  it('flies a plugged-only motor at its optimum, marked, when the recovery waits for the charge — never at 0', async () => {
    const tree = rocket();
    const deps = { fetchSpec: fetchMotorSpec, nozzleFor: nozzles({}) };
    const { rows } = await sweep(input(tree, { candidates: [f13], autoDelay: false }), deps);
    const row = rows[0]!;
    expect(row.error).toBeUndefined();
    expect(row.optimumForPlugged).toBe(true);
    expect(row.run!.delayS).toBe(recommendDelay(row.run!.optimumDelayS));
    // …and the RUN says so, not only the dialog: the run is what reaches the
    // history, the CSV and the XLSX, where its Delay column reads a delay the
    // motor is not sold with.
    const said = row.run!.comments.split(' | ');
    expect(said[said.length - 1]).toBe('This motor is sold plugged (no ejection charge), and this design '
      + 'deploys its recovery on the motor’s charge, so the batch flew it with a hypothetical charge at the optimum delay of '
      + `${row.run!.delayS} s rather than with no deployment at all. To fly it as sold, set the recovery `
      + 'to deploy at apogee or altitude.');
    expect(commentLevelsAlign(row.run!)).toBe(true);
    // What the old `?? 0` flew, on the same airframe.
    const r = OrkRocket.buildTree(engineTree(tree));
    r.setRogersModifiedBarrowman(true);
    r.setMotorById('mount', await fetchMotorSpec(f13, 0));
    const atBurnout = r.simulate({ launchRodLength: 1 }).summary.maxAltitude;
    expect(row.run!.maxAltitude).toBeGreaterThan(atBurnout * 1.3);

    // With the recovery on electronics it flies plugged — exactly how it
    // would fly — and reaches the same top, because nothing deploys before it.
    const apogee = await sweep(input(rocket({ deployEvent: 'apogee' }), { candidates: [f13], autoDelay: false }), deps);
    expect(apogee.rows[0]!.optimumForPlugged).toBeUndefined();
    expect(apogee.rows[0]!.run!.delayS).toBe(Infinity);
    expect(apogee.rows[0]!.run!.comments).not.toContain('the batch flew it');
    expect(apogee.rows[0]!.run!.maxAltitude).toBeCloseTo(row.run!.maxAltitude, 0);
  }, 60000);

  /**
   * THE SAME MOTOR READS THE SAME IN BOTH PLACES (v0.135) — for a plugged-only
   * motor under "optimal delay per motor" as well. Flown beside the design
   * page's own sequence: the motor browser's auto load flies `longest
   * prescribed ?? 0` (pinned above), and App re-flies at the rounded optimum.
   * The first cut of the row-407 fix flew such a motor PLUGGED here, and the
   * kernel takes a flight's optimum from a coast probe when the recovery
   * deploys before apogee but from the flight's own apogee when nothing has —
   * a few hundredths of a second apart. On this airframe the Ellis I160 then
   * rounded to 10 s here against 9 s on the design page.
   */
  it('flies a plugged-only motor under auto delay exactly as the design page does', async () => {
    const i160 = MOTOR_DB.find((m) => m.manufacturerAbbrev === 'Ellis' && m.designation === 'I160')!;
    expect(delayOptions(i160)).toEqual([Infinity]);
    const tree = fiftyMm();
    const opts = kernelSimOptions(DEFAULT_CONDITIONS);
    const r = OrkRocket.buildTree(engineTree(tree));
    r.setRogersModifiedBarrowman(true);
    const spec = await fetchMotorSpec(i160, 0);
    r.setMotorById('mount', spec);
    const launch = await flyLaunch(r, {
      assigned: [['mount', { spec, label: spec.designation, meta: { label: spec.designation, autoDelay: true }, ignition: { event: 'automatic', delay: 0 } }]],
      hardware: undefined, primaryMountId: 'mount', simOptions: opts,
      aeroMode: 'classic', supersonic: false, isOnLaunchStage: () => true, onSupersonicUpgrade: () => {},
    });
    const rec = launch.flownDelayS;
    const designPage = launch.result.summary.maxAltitude;

    const target = { ...MOUNT, diameterMm: 38 };
    const { rows } = await sweep(input(tree, { mounts: [target], target, candidates: [i160] }), {
      fetchSpec: fetchMotorSpec, nozzleFor: nozzles({}),
    });
    expect(rows[0]!.run!.delayS).toBe(rec);
    expect(rows[0]!.run!.maxAltitude).toBe(designPage);
  }, 60000);

  it('stamps the aero model through flightPipeline, and keeps Kbf off anything flown supersonic', async () => {
    const specs = { m1: curve('E20') };
    const cand = [entry('m1', 'Acme', 'E20', '5')];
    const stamp = async (model: BatchSweepInput['model']) => {
      const { rows } = await sweep(input(rocket(), { candidates: cand, model }), {
        fetchSpec: fetchFrom(specs), nozzleFor: nozzles({}),
      });
      return { aeroModel: rows[0]!.run!.aeroModel, rogersKbf: rows[0]!.run!.rogersKbf };
    };
    expect(await stamp('kbf')).toEqual({ aeroModel: 'classic', rogersKbf: true });
    expect(await stamp('eb')).toEqual({ aeroModel: 'classic', rogersKbf: false });
    expect(await stamp('supersonic')).toEqual({ aeroModel: 'supersonic', rogersKbf: false });
    expect(await stamp('hybrid')).toEqual({ aeroModel: 'hybrid', rogersKbf: true });
    // A subsonic E under Auto stays classic, with Kbf on as Auto flies it.
    expect(await stamp('auto')).toEqual({ aeroModel: 'classic', rogersKbf: true });
  }, 60000);

  it('does not re-fly a combination whose legs already sit at the optimum (the single pass never did)', async () => {
    const tree = clusterRocket('4-ring');
    const split = splitClusterTree(tree, 'mount')!;
    const cands = [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')];
    const specs = { a: curve('E20'), b: curve('E22', 1.05) };
    const target = { ...MOUNT, motorCount: 4 };
    // First find the combination's own optimum…
    const first = await sweep(input(tree, { mounts: [target], target, candidates: cands, splits: [split] }), {
      fetchSpec: fetchFrom(specs), nozzleFor: nozzles({}),
    });
    const combo = first.rows.find((r) => r.combo)!;
    const rec = combo.run!.delayS;
    expect(rec).toBe(recommendDelay(combo.run!.optimumDelayS));
    // …then hand every leg that delay up front: the flight is already the one
    // the rule wants, so the combination flies ONCE, where it used to fly twice.
    const atRec = { a: { ...specs.a }, b: { ...specs.b } };
    const fixedDelay: BatchSweepDeps['fetchSpec'] = async (m) => ({ ...atRec[m.motorId as 'a' | 'b'], ejectionDelay: rec });
    const flights = vi.spyOn(OrkRocket.prototype, 'simulate');
    let atComboStart = -1;
    const again = await runBatchSweep(input(tree, { mounts: [target], target, candidates: cands, splits: [split] }), {
      signal: new AbortController().signal,
      // The combination pass starts at progress `done === candidates.length`.
      onProgress: (p) => { if (p.done === cands.length) atComboStart = flights.mock.calls.length; },
    }, { fetchSpec: fixedDelay, nozzleFor: nozzles({}), yieldToUi: noYield });
    expect(atComboStart).toBeGreaterThan(0);
    // 'kbf' flies no Mach probe, so this is the combination's flights exactly.
    expect(flights.mock.calls.length - atComboStart).toBe(2); // one confirming target probe, one normal flight
    // …and it is the same flight the re-fly used to produce.
    expect(again.rows.find((r) => r.combo)!.run!.maxAltitude).toBe(combo.run!.maxAltitude);
  }, 60000);

  it('names the manufacturer in every leg of a combination label, and keys every row uniquely', async () => {
    const tree = clusterRocket('6-ring');
    const pair = splitClusterPairsTree(tree, 'mount')!;
    const cands = [entry('a', 'Acme', 'E20', '5'), entry('b', 'Bolt', 'E20', '5')];
    const specs = { a: curve('E20'), b: curve('E20', 1.1) };
    const target = { ...MOUNT, motorCount: 6 };
    const { rows } = await sweep(input(tree, { mounts: [target], target, candidates: cands, splits: [pair], autoDelay: false }), {
      fetchSpec: fetchFrom(specs), nozzleFor: nozzles({}),
    });
    const combos = rows.filter((r) => r.combo);
    // [a,a,b] and [a,b,b]: the two 4+2 rows.
    expect(combos.map((r) => r.label).sort()).toEqual(['2× Acme E20 + 4× Bolt E20', '4× Acme E20 + 2× Bolt E20']);
    expect(combos.every((r) => r.run!.motor === r.label)).toBe(true);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    // The run history prints `<manufacturer> <motor>`; a label that already
    // names every maker must not get them all a second time in front of it.
    for (const c of combos) expect(historyMotorLabel(c.run!)).toBe(c.label);
    expect(historyMotorLabel(rows.find((r) => !r.combo)!.run!)).toBe('Acme E20');
  }, 60000);

  /**
   * A cluster inside a POD SET (audit 2026-09-22, row 351, from review). The
   * single-motor pass counts the pods through `target.motorCount`; the
   * combination pass counted each group as `split.groupSize` alone — a 4-ring
   * in three pods read "2× A + 2× B", was stored as 4 motors and was given four
   * motors' equivalent exit, where the kernel burns twelve.
   */
  it('counts a combination’s groups as every pod fires them', async () => {
    const base = clusterRocket('4-ring');
    const bt = base.components[0]!.children![1]!;
    const mount = bt.children!.find((c) => c.id === 'mount')!;
    bt.children = [
      ...bt.children!.filter((c) => c.id !== 'mount'),
      {
        type: 'podset', id: 'pods', instanceCount: 3, radiusMethod: 'relative', radiusOffset: 0, angleOffset: 0,
        position: { method: 'bottom', offset: 0 },
        children: [{
          type: 'bodytube', id: 'pb', length: 0.3, outerRadius: 0.03, thickness: 0.001,
          children: [mount],
        } as ComponentNode],
      } as ComponentNode,
    ];
    const split = splitClusterTree(base, 'mount')!;
    const cands = [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')];
    const specs = { a: curve('E20'), b: curve('E22', 1.05) };
    const target = { ...MOUNT, motorCount: 12 };
    const { rows } = await sweep(input(base, { mounts: [target], target, candidates: cands, splits: [split], autoDelay: false }), {
      fetchSpec: fetchFrom(specs), nozzleFor: nozzles({ a: 0.01, b: 0.01 }),
    });
    const combo = rows.find((r) => r.combo)!;
    expect(combo.label).toBe('6× Acme E20 + 6× Acme E22');
    expect(combo.run!.motorCount).toBe(12);
    expect(combo.run!.batchMounts?.map(m => [m.role, m.motor, m.count])).toEqual([
      ['candidate', 'E20', 6], ['candidate', 'E22', 6],
    ]);
    // Twelve 10 mm exits, summed by area: 10·√12 mm.
    expect(combo.exitM).toBeCloseTo(0.01 * Math.sqrt(12), 12);
    // The single-motor rows already counted the pods, and still do.
    expect(rows.find((r) => !r.combo)!.run!.motorCount).toBe(12);
    expect(rows.find((r) => !r.combo)!.run!.batchMounts?.[0]?.count).toBe(12);
  }, 60000);

  it('the history keeps the maker in front of a combination stored before its label named one', () => {
    expect(historyMotorLabel({ manufacturer: 'Acme+Bolt', motor: '4× E20 + 2× E20', motorConfig: 'mixed 4+2' }))
      .toBe('Acme+Bolt 4× E20 + 2× E20');
    expect(historyMotorLabel({ manufacturer: 'Acme', motor: 'E20', motorConfig: 'single' })).toBe('Acme E20');
    expect(historyMotorLabel({ manufacturer: '', motor: 'E20' })).toBe('E20');
  });

  it('records nothing for a motor whose download Stop cut short — it was never flown', async () => {
    const ctrl = new AbortController();
    const specs = { a: curve('E20'), b: curve('E22') };
    const fetchSpec: BatchSweepDeps['fetchSpec'] = (m, delay, signal) => (m.motorId === 'a'
      ? Promise.resolve({ ...specs.a, ejectionDelay: delay })
      // The second download hangs until Stop, then rejects the way fetch does.
      : new Promise((_, reject) => {
        signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        ctrl.abort();
      }));
    const { rows, stopped } = await sweep(input(rocket(), {
      candidates: [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5'), entry('c', 'Acme', 'E24', '5')],
    }), { fetchSpec, nozzleFor: nozzles({}) }, ctrl.signal);
    expect(stopped).toBe(true);
    expect(rows.map((r) => r.entry.motorId)).toEqual(['a']);
    expect(rows.some((r) => r.error)).toBe(false);
  }, 60000);

  it('still records a real download failure as a row that could not be flown', async () => {
    const fetchSpec: BatchSweepDeps['fetchSpec'] = async () => { throw new Error('HTTP 500'); };
    const { rows, stopped } = await sweep(input(rocket(), { candidates: [entry('a', 'Acme', 'E20', '5')] }), {
      fetchSpec, nozzleFor: nozzles({}),
    });
    expect(stopped).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error).toBe('HTTP 500');
  });

  /**
   * v0.137 made nozzleFollow read `motorId ?? exMotorId`; App's batch wiring
   * still read `motorId` alone (audit 2026-09-22). With the ex: id handed
   * over, an imported motor counts on both sides of the nozzle rule.
   */
  it('an imported motor loaded on the target flies the exit typed for it', async () => {
    const tree = rocket({ nozzleExitDiameter: 0.05 });
    const cands = [entry('ex:mine', 'EX', 'E20', '5'), entry('cat', 'Acme', 'E22', '5')];
    const specs = { 'ex:mine': curve('E20'), cat: curve('E22') };
    const { rows } = await sweep(input(tree, { candidates: cands, assignedMotorIds: { mount: 'ex:mine' } }), {
      fetchSpec: fetchFrom(specs), nozzleFor: nozzles({ cat: 0.02 }),
    });
    expect(rows.find((r) => r.entry.motorId === 'ex:mine')!.exitM).toBe(0.05);
    // …and only for it.
    expect(rows.find((r) => r.entry.motorId === 'cat')!.exitM).toBeCloseTo(0.02, 12);
  }, 60000);

  it("App's ids read an imported motor by its ex: id — the id nozzleFollow reads for the same motor", () => {
    const tree = rocket({ sideMount: true });
    const mm = (meta: MountMotor['meta']) => ({ label: meta.label, spec: curve('E20'), meta } as MountMotor);
    const motors = {
      mount: mm({ label: 'E22', manufacturer: 'Acme', motorId: 'cat' }),
      side: mm({ label: 'E20', manufacturer: 'EX', exMotorId: 'ex:side' }),
    };
    const ids = batchMotorIds(motors);
    expect(ids).toEqual({ mount: 'cat', side: 'ex:side' });
    // …which is exactly what nozzleFollow sees on the design page.
    const follow = stageMotors(tree, Object.entries(motors))[0]!.motors;
    expect(Object.fromEntries(follow.map((m) => [m.mountId, m.motorId]))).toEqual(ids);
  });

  it("an imported motor on another mount adds its file's exit to every candidate's stage sum", async () => {
    const side: BatchMountOption = { id: 'side', label: 'Side', diameterMm: 24, motorCount: 1, maxMotorLengthM: null };
    const tree = rocket({ sideMount: true });
    const { rows } = await sweep(input(tree, {
      mounts: [MOUNT, side], candidates: [entry('cat', 'Acme', 'E22', '5')],
      assignedMotors: { side: curve('E20') }, assignedMotorIds: { side: 'ex:side' },
    }), { fetchSpec: fetchFrom({ cat: curve('E22') }), nozzleFor: nozzles({ cat: 0.04, 'ex:side': 0.03 }) });
    // 3-4-5: the two areas sum to one 0.05 m equivalent.
    expect(rows[0]!.exitM).toBeCloseTo(0.05, 12);
  }, 60000);

  /**
   * applyOthers' ignition restore, FLOWN rather than counted in the source
   * (flownIgnitionSites.test.ts can only see that a write happened). Every
   * setMotorById installs a fresh MotorConfiguration, so without the restore a
   * mount the design set never to light fired through the whole sweep.
   */
  it("keeps another mount's ignition: a motor set never to light rides along unlit", async () => {
    const side: BatchMountOption = { id: 'side', label: 'Side', diameterMm: 24, motorCount: 1, maxMotorLengthM: null };
    const over = {
      mounts: [MOUNT, side], candidates: [entry('cat', 'Acme', 'E22', '5')],
      assignedMotors: { side: curve('E20') },
    };
    const deps = { fetchSpec: fetchFrom({ cat: curve('E22') }), nozzleFor: nozzles({}) };
    const lit = await sweep(input(rocket({ sideMount: true }), over), deps);
    const unlit = await sweep(input(rocket({ sideMount: true }), {
      ...over, assignedIgnitions: { side: { event: 'never', delay: 0 } },
    }), deps);
    expect(unlit.rows[0]!.run!.maxAltitude).toBeLessThan(lit.rows[0]!.run!.maxAltitude * 0.8);
  }, 60000);

  /**
   * THE ROW-283 GAP (seam review of audit 2026-09-22). The design page refuses a
   * motor whose ignition event the kernel does not know — `writeMountMotor`
   * checks the event BEFORE the motor goes on — and flies without it. Batch
   * wrote the motor first, then the ignition threw into a catch meant for a
   * missing mount, so the same motor flew here on AUTOMATIC: 240.34 m in Batch
   * against 122.06 m on the design page, on the review's two-mount design.
   */
  it("refuses another mount's motor whose ignition the kernel does not know, as the design page does", async () => {
    const side: BatchMountOption = { id: 'side', label: 'Side', diameterMm: 24, motorCount: 1, maxMotorLengthM: null };
    const base = { mounts: [MOUNT, side], candidates: [entry('cat', 'Acme', 'E22', '5')] };
    const deps = { fetchSpec: fetchFrom({ cat: curve('E22') }), nozzleFor: nozzles({}) };
    const refused = await sweep(input(rocket({ sideMount: true }), {
      ...base, assignedMotors: { side: curve('E20') },
      assignedIgnitions: { side: { event: 'bogus' as never, delay: 0 } },
    }), deps);
    const absent = await sweep(input(rocket({ sideMount: true }), base), deps);
    expect(refused.rows[0]!.run!.maxAltitude).toBe(absent.rows[0]!.run!.maxAltitude);
  }, 60000);

  it("strips the design's own nozzle: a candidate with no published exit flies none", async () => {
    const cands = [entry('cat', 'Acme', 'E22', '5')];
    const deps = { fetchSpec: fetchFrom({ cat: curve('E22') }), nozzleFor: nozzles({}) };
    const withDesignNozzle = await sweep(input(rocket({ nozzleExitDiameter: 0.03 }), { candidates: cands, model: 'supersonic' }), deps);
    const without = await sweep(input(rocket(), { candidates: cands, model: 'supersonic' }), deps);
    expect(withDesignNozzle.rows[0]!.exitM).toBeNull();
    expect(withDesignNozzle.rows[0]!.run!.nozzleStages).toBeUndefined();
    expect(withDesignNozzle.rows[0]!.run!.maxAltitude).toBe(without.rows[0]!.run!.maxAltitude);
  }, 60000);
});

/**
 * The handle discipline, pinned in the source because what matters is what can
 * NEVER be written: a handle built from a tree that still carries the design's
 * nozzle, or a resetEngine() that frees the design's own handle mid-sweep.
 * These moved here from BatchSimulate.test.tsx with the code they read.
 */
describe('the sweep builds every handle over a stripped tree', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), './batchSweep.ts'), 'utf8');

  it('strips the design nozzle before the single-motor pass', () => {
    expect(src).toContain('const sweepTree = clearStageNozzles(tree);');
    // 124: the same stripped-tree pool now excludes the entire target set.
    expect(src).toContain('const sweepHandle = handlePool(sweepTree, targetIds);');
  });

  it('strips it for the combination passes too — split.tree comes from the design tree', () => {
    expect(src).toContain('handlePool(clearStageNozzles(split.tree)');
  });

  it('no handle is built from a raw tree', () => {
    expect(src).not.toContain('engineTree(tree)');
    expect(src).not.toContain('engineTree(split.tree)');
  });

  it('builds every handle through the pool, from the stripped base', () => {
    expect(src.match(/OrkRocket\.buildTree\(/g)).toHaveLength(1);
    expect(src).toContain('applyStageNozzles(base, { [stageIdOfTarget]: equivM as number })');
  });

  it('never frees the engine mid-sweep', () => {
    // Comments are stripped first — the warning against calling it is itself written in one.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('resetEngine(');
  });

  it('falls back to no nozzle when a candidate has none', () => {
    expect(src).toContain("const key = usable ? (equivM as number).toFixed(6) : 'none';");
  });
});


it('flies every batch candidate with the same aloft profile as Launch', async () => {
  const design = rocket();
  const specs = { m1: curve('E20'), m2: curve('E22', 1.1) };
  const candidates = [entry('m1', 'Acme', 'E20', '5'), entry('m2', 'Acme', 'E22', '5')];
  const launch = { ...DEFAULT_CONDITIONS, windAverage: 3, windLevels: [
    { altitude: 10, speed: 3, direction: 0, standardDeviation: 0 },
    { altitude: 80, speed: 12, direction: 0.2, standardDeviation: 0 },
  ] };
  const { rows } = await sweep(input(design, { candidates, launch, autoDelay: false, model: 'eb' }), {
    fetchSpec: fetchFrom(specs), nozzleFor: nozzles({}),
  });
  expect(rows).toHaveLength(2);
  for (let i = 0; i < rows.length; i++) {
    const r = OrkRocket.buildTree(engineTree(design));
    r.setRogersModifiedBarrowman(false);
    r.setMotorById('mount', Object.values(specs)[i]!);
    const direct = r.simulate(kernelSimOptions(launch));
    expect(rows[i]!.run!.windLevels).toEqual(launch.windLevels);
    expect(rows[i]!.run!.maxAltitude).toBe(direct.summary.maxAltitude);
  }
}, 60000);


it('S7a-2 flies candidates despite a motor left on a deleted mount', async () => {
  const inp = input(rocket(), {
    candidates: [entry('a', 'Acme', 'E20', '5')], autoDelay: false,
    assignedMotors: { deleted: curve('E20') }, assignedMotorIds: { deleted: 'gone' },
    assignedIgnitions: { deleted: { event: 'automatic', delay: 0 } },
  });
  const result = await sweep(inp, { fetchSpec: fetchFrom({ a: curve('E20') }), nozzleFor: nozzles({}) });
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]!.error).toBeUndefined();
  expect(result.rows[0]!.run).toBeDefined();
}, 30000);

it('K7: Batch row carries provenance keys (motorDataKey, designKey, motorSetKey) matching design, and a changed curve makes runMatchesDesign false', async () => {
  const tree = rocket();
  const specA = curve('E20');
  const cand = entry('a', 'Acme', 'E20', '5');
  const inp = input(tree, {
    candidates: [cand],
    autoDelay: false,
  });
  const result = await sweep(inp, { fetchSpec: fetchFrom({ a: specA }), nozzleFor: nozzles({}) });
  expect(result.rows).toHaveLength(1);
  const row = result.rows[0]!;
  expect(row.run).toBeDefined();
  const run = row.run!;

  // 1. A Batch row carries motorDataKey equal to motorDataKeyOf for its motors
  const expectedAssigned: [string, MountMotor][] = [[
    'mount',
    {
      spec: { ...specA, ejectionDelay: 5 },
      label: specA.designation,
      meta: {
        label: cand.designation,
        manufacturer: cand.manufacturerAbbrev,
        motorId: cand.motorId,
        autoDelay: false,
      },
      ignition: { event: 'automatic', delay: 0 },
    },
  ]];
  expect(run.motorDataKey).toBeDefined();
  expect(run.motorDataKey).toBe(motorDataKeyOf(expectedAssigned));

  // 2. Also carries designKey and motorSetKey matching the swept design and motor
  const cur = provenanceKeyOf({
    physicsKey: physicsKeyOf(tree.components),
    tree,
    assigned: expectedAssigned,
    hardwareDeltaKg: 0,
    launch: DEFAULT_CONDITIONS,
    aero: { aeroMode: 'classic', effectiveKbf: true, autoSupersonic: false },
  });
  expect(run.designKey).toBe(cur.designKey);
  expect(run.motorSetKey).toBe(cur.motorSetKey);
  expect(run.motorDataKeys).toEqual(cur.motorDataKeys);
  expect(runMatchesDesign(run, cur)).toBe(true);

  // 3. A changed curve makes runMatchesDesign false for it
  const changedSpec = { ...specA, thrusts: specA.thrusts.map((t) => t * 1.5) };
  const changedAssigned: [string, MountMotor][] = [[
    'mount',
    {
      ...expectedAssigned[0]![1],
      spec: changedSpec,
    },
  ]];
  const changedCur = provenanceKeyOf({
    physicsKey: physicsKeyOf(tree.components),
    tree,
    assigned: changedAssigned,
    hardwareDeltaKg: 0,
    launch: DEFAULT_CONDITIONS,
    aero: { aeroMode: 'classic', effectiveKbf: true, autoSupersonic: false },
  });
  expect(changedCur.motorDataKey).not.toBe(run.motorDataKey);
  expect(runMatchesDesign(run, changedCur)).toBe(false);
}, 30000);

it('K7: combination Batch row keys the original design and the flown group motors', async () => {
  const t = clusterRocket('4-ring');
  const split = splitClusterTree(t, 'mount')!;
  const cands = [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')];
  const { rows } = await sweep(input(t, { candidates: cands, splits: [split], autoDelay: false }),
    { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({}) });
  const comboRow = rows.find((r) => r.combo);
  expect(comboRow?.run).toBeDefined();
  const run = comboRow!.run!;
  expect(run.motorDataKey).toBeDefined();
  expect(run.designKey).toBe(provenanceKeyOf({
    physicsKey: physicsKeyOf(t.components),
    tree: t,
    assigned: [],
    hardwareDeltaKg: 0,
    launch: DEFAULT_CONDITIONS,
    aero: { aeroMode: 'classic', effectiveKbf: true, autoSupersonic: false },
  }).designKey);
  expect(run.motorSetKey).toBeDefined();
  const state = designState(split.tree, Object.fromEntries(split.mountIds.map((id, i) =>
    [id, loadedMotor(cands[i]!.motorId, cands[i]!.designation)])));
  const cur = provenanceKeyOf({
    ...deriveLaunchInputs(state, provenanceAero), physicsKey: physicsKeyOf(t.components), tree: state.tree, launch: state.launch,
    hardwareDeltaKg: 0, aero: provenanceAero,
  });
  expect(run.motorDataKey).toBe(cur.motorDataKey);
  expect(run.motorDataKeys).toEqual(cur.motorDataKeys);
  const original = designPageKey(designState(t, { mount: loadedMotor('a', 'E20') }));
  expect(changedSinceRun(run, original)).toEqual(['the motor']);
  expect(runMatchesDesign(run, cur)).toBe(true);
  expect(changedSinceRun(run, cur)).toEqual([]);
}, 30000);

const provenanceAero = { aeroMode: 'classic', effectiveKbf: true, autoSupersonic: false } as const;
const loadedMotor = (id: string, designation: string): MountMotor => ({
  label: designation, spec: curve(designation),
  meta: { label: designation, manufacturer: 'Acme', motorId: id, autoDelay: false },
  ignition: { event: 'automatic', delay: 0 },
});

it.each([false, true])('R7 ID-less Estes C6 Batch target stays current with Auto=%s until its policy changes', async (autoDelay) => {
  const tree = defaultTree();
  const mountId = motorMounts(tree)[0]!.id!;
  const candidate = MOTOR_DB.find(m => m.manufacturerAbbrev === 'Estes' && m.designation === 'C6')!;
  const spec = await fetchMotorSpec(candidate, 7);
  const motor: MountMotor = { label: 'C6-7', spec, meta: { label: 'C6-7', manufacturer: 'Estes', autoDelay },
    ignition: { event: 'automatic', delay: 0 } };
  const assigned: [string, MountMotor][] = [[mountId, motor]];
  const motors = { [mountId]: motor };
  const target = { ...MOUNT, id: mountId };
  const state = designState(tree, motors);
  const { rows } = await sweep(input(tree, { target, mounts: [target], candidates: [candidate], autoDelay,
    assignedMountMotors: motors, assignedMotors: { [mountId]: spec }, assignedMotorIds: batchMotorIds(motors),
  }), { fetchSpec: fetchFrom({ [candidate.motorId]: spec }), nozzleFor: nozzles({}) });
  expect(rows[0]!.error).toBeUndefined();
  const run = { ...rows[0]!.run!, flightConfigId: 'c1' };
  const key = designPageKey(state);
  expect(run.delayResolution!.mounts[0]!.motorIdentity).toBe(candidate.motorId);
  expect(key.delayMounts![0]!.motorIdentity).toBe('Estes/C6');
  expect(run.motorSetKey).toBe(key.motorSetKey);
  expect(run.motorDataKey).toBe(key.motorDataKey);
  const exportInput = { runs: [run], savedConfigs: [{ id: 'c1', name: 'C6', isDefault: true, motors }], activeConfigId: 'c1',
    assigned, mountIds: [mountId], designKey: key.designKey, conditionsKey: key.conditionsKey,
    model: provenanceAero, hasNozzle: false, motorSetKeyOf, hardwareDeltaKg: 0, primaryMountOf: () => mountId };
  const before = JSON.stringify(run);
  expect(changedSinceRun(run, key)).toEqual([]);
  expect(runMatchesDesign(run, key)).toBe(true);
  expect(matchingRecoveryEvents([run], key, () => undefined)).toEqual(run.recoveryEvents);
  expect(canReplayDelays(run.delayResolution, assigned, mountId, run.delayS, true)).toBe(true);
  expect(Object.keys(flightDataForExport(exportInput))).toEqual(['c1']);
  expect(flownAutoDelays(exportInput)).toEqual(autoDelay ? { c1: { [mountId]: run.delayS } } : {});
  motor.meta.autoDelay = !autoDelay;
  const toggled = designPageKey(state);
  expect(toggled.motorSetKey).toBe(key.motorSetKey);
  expect(changedSinceRun(run, toggled)).toEqual(['the motor delay policy']);
  expect(runMatchesDesign(run, toggled)).toBe(false);
  expect(matchingRecoveryEvents([run], toggled, () => undefined)).toBeUndefined();
  expect(canReplayDelays(run.delayResolution, assigned, mountId, run.delayS, true)).toBe(false);
  expect(flightDataForExport(exportInput)).toEqual({});
  expect(flownAutoDelays(exportInput)).toEqual({});
  expect(JSON.stringify(run)).toBe(before);
}, 30000);

it.each([
  { autoDelay: false, legacy: false }, { autoDelay: true, legacy: false },
  { autoDelay: false, legacy: true }, { autoDelay: true, legacy: true },
  { autoDelay: false, legacy: true, legacyTarget: true }, { autoDelay: true, legacy: true, legacyTarget: true },
])('R7: Batch Auto=$autoDelay legacy=$legacy target=$legacyTarget rejects a same-number policy toggle on the target or retained mount', async ({ autoDelay, legacy, legacyTarget }) => {
  const tree = rocket({ sideMount: true });
  const mountMotors = { mount: loadedMotor('a', 'E20'), side: loadedMotor('b', 'E22') };
  if (legacy) {
    delete mountMotors.side.meta.motorId;
    delete mountMotors.side.meta.exMotorId;
  }
  if (legacyTarget) delete mountMotors.mount.meta.motorId;
  for (const mm of Object.values(mountMotors)) mm.meta.autoDelay = autoDelay;
  const state = designState(tree, mountMotors);
  const { rows } = await sweep(input(tree, {
    candidates: [entry('a', 'Acme', 'E20', '3,5')], autoDelay,
    assignedMountMotors: mountMotors,
    assignedMotors: { mount: mountMotors.mount.spec, side: mountMotors.side.spec },
    assignedMotorIds: batchMotorIds(mountMotors),
    assignedAutoDelays: { side: autoDelay },
  }), { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({}) });
  const run = rows[0]!.run!;
  expect(rows[0]!.error).toBeUndefined();
  const current = designPageKey(state);
  expect(changedSinceRun(run, current)).toEqual([]);
  expect(runMatchesDesign(run, current)).toBe(true);
  expect(run.delayResolution!.mounts.find((m) => m.mountId === 'side')!.motorIdentity)
    .toBe(legacy ? 'Acme/E22' : 'b');
  expect(run.recoveryEvents).toBeDefined();
  expect(matchingRecoveryEvents([run], current, () => undefined)).toEqual(run.recoveryEvents);
  const assigned = Object.entries(mountMotors);
  const exportInput = () => ({ runs: [{ ...run, flightConfigId: 'c1' }],
    savedConfigs: [{ id: 'c1', name: 'Batch', isDefault: true, motors: mountMotors }], activeConfigId: 'c1',
    assigned, mountIds: ['mount', 'side'], designKey: current.designKey, conditionsKey: current.conditionsKey,
    model: provenanceAero, hasNozzle: false, motorSetKeyOf, hardwareDeltaKg: 0,
    primaryMountOf: () => 'mount',
  });
  const expectedAuto = autoDelay ? { c1: Object.fromEntries(run.delayResolution!.mounts.map(m => [m.mountId, m.flownDelay])) } : {};
  expect(canReplayDelays(run.delayResolution, assigned, 'mount', run.delayS, true)).toBe(true);
  expect(Object.keys(flightDataForExport(exportInput()))).toEqual(['c1']);
  expect(flownAutoDelays(exportInput())).toEqual(expectedAuto);
  for (const mm of Object.values(mountMotors)) {
    mm.meta.autoDelay = !autoDelay;
    const changed = designPageKey(state);
    expect(changed.motorSetKey).toBe(current.motorSetKey);
    expect(changedSinceRun(run, changed)).toEqual(['the motor delay policy']);
    expect(runMatchesDesign(run, changed)).toBe(false);
    expect(matchingRecoveryEvents([run], changed, () => undefined)).toBeUndefined();
    expect(canReplayDelays(run.delayResolution, assigned, 'mount', run.delayS, true)).toBe(false);
    expect(flightDataForExport(exportInput())).toEqual({});
    expect(flownAutoDelays(exportInput())).toEqual({});
    mm.meta.autoDelay = autoDelay;
  }
}, 30000);

it.each([false, true])('R7: mixed Batch retains a legacy background motor with Auto=%s', async (autoDelay) => {
  const tree = clusterRocket('4-ring');
  tree.components[0]!.children![1]!.children!.push({
    type: 'innertube', id: 'side', length: 0.2, outerRadius: 0.0125, thickness: 0.0005, motorMount: true,
  } as ComponentNode);
  const split = splitClusterTree(tree, 'mount')!;
  const side = loadedMotor('legacy', 'E22');
  delete side.meta.motorId;
  delete side.meta.exMotorId;
  side.meta.autoDelay = autoDelay;
  const { rows } = await sweep(input(tree, {
    mounts: [MOUNT, { ...MOUNT, id: 'side' }],
    candidates: [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')],
    splits: [split], autoDelay: false,
    assignedMountMotors: { side }, assignedMotors: { side: side.spec },
    assignedMotorIds: batchMotorIds({ side }), assignedAutoDelays: { side: autoDelay },
  }), { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({}) });
  const row = rows.find((r) => r.combo)!;
  expect(row.error).toBeUndefined();
  const run = row.run!;
  const motors = { side, ...Object.fromEntries(split.mountIds.map((id, i) =>
    [id, loadedMotor(i === 0 ? 'a' : 'b', i === 0 ? 'E20' : 'E22')])) };
  const current = () => ({ ...designPageKey(designState(split.tree, motors)),
    // Batch's temporary group mounts retain the original design's tree stamp.
    designKey: designPageKey(designState(tree, { side })).designKey });
  expect(run.delayResolution!.mounts.find((m) => m.mountId === 'side')!.motorIdentity).toBe('Acme/E22');
  expect(changedSinceRun(run, current())).toEqual([]);
  expect(runMatchesDesign(run, current())).toBe(true);
  expect(matchingRecoveryEvents([run], current(), () => undefined)).toEqual(run.recoveryEvents);
  side.meta.autoDelay = !autoDelay;
  expect(changedSinceRun(run, current())).toEqual(['the motor delay policy']);
  expect(runMatchesDesign(run, current())).toBe(false);
  expect(matchingRecoveryEvents([run], current(), () => undefined)).toBeUndefined();
}, 30000);
const designState = (tree: RocketTree, mountMotors: Record<string, MountMotor>): DesignState => ({
  tree, mountMotors, launch: DEFAULT_CONDITIONS, measured: { massKg: null, cgM: null },
  savedConfigs: [], activeConfigId: null,
});

function designPageKey(state: DesignState) {
  const derived = deriveLaunchInputs(state, provenanceAero);
  const built = buildDesign(designBuildInputOf({
    tree: state.tree, assigned: derived.assigned, effectiveKbf: true, effectiveSupersonic: false,
    measuredDryMassKg: null, primaryMountId: derived.primaryMountId, currentSetKey: derived.currentSetKey,
  }), KERNEL_HANDLES);
  if ('error' in built) throw new Error(built.error);
  expect(built.motorFailures).toEqual([]);
  return provenanceKeyOf({
    ...derived, tree: state.tree, launch: state.launch,
    hardwareDeltaKg: hardwareDeltaKgOf(built), aero: provenanceAero,
  });
}

it('K7: a batch database nozzle does not match a design with no nozzle', async () => {
  const tree = rocket();
  const state = designState(tree, { mount: loadedMotor('a', 'E20') });
  const cur = designPageKey(state);
  const { rows } = await sweep(input(tree, {
    candidates: [entry('a', 'Acme', 'E20', '5')], autoDelay: false,
    assignedMountMotors: state.mountMotors,
    assignedMotors: { mount: state.mountMotors.mount!.spec },
    assignedMotorIds: batchMotorIds(state.mountMotors),
  }), { fetchSpec: fetchFrom({ a: curve('E20') }), nozzleFor: nozzles({ a: 0.012 }) });
  expect(rows[0]!.error).toBeUndefined();
  const run = rows[0]!.run!;
  expect(run.nozzleStages).toEqual(['Sustainer']);
  expect(run.motorSetKey).toBe(cur.motorSetKey);
  expect(run.motorDataKey).toBe(cur.motorDataKey);
  expect(run.motorDataKeys).toEqual(cur.motorDataKeys);
  expect(runMatchesDesign(run, cur)).toBe(false);
  expect(changedSinceRun(run, cur)).toEqual(['the design']);
}, 30000);

it.each([0.016, null])('K7: a batch candidate matches the design after following its nozzle %s', async (exitB) => {
  const exitA = 0.012;
  const tree = rocket({ nozzleExitDiameter: exitA });
  const state = designState(tree, { mount: loadedMotor('a', 'E20') });
  const { rows } = await sweep(input(tree, {
    candidates: [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')], autoDelay: false,
    assignedMountMotors: state.mountMotors,
    assignedMotors: { mount: state.mountMotors.mount!.spec },
    assignedMotorIds: batchMotorIds(state.mountMotors),
  }), {
    fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }),
    nozzleFor: nozzles({ a: exitA, ...(exitB !== null ? { b: exitB } : {}) }),
  });
  const curA = designPageKey(state);
  const curB = designPageKey(designState(
    applyStageNozzles(tree, { st0: exitB }), { mount: loadedMotor('b', 'E22') },
  ));
  for (const [id, cur] of [['a', curA], ['b', curB]] as const) {
    const row = rows.find((r) => r.entry.motorId === id)!;
    expect(row.error).toBeUndefined();
    expect(runMatchesDesign(row.run!, cur)).toBe(true);
    expect(changedSinceRun(row.run!, cur)).toEqual([]);
  }
}, 30000);

it.each([0.016, null])('K7: combination provenance follows its equivalent nozzle %s', async (exitB) => {
  const tree = applyStageNozzles(clusterRocket('4-ring'), { st0: 0.04 });
  const split = splitClusterTree(tree, 'mount')!;
  const { rows } = await sweep(input(tree, {
    candidates: [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')],
    splits: [split], autoDelay: false,
  }), {
    fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }),
    nozzleFor: nozzles({ a: 0.012, ...(exitB !== null ? { b: exitB } : {}) }),
  });
  const row = rows.find((r) => r.combo)!;
  expect(row.error).toBeUndefined();
  const exitM = exitB === null ? null : Math.sqrt(2 * 0.012 ** 2 + 2 * exitB ** 2);
  if (exitM === null) expect(row.exitM).toBeNull();
  else expect(row.exitM).toBeCloseTo(exitM, 10);
  const cur = designPageKey(designState(
    applyStageNozzles(split.tree, { st0: exitM }),
    Object.fromEntries(split.mountIds.map((id, i) => [id, loadedMotor(i === 0 ? 'a' : 'b', i === 0 ? 'E20' : 'E22')])),
  ));
  const original = designPageKey(designState(
    applyStageNozzles(tree, { st0: exitM }), { mount: loadedMotor('a', 'E20') },
  ));
  expect(row.run!.designKey).toBe(original.designKey);
  expect(changedSinceRun(row.run!, original)).toEqual(['the motor']);
  expect(runMatchesDesign(row.run!, { ...cur, designKey: original.designKey })).toBe(true);
}, 30000);

it.each([
  { name: 'weighed target', sideMount: false, weighed: true, targetId: 'mount' },
  { name: 'two catalogue mounts', sideMount: true, weighed: false, targetId: 'mount' },
  { name: 'weighed retained mount', sideMount: true, weighed: true, targetId: 'side' },
  { name: 'legacy weighed retained mount', sideMount: true, weighed: true, targetId: 'side', legacy: true },
])('K7: design-page provenance matches a real batch row with $name', async ({ sideMount, weighed, targetId, legacy }) => {
  const tree = rocket({ sideMount });
  const state = designState(tree, {
    mount: loadedMotor('a', 'E20'),
    ...(sideMount ? { side: loadedMotor('b', 'E22') } : {}),
  });
  if (weighed) {
    const dryKg = OrkRocket.buildTree(engineTree(tree)).staticInfo().massEmpty;
    state.mountMotors.mount!.padMassKg = dryKg + (sideMount ? 0.14 : 0.07) + 0.01;
    state.mountMotors.mount!.padMassWeighedWith = legacy ? LEGACY_PAD_MASS_KEY : padMassSetKey(tree, state.mountMotors);
  }
  const derived = deriveLaunchInputs(state, provenanceAero);
  const built = buildDesign(designBuildInputOf({
    tree, assigned: derived.assigned, effectiveKbf: true, effectiveSupersonic: false,
    measuredDryMassKg: null, primaryMountId: derived.primaryMountId, currentSetKey: derived.currentSetKey,
  }), KERNEL_HANDLES);
  if ('error' in built) throw new Error(built.error);
  expect(built.motorFailures).toEqual([]);
  const hw = built.hardware;
  if (weighed) expect(hw.state).toBe('ok');
  const current = () => provenanceKeyOf({
    ...deriveLaunchInputs(state, provenanceAero), tree, launch: state.launch,
    hardwareDeltaKg: hardwareDeltaKgOf(built), aero: provenanceAero,
  });
  const cur = current();
  const mounts = [MOUNT, ...(sideMount ? [{ ...MOUNT, id: 'side' }] : [])];
  const mm = state.mountMotors[targetId]!;
  const inp = input(tree, {
    mounts, target: mounts.find((m) => m.id === targetId)!,
    candidates: [entry(mm.meta.motorId!, 'Acme', mm.spec.designation, '5')], autoDelay: false,
    assignedMountMotors: state.mountMotors,
    assignedMotors: Object.fromEntries(derived.assigned.map(([id, motor]) => [id, flownSpec(id, motor.spec, hw)])),
    assignedMotorIds: batchMotorIds(state.mountMotors),
    assignedIgnitions: Object.fromEntries(derived.assigned.map(([id, motor]) => [id, motor.ignition])),
    ...(hw.state === 'ok' ? { retainedHardware: { mountId: hw.appliedTo, deltaKg: hw.deltaKg } } : {}),
    ...(hw.state === 'ok' && !legacy ? { weighed: {
      mountId: hw.appliedTo, identity: motorIdentity(state.mountMotors[hw.appliedTo]!.meta, 'E20'),
      pinned: false, name: 'E20', perMotorShiftKg: hw.perMotorShiftKg, deltaKg: hw.deltaKg,
    } } : {}),
  });
  const { rows } = await sweep(inp, {
    fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({}),
  });
  expect(rows[0]!.error).toBeUndefined();
  const run = rows[0]!.run!;
  expect(run.launchMass).toBeCloseTo(built.info.mass, 8);
  expect(run.motorDataKey).toBe(cur.motorDataKey);
  expect(run.motorDataKeys).toEqual(cur.motorDataKeys);
  expect(run.motorSetKey).toBe(cur.motorSetKey);
  expect(runMatchesDesign(run, cur)).toBe(true);
  expect(changedSinceRun(run, cur)).toEqual([]);
  expect(storedSimCost([run], cur, tree.name!)).toEqual({ ms: run.execMs });
  mm.spec = { ...mm.spec, thrusts: mm.spec.thrusts.map((t) => t * 1.5) };
  expect(runMatchesDesign(run, current())).toBe(false);
  expect(changedSinceRun(run, current())).toEqual(['the motor']);
  expect(storedSimCost([run], current(), tree.name!)).toBeNull();
}, 30000);


it.each(['removed', 'refused', 'target'] as const)('R9: excludes retained hardware for a %s mount', async (kind) => {
  const tree = rocket({ sideMount: true });
  const motor = loadedMotor('a', 'E20');
  motor.padMassWeighedWith = LEGACY_PAD_MASS_KEY;
  const mountId = kind === 'removed' ? 'missing' : kind === 'target' ? 'mount' : 'side';
  const base = input(tree, {
    candidates: [entry('a', 'Acme', 'E20', '5')], autoDelay: false,
    assignedMountMotors: { [mountId]: motor },
    assignedMotors: { [mountId]: { ...motor.spec, masses: motor.spec.masses.map((m) => m + 0.01) } },
    assignedIgnitions: { [mountId]: { event: 'invalid' as MountMotor['ignition']['event'], delay: 0 } },
  });
  const deps = { fetchSpec: fetchFrom({ a: motor.spec }), nozzleFor: nozzles({}) };
  const control = (await sweep(base, deps)).rows[0]!;
  const result = (await sweep({ ...base, retainedHardware: { mountId, deltaKg: 0.01 } }, deps)).rows[0]!;
  expect(result.error).toBeUndefined();
  expect(result.run!.motorSetKey).toBe(control.run!.motorSetKey);
  expect(result.run!.launchMass).toBeCloseTo(control.run!.launchMass!, 8);
  if (kind === 'target') {
    expect(result.run!.launchMass).toBeCloseTo(base.info.massEmpty + 0.07, 8);
  }
});

it('R9: retains legacy hardware provenance and flown mass in single and mixed rows', async () => {
  const tree = clusterRocket('4-ring');
  tree.components[0]!.children!.find((n) => n.id === 'bt')!.children!.push({ type: 'innertube', id: 'side', length: 0.2,
    outerRadius: 0.0125, thickness: 0.0005, motorMount: true } as ComponentNode);
  const split = splitClusterTree(tree, 'mount')!;
  const side = loadedMotor('c', 'E24');
  side.padMassWeighedWith = LEGACY_PAD_MASS_KEY;
  const base = input(tree, {
    mounts: [{ ...MOUNT, motorCount: 4 }, { ...MOUNT, id: 'side' }],
    target: { ...MOUNT, motorCount: 4 }, splits: [split],
    candidates: [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')], autoDelay: false,
    assignedMountMotors: { side }, assignedMotorIds: { side: 'c' },
    assignedMotors: { side: { ...side.spec, masses: side.spec.masses.map((m) => m + 0.01) } },
    assignedIgnitions: { side: side.ignition },
  });
  const deps = { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({}) };
  const control = await sweep(base, deps);
  const result = await sweep({ ...base, retainedHardware: { mountId: 'side', deltaKg: 0.01 } }, deps);
  expect(result.rows).toHaveLength(3);
  expect(result.rows.filter((r) => r.combo)).toHaveLength(1);
  for (const [index, row] of result.rows.entries()) {
    expect(row.error).toBeUndefined();
    expect(row.run!.launchMass).toBeCloseTo(control.rows[index]!.run!.launchMass!, 8);
    expect(row.run!.launchMass).toBeCloseTo(base.info.massEmpty + 0.36, 8);
    expect(row.run!.motorSetKey).toBe(`${control.rows[index]!.run!.motorSetKey}|hw:100`);
    expect(row.run!.motorDataKey).toBe(control.rows[index]!.run!.motorDataKey);
  }
}, 60000);

it('K7: plugged exception provenance matches Auto and rejects P on charge recovery', async () => {
  const tree = rocket({ deployEvent: 'ejection' });
  const mm = loadedMotor('p', 'E20');
  mm.spec = { ...mm.spec, ejectionDelay: Infinity };
  const state = designState(tree, { mount: mm });
  const { rows } = await sweep(input(tree, {
    candidates: [entry('p', 'Acme', 'E20', 'P')], autoDelay: false,
    assignedMountMotors: state.mountMotors,
    assignedMotors: { mount: mm.spec }, assignedMotorIds: { mount: 'p' },
  }), { fetchSpec: fetchFrom({ p: curve('E20') }), nozzleFor: nozzles({}) });
  const row = rows[0]!;
  expect(row.error).toBeUndefined();
  expect(row.optimumForPlugged).toBe(true);
  expect(row.run!.delayResolution!.mounts[0]!.mode).toBe('auto');
  const plugged = designPageKey(state);
  expect(runMatchesDesign(row.run!, plugged)).toBe(false);
  expect(changedSinceRun(row.run!, plugged)).toContain('the motor');
  const auto = designPageKey(designState(tree, { mount: {
    ...mm, spec: { ...mm.spec, ejectionDelay: 0 }, meta: { ...mm.meta, autoDelay: true },
  } }));
  expect(runMatchesDesign(row.run!, auto)).toBe(true);
  expect(changedSinceRun(row.run!, auto)).toEqual([]);
}, 30000);

it('K7: plugged combination provenance keys every target leg at Auto', async () => {
  const tree = clusterRocket('4-ring', 'ejection');
  const split = splitClusterTree(tree, 'mount')!;
  const { rows } = await sweep(input(tree, {
    candidates: [entry('a', 'Acme', 'E20', 'P'), entry('b', 'Acme', 'E22', 'P')],
    splits: [split], autoDelay: false,
  }), { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({}) });
  const row = rows.find((r) => r.combo)!;
  expect(row.error).toBeUndefined();
  expect(row.optimumForPlugged).toBe(true);
  const assigned = Object.fromEntries(split.mountIds.map((id, i) => {
    const mm = loadedMotor(i === 0 ? 'a' : 'b', i === 0 ? 'E20' : 'E22');
    return [id, { ...mm, spec: { ...mm.spec, ejectionDelay: 0 }, meta: { ...mm.meta, autoDelay: true } }];
  }));
  const cur = designPageKey(designState(split.tree, assigned));
  expect(row.run!.motorSetKey).toBe(cur.motorSetKey);
  expect(row.run!.motorDataKeys).toEqual(cur.motorDataKeys);
}, 30000);

it('batch flight mount labels use the catalogue designation and chosen delay', async () => {
  const fly = vi.spyOn(flightRunner, 'flyLaunch');
  const candidate = entry('label-test', 'Cesaroni', '1013J453-16A', '5');
  const result = await sweep(input(rocket(), { candidates: [candidate], autoDelay: false }),
    { fetchSpec: fetchFrom({ 'label-test': curve('old-spec-name') }), nozzleFor: nozzles({}) });
  expect(result.rows[0]!.run).toBeDefined();
  expect(fly.mock.calls[0]![1].assigned[0]![1].label).toBe('J453-5');
  expect(fly.mock.calls[0]![1].assigned[0]![1].meta.label).toBe('J453-5');
});

it.each(['eb', 'kbf', 'supersonic', 'hybrid', 'auto'] as const)('batch %s prepares model-selected partial weather and Auto upgrade air', async (model) => {
  const fly = vi.spyOn(flightRunner, 'flyLaunch');
  const candidate = entry('isa-test', 'Acme', 'E20', '5');
  const launch = { ...DEFAULT_CONDITIONS, launchAltitudeM: 10000, pressureHPa: 800 };
  await sweep(input(rocket(), { model, launch, candidates: [candidate], autoDelay: false }),
    { fetchSpec: fetchFrom({ 'isa-test': curve('E20') }), nozzleFor: nozzles({}) });
  expect(fly).toHaveBeenCalled();
  const options = fly.mock.calls[0]![1];
  const classic = kernelSimOptions(launch, { aeroMode: 'classic' });
  const corrected = kernelSimOptions(launch, { aeroMode: 'supersonic' });
  expect(options.simOptions).toStrictEqual(model === 'eb' ? classic : corrected);
  expect(options.supersonicSimOptions).toStrictEqual(corrected);
});

it('batch background labels follow an overlay without changing the loaded spec', async () => {
  const fly = vi.spyOn(flightRunner, 'flyLaunch');
  const before = MOTOR_DB.find(m => m.designation === 'F67C')!;
  const after = { ...before, designation: 'F67C-UPDATED' };
  setCatalogueOverlay({ ...diffCatalogue([before], [after]), baseGenerated: MOTOR_DB_DATE,
    fetchedAt: '2026-10-04T00:00:00Z', liveCount: 1, rejected: [] });
  try {
    const spec = curve(before.designation);
    const candidate = entry('label-test', 'Cesaroni', '1013J453-16A', '5');
    const { rows } = await sweep(input(rocket({ sideMount: true }), {
      candidates: [candidate], autoDelay: false,
      mounts: [MOUNT, { ...MOUNT, id: 'side', label: 'Side' }],
      assignedMotors: { side: spec }, assignedMotorIds: { side: before.motorId },
    }), { fetchSpec: fetchFrom({ 'label-test': curve(candidate.designation) }), nozzleFor: nozzles({}) });
    expect(rows[0]!.run).toBeDefined();
    const background = fly.mock.calls[0]![1].assigned.find(([id]) => id === 'side')![1];
    expect(background.label).toBe('F67C-UPDATED-5');
    expect(background.meta.label).toBe(background.label);
    expect(background.spec).toEqual(spec);
  } finally {
    setCatalogueOverlay(null);
  }
});

function separateRing(n = 4) {
  const tree = clusterRocket(n === 4 ? '4-ring' : '6-ring', 'apogee');
  const body = tree.components[0]!.children![1]!;
  const original = body.children!.find(m => m.id === 'mount')!;
  const tubes = Array.from({ length: n }, (_, i) => ({ ...original, id: `ring${i}`, name: `MMT ${i + 1}`,
    cluster: 'single', radialPosition: 0.023, radialDirection: i * Math.PI * 2 / n } as ComponentNode));
  body.children = [...body.children!.filter(m => m.id !== 'mount'), ...tubes];
  const mounts = tubes.map(m => ({ ...MOUNT, id: m.id!, label: m.name!, diameterMm: 24 }));
  return { tree, mounts, target: mounts[0]!, targetMountIds: mounts.map(m => m.id) };
}

it('Round 5 refuses an oversized candidate on a narrower matching target before installing any leg', async () => {
  const tree = rocket({ sideMount: true, deployEvent: 'apogee' });
  const tubes = motorMounts(tree);
  tubes.forEach((m, i) => {
    m.outerRadius = [16.90, 16.49][i]! / 2000 + 0.0005; m.thickness = 0.0005; m.name = i ? 'Narrow MMT' : 'Wide MMT';
  });
  const mounts = tubes.map((m, i) => ({ ...MOUNT, id: m.id!, label: i ? 'Narrow MMT' : 'Wide MMT', diameterMm: i ? 16 : 17 }));
  const candidate = { ...entry('a', 'Acme', 'D18', '5'), diameter: 18 };
  expect(motorDb.fitsMount(mounts[0]!.diameterMm, candidate)).toBe(true);
  expect(motorDb.fitsMount(mounts[1]!.diameterMm, candidate)).toBe(false);
  const fly = vi.spyOn(flightRunner, 'flyLaunch');
  const deps = { fetchSpec: fetchFrom({ a: { ...curve('D18'), diameter: 0.018 } }), nozzleFor: nozzles({}) };
  const inp = input(tree, { target: mounts[0]!, mounts, candidates: [candidate], autoDelay: false,
    targetMountIds: mounts.map(m => m.id) });
  const refused = await sweep(inp, deps);
  expect(refused.rows[0]!.run).toBeUndefined();
  expect(refused.rows[0]!.error).toContain('Motor diameter does not fit Narrow MMT');
  expect(fly).not.toHaveBeenCalled();
  const off = await sweep({ ...inp, targetMountIds: undefined }, deps);
  expect(off.rows[0]!.error).toBeUndefined();
  expect(off.rows[0]!.run!.batchMounts?.find(m => m.mountId === 'side')?.role).toBe('empty');
}, 30000);

it('Round 5 validates each separate-ring mixed leg against its own bore', async () => {
  const setup = separateRing();
  motorMounts(setup.tree).forEach((m, i) => {
    m.outerRadius = (i % 2 ? 16.49 : 16.90) / 2000 + 0.0005; m.thickness = 0.0005;
    setup.mounts[i]!.diameterMm = i % 2 ? 16 : 17;
  });
  const ring = batchRingSplits(setup.tree, setup.mounts);
  const candidates = [{ ...entry('a', 'Acme', 'D18', '5'), diameter: 18 }, { ...entry('b', 'Acme', 'D13', '5'), diameter: 13 }];
  const fly = vi.spyOn(flightRunner, 'flyLaunch');
  const out = await sweep(input(setup.tree, { ...setup, candidates, autoDelay: false, splits: [ring.halves!] }),
    { fetchSpec: fetchFrom({ a: { ...curve('D18'), diameter: 0.018 }, b: { ...curve('D13'), diameter: 0.013 } }), nozzleFor: nozzles({}) });
  const mixed = out.rows.filter(r => r.combo);
  expect(mixed).toHaveLength(2);
  expect(mixed.filter(r => r.run)).toHaveLength(1);
  expect(mixed.find(r => r.error)?.error).toContain('Motor diameter does not fit MMT 2');
  expect(fly).toHaveBeenCalledTimes(2); // One fitting homogeneous row and one fitting arrangement.
  for (const [, options] of fly.mock.calls) {
    for (const [id, m] of options.assigned) {
      expect(motorDb.fitsMount(setup.mounts.find(target => target.id === id)!.diameterMm,
        { diameter: m.spec.diameter * 1000 })).toBe(true);
    }
  }
}, 30000);

it('124 sweeps every target with its own ignition, sums nozzle counts and freezes all roles', async () => {
  const setup = separateRing();
  const c = entry('a', 'Acme', 'E20', '5');
  const fly = vi.spyOn(flightRunner, 'flyLaunch');
  const ignitions = Object.fromEntries(setup.mounts.map((m, i) => [m.id,
    { event: 'launch' as const, delay: i % 2 ? 0.4 : 0 }]));
  const inp = input(setup.tree, { ...setup, candidates: [c], autoDelay: false, assignedIgnitions: ignitions });
  const result = await sweep(inp,
    { fetchSpec: fetchFrom({ a: curve('E20') }), nozzleFor: nozzles({ a: 0.01 }) });
  const row = result.rows[0]!;
  expect(row.error).toBeUndefined();
  expect(row.exitM).toBeCloseTo(0.02, 10);
  expect(row.run!.motorCount).toBe(4);
  expect(row.run!.batchTargetMountIds).toEqual(setup.targetMountIds);
  expect(row.run!.batchMounts?.map(m => [m.mountId, m.role])).toEqual(setup.mounts.map(m => [m.id, 'candidate']));
  expect(fly.mock.calls[0]![1].assigned.map(([id, m]) => [id, m.ignition])).toEqual(Object.entries(ignitions));
  expect(runsToTable([row.run!]).rows[0]?.slice(-2)).toEqual(['MMT 1; MMT 2; MMT 3; MMT 4', '']);
  expect(batchLoadoutText(row.run!)).toBe('E20 in MMT 1, MMT 2, MMT 3, MMT 4');
  const table = runsToTable([row.run!]);
  expect(table.rows[0]![table.headers.indexOf('Motors (cluster)')]).toBe(4);
  const printed = designPrintHtml({ tree: setup.tree, info: inp.info, units: INITIAL_UNITS,
    radiusMode: 'diameter', withMotors: true, appVersion: 'test', run: row.run!, changedSince: [] });
  expect(printed).toContain('Motor count (candidate group): 4');
  expect(printed).toContain('Complete flight motor count: 4');
  expect(printed).toContain('E20 in MMT 1, MMT 2, MMT 3, MMT 4');
  expect(row.run!.delayResolution!.mounts).toHaveLength(4);
}, 30000);

it('124 excludes a candidate too long for any target and names that mount', async () => {
  const setup = separateRing(); setup.mounts[2]!.maxMotorLengthM = 0.06;
  const result = await sweep(input(setup.tree, { ...setup,
    candidates: [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')],
    splits: [batchRingSplits(setup.tree, setup.mounts).halves!] }),
    { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({}) });
  expect(result.rows[0]!.run).toBeUndefined();
  expect(result.rows[0]!.error).toContain('max motor length in MMT 3');
  expect(result.rows).toHaveLength(4);
  expect(result.rows.every(r => !r.run && r.error?.includes('max motor length in MMT 3'))).toBe(true);
});

it('124 weighed hardware follows its own target only, including a non-selected mount', async () => {
  const setup = separateRing();
  const cands = [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')];
  const fetchSpec = fetchFrom({ a: curve('E20'), b: curve('E22') });
  const fly = vi.spyOn(flightRunner, 'flyLaunch');
  const weighed = { mountId: 'ring2', identity: 'Acme/E20', pinned: false, name: 'E20', perMotorShiftKg: 0.1, deltaKg: 0.1 };
  const result = await sweep(input(setup.tree, { ...setup, candidates: cands, autoDelay: false, weighed }), { fetchSpec, nozzleFor: nozzles({}) });
  expect(result.rows.every(r => r.run)).toBe(true);
  const masses = (i: number) => fly.mock.calls[i]![1].assigned.map(([id, m]) => [id, m.spec.masses[0]]);
  expect(masses(0)).toEqual(setup.mounts.map(m => [m.id, m.id === weighed.mountId ? 0.17 : 0.07]));
  expect(masses(1)).toEqual(setup.mounts.map(m => [m.id, 0.07]));
  expect(result.rows[0]!.run!.launchMass! - result.rows[1]!.run!.launchMass!).toBeCloseTo(0.1, 6);
}, 30000);

it.each([4, 6])('Round 4: 125 flies every separate %s-ring arrangement into symmetric tube groups', async n => {
  const setup = separateRing(n);
  const ring = batchRingSplits(setup.tree, setup.mounts);
  const cands = [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5'),
    ...(n === 6 ? [entry('c', 'Acme', 'E24', '5')] : [])];
  const fly = vi.spyOn(flightRunner, 'flyLaunch');
  const result = await sweep(input(setup.tree, { ...setup, candidates: cands, autoDelay: false,
    splits: [ring.halves!, ...(ring.pairs ? [ring.pairs] : [])] }),
  { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22', 1.1), c: curve('E24', 1.2) }), nozzleFor: nozzles({ a: 0.01, b: 0.012, c: 0.014 }) });
  expect(result.rows).toHaveLength(n === 4 ? 4 : 33);
  expect(new Set(result.rows.map(r => r.key)).size).toBe(result.rows.length);
  expect(result.rows.every(r => r.run && !r.error)).toBe(true);
  expect(result.rows[cands.length]!.run!.motorConfig).toBe(n === 4 ? 'mixed 2+2' : 'mixed 3+3');
  expect(result.rows[cands.length]!.run!.motor).toBe(`${n / 2}× Acme E20 + ${n / 2}× Acme E22`);
  if (n === 6) {
    expect(result.rows.filter(r => r.run!.motorConfig === 'mixed 3+3')).toHaveLength(6);
    expect(result.rows.filter(r => r.run!.motorConfig === 'mixed 4+2')).toHaveLength(18);
    expect(result.rows.filter(r => r.run!.motorConfig === 'mixed 2+2+2')).toHaveLength(6);
  }
  for (let index = cands.length; index < result.rows.length; index++) {
    const assigned = fly.mock.calls[index]![1].assigned;
    expect(assigned).toHaveLength(n);
    expect(result.rows[index]!.run!.batchMounts?.every(m => m.role === 'candidate')).toBe(true);
    expect(result.rows[index]!.run!.motorCount).toBe(n);
    const moment = assigned.reduce((sum, [id, mm]) => {
      const angle = Number(findMount(id)['radialDirection']);
      return [sum[0]! + mm.spec.thrusts[1]! * Math.cos(angle), sum[1]! + mm.spec.thrusts[1]! * Math.sin(angle)];
    }, [0, 0]);
    expect(Math.hypot(...moment)).toBeLessThan(1e-10);
  }
  function findMount(id: string) { return motorMounts(setup.tree).find(m => m.id === id)!; }
}, 30000);

it('124 resolves Auto separately on every target, and fixed-delay targets retain Never ignition', async () => {
  const setup = separateRing();
  const c = entry('a', 'Acme', 'E20', '5');
  const assignedIgnitions: BatchSweepInput['assignedIgnitions'] = Object.fromEntries(setup.mounts.map((m, i) => [m.id,
    { event: 'launch' as const, delay: i % 2 ? 1.1 : 0 }]));
  const out = await sweep(input(setup.tree, { ...setup, candidates: [c], assignedIgnitions }),
    { fetchSpec: fetchFrom({ a: curve('E20') }), nozzleFor: nozzles({}) });
  expect(out.rows[0]!.error).toBeUndefined();
  expect(out.rows[0]!.run!.delayResolution!.mounts).toHaveLength(4);
  expect(out.rows[0]!.run!.delayResolution!.mounts.every(m => m.mode === 'auto' && m.status === 'resolved')).toBe(true);
  assignedIgnitions.ring3!.event = 'never';
  const fixed = await sweep(input(setup.tree, { ...setup, candidates: [c], assignedIgnitions, autoDelay: false }),
    { fetchSpec: fetchFrom({ a: curve('E20') }), nozzleFor: nozzles({}) });
  expect(fixed.rows[0]!.error).toBeUndefined();
  const run = fixed.rows[0]!.run!;
  expect(run.batchMounts?.find(m => m.mountId === 'ring3')?.ignition).toBe('never');
  expect(batchLoadoutText(run)).toContain('never ignites');
  expect(run.delayResolution!.mounts).toHaveLength(4);
  expect(run.delayResolution!.mounts.every(m => m.mode === 'manual' && m.status === 'fixed')).toBe(true);
}, 30000);

it.each(['ring1', 'ring2'])('Round 2 carries weighed hardware and provenance on separate-ring mixed leg %s', async mountId => {
  const setup = separateRing();
  const cands = [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')];
  const motor = mountId === 'ring1' ? 'E22' : 'E20';
  const weighed = { mountId, identity: `Acme/${motor}`, pinned: false, name: motor, perMotorShiftKg: 0.1, deltaKg: 0.1 };
  const base = input(setup.tree, { ...setup, candidates: cands, autoDelay: false,
    splits: [batchRingSplits(setup.tree, setup.mounts).halves!] });
  const deps = { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({}) };
  const control = await sweep(base, deps);
  const fly = vi.spyOn(flightRunner, 'flyLaunch');
  const result = await sweep({ ...base, weighed }, deps);
  const mixedIndex = result.rows.findIndex(r => r.combo && r.weighed);
  const mixed = result.rows[mixedIndex]!;
  const bare = control.rows.find(r => r.combo)!;
  expect(mixed.error).toBeUndefined();
  expect(mixed.run!.launchMass! - bare.run!.launchMass!).toBeCloseTo(0.1, 8);
  expect(mixed.run!.motorSetKey).toBe(`${bare.run!.motorSetKey}|hw:1000`);
  expect(mixed.weighed).toBe(true);
  expect(mixed.run!.motorDataKey).toBe(bare.run!.motorDataKey);
  expect(mixed.run!.motorDataKeys).toEqual(bare.run!.motorDataKeys);
  const assigned = fly.mock.calls[mixedIndex]![1].assigned;
  expect(assigned.find(([id]) => id === weighed.mountId)![1].spec.masses[0]).toBeCloseTo(0.17, 8);
  const ordinary = await flyLaunch(OrkRocket.buildTree(engineTree(setup.tree)), {
    ...fly.mock.calls[mixedIndex]![1], assigned: assigned.map(([id, mm]) => [id, id === weighed.mountId
      ? { ...mm, spec: { ...curve(motor), masses: curve(motor).masses.map(m => m + 0.1) } } : mm]),
  });
  expect(mixed.run!.launchMass).toBeCloseTo(ordinary.result.series.mass[0]!, 3);
}, 30000);

it('Round 2 empty targets retain own ignition defaults', async () => {
  const setup = separateRing();
  const tree = { ...setup.tree, ignitionDefaults: { ring1: { event: 'launch' as const, delay: 1 } } };
  const fly = vi.spyOn(flightRunner, 'flyLaunch');
  const out = await sweep(input(tree, { ...setup, tree, candidates: [entry('a', 'Acme', 'E20', '5')], autoDelay: false }),
    { fetchSpec: fetchFrom({ a: curve('E20') }), nozzleFor: nozzles({}) });
  expect(out.rows[0]!.error).toBeUndefined();
  expect(fly.mock.calls[0]![1].assigned.find(([id]) => id === 'ring1')![1].ignition).toEqual({ event: 'launch', delay: 1 });
}, 30000);

it.each(['never', 'burnout', 'ejectioncharge'] as const)('Round 2 Auto excludes an unlit %s target from solving', async event => {
  const setup = separateRing();
  const fly = vi.spyOn(flightRunner, 'flyLaunch');
  const out = await sweep(input(setup.tree, { ...setup, candidates: [entry('a', 'Acme', 'E20', '5')],
    assignedIgnitions: { ring3: { event, delay: 0 } } }),
    { fetchSpec: fetchFrom({ a: curve('E20') }), nozzleFor: nozzles({}) });
  expect(out.rows[0]!.error).toBeUndefined();
  expect(out.rows[0]!.run!.delayResolution!.mounts.find(m => m.mountId === 'ring3')?.mode).toBe('manual');
  expect(fly.mock.calls[0]![1].assigned.find(([id]) => id === 'ring3')![1].meta.autoDelay).toBe(false);
  if (event === 'never') expect(out.rows[0]!.run!.batchMounts?.find(m => m.mountId === 'ring3')?.ignition).toBe('never');
  const primary = await sweep(input(setup.tree, { ...setup, candidates: [entry('a', 'Acme', 'E20', '5')],
    assignedIgnitions: { ring0: { event, delay: 0 } } }),
    { fetchSpec: fetchFrom({ a: curve('E20') }), nozzleFor: nozzles({}) });
  expect(primary.rows[0]!.error).toBeUndefined();
  expect(primary.rows[0]!.run!.delayResolution!.mounts.find(m => m.mountId === 'ring0')?.mode).toBe('manual');
  expect(primary.rows[0]!.label).not.toContain('automatic delay');
}, 30000);

it.each([4, 6])('Round 2 enumerates both arrangements for distinct ignition groups in a %s-ring', async n => {
  const setup = separateRing(n);
  const ring = batchRingSplits(setup.tree, setup.mounts);
  const splits = [ring.halves!, ...(ring.pairs ? [ring.pairs] : [])];
  const cands = [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')];
  const fly = vi.spyOn(flightRunner, 'flyLaunch');
  const inp = input(setup.tree, { ...setup, splits, candidates: cands, autoDelay: false,
    assignedIgnitions: { ring1: { event: 'launch', delay: 1 }, ring3: { event: 'launch', delay: 1 } } });
  const deps = { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22', 1.1) }), nozzleFor: nozzles({}) };
  const out = await sweep(inp, deps);
  expect(out.rows).toHaveLength(n === 4 ? 4 : 10);
  expect(new Set(out.rows.map(r => r.key)).size).toBe(out.rows.length);
  expect(out.rows.every(r => r.run && !r.error)).toBe(true);
  const vectors = fly.mock.calls.slice(cands.length).map(([, options]) => Object.fromEntries(options.assigned.map(([id, m]) => [id, m.meta.motorId])));
  expect(vectors).toContainEqual(Object.fromEntries(setup.mounts.map((m, i) => [m.id, i % 2 ? 'a' : 'b'])));
  expect(vectors).toContainEqual(Object.fromEntries(setup.mounts.map((m, i) => [m.id, i % 2 ? 'b' : 'a'])));
  const reversed = await sweep({ ...inp, candidates: [...cands].reverse() }, deps);
  expect(reversed.rows.map(r => r.key).sort()).toEqual(out.rows.map(r => r.key).sort());
}, 60000);

it.each([0, 0.03])('Round 3 matching mixed loadout preserves the typed stage exit %s m', async exit => {
  const setup = separateRing();
  setup.tree.components[0]!.nozzleExitDiameter = exit;
  const split = batchRingSplits(setup.tree, setup.mounts).halves!;
  const ids = Object.fromEntries(split.mountGroups!.flatMap((group, k) => group.map(id => [id, k ? 'b' : 'a'])));
  const result = await sweep(input(setup.tree, { ...setup, autoDelay: false, splits: [split],
    candidates: [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')], assignedMotorIds: ids,
    assignedIgnitions: { ring1: { event: 'launch', delay: 1 } } }),
  { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({ a: 0.01, b: 0.012 }) });
  const mixed = result.rows.find(r => r.combo)!;
  expect(mixed.error).toBeUndefined();
  expect(mixed.exitM).toBe(exit);
  expect(mixed.run!.nozzleStages).toEqual(exit ? ['Sustainer'] : undefined);
  expect(mixed.run!.batchTargetMountIds).toEqual(split.mountGroups!.flat());
  expect(result.rows.filter(r => r.combo)[1]!.exitM).toBeCloseTo(Math.sqrt(2 * 0.01 ** 2 + 2 * 0.012 ** 2), 12);
});

it('Round 3 weighed synchronous groups enumerate and key both arrangements independent of candidate order', async () => {
  const setup = separateRing();
  const candidates = [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')];
  const weighed = { mountId: 'ring1', identity: 'Acme/E20', pinned: false, name: 'E20', perMotorShiftKg: 0.1, deltaKg: 0.1 };
  const inp = input(setup.tree, { ...setup, candidates, weighed, autoDelay: false,
    splits: [batchRingSplits(setup.tree, setup.mounts).halves!] });
  const deps = { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({}) };
  const out = await sweep(inp, deps);
  const mixed = out.rows.filter(r => r.combo);
  expect(mixed).toHaveLength(2);
  expect(mixed.every(r => r.run && !r.error)).toBe(true);
  expect(new Set(mixed.map(r => r.key)).size).toBe(2);
  expect(mixed.filter(r => r.weighed)).toHaveLength(1);
  expect(Math.abs(mixed[0]!.run!.launchMass! - mixed[1]!.run!.launchMass!)).toBeCloseTo(0.1, 8);
  const reversed = await sweep({ ...inp, candidates: [...candidates].reverse() }, deps);
  expect(reversed.rows.map(r => r.key).sort()).toEqual(out.rows.map(r => r.key).sort());
});

it('Round 4 synchronous overhang groups fly and key both mass arrangements', async () => {
  const setup = separateRing();
  for (const mount of motorMounts(setup.tree)) mount.motorOverhang = ['ring0', 'ring2'].includes(mount.id!) ? 0 : 0.08;
  const candidates = [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')];
  const fly = vi.spyOn(flightRunner, 'flyLaunch');
  const inp = input(setup.tree, { ...setup, candidates, autoDelay: false,
    splits: [batchRingSplits(setup.tree, setup.mounts).halves!] });
  const deps = { fetchSpec: fetchFrom({ a: curve('E20'), b: { ...curve('E22'), masses: curve('E22').masses.map(m => m + 0.1) } }),
    nozzleFor: nozzles({}) };
  const out = await sweep(inp, deps);
  const mixed = out.rows.filter(r => r.combo);
  expect(mixed).toHaveLength(2);
  expect(mixed.every(r => r.run && !r.error)).toBe(true);
  expect(new Set(mixed.map(r => r.key)).size).toBe(2);
  expect(Math.abs(mixed[0]!.run!.launchCG! - mixed[1]!.run!.launchCG!)).toBeGreaterThan(0.001);
  expect(Math.abs(mixed[0]!.run!.launchStaticMarginCal! - mixed[1]!.run!.launchStaticMarginCal!)).toBeGreaterThan(0.01);
  for (const row of mixed) {
    const options = fly.mock.calls[out.rows.indexOf(row)]![1];
    const ordinary = await simulateDesign(designState(setup.tree, Object.fromEntries(options.assigned)),
      { aero: provenanceAero, yieldToUi: noYield });
    expect(row.run!.launchCG).toBeCloseTo(ordinary.run.launchCG!, 6);
  }
  console.log('Round 4 unequal-overhang SI:', mixed.map(r => ({ key: r.key, launchCGM: r.run!.launchCG,
    staticMarginCal: r.run!.launchStaticMarginCal })));
  const reversed = await sweep({ ...inp, candidates: [...candidates].reverse() }, deps);
  expect(reversed.rows.map(r => r.key).sort()).toEqual(out.rows.map(r => r.key).sort());
}, 30000);

it('Round 4 synchronous reversed loaded pairs retain nozzle OFF and match ordinary Launch', async () => {
  const setup = separateRing();
  setup.tree.components[0]!.nozzleExitDiameter = 0;
  const split = batchRingSplits(setup.tree, setup.mounts).halves!;
  const ids = Object.fromEntries(split.mountGroups!.flatMap((group, k) => group.map(id => [id, k ? 'a' : 'b'])));
  const fly = vi.spyOn(flightRunner, 'flyLaunch');
  const result = await sweep(input(setup.tree, { ...setup, autoDelay: false, splits: [split], assignedMotorIds: ids,
    candidates: [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5')] }),
  { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22', 1.1) }), nozzleFor: nozzles({ a: 0.01, b: 0.012 }) });
  const index = fly.mock.calls.findIndex(([, options]) => options.assigned.every(([id, mm]) => mm.meta.motorId === ids[id]));
  expect(index).toBeGreaterThanOrEqual(0);
  const row = result.rows[index]!;
  expect(row.error).toBeUndefined();
  expect(row.exitM).toBe(0);
  expect(row.run!.nozzleStages).toBeUndefined();
  const ordinary = await simulateDesign(designState(setup.tree, Object.fromEntries(fly.mock.calls[index]![1].assigned)),
    { aero: provenanceAero, yieldToUi: noYield });
  expect(row.run!.launchMass).toBeCloseTo(ordinary.run.launchMass!, 6);
  expect(row.run!.maxAltitude).toBeCloseTo(ordinary.run.maxAltitude!, 6);
  console.log('Round 4 loaded OFF SI:', { batchApogeeM: row.run!.maxAltitude, launchApogeeM: ordinary.run.maxAltitude });
});

it.each([4, 6])('Round 4 retains v0.200 cluster-split %s-ring counts and multiset keys', async n => {
  const tree = clusterRocket(n === 4 ? '4-ring' : '6-ring', 'apogee');
  const halves = splitClusterTree(tree, 'mount')!;
  const pairs = n === 6 ? splitClusterPairsTree(tree, 'mount')! : null;
  const cands = [entry('a', 'Acme', 'E20', '5'), entry('b', 'Acme', 'E22', '5'), entry('c', 'Acme', 'E24', '5')];
  const result = await sweep(input(tree, { target: { ...MOUNT, motorCount: n }, candidates: cands, autoDelay: false,
    splits: [halves, ...(pairs ? [pairs] : [])] }),
  { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22', 1.1), c: curve('E24', 1.2) }), nozzleFor: nozzles({}) });
  expect(result.rows).toHaveLength(n === 4 ? 6 : 13);
  expect(result.rows.every(r => r.run && !r.error)).toBe(true);
  expect(result.rows.filter(r => r.run!.motorConfig === `mixed ${n / 2}+${n / 2}`).map(r => r.key)).toEqual(
    [['a', 'b'], ['a', 'c'], ['b', 'c']].map(ids => batchRowKey(`mixed ${n / 2}+${n / 2}`, ids)));
  if (n === 6) {
    expect(result.rows.filter(r => r.run!.motorConfig === 'mixed 4+2')).toHaveLength(6);
    expect(result.rows.filter(r => r.run!.motorConfig === 'mixed 2+2+2')).toHaveLength(1);
  }
}, 30000);

it('Round 3 plugged exception provenance preserves unlit legs in both passes', async () => {
  const setup = separateRing();
  setup.tree.components[0]!.children![1]!.children!.find(c => c.id === 'chute')!.deployEvent = 'ejection';
  const fly = vi.spyOn(flightRunner, 'flyLaunch');
  const out = await sweep(input(setup.tree, { ...setup, autoDelay: false,
    candidates: [entry('a', 'Acme', 'E20', 'P'), entry('b', 'Acme', 'E22', 'P')],
    splits: [batchRingSplits(setup.tree, setup.mounts).halves!],
    assignedIgnitions: { ring3: { event: 'never', delay: 0 } } }),
  { fetchSpec: fetchFrom({ a: curve('E20'), b: curve('E22') }), nozzleFor: nozzles({}) });
  for (const [i, row] of out.rows.entries()) {
    expect(row.error).toBeUndefined();
    const assigned = fly.mock.calls[i]![1].assigned;
    const unlit = assigned.find(([id]) => id === 'ring3')![1];
    expect(unlit.meta.autoDelay).toBe(false);
    expect(unlit.spec.ejectionDelay).toBe(Infinity);
    const current = designPageKey(designState(setup.tree, Object.fromEntries(assigned.map(([id, mm]) => [id,
      mm.meta.autoDelay ? { ...mm, spec: { ...mm.spec, ejectionDelay: 0 } } : mm]))));
    expect(row.run!.motorSetKey).toBe(current.motorSetKey);
    expect(changedSinceRun(row.run!, current)).toEqual([]);
    expect(canReplayDelays(row.run!.delayResolution, assigned, assigned[0]![0], row.run!.delayS, true)).toBe(true);
  }
}, 60000);
