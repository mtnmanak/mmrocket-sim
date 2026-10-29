import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { authenticatedWorker as worker } from './auth.testSupport.js';
import * as headless from '../../app/src/headless/index.js';
import { vi } from 'vitest';
import { noteStrings, warningEcho } from './fileStrings.js';
import { bytesOf } from './fixtures.testSupport.js';

/** Hostile file text is bounded at the API display boundary. */
const ctx = { waitUntil: (_p: Promise<unknown>) => {} };
const post = (route: string, filename: string, body: Uint8Array) => worker.fetch(
  new Request(`http://local${route}?filename=${encodeURIComponent(filename)}`, { method: 'POST', body: new Uint8Array(body).buffer }), undefined, ctx);
const LONG = 'L'.repeat(5000) + '\u202e';
const points = (text: string) => Array.from(text).length;
function clean(value: unknown): void {
  if (typeof value === 'string') {
    expect(points(value)).toBeLessThanOrEqual(4000);
    expect(value).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u);
  } else if (Array.isArray(value)) value.forEach(clean);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'fragment' || key === 'link') continue;
      // Aggregated notes are reconstructed from separately bounded entries.
      if (key === 'text' && 'group' in value && typeof item === 'string') {
        expect(item).not.toMatch(/[\r\t\u202e]/u);
      } else clean(item);
    }
  }
}
const reference = () => strFromU8(unzipSync(bytesOf('reference.ork'))['rocket.ork']!);
const ork = (xml: string) => zipSync({ 'rocket.ork': strToU8(xml) });

describe('file-derived names and notes are safe at the API edge', () => {
  it('/describe mounts[].name and mounts[].stageName', async () => {
    const xml = reference().replace('<name>Inner Tube</name>', `<name>${LONG}</name>`).replace(/(<stage>\s*<name>)Sustainer/, `$1${LONG}`);
    const out = await (await post('/describe', 'parts.ork', ork(xml))).json() as { mounts: { name: string; stageName: string }[] };
    clean(out);
    expect(points(out.mounts[0]!.name)).toBeLessThanOrEqual(200);
    expect(points(out.mounts[0]!.stageName)).toBeLessThanOrEqual(200);
  });

  it('/experimental/fly motors[].mount', async () => {
    const xml = reference().replace('<name>Inner Tube</name>', `<name>${LONG}</name>`);
    const out = await (await post('/experimental/fly', 'mount.ork', ork(xml))).json() as { motors: { mount: string }[] };
    clean(out);
    expect(points(out.motors[0]!.mount)).toBeLessThanOrEqual(200);
  }, 60_000);

  it('/experimental/fly warnings[].message quotes component names', async () => {
    const rkt = strFromU8(bytesOf('TubeFins2.rkt')).replace('<Name>Nose cone</Name>', `<Name>${LONG}</Name>`);
    const out = await (await post('/experimental/fly', 'TubeFins2.rkt', strToU8(rkt))).json() as { warnings: { message: string }[] };
    expect(out.warnings.length).toBeGreaterThan(0);
    for (const warning of out.warnings) clean(warning.message);
  }, 60_000);

  it('a quoted motor designation in notes and in a 422 importNote', async () => {
    const xml = reference().replace('<designation>C6</designation>', `<designation>${LONG}</designation>`);
    const response = await post('/experimental/fly', 'motor.ork', ork(xml));
    const out = await response.json() as { error?: { importNote: { text: string } }; notes?: { import: { text: string } } };
    const note = out.error?.importNote.text ?? out.notes!.import.text;
    clean(out.error?.importNote ?? out.notes!.import);
    expect(note).not.toContain(LONG);
  }, 60_000);
});

it('bounds every fly text carrier, including warning source snapshots and abort event sources', async () => {
  const out = await headless.simulateFile(bytesOf('reference.ork'), 'reference.ork', { reportSeries: 'summary' });
  const mount = out.flight.delayResolution.mounts[0]!;
  mount.mountName = LONG;
  const motor = out.state.mountMotors[mount.mountId]!;
  out.state.mountMotors[mount.mountId] = { ...motor, spec: { ...motor.spec, designation: LONG },
    meta: { ...motor.meta, manufacturer: LONG } };
  out.state.tree.name = LONG;
  out.result.events.push({ type: 'EXCEPTION', time: 1, source: LONG });
  out.build.motorFailures.push({ mountId: mount.mountId, text: LONG });
  out.run.simWarnings = [{ key: 'Other', message: LONG, sources: [{ name: LONG }] }];
  out.importNote.text = LONG;
  out.run.comments = LONG;
  headless.motorMounts(out.state.tree)[0]!.name = LONG;
  const spy = vi.spyOn(headless, 'simulateFile').mockResolvedValue(out);
  try {
    const response = await post('/experimental/fly', 'hostile.ork', bytesOf('reference.ork'));
    expect(response.status).toBe(200);
    const result = await response.json() as { motors: { designation: string; manufacturer: string; mount: string }[]; aborts: { branch: string; event: { source: string } }[] };
    clean(result);
    for (const motor of result.motors) for (const name of [motor.mount, motor.designation, motor.manufacturer]) expect(points(name)).toBeLessThanOrEqual(200);
    expect(points(result.aborts[0]!.branch)).toBeLessThanOrEqual(200);
    expect(points(result.aborts[0]!.event.source)).toBeLessThanOrEqual(200);
  } finally { spy.mockRestore(); }
});

it('bounds nested import metadata and notes while retaining structural line breaks', () => {
  const original = { text: 'First line.\nOrdinary.', group: { heading: 'First line.', lines: [{ part: 'Tube', configuration: 'Flight', text: 'Ordinary.' }] } };
  expect(noteStrings(original)).toEqual(original);
  const result = noteStrings({ text: LONG, group: { lines: [{ part: LONG, configuration: LONG, text: LONG }] } });
  clean(result);
  expect(points(result.group.lines[0]!.part)).toBeLessThanOrEqual(200);
  expect(points(result.group.lines[0]!.configuration)).toBeLessThanOrEqual(200);
  expect(warningEcho('Warning: "' + 'L'.repeat(300) + '"')).not.toContain('L'.repeat(300));
});
it.each(['/describe', '/experimental/fly'])('sanitises %s error messages and nested import notes', async route => {
  const note = { text: LONG, severity: 'warn' as const, group: { lines: [{ part: LONG, configuration: LONG, text: LONG }] } };
  const failure = new headless.SimulateDesignError('build', LONG, { importNote: note });
  const spy = vi.spyOn(headless, route === '/describe' ? 'describeFile' : 'simulateFile').mockRejectedValue(failure);
  try {
    const response = await post(route, 'refused.ork', bytesOf('reference.ork'));
    expect(response.status).toBe(422);
    const out = await response.json() as { error: { importNote: typeof note } };
    clean(out);
    expect(points(out.error.importNote.group.lines[0]!.part)).toBeLessThanOrEqual(200);
  } finally { spy.mockRestore(); }
});

it('strips short unsafe note characters and replaces short unsafe name characters', async () => {
  const short = 'left\u202eright\u0000';
  expect(noteStrings({ text: short })).toEqual({ text: 'leftright' });
  expect(noteStrings({ part: short })).toEqual({ part: 'left?right?' });
  const normal = await headless.describeFile(bytesOf('reference.ork'), 'reference.ork');
  normal.notes.import.text = short;
  normal.notes.analysis.push(short);
  normal.notes.export.push(short);
  normal.mounts[0]!.name = short;
  normal.mounts[0]!.stageName = short;
  const spy = vi.spyOn(headless, 'describeFile').mockResolvedValue(normal);
  try {
    const out = await (await post('/describe', 'safe.ork', bytesOf('reference.ork'))).json() as typeof normal;
    expect(out.mounts[0]!.name).toBe('left?right?');
    expect(out.mounts[0]!.stageName).toBe('left?right?');
    expect(out.notes.import.text).toBe('leftright');
    expect(out.notes.analysis).toContain('leftright');
    expect(out.notes.export).toContain('leftright');
    clean(out);
  } finally { spy.mockRestore(); }
});

it('removes file line controls inside entries and rebuilds only structural newlines', () => {
  const result = noteStrings({ text: 'obsolete', group: { heading: 'Loaded.', lines: [
    { text: 'Motor \u201cUNKNOWN\rINJECT\nFAKE\tTAB\u201d.', part: 'PART\rINJECT\nFAKE\tTAB' },
    { text: 'Next entry.' },
  ] } });
  expect(result.text).toBe('Loaded.\nMotor \u201cUNKNOWNINJECTFAKE TAB\u201d.\nNext entry.');
  expect(result.group.lines[0]!.text).not.toMatch(/[\r\n\t]/);
  expect(result.group.lines[0]!.part).not.toMatch(/[\r\n\t]/);
});
it('keeps the end of a large aggregate while bounding each note entry', () => {
  const lines = Array.from({ length: 100 }, (_, i) => ({ text: 'Entry ' + i + ': ' + 'ordinary '.repeat(10) }));
  const text = ['Loaded.', ...lines.map(line => line.text)].join('\n');
  expect(text.length).toBeGreaterThan(4000);
  expect(noteStrings({ text, group: { heading: 'Loaded.', lines } })).toEqual({ text, group: { heading: 'Loaded.', lines } });
});
it.each(['unquoted ', 'unpaired "'])('bounds a warning with an %s name', prefix => {
  expect(points(warningEcho(prefix + 'x'.repeat(5000)))).toBeLessThanOrEqual(1000);
});

it.each(['/describe', '/experimental/fly'])('%s strips file line controls in real imported notes', async route => {
  const hostile = 'UNKNOWN&#13;INJECT&#10;FAKE&#9;TAB';
  const xml = reference()
    .replace('<designation>C6</designation>', '<designation>' + hostile + '</designation>')
    .replace('<name>Inner Tube</name>', '<name>PART' + hostile + '</name>')
    .replace(/<material ([^>]*)density="[^"]*"/, '<material $1density="0"')
    .replace('<name>Nose Cone</name>', '<name>COMPONENT' + hostile + '</name>');
  const response = await post(route, 'controls.ork', ork(xml));
  const result = await response.json() as { error?: { importNote: { text: string } }; notes?: { import: { text: string } } };
  expect(response.status, JSON.stringify(result)).toBe(route === '/describe' ? 200 : 422);
  const note = result.error?.importNote ?? result.notes!.import;
  expect(note.text).toContain('UNKNOWNINJECTFAKE TAB');
  expect(note.text).toContain('COMPONENTUNKNOWNINJECTFAKE TAB');
  expect(note.text).not.toMatch(/[\r\t]/);
  expect(note.text).toContain('Loaded \u201cReference Rocket\u201d.\n');
  expect(note.text).not.toContain('INJECT\nFAKE');
});

it.each(['Loaded.\n\nNext.', '\nNext.'])('keeps ordinary empty entries and headings: %j', text => {
  const note = { text, group: { heading: text.split('\n')[0], lines: [{ text: 'Next.' }] } };
  expect(noteStrings(note)).toEqual(note);
});
it('applies warning limits to kernel, rail and wake flight comments and warnings at the route', async () => {
  const out = await headless.simulateFile(bytesOf('reference.ork'), 'reference.ork', { reportSeries: 'summary' });
  const name = 'P'.repeat(3500);
  const comments = ['[Warning.X] "' + name + '"', 'Rail "' + name + '"', 'Wake "' + name + '"', 'Unquoted ' + name, 'Rail "' + 'Q'.repeat(300) + '"'];
  out.run.comments = comments.join(' | ');
  out.run.simWarnings = [{ key: 'Other', message: 'Unquoted ' + name },
    { key: 'Other', message: '[Warning.X] ' + 'T'.repeat(1200) },
    { key: 'HighSpeedDeployment', message: '', quantity: { kind: 'velocity', value: 30 },
      sources: Array.from({ length: 8 }, () => ({ name: 'S'.repeat(180) })) }];
  const spy = vi.spyOn(headless, 'simulateFile').mockResolvedValue(out);
  try {
    const response = await post('/experimental/fly', 'warnings.ork', bytesOf('reference.ork'));
    expect(response.status).toBe(200);
    const result = await response.json() as { warnings: { message: string }[]; notes: { flight: { text: string }[] } };
    expect(result.notes.flight).toHaveLength(comments.length);
    // The raw 1000-point projection precedes removal of the 12-point debug prefix.
    expect(result.warnings[1]!.message).toBe('T'.repeat(987) + '\u2026');
    for (const entry of [...result.notes.flight, ...result.warnings.map(w => ({ text: w.message }))]) {
      expect(points(entry.text)).toBeLessThanOrEqual(1000);
      for (const match of entry.text.matchAll(/"([^"]*)"/g)) expect(points(match[1]!)).toBeLessThanOrEqual(200);
    }
  } finally { spy.mockRestore(); }
});
it.each(['/describe', '/experimental/fly'])('%s removes manufacturer and part file controls before note boundaries form', async route => {
  const xml = reference().replace(/<manufacturer>[^<]*<\/manufacturer>/g, '<manufacturer>OTHER&#10;FAKE&#13;&#9;TAB</manufacturer>')
    .replace(/<material ([^>]*)density="[^"]*"/, '<material $1density="0"')
    .replace('<name>Nose Cone</name>', '<name>PART&#10;FAKE&#13;&#9;TAB</name>');
  const response = await post(route, 'source-controls.ork', ork(xml));
  const result = await response.json() as { notes: { import: { text: string } } };
  expect(response.status, JSON.stringify(result)).toBe(200);
  expect(result.notes.import.text).toContain('OTHERFAKE TAB');
  expect(result.notes.import.text).toContain('PARTFAKE TAB');
  expect(result.notes.import.text).not.toContain('OTHER\nFAKE');
  expect(result.notes.import.text).not.toMatch(/[\r\t]/);
});

it.each(['/describe', '/experimental/fly'])('%s removes designation LF before splitting a matched motor note', async route => {
  const xml = reference().replace('<designation>C6</designation>', '<designation>C&#10;6</designation>')
    .replace(/<manufacturer>[^<]*<\/manufacturer>/g, '<manufacturer>OTHER</manufacturer>');
  const response = await post(route, 'designation-controls.ork', ork(xml));
  const result = await response.json() as { notes: { import: { text: string } } };
  expect(response.status, JSON.stringify(result)).toBe(200);
  expect(result.notes.import.text).toContain('Motor \u201cC6\u201d');
  expect(result.notes.import.text).not.toContain('C\n6');
});

it.each([
  ['curly double', '\u201c', '\u201d'],
  ['straight double', '"', '"'],
])('bounds %s quoted names, including a trailing or missing close', (_label, open, close) => {
  const name = 'N'.repeat(300);
  for (const raw of [open + name + close, open + name + close + close, open + name]) {
    const result = warningEcho('Part ' + raw);
    expect(points(result)).toBeLessThanOrEqual(1000);
    expect(result).not.toContain(name);
    expect(points(result.slice(('Part ' + open).length))).toBeLessThanOrEqual(202);
  }
  expect(warningEcho('Part ' + open + 'Ordinary' + close + ' is unchanged.'))
    .toBe('Part ' + open + 'Ordinary' + close + ' is unchanged.');
});
it('holds a name with an embedded closing quote to the message bound only', () => {
  for (const raw of ['\u201cinner\u201d' + 'N'.repeat(2000) + '\u201d', '"inner"' + 'N'.repeat(2000) + '"', '""' + 'N'.repeat(2000) + '"']) {
    expect(points(warningEcho('Part ' + raw))).toBeLessThanOrEqual(1000);
  }
});
it('never cuts the app text around a name, and treats the apostrophe as text', () => {
  // The base-drag note shape: a curly-quoted name, then advisory text holding \u2019.
  const advice = 'is an aft part with its mass included in an ancestor\u2019s override of all subcomponents, so the app shows more stability margin than the rocket really has. Use Delete on this part, then run the simulation again.';
  const message = 'Possible base-drag model: \u201cBob\u2019s tail cone\u201d ' + advice;
  expect(warningEcho(message)).toBe(message);
  const between = ' and ' + 'the app text between two names stays whole. '.repeat(8);
  expect(warningEcho('"A"' + between + '"B" end.')).toBe('"A"' + between + '"B" end.');
  expect(warningEcho('Tab\there and \u201cname\u201d')).toBe('Tab here and \u201cname\u201d');
});
it.each(['/describe', '/experimental/fly'])('%s applies warning bounds to build-error names and whole messages', async route => {
  const name = 'N'.repeat(300);
  const failure = new headless.SimulateDesignError('build', 'Part \u201c' + name + '\u201d: ' + 'detail '.repeat(200));
  const spy = vi.spyOn(headless, route === '/describe' ? 'describeFile' : 'simulateFile').mockRejectedValue(failure);
  try {
    const response = await post(route, 'refused.ork', bytesOf('reference.ork'));
    expect(response.status).toBe(422);
    const out = await response.json() as { error: { code: string; message: string } };
    expect(out.error.code).toBe('DESIGN_BUILD_FAILED');
    expect(points(out.error.message)).toBeLessThanOrEqual(1000);
    expect(out.error.message).not.toContain(name);
    expect(points(out.error.message.split('\u201c')[1]!.split('\u201d')[0]!)).toBeLessThanOrEqual(200);
  } finally { spy.mockRestore(); }
});
