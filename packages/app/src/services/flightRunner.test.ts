// @vitest-environment happy-dom
import { probeFlight, testMotor } from './autoDelay.testSupport.js';
import { addRun, loadRuns } from './simStore.js';
import type { SimRun } from './simReport.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FlightResult, IgnitionEvent, MotorSpec, OrkRocket } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { DEFAULT_CONDITIONS, kernelSimOptions } from '../components/LaunchPanel.js';
import { defaultTree, engineTree, flownRecoveryDevices, motorMounts } from '../tree/treeModel.js';
import {
  applyAssignedMotors, flyLaunch, reflyRun, writeMountMotor, type FlightHandle, type LaunchInput,
} from './flightRunner.js';
import { findDbMotor } from './motorDb.js';
import { mountMotorFromDb } from './motorMatch.js';
import { buildSimRun } from './simReport.js';
import { fetchMotorSpec } from './thrustcurve.js';

/**
 * The flight runner, flown — the behavioural replacement for the source-text
 * guards that used to live in flownIgnitionSites.test.ts (audit 2026-09-22).
 * Those counted `setFlownMotorOn(built.rocket, ` in App.tsx and stayed green
 * while "Show charts" re-flew a stored run at a delay a later Launch had left
 * on the shared handle; a count of call sites cannot see what a call writes.
 */

// ---------------------------------------------------------------------------
// The protocol, against a handle that records what it was told.
// ---------------------------------------------------------------------------

type Call =
  | ['motor', string, number]
  | ['ignition', string, IgnitionEvent, number]
  | ['supersonic', boolean]
  | ['kbf', boolean]
  | ['simulate'];

/** A stand-in handle: logs every write; `simulate` answers from `summary`. */
function recordingHandle(summary: Partial<FlightResult['summary']> = {}, opts: { throwOnSimulate?: boolean } = {}) {
  const calls: Call[] = [];
  const handle: FlightHandle = {
    setMotorById: (id: string, spec: MotorSpec) => { calls.push(['motor', id, spec.ejectionDelay]); },
    setMotorIgnitionById: (id: string, event: IgnitionEvent, delay = 0) => { calls.push(['ignition', id, event, delay]); },
    setHybridAero: () => {},
    setSupersonicAero: (on: boolean) => { calls.push(['supersonic', on]); },
    setRogersModifiedBarrowman: (on: boolean) => { calls.push(['kbf', on]); },
    simulate: (options) => {
      calls.push(['simulate']);
      if (opts.throwOnSimulate) throw new Error('kernel threw');
      return {
        ...(options?.delayProbe ? { delayProbe: probeFlight(['sustainer', 'booster'], 2 + (summary.optimumDelay ?? 6.85)).delayProbe } : {}),
        summary: { maxMachNumber: 0.3, optimumDelay: 6.85, maxAltitude: 100, ...summary },
        events: [], series: {},
      } as unknown as FlightResult;
    },
  };
  return { handle, calls };
}

const SPEC: MotorSpec = {
  designation: 'H128', diameter: 0.029, length: 0.194,
  times: [0, 0.1, 1.5], thrusts: [0, 150, 0], masses: [0.2, 0.19, 0.1],
  cgX: 0.097, ejectionDelay: 10,
};
const mm = (over: Partial<MountMotor> = {}): MountMotor => ({
  label: 'H128-10', spec: SPEC, meta: { label: 'H128-10' },
  ignition: { event: 'automatic', delay: 0 }, ...over,
});

/**
 * A staged design the way `assignMotor` leaves it: the sustainer (the PRIMARY)
 * electronics-timed at booster burnout + 1 s, the booster on AUTOMATIC.
 */
const staged = (autoDelay: boolean): LaunchInput => ({
  assigned: [
    ['sustainer', mm({ ignition: { event: 'burnout', delay: 1 }, meta: { label: 'H128-10', autoDelay } })],
    ['booster', mm()],
  ],
  hardware: undefined,
  primaryMountId: 'sustainer',
  simOptions: {},
  aeroMode: 'classic',
  supersonic: false,
  isOnLaunchStage: (id) => id === 'booster',
  onSupersonicUpgrade: () => {},
});

describe('Hybrid handle protocol', () => {
  it('keeps Kbf on, disables inherited Supersonic, and never runs the Auto upgrade', async () => {
    const { handle, calls } = recordingHandle({ maxMachNumber: 2 });
    const hybrids: boolean[] = [];
    handle.setHybridAero = (on) => { hybrids.push(on); };
    let upgrades = 0;
    const out = await flyLaunch(handle, { ...staged(false), aeroMode: 'hybrid', supersonic: true,
      onSupersonicUpgrade: () => { upgrades++; } });
    expect(hybrids).toEqual([true]);
    expect(calls).toContainEqual(['kbf', true]);
    expect(calls).toContainEqual(['supersonic', false]);
    expect(calls.filter((c) => c[0] === 'simulate')).toHaveLength(1);
    expect(out.usedSupersonic).toBe(false);
    expect(upgrades).toBe(0);
  });

  it.each([false, true])('restores Hybrid after replay, including kernel failure=%s', (fail) => {
    const { handle } = recordingHandle({}, { throwOnSimulate: fail });
    const hybrids: boolean[] = [];
    handle.setHybridAero = (on) => { hybrids.push(on); };
    const replay = () => reflyRun(handle, { ...staged(false), delayS: 10,
      fly: { hybrid: false, supersonic: true, kbf: true },
      restore: { hybrid: true, supersonic: false, kbf: true } });
    if (fail) expect(replay).toThrow('kernel threw');
    else replay();
    expect(hybrids).toEqual([false, true]);
  });
});

describe('complete per-mount Launch protocol', () => {
  function setup() {
    const specs = new Map<string, MotorSpec>();
    const snapshots: { probe: boolean; delays: number[]; supersonic: boolean }[] = [];
    let supersonic = false;
    const handle: FlightHandle = {
      setMotorById: (id, spec) => { specs.set(id, spec); }, setMotorIgnitionById: () => {},
      setHybridAero: () => {},
      setSupersonicAero: (on) => { supersonic = on; }, setRogersModifiedBarrowman: () => {},
      simulate: (o) => {
        snapshots.push({ probe: !!o?.delayProbe, delays: [...specs.values()].map((s) => s.ejectionDelay), supersonic });
        const p = probeFlight(undefined, supersonic ? 14 : 12);
        if (!o?.delayProbe) delete p.delayProbe;
        return p;
      },
    };
    const input: LaunchInput = { ...staged(false), assigned: [['a', testMotor()], ['b', testMotor()], ['manual', testMotor(false, 4)], ['plugged', testMotor(false, Infinity)]],
      primaryMountId: 'a', yieldToUi: async () => {}, mountNames: { a: 'Core', b: 'Booster MMT' } };
    return { handle, input, snapshots, specs };
  }

  it('flies the complete settled vector, persists/reloads/replays it and restores all mounts', async () => {
    const { handle, input, snapshots, specs } = setup();
    const f = await flyLaunch(handle, input);
    expect(snapshots).toEqual([
      { probe: true, delays: [0, 0, 4, Infinity], supersonic: false },
      { probe: true, delays: [10, 7, 4, Infinity], supersonic: false },
      { probe: false, delays: [10, 7, 4, Infinity], supersonic: false },
    ]);
    expect([...specs.values()].map((s) => s.ejectionDelay)).toEqual([0, 0, 4, Infinity]);
    localStorage.clear();
    addRun({ id: 'vector', delayS: f.flownDelayS, delayResolution: f.delayResolution } as SimRun);
    const saved = loadRuns()[0]!;
    reflyRun(handle, { ...input, delayS: saved.delayS, delayResolution: saved.delayResolution,
      fly: { kbf: false, supersonic: false }, restore: { kbf: false, supersonic: false } });
    expect(snapshots.at(-1)!.delays).toEqual([10, 7, 4, Infinity]);
    expect(snapshots.filter((s) => s.probe)).toHaveLength(2); // replay never optimizes
  });

  it('recomputes targets when the final normal flight upgrades Auto aero', async () => {
    const { handle, input, snapshots } = setup();
    const simulate = handle.simulate;
    handle.simulate = (o) => {
      const p = simulate(o);
      if (!o?.delayProbe && !o?.maxTime) p.summary.maxMachNumber = 1.1;
      return p;
    };
    const f = await flyLaunch(handle, { ...input, aeroMode: 'auto' });
    expect(f.usedSupersonic).toBe(true);
    expect(f.delayResolution.probes).toBe(4);
    expect(f.delayResolution.mounts.slice(0, 2).map((m) => m.flownDelay)).toEqual([12, 9]);
    expect(snapshots.at(-1)).toMatchObject({ probe: false, supersonic: true, delays: [12, 9, 4, Infinity] });
  });

  it('refuses unavailable telemetry without a normal flight and restores the setup', async () => {
    const { handle, input, specs } = setup();
    handle.simulate = () => { const p = probeFlight(); delete p.delayProbe; return p; };
    await expect(flyLaunch(handle, input)).rejects.toThrow('Core');
    expect([...specs.values()].map((s) => s.ejectionDelay)).toEqual([0, 0, 4, Infinity]);
  });

  it('refuses corrupt saved vectors before simulating', async () => {
    const { handle, input, snapshots } = setup();
    const f = await flyLaunch(handle, input); const count = snapshots.length;
    expect(() => reflyRun(handle, { ...input, delayS: f.flownDelayS,
      delayResolution: { ...f.delayResolution, mounts: f.delayResolution.mounts.slice(1) },
      fly: { kbf: false, supersonic: false }, restore: { kbf: false, supersonic: false },
    })).toThrow('incomplete');
    expect(snapshots).toHaveLength(count);
  });

  it('keeps weighed hardware through probes, final writes and restoration', async () => {
    const { handle, input, specs } = setup();
    input.hardware = { state: 'ok', appliedTo: 'a', motorCount: 1, perMotorShiftKg: 0.05,
      deltaKg: 0.05, motorMassKg: 0.4, mountCount: 2, dryMassKg: 0.2, drySource: 'computed', large: false };
    const simulate = handle.simulate;
    handle.simulate = (o) => {
      expect(specs.get('a')!.masses[0]).toBeCloseTo(testMotor().spec.masses[0]! + 0.05, 12);
      expect(specs.get('b')!.masses).toEqual(testMotor().spec.masses);
      return simulate(o);
    };
    await flyLaunch(handle, input);
    expect(specs.get('a')!.masses[0]).toBeCloseTo(0.25, 12);
  });

  it('omits a refused fixed mount and refuses an uninstalled Auto mount by name', async () => {
    const { handle, input } = setup();
    const f = await flyLaunch(handle, { ...input, refusedMountIds: ['manual'] });
    expect(f.delayResolution.mounts.some((m) => m.mountId === 'manual')).toBe(false);
    await expect(flyLaunch(handle, { ...input, refusedMountIds: ['b'] })).rejects.toThrow(/Booster MMT.*refused at build/);
  });

  /**
   * A REFUSED MOUNT IS LEFT OUT OF THE REPLAY THE WAY IT WAS LEFT OUT OF THE
   * LAUNCH (audit 2026-09-30). Launch stores the delay vector for the mounts it
   * flew, and a replay checked it against EVERY assigned mount, so the lengths
   * never matched: "Show charts" hid itself for every run of the design, and the
   * flight-data download refused with "Saved mount delays are incomplete" —
   * which no Launch could clear. Both refusals the build reports: a curve the
   * kernel refused (App passes those ids), and an ignition event the kernel does
   * not know, which writeMountMotor refuses whether or not anyone passes it.
   */
  it.each([
    ['a mount the build refused', (input: LaunchInput): LaunchInput => ({ ...input, refusedMountIds: ['manual'] })],
    ['a mount whose ignition the kernel does not know', (input: LaunchInput): LaunchInput => ({
      ...input,
      assigned: input.assigned.map(([id, m]) => [id, id === 'manual'
        ? { ...m, ignition: { event: 'bogus' as IgnitionEvent, delay: 0 } } : m] as const),
    })],
  ])('re-flies a run launched without %s on the mounts that flew', async (_what, refuse) => {
    const { handle, input, snapshots } = setup();
    const launched = refuse(input);
    const f = await flyLaunch(handle, launched);
    const flown = snapshots.at(-1)!;
    expect(flown).toMatchObject({ probe: false, delays: [10, 7, Infinity] });
    reflyRun(handle, { ...launched, delayS: f.flownDelayS, delayResolution: f.delayResolution,
      fly: { kbf: false, supersonic: false }, restore: { kbf: false, supersonic: false } });
    expect(snapshots.at(-1)).toEqual(flown);
  });
});

describe('flight runner — every motor write keeps its ignition', () => {
  /**
   * The bridge's `setMotorById` installs a FRESH MotorConfiguration, so a write
   * that does not re-apply the ignition silently returns the mount to
   * AUTOMATIC. On a staged design that lights the sustainer off the booster's
   * ejection charge instead of burnout + 1 s — and the auto-delay re-fly is the
   * flight `buildSimRun` stores (2026-09-08 audit).
   */
  const everyWriteKeepsIgnition = (calls: Call[]) => {
    calls.forEach((c, i) => {
      if (c[0] !== 'motor') return;
      if (c[1] === 'sustainer') {
        expect(calls[i + 1], `write #${i} of the sustainer lost its burnout + 1 s ignition`)
          .toEqual(['ignition', 'sustainer', 'burnout', 1]);
      } else {
        // AUTOMATIC with no timer is left exactly as the kernel configured it.
        expect(calls[i + 1]?.[0]).not.toBe('ignition');
      }
    });
  };

  it('on Launch, including the auto-delay write', async () => {
    const { handle, calls } = recordingHandle();
    const flight = await flyLaunch(handle, staged(true));
    expect(flight.flownDelayS).toBe(7); // 6.85 rounded — the auto delay DID write
    expect(calls.filter((c) => c[0] === 'motor' && c[1] === 'sustainer' && c[2] === 7)).toHaveLength(2);
    everyWriteKeepsIgnition(calls);
  });

  it('on a re-fly, including the delay write and every restore', async () => {
    const { handle, calls } = recordingHandle();
    const launch = await flyLaunch(handle, staged(true));
    reflyRun(handle, {
      ...staged(true), delayS: launch.flownDelayS, delayResolution: launch.delayResolution,
      fly: { supersonic: false, kbf: false }, restore: { supersonic: false, kbf: false },
    });
    expect(calls.some((c) => c[0] === 'motor' && c[1] === 'sustainer' && c[2] === 7)).toBe(true);
    everyWriteKeepsIgnition(calls);
  });
});

/**
 * reflyRun's own half of the delay contract. Launch now hands the handle back
 * at the spec delay, so a re-fly would pass every other test here even if it
 * went back to trusting the handle — writing the run's delay only when it
 * differed from the spec's, as "Show charts" and the flight-data download did
 * until the 2026-09-22 audit. These put a foreign delay on the handle FIRST,
 * the way any path that forgets the protocol would leave one.
 */
describe('flight runner — a re-fly never trusts the delay it finds on the handle', () => {
  it('flies the run’s delay even when it is the spec’s', async () => {
    const { handle, calls } = recordingHandle();
    writeMountMotor(handle, 'sustainer', { ...SPEC, ejectionDelay: 7 }, { event: 'burnout', delay: 1 });
    reflyRun(handle, {
      ...staged(false), delayS: SPEC.ejectionDelay,
      fly: { supersonic: false, kbf: false }, restore: { supersonic: false, kbf: false },
    });
    const beforeFlight = calls.slice(0, calls.findIndex((c) => c[0] === 'simulate'));
    const flown = [...beforeFlight].reverse().find((c) => c[0] === 'motor' && c[1] === 'sustainer');
    expect(flown, 'the re-fly flew the 7 s it found on the handle').toEqual(['motor', 'sustainer', 10]);
  });
});

describe('flight runner — the shared handle is handed back', () => {
  it('a re-fly that throws still restores the model and the motor', async () => {
    const { handle, calls } = recordingHandle({}, { throwOnSimulate: true });
    expect(() => reflyRun(handle, {
      ...staged(false), delayS: 10,
      fly: { supersonic: true, kbf: true }, restore: { supersonic: false, kbf: false },
    })).toThrow('kernel threw');
    const after = calls.slice(calls.findIndex((c) => c[0] === 'simulate') + 1);
    expect(after).toContainEqual(['supersonic', false]);
    expect(after).toContainEqual(['kbf', false]);
    // The last write of the primary puts its OWN delay back, not the run's.
    const lastPrimary = [...after].reverse().find((c) => c[0] === 'motor' && c[1] === 'sustainer');
    expect(lastPrimary).toEqual(['motor', 'sustainer', 10]);
  });
});

// ---------------------------------------------------------------------------
// The delay contract, flown on the REAL kernel — the audit's measured case.
// ---------------------------------------------------------------------------

/**
 * The starter rocket on an AeroTech F39-9 from the bundled curve: 9 s is
 * longer than this flight's 6.85 s optimum, so auto delay flies 7 s. Measured
 * by the 2026-09-22 audit — the stored 9 s run deploys at 18.14 m/s; its
 * "Show charts" re-fly after an auto-delay Launch deployed at 1.76 m/s, the
 * 7 s flight, under copy promising it "reproduces this exact flight".
 */
describe('flight runner — a stored run re-flies at the delay it flew (real kernel)', () => {
  let rocket: OrkRocket;
  let engine: ReturnType<typeof engineTree>;
  let motors: (auto: boolean) => LaunchInput;

  beforeAll(async () => {
    const { OrkRocket: Ork, resetEngine } = await import('@online-openrocket/engine');
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const db = findDbMotor('F39', undefined, undefined, 'AeroTech')!;
    const f39 = mountMotorFromDb(db, await fetchMotorSpec(db, 9), 9, { event: 'automatic', delay: 0 });
    resetEngine();
    engine = engineTree(tree);
    rocket = Ork.buildTree(engine);
    rocket.setRogersModifiedBarrowman(false);
    rocket.setSupersonicAero(false);
    rocket.setMotorById(mount, f39.spec);
    motors = (auto) => ({
      assigned: [[mount, { ...f39, meta: { ...f39.meta, autoDelay: auto } }]],
      hardware: undefined,
      primaryMountId: mount,
      simOptions: kernelSimOptions(DEFAULT_CONDITIONS),
      aeroMode: 'classic',
      supersonic: false,
      isOnLaunchStage: () => true,
      onSupersonicUpgrade: () => {},
    });
  }, 60_000);

  const deployAt = (res: FlightResult, delayS: number) => buildSimRun({
    result: res, info: rocket.staticInfo(),
    motor: { ...motors(false).assigned[0]![1].spec, ejectionDelay: delayS },
    meta: { label: 'F39-9' }, launch: DEFAULT_CONDITIONS, rocketName: 'starter', execMs: 1,
    flownRecovery: flownRecoveryDevices(engine),
  }).velocityAtDeployment;
  const classic = { supersonic: false, kbf: false };

  it('Show charts after an auto-delay Launch reproduces the stored 9 s flight, not the 7 s one', async () => {
    const runA = await flyLaunch(rocket, motors(false)); // auto off: flies the spec
    const runB = await flyLaunch(rocket, motors(true)); // auto on: flies the optimum
    expect(runA.flownDelayS).toBe(9);
    expect(runB.flownDelayS).toBe(runB.delayResolution.mounts[0]!.recommendedDelay);
    expect(deployAt(runA.result, 9)).not.toBe(deployAt(runB.result, runB.flownDelayS));

    const refly = reflyRun(rocket, {
      ...motors(true), delayS: runA.flownDelayS,
      simOptions: kernelSimOptions(DEFAULT_CONDITIONS), fly: classic, restore: classic,
    });
    expect(refly.summary).toEqual(runA.result.summary);
  }, 60_000);

  it('a stored 9 s run re-flies at 9 s whatever delay the handle was left carrying', async () => {
    const runA = await flyLaunch(rocket, motors(false));
    // A foreign 7 s put on the handle directly — not by a Launch, whose own
    // restore would hide a re-fly that trusts the handle.
    const [mount, f39] = motors(false).assigned[0]!;
    writeMountMotor(rocket, mount, { ...f39.spec, ejectionDelay: 7 }, f39.ignition);
    const refly = reflyRun(rocket, {
      ...motors(false), delayS: runA.flownDelayS,
      simOptions: kernelSimOptions(DEFAULT_CONDITIONS), fly: classic, restore: classic,
    });
    expect(deployAt(refly, 9)).toBeCloseTo(deployAt(runA.result, 9)!, 8);
    expect(refly.summary).toEqual(runA.result.summary);
  }, 60_000);

  it('Launch hands the handle back at the spec delay, whatever auto delay flew', async () => {
    const plain = (await flyLaunch(rocket, motors(false))).result.summary;
    await flyLaunch(rocket, motors(true));
    // Anything that flies the bare handle next — the next path to forget the
    // protocol — gets the design as it stands, not the auto delay.
    expect(rocket.simulate(kernelSimOptions(DEFAULT_CONDITIONS)).summary).toEqual(plain);
  }, 60_000);

  it('the auto-delay run itself re-flies at its own 7 s', async () => {
    const runB = await flyLaunch(rocket, motors(true));
    const refly = reflyRun(rocket, {
      ...motors(true), delayS: runB.flownDelayS, delayResolution: runB.delayResolution,
      simOptions: kernelSimOptions(DEFAULT_CONDITIONS), fly: classic, restore: classic,
    });
    expect(refly.summary).toEqual(runB.result.summary);
  }, 60_000);
});

/**
 * An ignition event that is none of the five (audit 2026-09-22). The bridge's
 * ignition write throws for it — but only AFTER `setMotorById` has installed
 * the motor, and there is no bridge call that takes a motor back off. So the
 * build reported the mount as REFUSED (recovery weight and the pad-mass
 * arithmetic left it out) while the handle flew it on AUTOMATIC: numbers
 * computed with and without the same motor.
 */
describe('flight runner — a motor whose ignition nothing knows stays OFF the handle', () => {
  const bogus = { event: 'bogus' as IgnitionEvent, delay: 0 };

  it('is refused before anything is written', async () => {
    const { handle, calls } = recordingHandle();
    expect(() => writeMountMotor(handle, 'mount', SPEC, bogus)).toThrow(/H128.*“bogus”/);
    expect(calls).toEqual([]);
  });

  it('a known event is written in the spelling the kernel parses it by', async () => {
    const { handle, calls } = recordingHandle();
    writeMountMotor(handle, 'mount', SPEC, { event: 'BURNOUT' as IgnitionEvent, delay: 1 });
    expect(calls).toEqual([['motor', 'mount', 10], ['ignition', 'mount', 'burnout', 1]]);
  });

  it('on the real kernel, the refused mount carries no motor at all', async () => {
    const { OrkRocket: Ork } = await import('@online-openrocket/engine');
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const db = findDbMotor('C6', undefined, undefined, 'Estes')!;
    const c6 = await fetchMotorSpec(db, 5);
    const rocket = Ork.buildTree(engineTree(tree));
    expect(() => writeMountMotor(rocket, mount, c6, bogus)).toThrow();
    const info = rocket.staticInfo();
    // Dry mass only — the refusal and the handle are one fact again.
    expect(info.mass).toBeCloseTo(info.massEmpty, 9);
    // …and applyAssignedMotors, which every flight starts from, keeps it so.
    applyAssignedMotors(rocket, {
      assigned: [[mount, { label: 'C6-5', spec: c6, meta: { label: 'C6-5' }, ignition: bogus }]],
      hardware: undefined,
    });
    expect(rocket.staticInfo().mass).toBeCloseTo(info.massEmpty, 9);
  }, 60_000);
});
