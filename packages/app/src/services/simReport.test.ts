import { describe, expect, it } from 'vitest';
import type { FlightResult, StaticInfo } from '@online-openrocket/engine';
import { buildSimRun, recommendDelay, SAFETY } from './simReport.js';
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
  it('snaps to the nearest available delay', () => {
    expect(recommendDelay(4.9, [3, 5, 7])).toBe(5);
    expect(recommendDelay(3.8, [3, 5, 7])).toBe(3);
    expect(recommendDelay(8.2, [3, 5, 7])).toBe(7);
  });
  it('rounds to whole seconds when no list is available', () => {
    expect(recommendDelay(4.9)).toBe(5);
    expect(recommendDelay(4.4, [])).toBe(4);
  });
  it('handles missing optimum', () => {
    expect(recommendDelay(null, [3, 5])).toBeNull();
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
});
