import { describe, expect, it } from 'vitest';
import type { FlightResult, FlightSeries, StaticInfo } from '@online-openrocket/engine';
import {
  buildSimRun, extractLandingDrift, extractMaxRollRate, formatStability, recommendDelay,
  ROLL_RATE_MEANINGFUL_RAD_S, runMatchesDesign, SAFETY, stabilityPercent, storedSimCost,
  type SimRun,
} from './simReport.js';
import { runsToCsv } from './simStore.js';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';

const info: StaticInfo = {
  length: 0.37, lengthAerodynamic: 0.37, mass: 0.051, massEmpty: 0.027, cgEmpty: 0.19, cg: 0.26,
  rotationalInertia: 1.2e-4, longitudinalInertia: 3.4e-3,
  rotationalInertiaEmpty: 1.0e-4, longitudinalInertiaEmpty: 3.0e-3,
  cp: 0.29, cna: 8, stabilityCalibers: 1.3, refDiameter: 0.024,
  warnings: 0, warningTexts: [],
};

/** Minimal but self-consistent flight: rod exit at 0.15 s, burnout 2 s, apogee 6.8 s. */
function fakeResult(): FlightResult {
  const time = [0, 0.15, 1, 2, 6.8, 7.0, 104];
  return {
    summary: {
      maxAltitude: 331.7, maxVelocity: 116.2, maxAcceleration: 227.5,
      maxMachNumber: 0.35, timeToApogee: 6.8, flightTime: 104,
      groundHitVelocity: 3.4, launchRodVelocity: 18.4,
      deploymentVelocity: 4.2, optimumDelay: 4.9,
    },
    events: [
      { type: 'LAUNCH', time: 0 },
      { type: 'LAUNCHROD', time: 0.15 },
      { type: 'BURNOUT', time: 2 },
      { type: 'APOGEE', time: 6.8 },
      { type: 'EJECTION_CHARGE', time: 7.0 },
      { type: 'RECOVERY_DEVICE_DEPLOYMENT', time: 7.0 },
      { type: 'GROUND_HIT', time: 104 },
    ],
    series: {
      time,
      altitude: [0, 2, 60, 200, 331.7, 331.0, 0],
      velocity: [0, 18.4, 100, 116.2, 1, 4.2, 3.4],
      acceleration: [0, 120, 30, -9.8, -9.8, -9.8, 0],
      mass: [0.051, 0.050, 0.045, 0.040, 0.040, 0.040, 0.040],
      thrust: [0, 11, 5, 0, 0, 0, 0],
      drag: [0, 0.1, 1, 1.4, 0, 0, 0],
      mach: [0, 0.05, 0.3, 0.35, 0, 0, 0],
      stability: [1.3, 1.3, 1.5, 1.6, 1.6, 1.6, 1.6],
      cpLocation: [0.29, 0.29, 0.29, 0.29, 0.29, 0.29, 0.29],
      cgLocation: [0.26, 0.26, 0.25, 0.25, 0.25, 0.25, 0.25],
      aoa: [0, 0, 0, 0, 0, 0, 0],
    },
  };
}

const motor = {
  designation: 'C6', diameter: 0.018, length: 0.07,
  times: [0, 2], thrusts: [10, 0], masses: [0.024, 0.013],
  cgX: 0.035, ejectionDelay: 5,
};

describe('recommendDelay', () => {
  it('rounds to the nearest whole second (delays get drilled, not bought)', () => {
    // the owner's example: prescribed 0/6/8/10/14 but optimal 12.7 → drill to 13.
    expect(recommendDelay(12.7)).toBe(13);
    expect(recommendDelay(4.9)).toBe(5);
    expect(recommendDelay(4.4)).toBe(4);
  });
  it('never recommends a negative delay', () => {
    expect(recommendDelay(-0.3)).toBe(0);
  });
  it('handles missing optimum', () => {
    expect(recommendDelay(null)).toBeNull();
  });
});

describe('buildSimRun — staged branches (Release C)', () => {
  /** Adds a booster branch to the fake flight. */
  function stagedResult(boosterChute: boolean): FlightResult {
    const base = fakeResult();
    const bTime = [2, 3, 6, 25];
    const boosterEvents = [
      { type: 'STAGE_SEPARATION', time: 2, source: 'Booster' },
      ...(boosterChute
        ? [{ type: 'RECOVERY_DEVICE_DEPLOYMENT', time: 2.5, source: 'BoosterChute' }]
        : [{ type: 'TUMBLE', time: 3 }]),
      { type: 'GROUND_HIT', time: 25 },
    ];
    return {
      ...base,
      branches: [
        { name: 'Sustainer', events: base.events, series: base.series },
        {
          name: 'Booster',
          events: boosterEvents,
          series: {
            ...base.series,
            time: bTime,
            altitude: [180, 190, 120, 0],
            velocity: [80, 20, boosterChute ? 5 : 28, boosterChute ? 5 : 30],
          },
        },
      ],
    };
  }

  const stagedInput = (boosterChute: boolean, highPower: boolean) => ({
    result: stagedResult(boosterChute),
    info,
    motor,
    launch: DEFAULT_CONDITIONS,
    rocketName: 'TwoStage',
    execMs: 10,
    stageMotorInfo: { Booster: { label: highPower ? 'J420R-0' : 'C6-0', highPower } },
    boosterMotors: [highPower ? 'J420R-0' : 'C6-0'],
  });

  it('reports the booster branch with its own recovery and landing verdict', () => {
    const run = buildSimRun(stagedInput(true, false));
    expect(run.branches?.length).toBe(1);
    const b = run.branches![0]!;
    expect(b.name).toBe('Booster');
    expect(b.apogee).toBeCloseTo(190);
    expect(b.deployments[0]?.device).toBe('BoosterChute');
    expect(b.landingRate).toBeCloseTo(5);
    expect(b.safeLandingRate).toBe(true);
    expect(run.boosterMotors).toEqual(['C6-0']);
  });

  it('lets a LOW-POWER booster tumble without a warning (G80 rule)', () => {
    const run = buildSimRun(stagedInput(false, false));
    const b = run.branches![0]!;
    expect(b.tumbles).toBe(true);
    expect(b.deployments.length).toBe(0);
    expect(run.comments).not.toMatch(/HIGH-POWER booster/);
  });

  it('flags a chuteless HIGH-POWER booster loudly (G80 rule)', () => {
    const run = buildSimRun(stagedInput(false, true));
    expect(run.comments).toMatch(/Booster has NO recovery device — a HIGH-POWER booster/);
    expect(run.branches![0]!.safeLandingRate).toBe(false);
  });

  it('serializes booster columns into the CSV', () => {
    const csv = runsToCsv([buildSimRun(stagedInput(true, false))]);
    expect(csv.split('\n')[0]).toContain('Booster landing rate (m/s)');
    expect(csv).toContain('C6-0');
  });
});

describe('buildSimRun', () => {
  const run = buildSimRun({
    result: fakeResult(), info, motor,
    meta: { label: 'C6-5', manufacturer: 'Estes', availableDelays: [3, 5, 7] },
    launch: { ...DEFAULT_CONDITIONS, windAverage: 2 },
    rocketName: 'Testbird', execMs: 12,
  });

  it('extracts event-derived attributes', () => {
    expect(run.timeToBurnout).toBe(2);
    expect(run.timeToRodDeparture).toBe(0.15);
    expect(run.rodExitVelocity).toBeCloseTo(18.4);
    expect(run.altitudeAtDeployment).toBeCloseTo(331.0, 1);
    expect(run.velocityAtDeployment).toBeCloseTo(4.2);
  });

  it('computes launch-state and delay attributes', () => {
    expect(run.launchMass).toBeCloseTo(0.051);
    expect(run.launchStaticMarginCal).toBeCloseTo(1.3);
    expect(run.optimumDelayS).toBeCloseTo(4.9);
    expect(run.recommendedDelayS).toBe(5);
    expect(run.thrustToWeightAtRod).toBeCloseTo(11 / (0.050 * 9.80665), 2);
  });

  it('grades safety', () => {
    expect(run.safeLiftoffSpeed).toBe(true); // 18.4 >= 15
    expect(run.safeDeployment).toBe(true);   // 4.2 <= 15
    expect(run.staticMarginOk).toBe(true);
    expect(run.weathercockRisk).toBe('moderate'); // 2 / 18.4 ≈ 0.109
  });

  it('flags an unsafe rod exit and mentions it in comments', () => {
    const slow = fakeResult();
    slow.summary.launchRodVelocity = 8;
    const r = buildSimRun({
      result: slow, info, motor,
      meta: { label: 'C6-5' }, launch: DEFAULT_CONDITIONS,
      rocketName: 'x', execMs: 1,
    });
    expect(r.safeLiftoffSpeed).toBe(false);
    expect(r.comments).toContain(`${SAFETY.minRodExitVelocity} m/s`);
  });
});

/**
 * Dual deployment: drogue at apogee (7 s), main at 250 m (30 s). Velocity
 * profile: drogue settles at `drogueRate`, main opens at that speed, lands
 * at `landRate`.
 */
function dualDeployResult(drogueRate: number, landRate: number): FlightResult {
  const time = [0, 2, 7, 7.5, 29.8, 30.0, 30.5, 90];
  const zeros = time.map(() => 0);
  return {
    summary: {
      maxAltitude: 800, maxVelocity: 150, maxAcceleration: 200,
      maxMachNumber: 0.45, timeToApogee: 7, flightTime: 90,
      groundHitVelocity: landRate, launchRodVelocity: 20,
      deploymentVelocity: 2.0, optimumDelay: 5.0,
    },
    events: [
      { type: 'LAUNCH', time: 0 },
      { type: 'LAUNCHROD', time: 0.2 },
      { type: 'BURNOUT', time: 2 },
      { type: 'APOGEE', time: 7 },
      { type: 'RECOVERY_DEVICE_DEPLOYMENT', time: 7.0, source: 'Drogue' },
      { type: 'RECOVERY_DEVICE_DEPLOYMENT', time: 30.0, source: 'Main' },
      { type: 'GROUND_HIT', time: 90 },
      { type: 'SIMULATION_END', time: 90 },
    ],
    series: {
      time,
      altitude: [0, 300, 800, 780, 255, 250, 240, 0],
      velocity: [0, 150, 2, drogueRate, drogueRate, drogueRate, landRate + 1, landRate],
      acceleration: zeros, mass: time.map(() => 0.5), thrust: zeros, drag: zeros,
      mach: zeros, stability: time.map(() => 1.5),
      cpLocation: time.map(() => 0.9), cgLocation: time.map(() => 0.7), aoa: zeros,
    },
  };
}

describe('dual deployment attribution', () => {
  const build = (drogueRate: number, landRate: number) => buildSimRun({
    result: dualDeployResult(drogueRate, landRate), info, motor,
    meta: { label: 'J350-auto', manufacturer: 'AT' },
    launch: DEFAULT_CONDITIONS, rocketName: 'DD', execMs: 1,
  });

  describe('the Cd each device flew (2026-09-03b)', () => {
    // The descent verdict rests entirely on this number, and until v0.099 the
    // report named the device but never the figure — which cost two round trips
    // with the owner in one day, both of the form "which Cd did that run use?".
    const withCd = (landRate: number) => buildSimRun({
      result: dualDeployResult(19.5, landRate), info, motor,
      meta: { label: 'J350-auto', manufacturer: 'AT' },
      launch: DEFAULT_CONDITIONS, rocketName: 'DD', execMs: 1,
      flownRecovery: {
        Drogue: { cd: 1.44, cdNominal: 1.5, diameter: 0.6096, spillHoleDiameter: 0.12192 },
        Main: { cd: 2.2, cdNominal: 2.2, diameter: 2.1336, spillHoleDiameter: null },
      },
    });

    it('attaches the flown coefficient to the right device', () => {
      const [drogue, main] = withCd(5.5).deployments;
      expect(drogue!.cd).toBe(1.44);
      expect(drogue!.cdNominal).toBe(1.5);
      expect(drogue!.spillHoleDiameter).toBeCloseTo(0.12192, 9);
      expect(main!.cd).toBe(2.2);
      expect(main!.spillHoleDiameter).toBeNull();
    });

    it('names the coefficient in the landing-too-fast sentence itself', () => {
      // "Landing too fast" is the app's strongest claim about a design; the
      // number it rests on belongs in the sentence, not only in a table.
      const said = withCd(9.0).comments ?? ''; // 29.5 ft/s — over the 20 ft/s target
      expect(said, 'no landing comment produced').toMatch(/Landing under/);
      expect(said).toMatch(/drag coefficient of 2\.20/);
    });

    it('a run carrying no coefficients still reports cleanly (runs stored before v0.099)', () => {
      const [drogue, main] = build(19.5, 5.5).deployments;
      expect(drogue!.cd).toBeNull();
      expect(main!.cd).toBeNull();
      expect(main!.cdNominal).toBeNull();
      const said = build(19.5, 9.0).comments ?? '';
      expect(said).toMatch(/Landing under/);
      expect(said).not.toMatch(/drag coefficient/);
    });
  });

  it('reports each device with its own numbers', () => {
    const run = build(19.5, 5.5); // 64 ft/s drogue, 18 ft/s landing — all good
    expect(run.deployments).toHaveLength(2);
    const [drogue, main] = run.deployments;
    expect(drogue!.device).toBe('Drogue');
    expect(drogue!.isLanding).toBe(false);
    expect(drogue!.velocityAtDeployment).toBeCloseTo(2, 1); // opens at apogee
    expect(drogue!.descentRate).toBeCloseTo(19.5, 1);
    expect(drogue!.descentOk).toBe(true); // 64 ft/s within the 70 ft/s band
    expect(main!.device).toBe('Main');
    expect(main!.isLanding).toBe(true);
    expect(main!.velocityAtDeployment).toBeCloseTo(19.5, 1);
    expect(main!.openingOk).toBe(true); // opening under drogue speed is normal
    expect(main!.descentRate).toBeCloseTo(5.5, 1);
    expect(run.safeDeployment).toBe(true);
    expect(run.safeLandingRate).toBe(true); // 18 ft/s ≤ 20 ft/s
  });

  it('names the offending device when a threshold is broken', () => {
    const run = build(26, 8); // 85 ft/s under drogue, 26 ft/s landing
    const [drogue, main] = run.deployments;
    expect(drogue!.descentOk).toBe(false);
    expect(main!.openingOk).toBe(false); // opens at 26 m/s > 70 ft/s
    expect(main!.descentOk).toBe(false); // lands too fast
    expect(run.safeDeployment).toBe(false);
    expect(run.safeLandingRate).toBe(false);
    expect(run.comments).toMatch(/Descent under Drogue/);
    expect(run.comments).toMatch(/Main opens at/);
    expect(run.comments).toMatch(/Landing under Main/);
  });

  it('a main opening under a healthy drogue does NOT trip the hard-opening flag', () => {
    const run = build(20.5, 5.5); // 67 ft/s — inside the accepted band
    expect(run.deployments[1]!.openingOk).toBe(true);
    expect(run.safeDeployment).toBe(true);
    expect(run.comments).not.toMatch(/hard opening/);
  });
});

describe('landing drift & max roll rate (symbol-keyed series)', () => {
  /** fakeResult's series plus the lateral/roll symbol keys the engine emits. */
  function withSymbols(over: Partial<Record<string, (number | null)[]>> = {}): FlightSeries {
    const s = fakeResult().series;
    // Rocket drifts east: lands 25 m out on compass bearing 90° (π/2).
    s['Pl'] = [0, 0.1, 2, 8, 20, 24, 25];
    s['θl'] = [null, 1.5707963, 1.5707963, 1.5707963, 1.5707963, 1.5707963, 1.5707963];
    s['Px'] = [0, 0.1, 2, 8, 20, 24, 25];
    s['Py'] = [0, 0, 0, 0, 0, 0, 0];
    s['dΦ'] = [0, 0.1, -0.5, 0.3, null, 0.2, 0];
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) delete s[k]; else s[k] = v;
    }
    return s;
  }

  it('distance = last finite Pl sample; bearing from θl (the kernel compass bearing)', () => {
    // θl is atan2(x, y) with 0 = north (SimulationStatus.storeData) — already
    // a compass bearing, so it converts to degrees directly.
    const d = extractLandingDrift(withSymbols({ 'Pl': [0, 5, 25, null, null, null, null] }));
    expect(d.distanceM).toBe(25); // trailing nulls (NaN on the wire) skipped
    expect(d.bearingDeg).toBeCloseTo(90, 3);
  });

  it('falls back to atan2(Px, Py) when θl is absent', () => {
    const d = extractLandingDrift(withSymbols({ 'θl': undefined }));
    expect(d.bearingDeg).toBeCloseTo(90, 3); // due east: x=25, y=0
    const north = extractLandingDrift(withSymbols({
      'θl': undefined, 'Px': [0, 0, 0, 0, 0, 0, 0], 'Py': [0, 1, 2, 3, 4, 5, 6],
    }));
    expect(north.bearingDeg).toBeCloseTo(0, 3);
  });

  it('old engine artifact (no symbol keys) → nulls, never a crash', () => {
    const d = extractLandingDrift(fakeResult().series);
    expect(d.distanceM).toBeNull();
    expect(d.bearingDeg).toBeNull();
    expect(extractMaxRollRate(fakeResult().series)).toBeNull();
  });

  it('max roll rate is the peak |dΦ|, nulls ignored', () => {
    expect(extractMaxRollRate(withSymbols())).toBeCloseTo(0.5);
    expect(extractMaxRollRate(withSymbols({ 'dΦ': [null, null] }))).toBeNull();
  });

  it('the noise floor separates integrator jitter from real roll', () => {
    // 0.01 rad/s ≈ 0.57 °/s: non-rolling sims report ~1e-10…1e-3 rad/s of
    // numerical drift; the slowest deliberate roll is orders of magnitude up.
    expect(ROLL_RATE_MEANINGFUL_RAD_S).toBeCloseTo(0.01);
    expect(1e-4).toBeLessThan(ROLL_RATE_MEANINGFUL_RAD_S);   // jitter → row hidden
    expect(0.5).toBeGreaterThan(ROLL_RATE_MEANINGFUL_RAD_S); // real roll → shown
  });

  it('buildSimRun carries drift/roll fields and the raw sim warnings', () => {
    const result = fakeResult();
    result.series = withSymbols();
    result.warnings = [
      { key: 'NO_RECOVERY_DEVICE', message: '[Warning.NO_RECOVERY_DEVICE]', priority: 'HIGH' },
    ];
    const run = buildSimRun({
      result, info, motor, meta: { label: 'C6-5' },
      launch: DEFAULT_CONDITIONS, rocketName: 'x', execMs: 1,
    });
    expect(run.landingDistanceM).toBe(25);
    expect(run.landingBearingDeg).toBeCloseTo(90, 3);
    expect(run.maxRollRateRadS).toBeCloseTo(0.5);
    expect(run.simWarnings).toEqual(result.warnings);
  });

  it('pre-warning engine artifact: simWarnings stays ABSENT (unknown ≠ flew clean)', () => {
    const run = buildSimRun({
      result: fakeResult(), info, motor, meta: { label: 'C6-5' },
      launch: DEFAULT_CONDITIONS, rocketName: 'x', execMs: 1,
    });
    expect('simWarnings' in run).toBe(false);
    expect(run.landingDistanceM).toBeNull();
    expect(run.landingBearingDeg).toBeNull();
    expect(run.maxRollRateRadS).toBeNull();
  });
});

describe('runsToCsv', () => {
  it('produces one header + one row with quoting', () => {
    const run = buildSimRun({
      result: fakeResult(), info, motor,
      meta: { label: 'C6-5', manufacturer: 'Estes' },
      launch: DEFAULT_CONDITIONS, rocketName: 'Bird, the "Big" one', execMs: 3,
    });
    const csv = runsToCsv([run]);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Max altitude (m)');
    expect(lines[0]).toContain('Optimal delay (s)');
    expect(lines[1]).toContain('"Bird, the ""Big"" one"');
    // Cell-count parity — split only on commas outside quoted cells.
    const cells = (s: string) => s.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).length;
    expect(cells(lines[1]!)).toBe(cells(lines[0]!));
  });

  it('serializes sim warnings, landing drift and roll rate — blank on old runs', () => {
    const result = fakeResult();
    result.series['Pl'] = result.series.time.map((_, i) => i * 10);
    result.series['θl'] = result.series.time.map(() => Math.PI / 2);
    result.series['dΦ'] = result.series.time.map(() => Math.PI); // 0.5 r/s
    result.warnings = [
      { key: 'NO_RECOVERY_DEVICE', message: '[Warning.NO_RECOVERY_DEVICE]', priority: 'HIGH' },
      { key: 'LargeAOA', message: '[Warning.LargeAOA.str1]', priority: 'NORMAL' },
    ];
    const run = buildSimRun({
      result, info, motor, meta: { label: 'C6-5' },
      launch: DEFAULT_CONDITIONS, rocketName: 'x', execMs: 1,
    });
    const [header, row] = runsToCsv([run]).split('\n');
    const cells = (s: string) => s.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const hc = cells(header!);
    const rc = cells(row!);
    expect(rc[hc.indexOf('Sim warnings')]).toBe('NO_RECOVERY_DEVICE; LargeAOA');
    expect(rc[hc.indexOf('Landing distance (m)')]).toBe('60'); // last Pl sample
    expect(rc[hc.indexOf('Landing bearing (deg from N)')]).toBe('90');
    expect(rc[hc.indexOf('Max roll rate (r/s)')]).toBe('0.5'); // π rad/s = ½ rev/s

    // A run stored before these fields existed: cells empty, no crash.
    const old = buildSimRun({
      result: fakeResult(), info, motor, meta: { label: 'C6-5' },
      launch: DEFAULT_CONDITIONS, rocketName: 'x', execMs: 1,
    });
    delete old.simWarnings;
    delete (old as Partial<typeof old>).landingDistanceM;
    delete (old as Partial<typeof old>).maxRollRateRadS;
    const [h2, r2] = runsToCsv([old]).split('\n');
    expect(r2!.length).toBeGreaterThan(0);
    expect(cells(r2!).length).toBe(cells(h2!).length);
    expect(cells(r2!)[cells(h2!).indexOf('Sim warnings')]).toBe('');
  });

  it('ends with the "Flight config" column (Stage B) — blank on runs without one', () => {
    const cells = (s: string) => s.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const run = buildSimRun({
      result: fakeResult(), info, motor, meta: { label: 'C6-5' },
      launch: DEFAULT_CONDITIONS, rocketName: 'x', execMs: 1,
      flightConfig: 'Club field C6',
    });
    const [header, row] = runsToCsv([run]).split('\n');
    const hc = cells(header!);
    // Trailing on purpose: existing spreadsheet imports keep their columns.
    expect(hc[hc.length - 1]).toBe('Flight config');
    expect(cells(row!)[hc.indexOf('Flight config')]).toBe('Club field C6');
    // A run stored before the field existed exports an empty trailing cell.
    const old = buildSimRun({
      result: fakeResult(), info, motor, meta: { label: 'C6-5' },
      launch: DEFAULT_CONDITIONS, rocketName: 'x', execMs: 1,
    });
    expect('flightConfig' in old).toBe(false);
    const [h2, r2] = runsToCsv([old]).split('\n');
    expect(cells(r2!)[cells(h2!).indexOf('Flight config')]).toBe('');
  });
});

describe('the launch stability rows are labelled with the instant they belong to', () => {
  it('names the launch guide exit, not "launch", in the CSV header', () => {
    const run = buildSimRun({
      result: fakeResult(), info, motor, meta: { label: 'C6-5' },
      launch: DEFAULT_CONDITIONS, rocketName: 'Fixture', execMs: 1,
    });
    const header = runsToCsv([run]);
    expect(header).toContain('CG at launch guide exit');
    expect(header).toContain('CP at launch guide exit');
    expect(header).toContain('Static margin at launch guide exit');
    expect(header).toContain('Angle of attack at launch guide exit');
    // The whole group speaks with one voice — these two predate the rename.
    expect(header).toContain('Time to launch guide exit');
    expect(header).toContain('Velocity at launch guide exit');
    // "Launch mass" IS a t=0 quantity and keeps its name.
    expect(header).toContain('Launch mass');
  });
});

describe('the launch stability rows all come from one instant', () => {
  /**
   * The kernel refuses to record CP or stability until the rod is cleared
   * (AbstractSimulationStepper: `if (status.isLaunchRodCleared() && null != forces)`),
   * so cpLocation/stability carry a null prefix that cgLocation does not. Reading
   * each with its own "first finite" scan pairs sample 0's CG with sample 1's CP,
   * and the panel then contradicts its own arithmetic.
   */
  function rodClearedAtSampleOne(): FlightResult {
    const r = fakeResult();
    r.series.cgLocation = [0.26, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25];
    r.series.cpLocation = [null as unknown as number, 0.29, 0.29, 0.29, 0.29, 0.29, 0.29];
    // The margin AT the rod-clear sample, exactly as the kernel would record it.
    const cal = (0.29 - 0.25) / info.refDiameter;
    r.series.stability = [null as unknown as number, cal, cal, cal, cal, cal, cal];
    return r;
  }

  const build = (result: FlightResult) => buildSimRun({
    result, info, motor, meta: { label: 'C6-5' },
    launch: DEFAULT_CONDITIONS, rocketName: 'Fixture', execMs: 1,
  });

  it('the two rows shown reproduce the margin row', () => {
    const run = build(rodClearedAtSampleOne());
    const fromTheRowsOnScreen = (run.launchCP! - run.launchCG!) / info.refDiameter;
    expect(fromTheRowsOnScreen).toBeCloseTo(run.launchStaticMarginCal!, 6);
  });

  it('takes the CG from the sample the CP came from, not from t=0', () => {
    const run = build(rodClearedAtSampleOne());
    expect(run.launchCG).toBeCloseTo(0.25, 12);
  });

  it('reports the angle of attack at that same instant, which is why CP moved', () => {
    const r = rodClearedAtSampleOne();
    // 2.858 deg of crosswind AoA is what puts the flight CP forward of the
    // Design tab's zero-wind CP. Without the number on the panel the two
    // readings look like a contradiction — a tester reported exactly that.
    const aoa = (2.858 * Math.PI) / 180;
    r.series.aoa = [0, aoa, aoa, 0, 0, 0, 0];
    expect(build(r).rodExitAoa).toBeCloseTo(aoa, 12);
  });

  it('still falls back to the static analysis when the whole series is null', () => {
    const r = fakeResult();
    const nulls = r.series.time.map(() => null as unknown as number);
    r.series.cgLocation = nulls; r.series.cpLocation = nulls; r.series.stability = nulls;
    const run = build(r);
    expect(run.launchCG).toBe(info.cg);
    expect(run.launchCP).toBe(info.cp);
    expect(run.launchStaticMarginCal).toBe(info.stabilityCalibers);
  });
});

/**
 * Stability as a percentage (beta thread, KillerCheerio: "a way to view
 * %stability would be nice, it's better than calibers in my opinion").
 */
describe('stability margin display', () => {
  const at = (over: Partial<StaticInfo>): StaticInfo => ({ ...info, ...over });

  it('divides by the AERODYNAMIC length, like desktop OpenRocket', () => {
    // margin 0.10 m over a 1.00 m aerodynamic span = 10 %, even though the
    // all-components length is 1.25 m (a mass sled hanging past the airframe).
    const i = at({ cg: 0.5, cp: 0.6, length: 1.25, lengthAerodynamic: 1.0 });
    expect(stabilityPercent(i)).toBeCloseTo(10, 9);
  });

  it('falls back to total length when the aerodynamic span is missing', () => {
    const i = at({ cg: 0.5, cp: 0.6, length: 1.0, lengthAerodynamic: 0 });
    expect(stabilityPercent(i)).toBeCloseTo(10, 9);
  });

  it('formats each unit choice, and defaults to calibers', () => {
    const i = at({ cg: 0.5, cp: 0.6, length: 1.0, lengthAerodynamic: 1.0, stabilityCalibers: 1.85 });
    expect(formatStability(i)).toBe('1.85 cal');
    expect(formatStability(i, 'cal')).toBe('1.85 cal');
    expect(formatStability(i, 'pct')).toBe('10.0%');
    expect(formatStability(i, 'both')).toBe('1.85 cal · 10.0%');
  });

  it('reports a negative margin rather than hiding it', () => {
    const i = at({ cg: 0.7, cp: 0.6, length: 1.0, lengthAerodynamic: 1.0, stabilityCalibers: -1.2 });
    expect(stabilityPercent(i)).toBeCloseTo(-10, 9);
    expect(formatStability(i, 'pct')).toBe('-10.0%');
  });
});

/**
 * The kernel does not raise a warning when it gives up on a flight — it stops,
 * and returns a normal-looking (but truncated) result. simReport turns that
 * into the HIGH warning the report, the notices and the CSV all read.
 */
describe('SIM_ABORT surfacing', () => {
  const abortedAt = (time: number, cause: string, events = fakeResult().events) =>
    [...events, { type: 'SIM_ABORT', time, cause }];

  it('is silent on a flight that finished', () => {
    const run = buildSimRun({
      result: { ...fakeResult(), warnings: [] }, info, motor, meta: { label: 'C6-5' },
      launch: DEFAULT_CONDITIONS, rocketName: 'R', execMs: 1,
    });
    expect(run.simWarnings?.some((w) => w.key === 'SIM_ABORT')).toBe(false);
  });

  it('raises a HIGH warning naming the reason, in the app’s own words', () => {
    const result = { ...fakeResult(), warnings: [], events: abortedAt(1.14, 'TUMBLE_UNDER_THRUST') };
    const run = buildSimRun({
      result, info, motor, meta: { label: 'C6-5' },
      launch: DEFAULT_CONDITIONS, rocketName: 'R', execMs: 1,
    });
    const w = run.simWarnings!.find((x) => x.key === 'SIM_ABORT')!;
    expect(w.priority).toBe('HIGH');
    expect(w.message).toMatch(/stopped at T\+1\.14 s/);
    expect(w.message).toMatch(/tumble while the motor was still burning/);
    // NOT the kernel's own string: this build ships no resource bundle, so
    // Cause.toString() there is a bracketed l10n key.
    expect(w.message).not.toMatch(/\[SimulationAbort/);
    expect(runsToCsv([run])).toContain('SIM_ABORT');
  });

  // A separated booster flies its own branch and can be aborted alone, leaving
  // the sustainer's numbers good and the booster's truncated apogee rendered
  // beside them as if it were a real flight.
  it('catches an abort on a BOOSTER branch, and says which stage', () => {
    const base = fakeResult();
    const result: FlightResult = {
      ...base,
      warnings: [],
      branches: [
        { name: 'Sustainer', events: base.events, series: base.series },
        { name: 'Booster', events: abortedAt(0.6, 'ACTIVE_MASS_ZERO', []), series: base.series },
      ],
    };
    const run = buildSimRun({
      result, info, motor, meta: { label: 'C6-5' },
      launch: DEFAULT_CONDITIONS, rocketName: 'R', execMs: 1,
    });
    const w = run.simWarnings!.find((x) => x.key === 'SIM_ABORT')!;
    expect(w, 'a booster-only abort must still surface').toBeTruthy();
    expect(w.message).toMatch(/Booster stage/);
    expect(w.message).toMatch(/T\+0\.60 s/);
  });

  it('reports both branches when the whole flight and a booster each abort', () => {
    const base = fakeResult();
    const result: FlightResult = {
      ...base,
      warnings: [],
      events: abortedAt(2.0, 'NO_LIFTOFF'),
      branches: [
        { name: 'Sustainer', events: base.events, series: base.series },
        { name: 'Booster', events: abortedAt(0.6, 'ACTIVE_MASS_ZERO', []), series: base.series },
      ],
    };
    const run = buildSimRun({
      result, info, motor, meta: { label: 'C6-5' },
      launch: DEFAULT_CONDITIONS, rocketName: 'R', execMs: 1,
    });
    expect(run.simWarnings!.filter((x) => x.key === 'SIM_ABORT')).toHaveLength(2);
  });
});

/**
 * The time-step caution's cost reference from STORED runs — what keeps the
 * seconds estimate alive across a reload, and what stops one rocket's
 * measured flight time from pricing another's.
 */
describe('storedSimCost', () => {
  const stored = (rocket: string, execMs: number, timeStepS?: number) => buildSimRun({
    result: fakeResult(), info, motor, meta: { label: 'C6-5' },
    launch: { ...DEFAULT_CONDITIONS, ...(timeStepS !== undefined ? { timeStepS } : {}) },
    rocketName: rocket, execMs,
  });

  it('reads the newest run of THIS design, with the step it was measured at', () => {
    // Newest first, the order simStore keeps. timeStepS must ride along:
    // without it the caution scales a 0.01 s measurement as if it were made
    // at the default and quotes ~4-5x the real cost.
    const runs = [stored('Alpha', 2100, 0.01), stored('Alpha', 8000, 0.01)];
    expect(storedSimCost(runs, 'Alpha')).toEqual({ ms: 2100, timeStepS: 0.01 });
  });

  it("never prices one rocket's flight with another's", () => {
    // The reported shape: fly Mach2.trf.ork (~12 s), open a small sport
    // model, and the caution quoted "roughly 64 s per flight" for a rocket
    // that flies in two.
    expect(storedSimCost([stored('Mach2', 12000, 0.01)], 'Sport Model')).toBeNull();
    expect(storedSimCost([], 'Sport Model')).toBeNull();
  });

  it('leaves timeStepS absent for a run flown at the engine default', () => {
    const cost = storedSimCost([stored('Alpha', 900)], 'Alpha')!;
    expect(cost.ms).toBe(900);
    expect('timeStepS' in cost).toBe(false);
  });

  it('skips an unusable measurement and keeps looking', () => {
    const zero = stored('Alpha', 0);
    expect(storedSimCost([zero], 'Alpha')).toBeNull();
    expect(storedSimCost([zero, stored('Alpha', 1500)], 'Alpha')).toEqual({ ms: 1500 });
  });
});

/**
 * The pre-screen behind the "Show charts" button. A stored run carries ~50
 * scalars and a rocket NAME — no design tree — so this can never prove that
 * the design on screen is the one that flew. What it must do is refuse
 * confidently: drawing a re-flight of a DIFFERENT design under a stored run's
 * numbers would be an authoritative-looking wrong answer, which is exactly
 * the failure the app's own standing rules exist to avoid.
 */
describe('runMatchesDesign — what may be re-flown for its charts', () => {
  /**
   * A stored run carries ~50 scalars and a rocket NAME, so identity has to
   * come from the provenance keys stamped at launch. What this guard must do
   * is refuse confidently: re-flying draws a flight under a stored run's
   * numbers, and drawing a DIFFERENT flight there would be exactly the
   * authoritative-looking wrong answer the app's standing rules exist to
   * avoid.
   */
  const KEY = {
    designKey: 'd1',
    motorSetKey: 'm1',
    conditionsKey: 'c1',
    aeroMode: 'classic' as const,
    effectiveKbf: true,
    autoSupersonic: false,
  };
  const run = (over: Record<string, unknown> = {}): SimRun => ({
    ...buildSimRun({
      result: fakeResult(), info, motor, meta: { label: 'C6-5' },
      launch: DEFAULT_CONDITIONS, rocketName: 'Alpha', execMs: 100,
      aeroModel: 'classic', rogersKbf: true,
      designKey: 'd1', motorSetKey: 'm1',
    }),
    conditionsKey: 'c1',
    ...over,
  } as SimRun);

  it('matches the design, motors and conditions that produced it', () => {
    expect(runMatchesDesign(run(), KEY)).toBe(true);
  });

  it('refuses a changed design, a changed motor set, or changed conditions', () => {
    expect(runMatchesDesign(run({ designKey: 'd2' }), KEY)).toBe(false);
    expect(runMatchesDesign(run({ motorSetKey: 'm2' }), KEY)).toBe(false);
    expect(runMatchesDesign(run({ conditionsKey: 'c2' }), KEY)).toBe(false);
  });

  it('CONDITIONS are in the guard — this is what the old launch-mass check missed', () => {
    // The previous version compared wind average and time step only, so a run
    // flown at a different rod angle, rod length, altitude, temperature,
    // pressure or latitude passed — and "Show charts" re-flew at TODAY's
    // conditions and drew a genuinely different flight under its numbers.
    expect(runMatchesDesign(run(), { ...KEY, conditionsKey: 'launchRodAngleDeg=7' })).toBe(false);
  });

  it('refuses a run stored before the keys existed — unverifiable is not matched', () => {
    expect(runMatchesDesign(run({ designKey: undefined }), KEY)).toBe(false);
    expect(runMatchesDesign(run({ motorSetKey: undefined }), KEY)).toBe(false);
    expect(runMatchesDesign(run({ conditionsKey: undefined }), KEY)).toBe(false);
  });

  it('refuses a run flown on a different aero model, in both directions', () => {
    expect(runMatchesDesign(run({ aeroModel: 'supersonic', rogersKbf: false }), KEY)).toBe(false);
    expect(runMatchesDesign(run(), { ...KEY, aeroMode: 'supersonic' })).toBe(false);
    // Kbf is a real difference on the classic model — it moves CP.
    expect(runMatchesDesign(run({ rogersKbf: false }), KEY)).toBe(false);
  });

  it('refuses an UNKNOWN model, unlike the on-screen mark', () => {
    // runMatchesModel returns null for a run predating the field. The banner
    // treats that as "do not accuse"; re-flying treats it as "do not claim".
    expect(runMatchesDesign(run({ aeroModel: undefined }), KEY)).toBe(false);
    expect(runMatchesDesign(run({ rogersKbf: undefined }), KEY)).toBe(false);
  });

  it('an Auto session that has upgraded itself no longer matches a classic run', () => {
    const auto = { ...KEY, aeroMode: 'auto' as const };
    expect(runMatchesDesign(run({ aeroModel: 'classic', rogersKbf: true }), auto)).toBe(true);
    expect(runMatchesDesign(run({ aeroModel: 'classic', rogersKbf: true }),
      { ...auto, autoSupersonic: true })).toBe(false);
    expect(runMatchesDesign(run({ aeroModel: 'auto-supersonic', rogersKbf: false }),
      { ...auto, autoSupersonic: true })).toBe(true);
  });
});

