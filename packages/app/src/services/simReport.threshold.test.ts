import { describe, expect, it, vi } from 'vitest';
import type { FlightResult, StaticInfo } from '@online-openrocket/engine';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';
import { buildSimRun } from './simReport.js';
import { INITIAL_UNITS, IMPERIAL_UNITS } from '../prefs/units.js';

// A changed policy must reach both the condition and the report wording.
vi.mock('./machProbe.js', async (original) => ({
  ...await original<typeof import('./machProbe.js')>(), MACH_AUTO_THRESHOLD: 0.7,
}));

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

describe('U: report notification units', () => {
  it.each([14.85, 14.9, 14.95])('R12 names rod guidance once when %s m/s rounds to the same primary feet', velocity => {
    const result = fakeResult();
    result.summary.launchRodVelocity = velocity;
    result.series.velocity[1] = velocity;
    const run = buildSimRun({ result, info, motor, units: IMPERIAL_UNITS,
      launch: DEFAULT_CONDITIONS, rocketName: 'Units', execMs: 0 });
    expect(run.comments).toContain('Rod-exit speed just below 49 ft/s (15 m/s) guidance.');
    expect(run.comments).not.toContain('49 ft/s (14.9 m/s) <');
  });
  it('R12 names the landing target once when the primary display coincides', () => {
    const result = fakeResult();
    result.summary.groundHitVelocity = 6.15;
    result.series.velocity[result.series.velocity.length - 1] = 6.15;
    result.series.Vz = [0, 18.4, 100, 116.2, 0, -4.2, -6.15];
    result.series.altitude[result.series.altitude.length - 2] = 1000;
    const run = buildSimRun({ result, info, motor, units: IMPERIAL_UNITS,
      launch: DEFAULT_CONDITIONS, rocketName: 'Units', execMs: 0 });
    expect(run.comments).toContain('just above the 20 ft/s (6.1 m/s) landing target');
    expect(run.comments).not.toContain('20 ft/s (6.2 m/s) of descent');
  });
  it('retains the defining rod guidance near the limit with km/h selected', () => {
    const result = fakeResult();
    result.summary.launchRodVelocity = 14.99999;
    result.series.velocity[1] = 14.99999;
    const run = buildSimRun({ result, info, motor, meta: { label: 'C6' }, units: { ...INITIAL_UNITS, velocity: 'km/h' },
      launch: DEFAULT_CONDITIONS, rocketName: 'Units', execMs: 0 });
    expect(run.comments).toContain('Rod-exit speed just below 54 km/h (49 ft/s) (defined as 15 m/s) guidance.');
  });
  it('keeps the defining landing target when velocity is displayed in mph', () => {
    const result = fakeResult();
    result.series.altitude[result.series.altitude.length - 2] = 1000;
    const run = buildSimRun({ result, info, motor, meta: { label: 'C6' }, units: { ...IMPERIAL_UNITS, velocity: 'mph' },
      launch: DEFAULT_CONDITIONS, rocketName: 'Units', execMs: 0 });
    expect(run.comments).toContain('13.65 mph (6.1 m/s) (defined as 20 ft/s) landing target');
  });
  it.each([INITIAL_UNITS, IMPERIAL_UNITS])('does not display a near-limit rod exit as equal to guidance (%j)', units => {
    const result = fakeResult();
    result.summary.launchRodVelocity = 14.99999;
    result.series.velocity[1] = 14.99999;
    const run = buildSimRun({ result, info, motor, meta: { label: 'C6' }, units,
      launch: DEFAULT_CONDITIONS, rocketName: 'Units', execMs: 0 });
    expect(run.comments).toContain(units.velocity === 'm/s'
      ? 'Rod-exit speed just below 15 m/s (49 ft/s) guidance.'
      : 'Rod-exit speed just below 49 ft/s (15 m/s) guidance.');
  });
  it.each([
    [INITIAL_UNITS, '10.6 m/s (35 ft/s)', '15 m/s (49 ft/s)', '6.1 m/s (20 ft/s)'],
    [IMPERIAL_UNITS, '35 ft/s (10.6 m/s)', '49 ft/s (15 m/s)', '20 ft/s (6.1 m/s)'],
  ] as const)('uses both systems with the selected unit first (%j)', (units, speed, guidance, landing) => {
    const result = fakeResult();
    result.summary.launchRodVelocity = 10.6;
    result.series.velocity[1] = 10.6;
    result.series.altitude[result.series.altitude.length - 2] = 1000;
    const run = buildSimRun({ result, info, motor, meta: { label: 'C6' }, units,
      launch: DEFAULT_CONDITIONS, rocketName: 'Units', execMs: 0 });
    expect(run.comments).toContain(`Rod-exit speed ${speed} < ${guidance} guidance.`);
    expect(run.comments).toContain(`${landing} landing target`);
  });
});

describe('S7a-7: reports use the shared Mach threshold', () => {
  it.each([[0.7, false], [0.8, true]])('at Mach %s warns=%s', (maxMachNumber, warns) => {
    const result = fakeResult();
    result.summary.maxMachNumber = maxMachNumber;
    const run = buildSimRun({ result, info, motor, meta: { label: 'C6' },
      launch: DEFAULT_CONDITIONS, rocketName: 'Threshold', execMs: 0, aeroModel: 'classic' });
    expect(run.comments?.includes('approximate past ~Mach 0.7')).toBe(warns);
  });
});
