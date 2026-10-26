// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exToDbEntry, exToMotorSpec, loadExMotorIdentities, loadExMotors, parseEng, parseRse, restoreExMotors } from './exMotors.js';
import { validArchivedExMotor } from './exMotorArchive.js';
import { matchingExMotors, matchImportedMotor } from './motorMatch.js';
import { applyOpenMotorChoices } from './openMotorChoices.js';
import type { OrkMotorRef } from './orkFile.js';

const eng = 'E20 29 100 P 0.05 0.1 Home\n0 0\n0.5 40\n1 0';
const motor = () => parseEng(eng)[0]!;
afterEach(() => localStorage.clear());

it('E3 serializes archived EX identities once per definition', () => {
  const added = Array.from({ length: 128 }, (_, i) => ({ ...motor(), motorId: `ex:m${i}`, designation: `M${i}` }));
  const original = JSON.stringify;
  let identities = 0;
  const spy = vi.spyOn(JSON, 'stringify').mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
    if (Array.isArray(args[0]) && typeof args[0][0] === 'string') identities++;
    return original(...args);
  });
  try {
    const restored = restoreExMotors(added, []);
    expect(restored.size).toBe(128);
    expect(identities).toBeLessThanOrEqual(128);
  } finally { spy.mockRestore(); }
});

describe('S1c-5 integration: saved identity is separate from loadable flight data', () => {
  it('retains legacy makers without admitting their rejected curves or leaking flight fields', () => {
    const good = motor();
    const legacy = { ...good, motorId: 'ex:loki-e20', realManufacturer: 'Loki', source: undefined, addedAt: undefined };
    const invalid = { ...good, motorId: 'ex:bad-e20', totalWeightG: 0 };
    localStorage.setItem('online-openrocket.ex-motors.v1', JSON.stringify([
      good, legacy, invalid, null, { ...good, motorId: 'catalogue' },
      { ...good, designation: '' }, { ...good, realManufacturer: 7 },
    ]));
    expect(loadExMotors()).toEqual([good]);
    expect(loadExMotorIdentities()).toEqual([
      { motorId: good.motorId, designation: 'E20', realManufacturer: 'Home' },
      { motorId: 'ex:loki-e20', designation: 'E20', realManufacturer: 'Loki' },
      { motorId: 'ex:bad-e20', designation: 'E20', realManufacturer: 'Home' },
    ]);
  });

  it.each(['{', '{}', 'null'])('ignores malformed stored identity lists: %s', raw => {
    localStorage.setItem('online-openrocket.ex-motors.v1', raw);
    expect(loadExMotorIdentities()).toEqual([]);
  });
});

describe('S7a-2 EX delay policy', () => {
  it.each([
    { delays: '', delay: 0, auto: true },
    { delays: '5,10', delay: 10, auto: false },
    { delays: 'P', delay: Infinity, auto: false },
  ])('resolves every-delay against EX delays $delays in matching and choices', async ({ delays, delay, auto }) => {
    const ex = { ...motor(), delays };
    const ref: OrkMotorRef = { designation: 'E20', manufacturer: 'Home', diameter: 0,
      length: 0, delay: Infinity, rktEveryDelay: true };
    const matched = await matchImportedMotor(ref, { catalogue: [], exMotors: [ex] });
    expect(matched.motor?.spec.ejectionDelay).toBe(delay);
    expect(matched.motor?.meta.autoDelay === true).toBe(auto);
    const next = await applyOpenMotorChoices({ tree: { components: [] }, mountMotors: {}, savedConfigs: [], unmatchedRefs: {} }, null,
      [{ key: 'ex', ref, candidates: [], carriedBy: [], locations: [{ configId: null, mountId: 'm', ref }] }],
      { ex: { kind: 'ex', motor: ex } });
    expect(next.mountMotors.m?.spec.ejectionDelay).toBe(delay);
    expect(next.mountMotors.m?.meta.autoDelay === true).toBe(auto);
  });

  it('preserves explicit Auto across a different-maker catalogue substitution and EX choice', async () => {
    const ex = motor();
    const ref: OrkMotorRef = { designation: 'E20', manufacturer: 'Home', diameter: 0,
      length: 0, delay: 0, autoDelay: true };
    const matched = await matchImportedMotor(ref, {
      catalogue: [{ ...exToDbEntry(ex), motorId: 'other', manufacturerAbbrev: 'Elsewhere' }], exMotors: [ex],
    });
    expect(matched.motor?.meta.autoDelay).toBe(true);
    const next = await applyOpenMotorChoices({ tree: { components: [] }, mountMotors: {}, savedConfigs: [], unmatchedRefs: {} }, null,
      [{ key: 'ex', ref, candidates: [], carriedBy: [], locations: [{ configId: null, mountId: 'm', ref }] }],
      { ex: { kind: 'ex', motor: ex } });
    expect(next.mountMotors.m?.meta.autoDelay).toBe(true);
  });
});

it('S1c-2 describes the flown snapshot in the browser row', () => {
  const ex = { ...motor(), flightSnapshot: {
    designation: 'H100', diameter: 0.054, length: 0.3, cgX: 0.15,
    times: [0, 1, 2], thrusts: [0, 200, 0], masses: [0.5, 0.4, 0.3],
  } };
  expect(validArchivedExMotor(ex)).toBe(true);
  const row = exToDbEntry(ex);
  expect(row).toMatchObject({ motorId: ex.motorId, designation: 'H100', commonName: 'H100',
    diameter: 54, length: 300, totalWeightG: 500, propWeightG: 200,
    impulseClass: 'H', totImpulseNs: 200, avgThrustN: 100, maxThrustN: 200, burnTimeS: 2 });
  expect(exToMotorSpec(ex, 5).thrusts).toEqual([0, 200, 0]);
});

describe('S1c-2 snapshot matching follow-up', () => {
  const ex = () => ({ ...motor(), flightSnapshot: {
    designation: 'H100', diameter: 0.054, length: 0.3, cgX: 0.15,
    times: [0, 1, 2], thrusts: [0, 200, 0], masses: [0.5, 0.4, 0.3],
  } });
  const ref = (designation: string, diameter: number): OrkMotorRef => ({
    designation, diameter, manufacturer: 'Home', length: 0, delay: 5,
  });
  it.each([['E20', 0.029], ['E20', 0], ['H100', 0.029]] as const)(
    'does not auto-load a 54 mm H100 snapshot for %s at %s m', async (designation, diameter) => {
      const result = await matchImportedMotor(ref(designation, diameter), { catalogue: [], exMotors: [ex()] });
      expect(result.motor).toBeUndefined();
      expect(result.missing).toBe('database');
    });
  it('matches the snapshot and names it in the substitution note', async () => {
    const result = await matchImportedMotor(ref('H100', 0.054), { catalogue: [], exMotors: [ex()] });
    expect(result.motor?.spec).toMatchObject({ designation: 'H100', diameter: 0.054 });
    expect(result.infoNote).toContain('imported EX motor Home H100');
    expect(result.infoNote).not.toContain('E20');
  });
  it('names the snapshot for ambiguous matching choices', async () => {
    const motors = [ex(), { ...ex(), motorId: 'ex:home-e20~2' }];
    expect(matchingExMotors(ref('H100', 0.054), motors)).toHaveLength(2);
    const result = await matchImportedMotor(ref('H100', 0.054), { catalogue: [], exMotors: motors });
    expect(result.motor).toBeUndefined();
    expect(result.note).toContain('Home H100 [');
    expect(result.note).not.toContain('Home E20');
  });
});

describe('S1c-4 refuse negative motor points at import', () => {
  it.each([['-0.01', '10'], ['0.5', '-0.4']])('names negative point %s %s in both formats and retains siblings', (t, f) => {
    const bad = `BAD 29 100 P 0.05 0.1 Home\n0 0\n${t} ${f}\n1 0\n`;
    const notes: string[] = [];
    expect(parseEng(bad + eng, notes).map(m => m.designation)).toEqual(['E20']);
    expect(notes.join(' ')).toMatch(/BAD.*point 2.*negative/i);
    expect(() => parseEng(bad)).toThrow(/BAD.*point 2.*negative/i);
    const xmlMotor = (name: string, time: string, thrust: string) =>
      `<engine code="${name}" mfg="Home" dia="29" len="100" initWt="100" propWt="50"><data>`
      + `<eng-data t="0" f="0"/><eng-data t="${time}" f="${thrust}"/><eng-data t="1" f="0"/></data></engine>`;
    const xml = (body: string) => `<engine-database><engine-list>${body}</engine-list></engine-database>`;
    const rseNotes: string[] = [];
    expect(parseRse(xml(xmlMotor('BAD', t, f) + xmlMotor('GOOD', '0.5', '40')), rseNotes).map(m => m.designation)).toEqual(['GOOD']);
    expect(rseNotes.join(' ')).toMatch(/BAD.*point 2.*negative/i);
    expect(() => parseRse(xml(xmlMotor('BAD', t, f)))).toThrow(/BAD.*point 2.*negative/i);
  });
  it.each([{ time: -0.01, thrust: 10 }, { time: 0.5, thrust: -0.4 }])('refuses negative archive sample $time $thrust', sample => {
    expect(validArchivedExMotor({ ...motor(), samples: [{ time: 0, thrust: 0 }, sample, { time: 1, thrust: 0 }] })).toBe(false);
  });
});

it('S1c-5 drops legacy invalid fields at the library boundary and retains the valid sibling', () => {
  const good = motor();
  const bad = [{ totalWeightG: 0, propWeightG: 0 }, { propWeightG: null },
    { propWeightG: 101 }, { diameter: 0 }, { length: -1 }, { flightSnapshot: {} },
    { sampleMassesKg: [0, 0, 0] }, { exitDiameterM: 1 }];
  localStorage.setItem('online-openrocket.ex-motors.v1', JSON.stringify([
    ...bad.map((over, i) => ({ ...good, designation: `BAD${i}`, ...over })), good,
  ]));
  expect(loadExMotors()).toEqual([good]);
  expect(loadExMotors()).toEqual([good]);
});
