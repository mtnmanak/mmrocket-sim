// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { addExMotors, exToMotorSpec, loadExMotors, parseEng, parseRse, repairFlightSnapshot, restoreExMotors, type ExMotor } from './exMotors.js';
import { archiveExMotors, readArchivedExMotors } from './exMotorArchive.js';
import { discardSession, loadSession } from './session.js';
import { parseXml } from './xmlParse.js';
import { escapeXml } from './xmlUtil.js';

const template = parseEng('Small 29 100 P 0.0029 0.0072 Home\n0 0\n0.2 40\n0.5 0')[0]!;
// 7fe1cf9f parseRse/rseSampleMassesKg writer, valid propellant-mode inputs:
// auto-calc-mass enabled omits the optional array; disabled adds dry grams
// before dividing, without the later header-residue normalization.
function legacy(initG: number, propG: number, auto: boolean, start: number): ExMotor {
  const points = [propG, initG === 7.2 && propG === 2.9 ? 1.5 : propG / 2, 0];
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.01 * b;
  const propellant = near(points[0]!, propG);
  const low = propellant ? 0 : initG - propG;
  const high = propellant ? propG : initG;
  expect(points.every(m => m >= low * 0.99 && m <= high * 1.01)).toBe(true);
  const converted = points.map(m => {
    const caseG = propellant ? initG - propG : 0;
    const total = m + caseG;
    return Number.isFinite(total) ? total / 1000 : m / 1000 + caseG / 1000;
  });
  return { ...template, source: 'rse', totalWeightG: initG, propWeightG: propG,
    samples: [start, 0.2, 0.5].map((time, i) => ({ time, thrust: [0, 40, 0][i]! })),
    ...(!auto ? { sampleMassesKg: converted } : {}) };
}

function checkPair(initG: number, propG: number) {
  for (const auto of [false, true]) for (const start of [0, 0.1]) {
    discardSession();
    const motor = legacy(initG, propG, auto, start);
    expect(fresh(initG, propG, auto, start).sampleMassesKg).toEqual(motor.sampleMassesKg);
    const spec = exToMotorSpec(motor, Infinity);
    const expected = !auto ? [...(start ? [initG / 1000] : []), ...motor.sampleMassesKg!] : spec.masses;
    localStorage.setItem('online-openrocket.ex-motors.v1', JSON.stringify([motor]));
    const notes: string[] = [];
    expect(exToMotorSpec(loadExMotors(notes)[0]!, Infinity).masses).toEqual(expected);
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({
      tree: { name: 'Test', components: [] }, launch: { launchRodLengthM: 1, launchRodAngleDeg: 0,
        windAverage: 2, windStdDev: 0.2, launchAltitudeM: 0, temperatureC: null, pressureHPa: null, latitudeDeg: 45 },
      motor: spec, motorMeta: { exMotorId: motor.motorId },
      mountMotors: { m: { spec, meta: { exMotorId: motor.motorId }, label: 'Small' } },
      savedConfigs: [{ id: 'c', name: 'C', motors: { m: { spec, meta: { exMotorId: motor.motorId }, label: 'Small' } } }],
    }));
    const restored = loadSession()!;
    for (const s of [restored.motor!, restored.mountMotors!.m!.spec, restored.savedConfigs![0]!.motors.m!.spec]) {
      expect(s.masses).toEqual(expected);
    }
    expect(restored.treeRestoreNotes?.filter(n => n.includes('EX motor')) ?? []).toEqual([]);
    const saved = archiveExMotors([{ designation: motor.designation, manufacturer: 'Home', exMotorId: motor.motorId,
      diameter: spec.diameter, length: spec.length, exMotorSpec: spec, delay: Infinity }], notes);
    expect([...saved.ids.values()]).toEqual([motor.motorId]);
    expect(JSON.parse(saved.json!)[0].flightSnapshot).toBeUndefined();
    const rocket = parseXml(`<rocket><mmrexmotors version="1">${escapeXml(saved.json!)}</mmrexmotors></rocket>`, 'bad').documentElement!;
    expect(exToMotorSpec(readArchivedExMotors(rocket, notes).get(motor.motorId)!, Infinity).masses).toEqual(expected);
    expect(notes).toEqual([]);
  }
}

function fresh(initG: number, propG: number, auto: boolean, start: number): ExMotor {
  return parseRse(`<engine-database><engine-list><engine code="Small" mfg="Home" dia="29" len="100" delays="P" initWt="${initG}" propWt="${propG}" auto-calc-mass="${auto ? 1 : 0}"><data>`
    + [propG, initG === 7.2 && propG === 2.9 ? 1.5 : propG / 2, 0].map((m, i) => `<eng-data t="${[start, 0.2, 0.5][i]}" f="${[0, 40, 0][i]}" m="${m}"/>`).join('')
    + '</data></engine></engine-list></engine-database>')[0]!;
}

it('re-imports the legacy Small RSE without a changed-definition note or duplicate', () => {
  const motor = legacy(7.2, 2.9, false, 0);
  addExMotors([motor]);
  addExMotors([fresh(7.2, 2.9, false, 0)]);
  const notes: string[] = [];
  const spec = { ...exToMotorSpec(motor, Infinity), exDefinition: motor };
  const saved = archiveExMotors([{ designation: motor.designation, exMotorId: motor.motorId,
    diameter: spec.diameter, length: spec.length, exMotorSpec: spec, delay: Infinity }], notes);
  expect(saved.json).not.toBeNull();
  const ids = restoreExMotors([motor], notes);
  expect(ids.get(motor.motorId)).toBe(motor.motorId);
  expect(loadExMotors()).toHaveLength(1);
  expect(notes).toEqual([]);
});

afterEach(() => { discardSession(); localStorage.clear(); });
it.each([[7.2, 2.9], [0.7, 0.3], [41.7, 20.3]])('preserves the named legacy header %s/%s g', checkPair);
it('preserves a deterministic 2,384-pair grid at 0.1 g resolution', () => {
  for (let total = 5; total <= 600; total++) {
    for (const fraction of [0.2, 0.4, 0.6, 0.8]) checkPair(total / 10, Math.max(1, Math.floor(total * fraction)) / 10);
  }
}, 120_000);

it.each([[7.2, 2.9], [0.7, 0.3], [41.7, 20.3]])('repairs %s/%s g with the library burn-off bit for bit', (init, prop) => {
  const motor = legacy(init, prop, true, 0);
  const spec = exToMotorSpec(motor, Infinity);
  const repaired = repairFlightSnapshot({ ...spec, masses: [init / 1000, init / 1000, init / 1000 + 1] }, [], motor);
  expect(repaired.masses).toEqual(spec.masses);
  localStorage.setItem('online-openrocket.ex-motors.v1', JSON.stringify([motor]));
  const saved = archiveExMotors([{ designation: motor.designation, manufacturer: 'Home', exMotorId: motor.motorId,
    diameter: spec.diameter, length: spec.length, exMotorSpec: repaired, delay: Infinity }], []);
  expect([...saved.ids.values()]).toEqual([motor.motorId]);
});

it('describes the measured loaded curve when its separate captured definition needs repair', () => {
  const motor = { ...template, totalWeightG: 100, propWeightG: 50, sampleMassesKg: [0.1, 0.06, 0.09],
    samples: [0, 0.5, 1].map((time, i) => ({ time, thrust: [0, 40, 0][i]! })) };
  localStorage.setItem('online-openrocket.ex-motors.v1', JSON.stringify([motor]));
  const spec = { ...exToMotorSpec(motor, Infinity), exDefinition: motor, masses: [0.1, 0.09, 0.05] };
  const notes: string[] = [];
  const saved = archiveExMotors([{ designation: motor.designation, manufacturer: 'Home', exMotorId: motor.motorId,
    diameter: spec.diameter, length: spec.length, exMotorSpec: spec, delay: Infinity }], notes);
  expect(JSON.parse(saved.json!)[0].flightSnapshot.masses).toEqual(spec.masses);
  expect(notes.join(' ')).toContain('saved the loaded snapshot');
  expect(notes.join(' ')).not.toContain('burn-off mass curve is used');
});
