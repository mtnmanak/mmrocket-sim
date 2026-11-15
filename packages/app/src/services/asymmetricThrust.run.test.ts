// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import type { FlightResult, StaticInfo } from '@online-openrocket/engine';
import { balanceMotor, balanceTree } from './asymmetricThrust.testSupport.js';
import { buildSimRun } from './simReport.js';
import { addRun, loadRuns, runsToCsv } from './simStore.js';
import { formatWarning } from './simWarnings.js';
import { explanationFor } from './noteExplanations.js';
import { designPrintHtml } from './designPrintReport.js';
import { gradeBatchRun, type Criteria } from './batchCriteria.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { INITIAL_UNITS } from '../prefs/units.js';

afterEach(() => localStorage.clear());
const info: StaticInfo = { length: 1, lengthAerodynamic: 1, mass: 1, massEmpty: 0.8, cgEmpty: 0.5, cg: 0.5,
  rotationalInertia: 0.01, longitudinalInertia: 0.1, rotationalInertiaEmpty: 0.01, longitudinalInertiaEmpty: 0.1,
  cp: 0.7, cna: 8, stabilityCalibers: 1, refDiameter: 0.3, warnings: 0, warningTexts: [] };
const result: FlightResult = {
  summary: { maxAltitude: 100, maxVelocity: 30, maxAcceleration: 20, maxMachNumber: 0.1, timeToApogee: 5,
    flightTime: 20, groundHitVelocity: 5, launchRodVelocity: 20, deploymentVelocity: 4, optimumDelay: 3 },
  events: [{ type: 'IGNITION', motorMountId: 'm0', time: 0 },
    { type: 'LAUNCH', time: 0 }, { type: 'LAUNCHROD', time: 0.1 }, { type: 'BURNOUT', time: 2 },
    { type: 'APOGEE', time: 5 }, { type: 'GROUND_HIT', time: 20 }],
  series: { time: [0, 0.1, 2, 5, 20], altitude: [0, 1, 50, 100, 0], velocity: [0, 20, 30, 0, 5],
    acceleration: [20, 20, -10, -10, 0], mass: [1, 1, 0.8, 0.8, 0.8], thrust: [0, 100, 0, 0, 0],
    drag: [0, 1, 1, 0, 1], mach: [0, 0.1, 0.1, 0, 0], stability: [1, 1, 1, 1, 1],
    cpLocation: [0.7, 0.7, 0.7, 0.7, 0.7], cgLocation: [0.5, 0.5, 0.5, 0.5, 0.5], aoa: [0, 0, 0, 0, 0] },
};
const criteria: Criteria = { minRodExit: null, minThrustToWeight: null, minApogee: null, maxApogee: null,
  autoDelay: false, includeOOP: false, manufacturers: [], classes: [] };

it('row 127 attaches the flown warning, stores it, renders its tier, exports its key and prints its consequence', () => {
  const tree = balanceTree(2), motor = balanceMotor();
  const input = { result, info, motor: motor.spec, launch: DEFAULT_CONDITIONS, rocketName: 'Test', execMs: 1,
    advisoryTree: tree, advisoryMotors: [['m0', motor]] as const };
  const baseline = buildSimRun({ ...input, advisoryMotors: [] });
  const run = buildSimRun(input);
  expect(run.simWarnings?.map(w => w.key)).toContain('ASYMMETRIC_THRUST_DANGER');
  expect(gradeBatchRun(run, criteria)).toEqual(gradeBatchRun(baseline, criteria));
  expect(gradeBatchRun(run, criteria)).toEqual([]);
  expect(run.maxAltitude).toBe(baseline.maxAltitude);
  addRun(run);
  // Editing today's assignments cannot rewrite the run's frozen warning.
  motor.ignition.event = 'never';
  const stored = loadRuns()[0]!;
  const warning = stored.simWarnings!.find(w => w.key === 'ASYMMETRIC_THRUST_DANGER')!;
  expect(formatWarning(warning)).toMatchObject({ tier: 'danger', label: 'Unbalanced thrust',
    detail: expect.stringContaining('cartwheel') });
  expect(runsToCsv([stored])).toContain('ASYMMETRIC_THRUST_DANGER');
  expect(explanationFor(warning.key).remedy).toContain('20 %');
  const html = designPrintHtml({ tree, info, units: INITIAL_UNITS, radiusMode: 'diameter',
    withMotors: true, appVersion: 'test', run: stored, changedSince: null });
  expect(html).toContain('Danger: Unbalanced thrust');
  expect(html).toContain('simulation does not show this turn');
});

it('row 127 excludes build-refused motors from the warning', () => {
  const motor = balanceMotor();
  const run = buildSimRun({ result, info, motor: motor.spec, launch: DEFAULT_CONDITIONS, rocketName: 'Test', execMs: 1,
    advisoryTree: balanceTree(2), advisoryMotors: [['m0', motor]], refusedMountIds: ['m0'] });
  expect(run.simWarnings?.filter(w => w.key.startsWith('ASYMMETRIC_THRUST_')) ?? []).toEqual([]);
});

it('round 2 buildSimRun uses the recorded airstart time in its stored warning', () => {
  const air = { ...balanceMotor(), ignition: { event: 'burnout' as const, delay: 0 } };
  const run = buildSimRun({ result: { ...result, events: [
    ...result.events.filter(e => e.type !== 'IGNITION'), { type: 'IGNITION', motorMountId: 'm0', time: 3 },
  ] }, info, motor: air.spec, launch: DEFAULT_CONDITIONS, rocketName: 'Test', execMs: 1,
  advisoryTree: balanceTree(2), advisoryMotors: [['m0', air]] });
  addRun(run);
  const warning = loadRuns()[0]!.simWarnings!.find(w => w.key === 'ASYMMETRIC_THRUST_DANGER');
  expect(warning?.message).toContain('3.1 s after launch');
  expect(warning?.message).not.toContain('cannot tell');
});
