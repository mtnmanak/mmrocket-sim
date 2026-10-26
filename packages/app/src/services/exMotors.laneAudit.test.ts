// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { addExMotors, exToMotorSpec, loadExMotors, parseEng, parseRse, validExMotor, validFlightSnapshot } from './exMotors.js';
import { archiveExMotors } from './exMotorArchive.js';
import { importMotorFiles } from './importMotorFiles.js';
import { flownCurve, headerMasses, isSampleList, pickSampleFile } from './thrustcurve.js';

const eng = (curve = '0 0\n0.5 20\n1 0', masses = '0.05 0.1', maker = 'Home') => `Audit 29 100 P ${masses} ${maker}\n${curve}`;
const rse = (curve: string) => `<engine-database><engine-list><engine code="Audit" mfg="Home" dia="29" len="100"
  initWt="100" propWt="50"><data>${curve.split('\n').map(line => {
    const [t, f] = line.split(' '); return `<eng-data t="${t}" f="${f}"/>`;
  }).join('')}</data></engine></engine-list></engine-database>`;
afterEach(() => localStorage.clear());

describe('motor audit regressions', () => {
  it.each(['', '; comment\n'])('reads BOM-prefixed RASP headers and comments (%s)', prefix => {
    const text = `\uFEFF${prefix}${eng()}`;
    const motors = parseEng(`${text}\n${text}`);
    expect(motors).toHaveLength(2);
    expect(motors.map(m => m.designation)).toEqual(['Audit', 'Audit']);
  });
  it.each(['\u00a0', '\u2003', '\u202f'])('accepts copied Unicode whitespace %j on the user RASP import path', space => {
    const text = eng().replaceAll(' ', space) + `\n${space}\n`;
    const motor = parseEng(text)[0]!;
    expect(motor.designation).toBe('Audit');
    expect(motor.samples).toEqual(parseEng(eng())[0]!.samples);
    expect(motor.realManufacturer).toBe('Home');
  });
  it.each(['rse', 'eng'])('S1c-b3 decodes whitespace-prefixed XML in a .%s file by its declaration', async extension => {
    const text = ` \t\r\n<?xml version="1.0" encoding="windows-1252"?>\n${rse('0 0\n0.5 20\n1 0').replace('mfg="Home"', 'mfg="Aero\x99"')}`;
    const bytes = Uint8Array.from(text, c => c.charCodeAt(0));
    const out = await importMotorFiles([new File([bytes], `legacy.${extension}`)]);
    expect(out.error).toBeNull();
    expect(out.parsed[0]?.realManufacturer).toBe('Aero\u2122');
    expect(loadExMotors()[0]?.realManufacturer).toBe('Aero\u2122');
    expect(out.notice).not.toContain('RASP file');
  });

  it('S1c-4 refuses kg-to-gram overflow before reporting a persisted import', async () => {
    const out = await importMotorFiles([new File([eng(undefined, '1e308 1e308')], 'overflow.eng')]);
    expect(out.parsed).toHaveLength(0);
    expect(out.write).toBeNull();
    expect(out.error).toMatch(/mass/i);
    expect(loadExMotors()).toHaveLength(0);
  });

  it('S1c-5 reads single-quoted RSE header masses', () => {
    expect(headerMasses({ format: 'RockSim', data: btoa("<engine initWt='100' propWt='50'/>") }))
      .toEqual({ totalWeightG: 100, propWeightG: 50 });
  });

  it('S1c-b3 preserves Latin-1 RASP maker names across persistence', async () => {
    const bytes = Uint8Array.from(eng(undefined, undefined, 'Cr\xe9ateur'), c => c.charCodeAt(0));
    const out = await importMotorFiles([new File([bytes], 'legacy.eng')]);
    expect(out.parsed[0]?.realManufacturer).toBe('Cr\xe9ateur');
    expect(loadExMotors()[0]?.realManufacturer).toBe('Cr\xe9ateur');
    expect(out.notice).toMatch(/encoding|8859|Latin/i);
  });

  it.each([
    [{ time: 0, thrust: 10 }],
    [{ time: 0, thrust: 10 }, { time: 0, thrust: 10 }],
  ])('S1c-g3 refuses a curve that has fewer than two flown points (%j)', (...samples) => {
    expect(isSampleList(samples)).toBe(false);
    expect(pickSampleFile([{ format: 'RASP', samples }])).toBeNull();
  });

  it.each(['eng', 'rse'])('S1c-g4 repairs large coincident timestamps in %s before persistence', format => {
    const curve = '0 0\n100000000000 10\n100000000000 20\n100000000001 0';
    const motor = (format === 'eng' ? parseEng(eng(curve)) : parseRse(rse(curve)))[0]!;
    const flown = flownCurve(motor.samples).samples;
    expect(flown.every((p, i) => Number.isFinite(p.time) && (i === 0 || p.time > flown[i - 1]!.time))).toBe(true);
    expect(validExMotor(motor)).toBe(true);
    expect(addExMotors([motor]).stored).toBe(true);
    expect(loadExMotors()).toHaveLength(1);
  });

  it.each(['eng', 'rse'])('S1c-g5 refuses thrust above the kernel maximum in %s', format => {
    const curve = '0 0\n0.5 20000000\n1 0';
    expect(() => format === 'eng' ? parseEng(eng(curve)) : parseRse(rse(curve))).toThrow(/Audit.*thrust/i);
  });

  it('S1c-g5 rejects oversized cached/library/snapshot thrust while accepting the bound', () => {
    const motor = parseEng(eng())[0]!;
    const samples = [{ time: 0, thrust: 0 }, { time: 1, thrust: 20000000 }];
    expect(validExMotor({ ...motor, samples })).toBe(false);
    expect(isSampleList(samples)).toBe(false);
    expect(validFlightSnapshot({ ...exToMotorSpec(motor, 5), thrusts: [0, 20000000, 0] })).toBe(false);
    expect(isSampleList([{ time: 0, thrust: 0 }, { time: 1, thrust: 10000000 }])).toBe(true);
  });

  it('S1c-g6 falls back to the captured definition when a snapshot starts after zero', () => {
    const definition = parseEng(eng())[0]!;
    const spec = { ...exToMotorSpec(definition, 5), times: [0.1, 0.5, 1], exDefinition: definition };
    expect(validFlightSnapshot(spec)).toBe(false);
    const archive = archiveExMotors([{ designation: 'Audit', diameter: 0.029, length: 0.1, delay: 5,
      exMotorSpec: spec, exMotorId: definition.motorId }], []);
    const saved = JSON.parse(archive.json!) as unknown[];
    expect(saved).toEqual([definition]);
  });
});
