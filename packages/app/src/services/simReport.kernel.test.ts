import { describe, expect, it } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import type { FlightSeries } from '@online-openrocket/engine';
import { buildSimRun, extractLandingDrift, rodExitFromSeries, WIND_BLOWS_TOWARD_DEG } from './simReport.js';
import { runsToCsv } from './simStore.js';
import { formatWarning } from './simWarnings.js';
import { DEFAULT_CONDITIONS, kernelSimOptions } from '../components/LaunchPanel.js';
import { densityAltitudeM, isaAltitudeForDensity } from './atmosphere.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * DENSITY ALTITUDE against the kernel (weather build, step 1). The readout is
 * computed analytically from `padAir`; the kernel interpolates the same
 * profile on a 500 m grid. So the density the kernel actually flies at the pad
 * must read, through the same inverse, within a few metres of the readout —
 * which is the claim the guide makes ("up to about 16 ft").
 */
describe('the density-altitude readout describes the air the kernel flies', () => {
  it('agrees with the kernel’s own pad density to within 6 m (4,000 ft, 95 °F)', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    resetEngine();
    const launch = { ...DEFAULT_CONDITIONS, launchAltitudeM: 1219.2, temperatureC: 35 };
    const rocket = OrkRocket.buildTree(tree(true));
    rocket.setMotorById('mount', C6);
    const result = rocket.simulate({ ...kernelSimOptions(launch), series: 'full' });
    const rho0 = (result.series as unknown as Record<string, (number | null)[] | undefined>)['ρ']?.[0];
    expect(typeof rho0, 'the full series carries air density').toBe('number');
    expect(Math.abs(isaAltitudeForDensity(rho0!) - densityAltitudeM(launch))).toBeLessThan(6);
  }, 30000);
});

/**
 * LONGITUDE MOVES NO FLIGHT NUMBER (weather build, step 3) — the claim the
 * Longitude field's help and the guide make, held in a script. The kernel
 * places the pad at it (the flight data's λ), and nothing it computes depends
 * on it: gravity and the Coriolis term read latitude only.
 */
describe('longitude moves no flight number', () => {
  it('flies the default, 10° E and Black Rock to one apogee, top speed and flight time; only λ moves', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    resetEngine();
    const fly = (longitudeDeg: number | null) => {
      const rocket = OrkRocket.buildTree(tree(true));
      rocket.setMotorById('mount', C6);
      return rocket.simulate({
        ...kernelSimOptions({
          ...DEFAULT_CONDITIONS, windAverage: 4, windStdDev: 1, launchRodAngleDeg: 5, latitudeDeg: 40.65, longitudeDeg,
        }),
        randomSeed: 42, series: 'full',
      });
    };
    const blank = fly(null);
    const lambda0 = (r: typeof blank) => (r.series as unknown as Record<string, (number | null)[] | undefined>)['λ']?.[0];
    for (const lon of [10, -119.355]) {
      const moved = fly(lon);
      expect(moved.summary.maxAltitude, `${lon}`).toBe(blank.summary.maxAltitude);
      expect(moved.summary.maxVelocity, `${lon}`).toBe(blank.summary.maxVelocity);
      expect(moved.summary.flightTime, `${lon}`).toBe(blank.summary.flightTime);
      expect(lambda0(moved), `${lon}`).toBeCloseTo(lon, 6);
    }
    expect(lambda0(blank)).toBeCloseTo(-80.6, 6);
  }, 60000);
});

/**
 * ROD AIM (weather build, step 2), end to end through `kernelSimOptions` and
 * the real kernel. In calm air a tilted rod is the only thing that moves the
 * rocket sideways, so the landing bearing IS the rod's lean: the aim is
 * measured from straight into the wind, which blows from the east
 * (KERNEL_WIND_FROM_RAD), so 0 leans east (90°), +90 — to your right as you
 * face into the wind — leans south (180°), 180 west, −90 north. That is the
 * sign convention the field's help states, held against the physics.
 */
describe('Rod aim turns a tilted rod’s lean about the wind', () => {
  it('lands a calm-air flight toward the side the rod leans: 0 → E, +90 → S, 180 → W, −90 → N', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    resetEngine();
    const fly = (launchRodAimDeg: number) => {
      const rocket = OrkRocket.buildTree(tree(true));
      rocket.setMotorById('mount', C6);
      return extractLandingDrift(rocket.simulate({
        ...kernelSimOptions({ ...DEFAULT_CONDITIONS, launchRodAngleDeg: 10, launchRodAimDeg }),
        randomSeed: 42,
      }).series);
    };
    const off = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
    const drifts: number[] = [];
    for (const [aim, bearing] of [[0, 90], [90, 180], [180, 270], [-90, 0]] as const) {
      const d = fly(aim);
      expect(d.bearingDeg, `aim ${aim}`).not.toBeNull();
      expect(off(d.bearingDeg!, bearing), `aim ${aim}: bearing ${d.bearingDeg}`).toBeLessThan(15);
      drifts.push(d.distanceM!);
    }
    // One rod, turned: the same distance whichever way it points.
    expect(Math.max(...drifts) - Math.min(...drifts)).toBeLessThan(0.02 * Math.max(...drifts));
  }, 60000);

  // EVERY EXISTING FLIGHT IS UNCHANGED: an aim that does not move the flight
  // (0, a whole turn, or any aim on a vertical rod) flies byte-for-byte the
  // flight of a design saved before the field, full series and all.
  it('flies aim 0, a whole turn, and any aim on a vertical rod as the flight with no aim at all', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    resetEngine();
    const fly = (launch: typeof DEFAULT_CONDITIONS) => {
      const rocket = OrkRocket.buildTree(tree(true));
      rocket.setMotorById('mount', C6);
      return JSON.stringify(rocket.simulate({ ...kernelSimOptions(launch), randomSeed: 42, series: 'full' }));
    };
    const tilted = { ...DEFAULT_CONDITIONS, launchRodAngleDeg: 5, windAverage: 4, windStdDev: 1 };
    const before = fly(tilted);
    expect(fly({ ...tilted, launchRodAimDeg: 0 })).toBe(before);
    expect(fly({ ...tilted, launchRodAimDeg: 360 })).toBe(before);
    const vertical = { ...tilted, launchRodAngleDeg: 0 };
    expect(fly({ ...vertical, launchRodAimDeg: 90 })).toBe(fly(vertical));
    // …while an aim that does move it, does.
    expect(fly({ ...tilted, launchRodAimDeg: 180 })).not.toBe(before);
  }, 60000);

  // THE GUIDE'S FIGURES, held in a script (review of 2026-09-23): they were
  // measured at Wind gusts σ 1 and printed with no σ, so a reader flying the
  // panel's default σ 0 read 321/305 where the guide said 320/303. Flown here
  // at the default, rounded as printed, and found in the guide's own words.
  it('re-measures the Rod aim paragraph’s apogee and drift, at the σ it states', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    resetEngine();
    const fly = (launchRodAimDeg: number) => {
      const rocket = OrkRocket.buildTree(tree(true));
      rocket.setMotorById('mount', C6);
      const r = rocket.simulate({
        ...kernelSimOptions({ ...DEFAULT_CONDITIONS, launchRodAngleDeg: 5, windAverage: 4, launchRodAimDeg }),
        randomSeed: 42,
      });
      return [Math.round(r.summary.maxAltitude), Math.round(extractLandingDrift(r.series).distanceM!)] as const;
    };
    expect(DEFAULT_CONDITIONS.windStdDev).toBe(0);
    const [into, across, acrossLeft, down] = [fly(0), fly(90), fly(-90), fly(180)];
    expect(across).toEqual(acrossLeft);
    const guide = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'user-guide.md'), 'utf8');
    const para = guide.split(/\r?\n/).find((l) => l.startsWith('**Rod aim**'))!;
    expect(para).toContain('in a steady 4 m/s wind (Wind gusts σ 0, the default)');
    expect(para).toContain(`${into[0]} m of apogee and ${into[1]} m of drift aimed into the wind, `
      + `${across[0]} m and ${across[1]} m across it, ${down[0]} m and ${down[1]} m downwind`);
    // And one frame throughout: the wind the aim is measured from always
    // blows from the east. The weather section once said it had no direction.
    expect(guide).not.toMatch(/wind has no (compass )?direction/);
  }, 60000);

  // The aim turns the ROD, never the wind, so the landing label's "downwind"
  // stays the kernel's own: from KERNEL_WIND_FROM_RAD, toward that plus 180°.
  it('keeps the landing label’s "downwind" true: the wind still blows toward 270°', async () => {
    const { KERNEL_WIND_FROM_RAD } = await import('@online-openrocket/engine');
    expect(WIND_BLOWS_TOWARD_DEG).toBe((KERNEL_WIND_FROM_RAD * 180 / Math.PI + 180) % 360);
    expect(WIND_BLOWS_TOWARD_DEG).toBe(270);
  });
});
