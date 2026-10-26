// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { addExMotors, loadExMotors, parseEng, parseRse, validExMotor, validFlightSnapshot } from './exMotors.js';
import { importMotorFiles } from './importMotorFiles.js';
import { MAX_EX_IMPORT_MOTORS } from './exMotorLimits.js';
import { readArchivedExMotors } from './exMotorArchive.js';
import { jsXmlParser } from './xmlParseJs.js';
import { escapeXml } from './xmlUtil.js';

afterEach(() => localStorage.clear());
const rse = (attrs: string, masses = ['10', '8', '6.93'], dia = '18') => `<engine-database><engine code="Boundary" mfg="Home" dia="${dia}" len="100" ${attrs}><data>${masses.map((m, i) => `<eng-data t="${i}" f="${i === 1 ? 20 : 0}" m="${m}"/>`).join('')}</data></engine></engine-database>`;

it('ignores RSE engines under unknown wrappers while keeping desktop-recognized wrappers', () => {
  const engine = rse('initWt="10" propWt="3"').replace('<engine-database>', '').replace('</engine-database>', '');
  const hidden = `<unknown>${engine.replace('Boundary', 'Hidden')}</unknown>`;
  expect(parseRse(`<engine-database>${hidden}<engine-list>${engine}</engine-list></engine-database>`).map(m => m.designation)).toEqual(['Boundary']);
  expect(() => parseRse(hidden)).toThrow(/No <engine>/);
  expect(parseRse(engine).map(m => m.designation)).toEqual(['Boundary']);
});

it.each(['<unknown><data>$</data></unknown>', '<data><unknown>$</unknown></data>'])('does not read RSE samples through an unknown wrapper: %s', wrapper => {
  const xml = rse('initWt="10" propWt="3"');
  const samples = /<data>(.*)<\/data>/.exec(xml)![1]!;
  const hidden = wrapper.replace('$', samples);
  expect(() => parseRse(xml.replace(/<data>.*<\/data>/, hidden))).toThrow(/Boundary: no thrust data/);
  const withHidden = wrapper.startsWith('<data>')
    ? xml.replace('</data>', `${hidden.slice(6, -7)}</data>`)
    : xml.replace('</engine>', `${hidden}</engine>`);
  expect(parseRse(withHidden)[0]!.samples).toEqual([
    { time: 0, thrust: 0 }, { time: 1, thrust: 20 }, { time: 2, thrust: 0 },
  ]);
});

it('diagnoses per-point mass from the recognized RSE data, ignoring hidden data', () => {
  const xml = rse('initWt="10" propWt="3" auto-calc-mass="0"', ['', '8', '7']);
  const hidden = '<unknown><data><eng-data t="0" f="0" m="3"/></data></unknown>';
  const notes: string[] = [];
  expect(parseRse(xml.replace('<data>', `${hidden}<data>`), notes)).toHaveLength(1);
  expect(notes.join(' ')).toContain('point 1 of 3 has a blank m');
});

it.each([
  ['initWt="10" propWt="3" auto-calc-mass="0"', '18'],
  ['initWt="10" propWt="3" exitDia="13.5"', '18'],
  ['initWt="10" propWt="3" exitDia="2.55"', '17'],
])('RSE optional fields survive the library gate: %s', (attrs, dia) => {
  const [motor] = parseRse(rse(attrs, undefined, dia));
  expect(validExMotor(motor)).toBe(true);
  expect(addExMotors([motor!]).stored).toBe(true);
  expect(loadExMotors()).toHaveLength(1);
  const loaded = loadExMotors()[0]!;
  if (attrs.includes('auto-calc-mass')) expect(loaded.sampleMassesKg).toEqual([10, 8, 6.93].map(g => g / 1000));
  else expect(loaded.exitDiameterM).toBe(Number(/exitDia="([^"]+)"/.exec(attrs)![1]) / 1000);
});

it('does not persist an overflowing per-point mass', async () => {
  const out = await importMotorFiles([new File([rse('initWt="1.79e308" propWt="1e308" auto-calc-mass="0"', ['1.009e308', '0.5e308', '0'])], 'overflow.rse')]);
  expect(out.parsed).toHaveLength(1);
  expect(validExMotor(out.parsed[0])).toBe(true);
  expect(loadExMotors()).toHaveLength(1);
  expect(out.parsed[0]!.sampleMassesKg!.every(Number.isFinite)).toBe(true);
});

it.each([-1, 5, NaN, Infinity])('refuses snapshot CG outside its motor: %s', cgX => {
  expect(validFlightSnapshot({ designation: 'CG', diameter: 0.018, length: 0.1,
    times: [0, 1], thrusts: [0, 20], masses: [0.02, 0.01], cgX })).toBe(false);
});

it.each(['eng', 'rse'])('refuses an all-zero %s motor by name', format => {
  expect(() => format === 'eng' ? parseEng('Zero 29 100 P 0.05 0.1 Home\n0.5 0\n1 0')
    : parseRse(rse('initWt="10" propWt="3"').replace('f="20"', 'f="0"')))
    .toThrow(/Zero|Boundary/);
});

it('refuses an all-zero embedded motor and explains why', () => {
  const motor = parseEng('Zero 29 100 P 0.05 0.1 Home\n0 0\n1 20\n2 0')[0]!;
  motor.samples.forEach(point => { point.thrust = 0; });
  const notes: string[] = [];
  const rocket = jsXmlParser(`<rocket><mmrexmotors version="1">${escapeXml(JSON.stringify([motor]))}</mmrexmotors></rocket>`).documentElement;
  expect(readArchivedExMotors(rocket, notes).size).toBe(0);
  expect(notes.join('\n')).toMatch(/Zero.*no positive thrust/);
});

it('refuses a huge motor collection with a named count limit rather than a stack error', async () => {
  const out = await importMotorFiles([new File(['E 29 100 P 0.05 0.1 Home\n0 0\n1 20\n2 0\n'.repeat(150_000)], 'many.eng')]);
  expect(out.write).toBeNull();
  expect(out.error).toMatch(/motor count limit/i);
});

it('refuses aggregate bytes before reading the selection', async () => {
  const files = Array.from({ length: 3 }, (_, i) => new File(['not read'], `${i}.eng`));
  for (const file of files) Object.defineProperty(file, 'size', { value: 16 * 1024 * 1024 });
  const out = await importMotorFiles(files);
  expect(out.write).toBeNull();
  expect(out.error).toMatch(/selection.*limit/i);
});

it('imports the first 1000 motor files by path, ignores txt and reports the skipped count', async () => {
  const files = Array.from({ length: 1002 }, (_, i) => {
    const file = new File([`E${i} 29 100 P 0.05 0.1 Home\n0 0\n1 20\n2 0`], `${i}.eng`);
    Object.defineProperty(file, 'webkitRelativePath', { value: `folder/${String(i).padStart(4, '0')}.eng` });
    return file;
  }).reverse();
  const txt = new File(['ignored'], '0000.txt');
  Object.defineProperty(txt, 'size', { value: 32 * 1024 * 1024 });
  const out = await importMotorFiles([txt, ...files]);
  expect(out.parsed).toHaveLength(1000);
  expect(out.parsed[0]!.designation).toBe('E0');
  expect(out.parsed.at(-1)!.designation).toBe('E999');
  expect(out.notice).toMatch(/skipped 2.*1000.*file/i);
});

it('still reports the file count truncation when every selected motor file is invalid', async () => {
  const file = new File(['invalid'], 'bad.eng');
  const out = await importMotorFiles(Array.from({ length: 1001 }, () => file));
  expect(out.write).toBeNull();
  expect(out.notice).toMatch(/skipped 1.*1000.*file/i);
});

it.each(['zero thrust', 'outside CG'])('keeps valid embedded motors beside a legacy snapshot with %s', defect => {
  const good = parseEng('Good 29 100 P 0.05 0.1 Home\n0 0\n1 20\n2 0')[0]!;
  const bad = { ...good, motorId: 'ex:bad', designation: 'Bad', flightSnapshot: {
    designation: 'Bad', diameter: 0.029, length: 0.1, cgX: defect === 'outside CG' ? 5 : 0.05,
    times: [0, 1, 2], thrusts: defect === 'zero thrust' ? [0, 0, 0] : [0, 20, 0], masses: [0.1, 0.08, 0.05],
  } };
  const notes: string[] = [];
  const rocket = jsXmlParser(`<rocket><mmrexmotors version="1">${escapeXml(JSON.stringify([bad, good]))}</mmrexmotors></rocket>`).documentElement;
  expect([...readArchivedExMotors(rocket, notes).keys()]).toEqual([good.motorId]);
  expect(notes.join('\n')).toMatch(/Embedded EX motor Bad was not loaded/);
});

it('refuses repeated direct RSE data blocks per motor', () => {
  const bad = rse('initWt="10" propWt="3"').replace('</data>', '</data><data><eng-data t="3" f="0"/></data>');
  expect(() => parseRse(bad)).toThrow(/Boundary:.*multiple.*data/i);
  const good = rse('initWt="10" propWt="3"').replace('Boundary', 'Good').replace('<engine-database>', '').replace('</engine-database>', '');
  const notes: string[] = [];
  expect(parseRse(bad.replace('</engine-database>', `${good}</engine-database>`), notes).map(m => m.designation)).toEqual(['Good']);
  expect(notes.join(' ')).toMatch(/Boundary:.*multiple.*data/i);
});

it('bounds the RSE sibling collection before converting its engines', () => {
  const engine = rse('initWt="10" propWt="3"').replace('<engine-database>', '').replace('</engine-database>', '');
  expect(() => parseRse(`<engine-database>${engine.repeat(MAX_EX_IMPORT_MOTORS + 1)}</engine-database>`)).toThrow(/motor count limit/i);
});

it('bounds the aggregate motor count across separate under-limit collections', async () => {
  const half = Math.floor(MAX_EX_IMPORT_MOTORS / 2) + 1;
  const eng = 'E 29 100 P 0.05 0.1 Home\n0 0\n1 20\n2 0\n'.repeat(half);
  const out = await importMotorFiles([new File([eng], 'a.eng'), new File([eng], 'b.eng')]);
  expect(out.parsed).toHaveLength(half);
  expect(out.error).toMatch(/motor count limit/i);
});

it('refuses invalid motor data before any library write', () => {
  const motor = { ...parseEng('Invalid 29 100 P 0.05 0.1 Home\n0 0\n1 20\n2 0')[0]!, sampleMassesKg: [Infinity, 0.1, 0.05] };
  expect(() => addExMotors([motor])).toThrow(/Motor Invalid:.*not stored/);
  expect(loadExMotors()).toHaveLength(0);
});
