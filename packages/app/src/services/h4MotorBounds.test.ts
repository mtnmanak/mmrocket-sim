// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { exMotorFlightProblem, repairStoredExMotor, repairFlightSnapshot, exToDbEntry, exToMotorSpec, loadExMotors, parseEng, parseRse, validExMotor, validFlightSnapshot } from './exMotors.js';
import { archiveExMotors, readArchivedExMotors } from './exMotorArchive.js';
import { parseXml } from './xmlParse.js';
import { escapeXml } from './xmlUtil.js';
import { isSampleList, samplesToMotorSpec } from './thrustcurve.js';

const good = 'Good 29 100 P 0.05 0.1 Home\n0 0\n0.5 40\n1 0';
it('HF2 refuses an RSE motor with oversized point mass instead of substituting burn-off', () => {
  const notes: string[] = [];
  expect(() => parseRse('<engine-database><engine-list><engine code="Huge" mfg="Home" dia="29" len="100" initWt="100" propWt="50" auto-calc-mass="0"><data><eng-data t="0" f="0" m="1e25"/><eng-data t="0.5" f="40" m="50"/><eng-data t="1" f="0" m="0"/></data></engine></engine-list></engine-database>', notes)).toThrow(/mass/);
});
it.each([
  { totalWeightG: 1e23 }, { propWeightG: 1e23 }, { diameter: 1e9 }, { length: 1e9 },
  { sampleMassesKg: [0.1, 1e20, 0.05] },
])('HF2 refuses an entire stored motor above representability limits: %j', fields => {
  const motor = { ...parseEng(good)[0]!, ...fields };
  expect(validExMotor(motor)).toBe(false);
  localStorage.setItem('online-openrocket.ex-motors.v1', JSON.stringify([parseEng(good)[0]!, motor]));
  const notes: string[] = [];
  expect(loadExMotors(notes)).toHaveLength(1);
  expect(notes.length).toBeGreaterThan(0);
  localStorage.clear();
});
it.each([{ masses: [0.1, 1e20, 0.05] }, { diameter: 1e9 }, { length: 1e9 }])(
  'HF2 refuses oversized loaded snapshots without mass repair: %j', fields => {
    const motor = parseEng(good)[0]!;
    const flightSnapshot = { ...exToMotorSpec(motor, Infinity), ...fields };
    expect(validExMotor({ ...motor, flightSnapshot })).toBe(false);
  },
);
it.each(['Huge 29 100 P 1e19 1e20 Home', 'Huge 1000001 100 P 0.05 0.1 Home',
  'Huge 29 1000001 P 0.05 0.1 Home'])('HF2 refuses only oversized fresh motor %s', header => {
  const notes: string[] = [];
  expect(parseEng(good + '\n' + header + '\n0 0\n0.5 40\n1 0', notes)).toHaveLength(1);
  expect(notes.join(' ')).toContain('Huge');
});
it('drops overflowing optional source masses even when the gram header is finite', () => {
  const motor = { ...parseEng(good)[0]!, totalWeightG: 1.7976931348623156e305 * 1000,
    propWeightG: 1e307, sampleMassesKg: [1.7976931348623156e305, 1.797693134862316e305, 1.797693134862316e305] };
  expect(validExMotor(motor)).toBe(false); // HF2 refuses before gram-conversion repair.
  expect(repairStoredExMotor(motor).sampleMassesKg).toBeUndefined();
  expect(exToMotorSpec(motor, Infinity).masses.every(m => Number.isFinite(m * 1000))).toBe(true);
});
it('repairs every snapshot mass whose gram conversion overflows independently of tolerant ordering', () => {
  const spec = exToMotorSpec(parseEng(good)[0]!, Infinity);
  const snapshot = { ...spec, masses: [1.7976931348623156e305, 1.797693134862316e305, 1.797693134862316e305] };
  expect(Number.isFinite(snapshot.masses[0]! * 1000)).toBe(true);
  expect(validFlightSnapshot(snapshot)).toBe(false);
  const repaired = repairFlightSnapshot(snapshot);
  expect(repaired.masses.every(m => Number.isFinite(m * 1000))).toBe(true);
  expect(validFlightSnapshot(repaired)).toBe(false); // HF2 refuses the whole oversized motor.
  const saved = archiveExMotors([{ designation: 'Good', diameter: spec.diameter,
    length: spec.length, exMotorSpec: snapshot, delay: Infinity }], []);
  expect(saved.json).not.toBeNull(); // The valid captured source remains available; oversized snapshot is refused.
  expect(JSON.parse(saved.json!)[0].flightSnapshot).toBeUndefined();
});
it('preserves v0.197 measured masses with one ulp of header residue through Save/reopen', () => {
  const masses = [0.007200000000000001, 0.0058, 0.0043];
  const motor = { ...parseEng('Small 29 100 P 0.0029 0.0072 Home\n0 0\n0.2 40\n0.5 0')[0]!, source: 'rse' as const, sampleMassesKg: masses };
  localStorage.setItem('online-openrocket.ex-motors.v1', JSON.stringify([motor]));
  try {
    const notes: string[] = [];
    expect(loadExMotors(notes)[0]!.sampleMassesKg).toEqual(masses);
    const spec = { ...exToMotorSpec(motor, Infinity), masses };
    expect(exToMotorSpec(repairStoredExMotor(motor, notes), Infinity).masses).toEqual(masses);
    const saved = archiveExMotors([{ designation: motor.designation, manufacturer: 'Home', exMotorId: motor.motorId,
      diameter: spec.diameter, length: spec.length, exMotorSpec: spec, delay: Infinity }], notes);
    expect(saved.ids.values().next().value).toBe(motor.motorId);
    const rocket = parseXml(`<rocket><mmrexmotors version="1">${escapeXml(saved.json!)}</mmrexmotors></rocket>`, 'bad').documentElement!;
    const reopened = readArchivedExMotors(rocket, notes).get(motor.motorId)!;
    expect(exToMotorSpec(reopened, Infinity).masses).toEqual(masses);
    expect(notes).toEqual([]);
  } finally { localStorage.clear(); }
});

it('does not call a repaired captured definition a changed library or a saved snapshot', () => {
  const motor = { ...parseEng(good)[0]!, sampleMassesKg: [0.1, 0.06, 0.09] };
  localStorage.setItem('online-openrocket.ex-motors.v1', JSON.stringify([motor]));
  try {
    const notes: string[] = [];
    const spec = { ...exToMotorSpec(motor, Infinity), exDefinition: motor };
    const saved = archiveExMotors([{ designation: motor.designation, manufacturer: 'Home', exMotorId: motor.motorId,
      diameter: spec.diameter, length: spec.length, exMotorSpec: spec, delay: Infinity }], notes);
    expect(JSON.parse(saved.json!)[0].flightSnapshot).toBeUndefined();
    expect(notes.join(' ')).not.toMatch(/library definition changed|saved the loaded snapshot/);
  } finally { localStorage.clear(); }
});
it.each([[0.1, 0.06, 0.09], [0.1], [0.1, 9, -1]])('drops optional legacy masses %j rather than refusing the motor', (...masses) => {
  const motor = { ...parseEng(good)[0]!, sampleMassesKg: masses };
  expect(validExMotor(motor)).toBe(true);
  const notes: string[] = [];
  const repaired = repairStoredExMotor(motor, notes);
  expect(repaired.sampleMassesKg).toBeUndefined();
  expect(exToMotorSpec(repaired, Infinity).masses).toEqual([0.1, expect.closeTo(0.075, 12), 0.05]);
  expect(notes).toHaveLength(1);
});

it.each([
  { times: [0, 1e-9, 0.5, 1], thrusts: [0, 0, 40, 0], masses: [0.1, 0.1004, 0.075, 0.05] },
  { times: [0, 0.5, 1, 1 + 5e-9], thrusts: [0, 40, 0, 0], masses: [0.1, 0.1004, 0.06, 0.05] },
])('keeps snapshot repair arrays aligned on read and Save: %j', fields => {
  const motor = parseEng(good)[0]!;
  const snapshot = { ...exToMotorSpec(motor, Infinity), exDefinition: undefined, ...fields };
  expect(validFlightSnapshot(repairFlightSnapshot(snapshot))).toBe(true);
  const rocket = parseXml(`<rocket><mmrexmotors version="1">${escapeXml(JSON.stringify([{ ...motor, flightSnapshot: snapshot }]))}</mmrexmotors></rocket>`, 'bad').documentElement!;
  expect(validFlightSnapshot(readArchivedExMotors(rocket, []).get(motor.motorId)!.flightSnapshot)).toBe(true);
  const notes: string[] = [];
  const saved = archiveExMotors([{ designation: 'Good', manufacturer: 'Home', diameter: 0.029, length: 0.1, exMotorSpec: snapshot, delay: Infinity }], notes);
  expect(saved.json).not.toBeNull();
  expect(validFlightSnapshot(JSON.parse(saved.json!)[0].flightSnapshot)).toBe(true);
});

it.each([[{ time: 0, thrust: 0 }, { time: 1, thrust: 0 }], [{ time: 0, thrust: 10 }, { time: 0, thrust: 10 }]].map(samples => [samples]))('names degenerate source thrust even with a valid snapshot', samples => {
  const motor = parseEng(good)[0]!;
  expect(exMotorFlightProblem({ ...motor, samples, flightSnapshot: exToMotorSpec(motor, Infinity) })).toMatch(/thrust/);
});

it('uses burn-off in the flown snapshot when source masses are dropped', () => {
  const motor = parseEng(good)[0]!;
  const legacy = { ...motor, sampleMassesKg: [0.1, 0.06, 0.09], flightSnapshot: { ...exToMotorSpec(motor, Infinity), masses: [0.1, 0.09, 0.05] } };
  expect(exToMotorSpec(repairStoredExMotor(legacy), Infinity).masses).toEqual([0.1, expect.closeTo(0.075, 12), 0.05]);
});
it('repairs in-band stored rising point masses and does not fly them through direct conversion', () => {
  const motor = { ...parseEng(good)[0]!, sampleMassesKg: [0.1004, 0.075, 0.05] };
  expect(validExMotor(motor)).toBe(true);
  expect(validFlightSnapshot(exToMotorSpec(motor, Infinity))).toBe(true);
});

it('loads a v0.197 library entry with one named repair note', () => {
  const motor = { ...parseEng(good)[0]!, designation: 'Old\u202e', sampleMassesKg: [0.1004, 0.075, 0.05] };
  localStorage.setItem('online-openrocket.ex-motors.v1', JSON.stringify([motor]));
  const notes: string[] = [];
  const loaded = loadExMotors(notes);
  localStorage.clear();
  expect(loaded).toHaveLength(1);
  expect(loaded[0]!.sampleMassesKg).toBeUndefined();
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatch(/Old\[U\+202E\].*stored per-point masses were inconsistent.*burn-off mass curve/);
});

it('checks point masses after sorting times for saved and RSE curves', () => {
  const motor = { ...parseEng(good)[0]!, samples: [{ time: 0, thrust: 0 }, { time: 1, thrust: 0 }, { time: 0.5, thrust: 40 }], sampleMassesKg: [0.1, 0.05, 0.09] };
  expect(validExMotor(motor)).toBe(true);
  expect(exToMotorSpec(motor, Infinity).masses).toEqual([0.1, 0.09, 0.05]);
  const notes: string[] = [];
  const imported = parseRse('<engine-database><engine-list><engine code="Sorted" mfg="Home" dia="29" len="100" initWt="100" propWt="50" auto-calc-mass="0"><data><eng-data t="0" f="0" m="50"/><eng-data t="1" f="0" m="0"/><eng-data t="0.5" f="40" m="40"/></data></engine></engine-list></engine-database>', notes)[0]!;
  expect(exToMotorSpec(imported, Infinity).masses).toEqual([0.1, 0.09, 0.05]);
  expect(notes.join(' ')).not.toMatch(/per-point masses/);
});

it('repairs legacy snapshots on read and save, refusing only unusable siblings', () => {
  const goodMotor = parseEng(good)[0]!;
  const legacy = { ...goodMotor, motorId: 'ex:legacy', flightSnapshot: { ...exToMotorSpec(goodMotor, Infinity), exDefinition: undefined, masses: [0.1, 0.1004, 0.05] } };
  const bad = { ...legacy, motorId: 'ex:bad', flightSnapshot: { ...legacy.flightSnapshot, masses: [0.1, 0.25, 0.05] } };
  const overflow = { ...legacy, motorId: 'ex:overflow', flightSnapshot: { ...legacy.flightSnapshot, times: [0, 1e308, 1.7e308], thrusts: [0, 10, 0] } };
  const rocket = parseXml(`<rocket><mmrexmotors version="1">${escapeXml(JSON.stringify([goodMotor, legacy, bad, overflow]))}</mmrexmotors></rocket>`, 'bad').documentElement!;
  const notes: string[] = [];
  const loaded = readArchivedExMotors(rocket, notes);
  expect([...loaded.keys()]).toEqual([goodMotor.motorId, legacy.motorId, bad.motorId]);
  expect(validFlightSnapshot(exToMotorSpec(loaded.get(bad.motorId)!, Infinity))).toBe(true);
  expect(validFlightSnapshot(exToMotorSpec(loaded.get(legacy.motorId)!, Infinity))).toBe(true);
  expect(notes.join(' ')).toMatch(/inconsistent/);
  expect(notes.join(' ')).toMatch(/mass/);
  expect(notes.join(' ')).toMatch(/impulse/);
  const saveNotes: string[] = [];
  const mount = { designation: 'Good', manufacturer: 'Home', diameter: 0.029, length: 0.1, exMotorSpec: legacy.flightSnapshot, delay: Infinity };
  const saved = archiveExMotors([mount, { ...mount }], saveNotes);
  expect(saved.json).not.toBeNull();
  expect(validFlightSnapshot(JSON.parse(saved.json!)[0].flightSnapshot)).toBe(true);
  expect(saveNotes.filter(n => n.includes('stored per-point masses'))).toHaveLength(1);
});

it('refuses finite snapshot samples whose integrated impulse overflows', () => {
  const motor = parseEng(good)[0]!;
  const snapshot = { ...exToMotorSpec(motor, Infinity), times: [0, 1e308, 1.7e308], thrusts: [0, 10, 0] };
  expect(validFlightSnapshot(snapshot)).toBe(false);
  expect(validExMotor({ ...motor, flightSnapshot: snapshot })).toBe(false);
});

it.each([[50.4, 50.45, 0], [50.4, 25, 0], [100.4, 75, 50], [50, 25, 25.1]])(
  'names unsafe RSE point masses %j and saves the fallback without a false caution', (...masses) => {
    const notes: string[] = [];
    const motor = parseRse('<engine-database><engine-list><engine code="BadMass" mfg="Home" dia="29" len="100" initWt="100" propWt="50" auto-calc-mass="0"><data>'
      + masses.map((m, i) => `<eng-data t="${[0.1, 0.5, 1][i]}" f="${[0, 40, 0][i]}" m="${m}"/>`).join('')
      + '</data></engine></engine-list></engine-database>', notes)[0]!;
    expect(motor.sampleMassesKg).toBeUndefined();
    expect(notes.join(' ')).toMatch(/per-point masses.*impulse/);
    const spec = exToMotorSpec(motor, Infinity);
    expect(validFlightSnapshot(spec)).toBe(true);
    const saveNotes: string[] = [];
    const archive = archiveExMotors([{ designation: motor.designation, exMotorId: motor.motorId,
      diameter: spec.diameter, length: spec.length, exMotorSpec: spec, delay: Infinity }], saveNotes);
    expect(archive.json).not.toBeNull();
    expect(saveNotes.join(' ')).not.toMatch(/loaded curve is invalid/);
  },
);
afterEach(() => { vi.useRealTimers(); vi.doUnmock('../data/motorCurves.json'); });

it.each(['\r', '\r\n', '\n'])('reads RASP with %j line endings', newline => {
  expect(parseEng(('; comment\n' + good).replaceAll('\n', newline))).toHaveLength(1);
});

it.each([true, false])('names a zero-sample motor, before sibling: %s', first => {
  const empty = 'Empty 29 100 P 0.05 0.1 Home';
  const notes: string[] = [];
  expect(parseEng(first ? empty + '\n' + good : good + '\n' + empty, notes)).toHaveLength(1);
  expect(notes.join(' ')).toContain('Empty: no thrust data');
});

it.each(['-1 1', '1 10000001'])('cleans a refused name for %s', point => {
  const notes: string[] = [];
  parseEng(good + '\nBad\u202e\u0085 29 100 P 0.05 0.1 Home\n' + point, notes);
  expect(notes.join(' ')).not.toMatch(/[\u202e\u0085]/u);
  expect(notes.join(' ')).toContain('Bad[U+202E]');
});

it('refuses overflowing impulse at import, library and spec boundaries', () => {
  const samples = [{ time: 0, thrust: 0 }, { time: 1e308, thrust: 10 }, { time: 1.1e308, thrust: 0 }];
  const motor = { ...parseEng(good)[0]!, samples };
  expect(() => parseEng('Huge 29 100 P 0.05 0.1 Home\n0 0\n1e308 10\n1.1e308 0')).toThrow(/impulse/i);
  expect(validExMotor(motor)).toBe(false);
  expect(isSampleList(samples)).toBe(false);
  expect(() => samplesToMotorSpec(exToDbEntry(motor), samples, Infinity)).toThrow(/impulse/i);
});

it.each([
  { masses: [0.1, 0.25, 0.05] },
  { masses: [1e306, 0.5e306, 0] },
  { diameter: 1e306 }, { length: 1e306 },
])('refuses unsafe snapshot fields %j', fields => {
  const motor = parseEng(good)[0]!;
  const snapshot = { ...exToMotorSpec(motor, Infinity), ...fields };
  expect(validFlightSnapshot(snapshot)).toBe(false);
  const repairable = fields.masses !== undefined && fields.masses[0]! < 1e15;
  expect(validExMotor({ ...motor, flightSnapshot: snapshot })).toBe(repairable);
  if (fields.masses) expect(validFlightSnapshot(exToMotorSpec({ ...motor, flightSnapshot: snapshot }, Infinity))).toBe(repairable);
});

it('reuses a failed bundle attempt across lookups, then retries after cooldown', async () => {
  vi.resetModules();
  vi.useFakeTimers();
  let attempts = 0;
  vi.doMock('../data/motorCurves.json', () => ({ get default() {
    attempts++;
    if (attempts === 1) throw new Error('chunk unavailable');
    return { curves: {}, complete: true };
  } }));
  const { requireCurveBundle } = await import('./thrustcurve.js');
  await expect(requireCurveBundle()).rejects.toThrow();
  await expect(requireCurveBundle()).rejects.toThrow();
  expect(attempts).toBe(1);
  vi.advanceTimersByTime(30_000);
  await expect(requireCurveBundle()).resolves.toBeUndefined();
  expect(attempts).toBe(2);
});
