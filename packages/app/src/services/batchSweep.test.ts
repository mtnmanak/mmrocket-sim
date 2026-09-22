import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrkRocket, type ComponentNode, type MotorSpec, type RocketTree } from '@online-openrocket/engine';
import { DEFAULT_CONDITIONS, kernelSimOptions } from '../components/LaunchPanel.js';
import { engineTree, splitClusterPairsTree, splitClusterTree } from '../tree/treeModel.js';
import { MOTOR_DB, type MotorDbEntry } from './motorDb.js';
import type { NozzleEntry } from './nozzleDb.js';
import { delayOptions, fetchMotorSpec } from './thrustcurve.js';
import { commentLevelsAlign, recommendDelay } from './simReport.js';
import { stageMotors } from './nozzleFollow.js';
import type { MountMotor } from '../App.js';
import {
  batchDelayRule, batchMotorIds, batchMotorNames, batchRowKey, deploysOnEjectionCharge, provisionalDelay,
  runBatchSweep, type BatchMountOption, type BatchSweepDeps, type BatchSweepInput,
} from './batchSweep.js';

/**
 * services/batchSweep.ts — the batch sweep out of its component (audit
 * 2026-09-22), flown here on the REAL TeaVM kernel. Only the network (the
 * thrust-curve download) and the lazy nozzle table are stubbed, so what these
 * pin is the sweep itself: which delay, which nozzle, which rows, which keys.
 */

afterEach(() => { vi.restoreAllMocks(); });

/** One 45 cm, 42 mm airframe; the options change only what each test is about. */
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
function clusterRocket(cluster: '4-ring' | '6-ring'): RocketTree {
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
            { type: 'parachute', id: 'chute', name: 'Main', diameter: 0.8 } as ComponentNode,
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
    assignedMotors: {}, assignedMotorIds: {}, assignedIgnitions: {},
    model: 'kbf', autoDelay: true, launch: DEFAULT_CONDITIONS, rocketName: 'Sweep bird',
    ...over,
  };
}

const sweep = (inp: BatchSweepInput, deps: Partial<BatchSweepDeps>, signal = new AbortController().signal) =>
  runBatchSweep(inp, { signal }, { yieldToUi: noYield, ...deps });

describe('provisionalDelay — what a candidate flies before any optimum is known', () => {
  it('is the longest prescribed delay in either mode', () => {
    for (const auto of [false, true]) {
      expect(provisionalDelay(entry('a', 'X', 'A', '3,5,7'), auto)).toBe(7);
      expect(provisionalDelay(entry('a', 'X', 'A', '6,10,P'), auto)).toBe(10);
      // Unlisted delays read as [0] in delayOptions — unknown, not plugged.
      expect(provisionalDelay(entry('a', 'X', 'A', ''), auto)).toBe(0);
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
    // Its default pick (a fixed delay), and what its auto load flies before App re-flies at the optimum.
    expect(browser).toContain('setDelay(finite[finite.length - 1] ?? opts[opts.length - 1] ?? 0);');
    expect(browser).toContain("const chosen = delay === 'auto' ? finite[finite.length - 1] ?? 0");
    let pluggedOnly = 0;
    for (const m of MOTOR_DB) {
      const opts = delayOptions(m);
      const finite = opts.filter((d) => Number.isFinite(d));
      if (finite.length === 0 && opts.includes(Infinity)) pluggedOnly++;
      expect(provisionalDelay(m, false), m.designation).toBe(finite[finite.length - 1] ?? opts[opts.length - 1] ?? 0);
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

describe('batchDelayRule — ONE rule for both passes', () => {
  const rule = (flownDelays: number[], optimum: number | null, autoDelay = true, deploysOnCharge = true) =>
    batchDelayRule({ flownDelays, optimum, autoDelay, deploysOnCharge });

  it('with auto delay, flies the rounded optimum and re-flies only when some leg is not already at it', () => {
    expect(rule([7], 6.8)).toEqual({ delay: 7, refly: false, optimumForPlugged: false });
    expect(rule([7], 5.2)).toEqual({ delay: 5, refly: true, optimumForPlugged: false });
    // A combination whose legs already sit at the optimum: the combination
    // pass used to re-fly this every time, for an identical flight.
    expect(rule([6, 6], 6.1)).toEqual({ delay: 6, refly: false, optimumForPlugged: false });
    expect(rule([6, 8], 6.1)).toEqual({ delay: 6, refly: true, optimumForPlugged: false });
  });

  it('keeps the flight it has when the kernel gives no optimum', () => {
    expect(rule([7], null)).toEqual({ delay: 7, refly: false, optimumForPlugged: false });
  });

  it('without auto delay, keeps each leg at its own delay and records the earliest charge', () => {
    expect(rule([7], 3, false)).toEqual({ delay: 7, refly: false, optimumForPlugged: false });
    expect(rule([10, Infinity], 3, false)).toEqual({ delay: 10, refly: false, optimumForPlugged: false });
  });

  it('flies a charge-less flight at its optimum, and says so, only when the recovery waits for the charge', () => {
    expect(rule([Infinity], 6.2, false, true)).toEqual({ delay: 6, refly: true, optimumForPlugged: true });
    expect(rule([Infinity, Infinity], 6.2, false, true)).toEqual({ delay: 6, refly: true, optimumForPlugged: true });
    // Electronics deploy it: plugged is exactly how it flies.
    expect(rule([Infinity], 6.2, false, false)).toEqual({ delay: Infinity, refly: false, optimumForPlugged: false });
  });
});

describe('batchMotorNames and batchRowKey — rows that can be told apart', () => {
  it('names the manufacturer, and falls back to the raw designation only where two candidates would read alike', () => {
    const cti = MOTOR_DB.filter((m) => m.manufacturerAbbrev === 'Cesaroni' && /^\d+H255-14A$/.test(m.designation));
    expect(cti.map((m) => m.designation).sort()).toEqual(['229H255-14A', '315H255-14A']);
    const other = MOTOR_DB.find((m) => m.manufacturerAbbrev === 'AeroTech' && m.designation === 'F13-RCT')!;
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
      + 'deploys its recovery on the motor’s charge, so the batch flew it at the optimum delay of '
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
    const rec = recommendDelay(r.simulate(opts).summary.optimumDelay)!;
    r.setMotorById('mount', { ...spec, ejectionDelay: rec });
    const designPage = r.simulate(opts).summary.maxAltitude;

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
    expect(flights.mock.calls.length - atComboStart).toBe(1);
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
  }, 60000);

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
    expect(src).toContain('const sweepHandle = handlePool(sweepTree, [target.id]);');
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
