import { describe, expect, it } from 'vitest';
import type { FlightResult, FlightSeries, StaticInfo } from '@online-openrocket/engine';
import {
  buildSimRun, extractLandingDrift, extractMaxRollRate, recommendDelay,
  ROLL_RATE_MEANINGFUL_RAD_S, SAFETY,
} from './simReport.js';
import { runsToCsv } from './simStore.js';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';

const info: StaticInfo = {
  length: 0.37, mass: 0.051, massEmpty: 0.027, cgEmpty: 0.19, cg: 0.26,
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
