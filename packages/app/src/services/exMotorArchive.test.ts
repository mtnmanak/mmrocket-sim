import { expect, it } from 'vitest';
import { readArchivedExMotors } from './exMotorArchive.js';
import { jsXmlParser } from './xmlParseJs.js';
import { escapeXml } from './xmlUtil.js';

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
