// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OrkRocket, resetEngine, type FlightResult, type MotorSpec, type RocketTree } from '@online-openrocket/engine';
import { DEFAULT_CONDITIONS, kernelSimOptions } from '../components/LaunchPanel.js';
import { IMPERIAL_UNITS, METRIC_UNITS } from '../prefs/units.js';
import { exportOrk, importOrk } from './orkFile.js';
import { importedSummaryRuns, planSummaryImport, summaryDocument, summaryOf } from './orkFlightData.js';
import { flushSession, loadSession, saveSessionDebounced } from './session.js';
import { buildSimRun, type SimRun } from './simReport.js';
import { addRun, appendImportedRuns, loadRuns } from './simStore.js';
import { formatWarning } from './simWarnings.js';

const CHUTE_NAME = 'Main <&> "early"';
// The existing C6 reference curve, with immediate ejection after burnout.
const MOTOR: MotorSpec = {
  designation: 'C6', diameter: 0.018, length: 0.07,
  times: [0, 0.1, 0.3, 0.5, 1, 1.5, 1.85, 2],
  thrusts: [0, 12, 6, 5.1, 4.9, 4.8, 4.5, 0],
  masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132],
  cgX: 0.035, ejectionDelay: 0,
};

const design = (crossSection: string): RocketTree => ({
  name: 'Warning quantities flight', components: [
    { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002,
      shape: 'ogive', overrideMass: 0.04 },
    { type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950,
      children: [
        { type: 'freeformfinset', finCount: 3, thickness: 0.003, crossSection,
          position: { method: 'bottom', offset: 0 },
          points: [[0, 0], [0.02, 0.05], [0.07, 0.05], [0.09, 0]] },
        { type: 'innertube', id: 'mount', length: 0.07, outerRadius: 0.0095,
          thickness: 0.0005, motorMount: true },
        { type: 'parachute', id: 'chute-1', name: CHUTE_NAME,
          diameter: 0.3, deployEvent: 'ejection' },
      ] },
  ],
});

afterEach(() => { flushSession(); localStorage.clear(); });

it('retains both real identical EventAfterLanding warnings on first import and repeat import', () => {
  const tree = design('rounded');
  tree.components[0]!.overrideMass = 0.5;
  const children = tree.components[1]!.children!;
  children.splice(2, 1, { ...children[1]!, id: 'mount-2' });
  const launch = { ...DEFAULT_CONDITIONS, launchRodLengthM: 1, timeStepS: 0.05,
    windAverage: 0, windStdDev: 0 };
  resetEngine();
  let run: SimRun;
  let result: FlightResult;
  try {
    const rocket = OrkRocket.buildTree(tree);
    const motor = { ...MOTOR, ejectionDelay: 7 };
    rocket.setMotorById('mount', motor);
    rocket.setMotorById('mount-2', motor);
    result = rocket.simulate({ ...kernelSimOptions(launch), randomSeed: 42 });
    run = buildSimRun({ result, info: rocket.staticInfo(), motor, launch,
      rocketName: tree.name!, execMs: 0, aeroModel: 'classic' });
  } finally {
    resetEngine();
  }
  expect(result.events.some(e => e.type === 'SIM_ABORT')).toBe(false);
  const ground = result.events.find(e => e.type === 'GROUND_HIT')!;
  expect(ground.time).toBeLessThan(9); // Both seven-second delays expire after landing.
  const duplicates = result.warnings!.filter(w => w.key === 'EventAfterLanding');
  expect(duplicates).toHaveLength(2);
  expect(duplicates[0]).toEqual(duplicates[1]);
  addRun(run);
  expect(loadRuns()[0]!.simWarnings).toEqual(result.warnings);
  localStorage.clear();
  const xml = exportOrk({ name: tree.name!, tree, launch,
    configs: [{ id: 'c1', name: 'Flight', isDefault: true, motors: {} }],
    activeConfigId: 'c1', flightData: { c1: summaryOf(run) } });
  const imported = importOrk(xml);
  expect(imported.storedSimulations![0]!.data.simWarnings).toEqual(result.warnings);
  const plan = planSummaryImport(imported);
  appendImportedRuns(plan.runs, plan.updatedRuns);
  expect(loadRuns()[0]!.simWarnings).toEqual(result.warnings);
  const repeat = planSummaryImport(imported, loadRuns());
  expect(repeat.runs).toEqual([]);
  expect(repeat.updatedRuns).toEqual([]);
  appendImportedRuns(repeat.runs, repeat.updatedRuns);
  expect(loadRuns()[0]!.simWarnings).toEqual(result.warnings);
});

describe.each(['rounded', 'airfoil'])('real kernel warning quantities (%s freeform fins)', crossSection => {
  const tree = design(crossSection);
  // Deliberate shear provokes fin stall AFTER the warning inhibition on
  // leaving the rod. Nose ballast keeps this a stable, completed flight.
  const launch = { ...DEFAULT_CONDITIONS, launchRodLengthM: 1, timeStepS: 0.05,
    windLevels: [
      { altitude: 0, speed: 0, direction: 0, standardDeviation: 0 },
      { altitude: 20, speed: 0, direction: 0, standardDeviation: 0 },
      { altitude: 21, speed: 40, direction: 0, standardDeviation: 0 },
    ] };
  let result: FlightResult;
  let run: SimRun;
  let savedWarnings: FlightResult['warnings'];

  beforeAll(() => {
    resetEngine();
    const rocket = OrkRocket.buildTree(tree);
    rocket.setMotorById('mount', MOTOR);
    result = rocket.simulate({ ...kernelSimOptions(launch), randomSeed: 42 });
    run = buildSimRun({ result, info: rocket.staticInfo(), motor: MOTOR,
      launch, rocketName: tree.name!, execMs: 0, aeroModel: 'classic' });
    savedWarnings = result.warnings!.map(w => ({ ...w, sources: w.sources!.map(s => s === null ? null : { name: s.name }) }));
    resetEngine();
    expect(result.events.some(e => e.type === 'SIM_ABORT')).toBe(false);
    expect(result.events.some(e => e.type === 'GROUND_HIT')).toBe(true);
  }, 30000);

  function assertCurrentUnits(saved: SimRun) {
    const speed = saved.simWarnings!.find(w => w.key === 'HighSpeedDeployment')!;
    const aoa = saved.simWarnings!.find(w => w.key === 'LargeAOA')!;
    expect(speed.quantity?.kind).toBe('velocity');
    expect(aoa.quantity?.kind).toBe('angle');
    // Independent unit arithmetic: 1 ft = 0.3048 m, 180 degrees = pi radians.
    const rounded = (n: number) => String(Number(n.toFixed(3)));
    for (const units of [METRIC_UNITS, IMPERIAL_UNITS]) {
      const v = speed.quantity!.value / (units.velocity === 'ft/s' ? 0.3048 : 1);
      expect(formatWarning(speed, units).detail).toBe(`(${rounded(v)} ${units.velocity}): "${CHUTE_NAME}"`);
      expect(formatWarning(aoa, units).detail).toBe(`(${rounded(aoa.quantity!.value * 180 / Math.PI)} \u00b0)`);
    }
    expect(formatWarning(aoa, { ...METRIC_UNITS, angle: 'rad' }).detail)
      .toBe(`(${rounded(aoa.quantity!.value)} rad)`);
  }

  it('exports deployment speed in m/s with the real source ID/name and fallback text', () => {
    const warning = result.warnings!.find(w => w.key === 'HighSpeedDeployment')!;
    expect(warning).toBeDefined();
    expect(warning.quantity?.kind).toBe('velocity');
    expect(warning.sources).toEqual([{ id: 'chute-1', name: CHUTE_NAME }]);
    expect(warning.priority).toBe('NORMAL');
    const deployment = result.events.find(e => e.type === 'RECOVERY_DEVICE_DEPLOYMENT')!;
    expect(deployment).toMatchObject({ sourceId: 'chute-1', source: CHUTE_NAME });
    // The first recovery sample records the pre-deceleration velocity used
    // by HighSpeedDeployment. 1e-9 m/s allows serialization/float noise.
    const index = result.series.time.findIndex(t => t >= deployment.time);
    expect(warning.quantity!.value).toBeGreaterThan(20);
    expect(warning.quantity!.value).toBeCloseTo(result.series.velocity[index]!, 9);
    expect(warning.message).toMatch(/^\[Warning.RECOVERY_HIGH_SPEED\] \([\d.]+ m\/s\):/);
    expect(warning.message).toContain(`"${CHUTE_NAME}"`);
    const legacy = { key: warning.key, message: warning.message };
    expect(formatWarning(legacy, IMPERIAL_UNITS).detail)
      .toBe(warning.message.replace('[Warning.RECOVERY_HIGH_SPEED]', '').trim().replace(/\s+/g, ' '));
  });

  it('exports the recorded large AoA in radians with an empty source list and fallback text', () => {
    const warning = result.warnings!.find(w => w.key === 'LargeAOA')!;
    expect(warning).toBeDefined();
    expect(warning.quantity?.kind).toBe('angle');
    expect(warning.sources).toEqual([]); // LargeAOA has no component source in the kernel.
    // OR #3183 (tumble release): LargeAOA is informative, LOW (was NORMAL). The
    // app only singles out HIGH, so nothing it shows changes.
    expect(warning.priority).toBe('LOW');
    // This fixture reaches its greatest AoA during the shear, while warnings
    // are enabled. 1e-12 rad tolerates last-bit runtime differences.
    const maxAoa = Math.max(...result.series.aoa.filter(Number.isFinite));
    expect(maxAoa).toBeGreaterThan(0.3);
    expect(maxAoa).toBeLessThan(0.8);
    expect(warning.quantity!.value).toBeCloseTo(maxAoa, 12);
    expect(warning.message).toMatch(/^\[Warning.LargeAOA.str2\][\d.]+\u00b0\)$/);
    expect(formatWarning({ key: warning.key, message: warning.message }, IMPERIAL_UNITS).detail)
      .toBe(warning.message.replace('[Warning.LargeAOA.str2]', ''));
  });

  it('formats the actual payload in current units after saved run history reload', () => {
    expect(run.simWarnings).toEqual(savedWarnings);
    addRun(run);
    const saved = loadRuns()[0]!;
    expect(saved.simWarnings).toEqual(savedWarnings);
    assertCurrentUnits(saved);
  });

  it('round-trips the flown warnings through .ork app data, session autosave, and re-save', () => {
    const write = (saved: SimRun) => exportOrk({
      name: tree.name!, tree, launch,
      configs: [{ id: 'c1', name: 'Flight', isDefault: true, motors: {} }],
      activeConfigId: 'c1', flightData: { c1: summaryOf(saved) },
    });
    const imported = importOrk(write(run));
    expect(imported.storedSimulations![0]!.data.simWarnings).toEqual(savedWarnings);
    saveSessionDebounced({ tree: imported.tree, launch, importedDocument: summaryDocument(imported) });
    flushSession();
    const document = loadSession()!.importedDocument!;
    expect(document.storedSimulations[0]!.data.simWarnings).toEqual(savedWarnings);
    const restored = importedSummaryRuns(document)[0]!;
    assertCurrentUnits(restored);
    const reopened = importedSummaryRuns(importOrk(write(restored)))[0]!;
    expect(reopened.simWarnings).toEqual(savedWarnings);
    assertCurrentUnits(reopened);
  });
});
