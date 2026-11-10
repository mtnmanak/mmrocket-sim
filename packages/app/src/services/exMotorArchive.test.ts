import { expect, it } from 'vitest';
import { readArchivedExMotors } from './exMotorArchive.js';
import { jsXmlParser } from './xmlParseJs.js';
import { escapeXml } from './xmlUtil.js';
import { parseEng } from './exMotors.js';
import { MAX_EX_MOTOR_SAMPLES, MAX_EMBEDDED_EX_MOTORS } from './exMotorLimits.js';
import { MAX_EX_ARCHIVE_BYTES } from './exMotorArchive.js';

const goodMotor = () => parseEng('T1 18 70 0 0.01 0.02 Test\n0 0\n0.1 2\n1 0')[0]!;
const archive = (raw: string, version = '1') => jsXmlParser(`<rocket><mmrexmotors version="${version}">${escapeXml(raw)}</mmrexmotors></rocket>`).documentElement;

it.each(['non-finite', 'samples', 'definition', 'null'] as const)('keeps good siblings beside %s damage', kind => {
  const good = { ...goodMotor(), motorId: 'ex:good' };
  const bad = { ...goodMotor(), designation: 'Bad', motorId: 'ex:bad' };
  if (kind === 'samples') bad.samples = Array.from({ length: MAX_EX_MOTOR_SAMPLES + 1 }, () => ({ time: 0, thrust: 0 }));
  if (kind === 'definition') bad.diameter = 0;
  const raw = kind === 'non-finite' ? JSON.stringify([bad, good]).replace('"diameter":18', '"diameter":1e999')
    : JSON.stringify([kind === 'null' ? null : bad, good]);
  const notes: string[] = [];
  expect([...readArchivedExMotors(archive(raw), notes).keys()]).toEqual(['ex:good']);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain('was not loaded:');
});

it.each([
  ['mass', { totalWeightG: 1e20, propWeightG: 1e19 }],
  ['diameter', { diameter: 2_000_000 }],
  ['length', { length: 2_000_000 }],
] as const)('HF integration: an oversized embedded motor (%s) is refused alone and good siblings load', (_kind, fields) => {
  const good = { ...goodMotor(), motorId: 'ex:good' };
  const huge = { ...goodMotor(), ...fields, designation: 'Huge', motorId: 'ex:huge' };
  const notes: string[] = [];
  expect([...readArchivedExMotors(archive(JSON.stringify([huge, good])), notes).keys()]).toEqual(['ex:good']);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain('Huge');
  expect(notes[0]).toContain('beyond the numbers the simulator can handle');
});

it('refuses every sharer of an id, even when one sharer is malformed', () => {
  for (const damaged of [false, true]) {
    const one = { ...goodMotor(), designation: 'One' };
    const two = { ...one, designation: 'Two', diameter: damaged ? 0 : one.diameter };
    const notes: string[] = [];
    expect([...readArchivedExMotors(archive(JSON.stringify([one, two, { ...goodMotor(), motorId: 'ex:third' }])), notes).keys()]).toEqual(['ex:third']);
    expect(notes).toHaveLength(2);
    expect(notes.join(' ')).toContain('shared library id');
    expect(notes[0]).toContain('One');
    expect(notes[1]).toContain('Two');
  }
});

it('retains whole-archive refusal for archive-level damage', () => {
  for (const raw of ['{', '{}', JSON.stringify(Array.from({ length: MAX_EMBEDDED_EX_MOTORS + 1 }, goodMotor)), ' '.repeat(MAX_EX_ARCHIVE_BYTES + 1)]) {
    const notes: string[] = [];
    expect(readArchivedExMotors(archive(raw), notes).size).toBe(0);
    expect(notes[0]).toContain('Embedded EX motors were refused:');
  }
  const repeated = jsXmlParser('<rocket><mmrexmotors version="1">[]</mmrexmotors><mmrexmotors version="1">[]</mmrexmotors></rocket>').documentElement;
  expect(readArchivedExMotors(repeated, []).size).toBe(0);
});

it('names a repeated duplicate designation only once', () => {
  const notes: string[] = [];
  const motor = goodMotor();
  expect(readArchivedExMotors(archive(JSON.stringify([motor, motor])), notes).size).toBe(0);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain('shared library id');
});

it.each(['', '   ', '\n', '\u0001\u0085', '\u202e\u200b'])('names a refused blank designation (%j)', designation => {
  const notes: string[] = [];
  readArchivedExMotors(archive(JSON.stringify([{ motorId: 'ex:bad', designation }])), notes);
  expect(notes[0]).toContain('Embedded EX motor (unnamed) was not loaded:');
});

it('bounds malformed names and the number of refusal notes', () => {
  const bad = { designation: 'X\n\u202e' + 'x'.repeat(10000) };
  const notes: string[] = [];
  expect(readArchivedExMotors(archive(JSON.stringify(Array.from({ length: MAX_EMBEDDED_EX_MOTORS }, () => bad))), notes).size).toBe(0);
  expect(notes).toHaveLength(MAX_EMBEDDED_EX_MOTORS);
  expect(notes.every(n => n.length < 500 && !/[\n\u202e]/.test(n))).toBe(true);
});

it('cleans a refused embedded motor name without cutting a Unicode character', () => {
  const motor = parseEng('T1 18 70 0 0.01 0.02 Test\n0 0\n0.1 2\n1 0')[0]!;
  motor.designation = 'A\n\u2028\u202e\u200b”' + 'x'.repeat(153) + '🚀';
  motor.samples = motor.samples.map(p => ({ ...p, thrust: 0 }));
  const rocket = jsXmlParser('<rocket><mmrexmotors version="1">' + escapeXml(JSON.stringify([motor])) + '</mmrexmotors></rocket>').documentElement;
  const notes: string[] = [];
  expect(readArchivedExMotors(rocket, notes).size).toBe(0);
  expect(notes[0]).toContain('A[U+202E][U+200B][U+201D]');
  expect(notes[0]).not.toMatch(/[\r\n\u2028\u202e\u200b\ud800-\udfff]/u);
});

it.each([
  ['bidi override', '\u202e'],
  ['bidi mark', '\u061c'],
  ['C1 control', '\u0085'],
  ['line separator', '\u2028'],
])('strips a %s echoed by the embedded EX JSON parser', (_label, control) => {
  const raw = '["\u6a5f\u4f53' + control + '",]';
  let parserMessage = '';
  try { JSON.parse(raw); } catch (error) { parserMessage = (error as Error).message; }
  expect(parserMessage).toContain(control);
  const rocket = jsXmlParser('<rocket><mmrexmotors version="1">' + escapeXml(raw) + '</mmrexmotors></rocket>').documentElement;
  const notes: string[] = [];

  expect(readArchivedExMotors(rocket, notes).size).toBe(0);
  expect(notes).toHaveLength(1);
  expect(notes[0]).not.toContain(control);
  expect(notes[0]).toContain('\u6a5f\u4f53');
  expect(notes[0]).toContain('Embedded EX motors were refused:');
  expect(notes[0]).toContain('Re-import the original .eng/.rse; these motors were not loaded.');
});

it('preserves ordinary embedded EX refusal text', () => {
  const rocket = jsXmlParser('<rocket><mmrexmotors version="2">[]</mmrexmotors></rocket>').documentElement;
  const notes: string[] = [];

  expect(readArchivedExMotors(rocket, notes).size).toBe(0);
  expect(notes).toEqual(['Embedded EX motors were refused: unsupported or repeated extension. Re-import the original .eng/.rse; these motors were not loaded.']);
});
