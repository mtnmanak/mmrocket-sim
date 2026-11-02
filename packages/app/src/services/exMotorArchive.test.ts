import { expect, it } from 'vitest';
import { readArchivedExMotors } from './exMotorArchive.js';
import { jsXmlParser } from './xmlParseJs.js';
import { escapeXml } from './xmlUtil.js';
import { parseEng } from './exMotors.js';

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
