import { describe, expect, it } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import type { FlightSeries } from '@online-openrocket/engine';
import { buildSimRun, rodExitFromSeries } from './simReport.js';
import { runsToCsv } from './simStore.js';
import { formatWarning } from './simWarnings.js';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';

/**
 * Simulation warnings and landing drift, end-to-end through the REAL kernel
 * (TeaVM artifact): the engine must emit the warning/series, and simReport
 * must surface them into the SimRun the report and CSV render.
 */

const C6: MotorSpec = {
  designation: 'C6', diameter: 0.018, length: 0.07,
  times: [0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0],
  thrusts: [0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0],
  masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132],
  cgX: 0.035, ejectionDelay: 5.0,
};

/** The reference test rocket, with or without its parachute. */
const tree = (withChute: boolean): RocketTree => ({
  name: withChute ? 'Chuted' : 'Ballistic',
  components: [
    { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' } as ComponentNode,
    {
      type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950,
      children: [
        { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
        { type: 'innertube', id: 'mount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005, motorMount: true },
        ...(withChute ? [{ type: 'parachute', diameter: 0.3 } as ComponentNode] : []),
      ],
    } as ComponentNode,
  ],
});

describe('kernel warnings + drift, end-to-end', () => {
  it('a recovery-device-less rocket surfaces NO_RECOVERY_DEVICE into the SimRun', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    resetEngine();
    const rocket = OrkRocket.buildTree(tree(false));
    rocket.setMotorById('mount', C6);
    const result = rocket.simulate({ launchRodLength: 1.0, timeStep: 0.05 });

    const w = (result.warnings ?? []).find((x) => x.key === 'NO_RECOVERY_DEVICE');
    expect(w, 'engine must emit the NO_RECOVERY_DEVICE warning').toBeTruthy();
    expect(w!.priority).toBe('HIGH');

    const run = buildSimRun({
      result, info: rocket.staticInfo(), motor: C6, meta: { label: 'C6-5' },
      launch: DEFAULT_CONDITIONS, rocketName: 'Ballistic', execMs: 1,
    });
    expect(run.simWarnings?.some((x) => x.key === 'NO_RECOVERY_DEVICE')).toBe(true);
    expect(formatWarning(run.simWarnings!.find((x) => x.key === 'NO_RECOVERY_DEVICE')!).high).toBe(true);
    // …and it reaches the run-table CSV's Sim warnings column.
    expect(runsToCsv([run])).toContain('NO_RECOVERY_DEVICE');
  }, 30000);

  it('wind > 0 → real downwind drift; wind = 0 → drift ≈ 0', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    resetEngine();

    const fly = (windAverage: number) => {
      const rocket = OrkRocket.buildTree(tree(true));
      rocket.setMotorById('mount', C6);
      const result = rocket.simulate({
        launchRodLength: 1.0, timeStep: 0.05, windAverage, randomSeed: 42,
      });
      return buildSimRun({
        result, info: rocket.staticInfo(), motor: C6, meta: { label: 'C6-5' },
        launch: { ...DEFAULT_CONDITIONS, windAverage }, rocketName: 'Chuted', execMs: 1,
      });
    };

    const calm = fly(0);
    const windy = fly(4);

    // Calm + straight-up rod: essentially no lateral travel.
    expect(calm.landingDistanceM).not.toBeNull();
    expect(calm.landingDistanceM!).toBeLessThan(2);

    // 4 m/s wind for a minute-plus under canopy: tens of meters, downwind.
    // The kernel's wind is a fixed EAST wind (PinkNoiseWindModel direction
    // π/2, meteorological "from"; the stepper ADDS the vector to rocket
    // velocity) — so downwind is compass 270° and the rocket lands west.
    expect(windy.landingDistanceM!).toBeGreaterThan(20);
    expect(windy.landingDistanceM!).toBeGreaterThan(calm.landingDistanceM! * 10);
    expect(windy.landingBearingDeg!).toBeGreaterThan(210);
    expect(windy.landingBearingDeg!).toBeLessThan(330);
  }, 30000);

  /**
   * A rocket the kernel refuses to fly comes back as a NORMAL result — no
   * exception, no engine warning — just a truncated series and a SIM_ABORT
   * event. Before this the app showed the resulting apogee-0 "flight" with
   * nothing at all to say why. On the beta test corpus 17 of the 72 flyable
   * imports end this way, so the silent version was not a corner case.
   */
  it('a rocket that cannot fly surfaces SIM_ABORT — with the reason the kernel gave', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    resetEngine();
    // A mount with no motor: the kernel aborts with NO_MOTORS_DEFINED rather
    // than throwing, which is exactly the shape that used to vanish.
    const rocket = OrkRocket.buildTree(tree(true));
    const result = rocket.simulate({ launchRodLength: 1.0, timeStep: 0.05 });

    const abort = result.events.find((e) => e.type === 'SIM_ABORT');
    expect(abort, 'kernel must emit a SIM_ABORT event for an unflyable rocket').toBeTruthy();
    expect(abort!.cause, 'and the bridge must carry its machine-readable cause').toBeTruthy();
    // The NAME, not the kernel's translated sentence — this build has no
    // resource bundle, so that would be a bracketed l10n key.
    expect(abort!.cause).toMatch(/^[A-Z_]+$/);

    const run = buildSimRun({
      result, info: rocket.staticInfo(), motor: C6, meta: { label: 'none' },
      launch: DEFAULT_CONDITIONS, rocketName: 'Unflyable', execMs: 1,
    });
    const w = run.simWarnings?.find((x) => x.key === 'SIM_ABORT');
    expect(w, 'and it must reach the report as a warning').toBeTruthy();
    expect(w!.priority).toBe('HIGH');
    // …worded by the app, not echoed from the kernel.
    expect(w!.message).toMatch(/stopped at T\+/);
    expect(w!.message.length).toBeGreaterThan(60);
    // …and out to the run-table CSV, like every other simulation warning.
    expect(runsToCsv([run])).toContain('SIM_ABORT');
  }, 30000);
});

/**
 * C4 — the launch-rod exit velocity is read at the instant the rocket leaves the
 * guide, not at the end of the step that carried it past.
 *
 * The kernel raises LAUNCHROD at the END of whichever step first crossed the rod tip
 * (BasicEventSimulationEngine.java:246-250) and FlightData interpolates at that time,
 * which is itself a stored sample — so the "interpolation" returned the end-of-step
 * value verbatim. The rocket is under 15-25 g there, so the figure was ALWAYS high.
 * Desktop OpenRocket 24.12 has the identical artifact; this is a deliberate
 * improvement on it, not a parity repair.
 */
describe('launch-rod exit is read at the crossing, not at the end of the step', () => {
  it('interpolates across the straddling step, in distance from the pad', () => {
    // Pad distance is hypot(Pl, altitude). Crossing 1.0 m exactly half way between
    // the 0.8 m and 1.2 m samples must give the mid velocity and the mid time.
    const series = {
      time: [0, 0.1, 0.2],
      altitude: [0, 0.8, 1.2],
      velocity: [0, 10, 14],
      Pl: [0, 0, 0],
    } as unknown as FlightSeries;
    const got = rodExitFromSeries(series, 1.0, 0.1)!;
    expect(got.velocity).toBeCloseTo(12, 9);
    expect(got.time).toBeCloseTo(0.15, 9);
  });

  it('measures along a TILTED rod, not up the vertical', () => {
    // Same altitudes, but the rocket is also moving downrange: the pad distance is
    // larger, so the rod is cleared EARLIER and the velocity is lower.
    const series = {
      time: [0, 0.1, 0.2],
      altitude: [0, 0.8, 1.2],
      velocity: [0, 10, 14],
      Pl: [0, 0.6, 0.9],
    } as unknown as FlightSeries;
    const got = rodExitFromSeries(series, 1.0, 0.1)!;
    // hypot(0.6, 0.8) = 1.0 exactly — the rod is cleared AT the first sample.
    expect(got.velocity).toBeCloseTo(10, 9);
    expect(got.time).toBeCloseTo(0.1, 9);
  });

  it('fails closed on a series whose samples are not one integration step apart', () => {
    // A hand-built fixture rather than a flown series. Returning null keeps the
    // kernel's own number instead of inventing one from two far-apart points.
    const series = {
      time: [0, 1.0], altitude: [0, 5], velocity: [0, 40], Pl: [0, 0],
    } as unknown as FlightSeries;
    expect(rodExitFromSeries(series, 1.0, 0.05)).toBeNull();
  });

  it('returns null for a rocket that never clears the rod, and for a nonsense rod', () => {
    const series = {
      time: [0, 0.1], altitude: [0, 0.2], velocity: [0, 3], Pl: [0, 0],
    } as unknown as FlightSeries;
    expect(rodExitFromSeries(series, 1.0, 0.1)).toBeNull();
    expect(rodExitFromSeries(series, 0, 0.1)).toBeNull();
    expect(rodExitFromSeries(series, NaN, 0.1)).toBeNull();
  });

  it('is LOWER than the kernel summary and matches a fine-step flight, end to end', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    resetEngine();
    const rocket = OrkRocket.buildTree(tree(true));
    rocket.setMotorById('mount', C6);
    const coarse = rocket.simulate({ launchRodLength: 1.0, timeStep: 0.05 });

    const run = buildSimRun({
      result: coarse, info: rocket.staticInfo(), motor: C6, meta: { label: 'C6-5' },
      launch: { ...DEFAULT_CONDITIONS, launchRodLengthM: 1.0, timeStepS: 0.05 },
      rocketName: 'Rod', execMs: 1,
    });

    // The kernel's own number is the end-of-step one and reads high.
    const raw = coarse.summary.launchRodVelocity!;
    expect(run.rodExitVelocity!).toBeLessThan(raw);
    // Measured on this design: +3.97 % before the fix.
    expect((raw - run.rodExitVelocity!) / run.rodExitVelocity!).toBeGreaterThan(0.02);

    // And it agrees with what a far finer step converges to. The RAW value at a fine
    // step is still biased (dt[0] floors at MIN_TIME_STEP before the on-rod /5), so
    // the reference is the fine-step run put through the same interpolation.
    resetEngine();
    const fine = OrkRocket.buildTree(tree(true));
    fine.setMotorById('mount', C6);
    const fineRun = buildSimRun({
      result: fine.simulate({ launchRodLength: 1.0, timeStep: 0.0005 }),
      info: fine.staticInfo(), motor: C6, meta: { label: 'C6-5' },
      launch: { ...DEFAULT_CONDITIONS, launchRodLengthM: 1.0, timeStepS: 0.0005 },
      rocketName: 'Rod', execMs: 1,
    });
    expect(run.rodExitVelocity!).toBeCloseTo(fineRun.rodExitVelocity!, 1);
  }, 60000);

  it('reports the departure time from the same instant as the velocity', async () => {
    // Three rod numbers from two different instants is how the panel came to
    // contradict its own arithmetic. The departure time must move with the velocity.
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    resetEngine();
    const rocket = OrkRocket.buildTree(tree(true));
    rocket.setMotorById('mount', C6);
    const result = rocket.simulate({ launchRodLength: 1.0, timeStep: 0.05 });
    const run = buildSimRun({
      result, info: rocket.staticInfo(), motor: C6, meta: { label: 'C6-5' },
      launch: { ...DEFAULT_CONDITIONS, launchRodLengthM: 1.0, timeStepS: 0.05 },
      rocketName: 'Rod', execMs: 1,
    });
    const eventT = result.events!.find((e) => e.type === 'LAUNCHROD')!.time;
    expect(run.timeToRodDeparture!).toBeLessThan(eventT);
  }, 30000);
});
