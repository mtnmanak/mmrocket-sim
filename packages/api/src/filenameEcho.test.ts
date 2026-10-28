import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { worker } from './index.js';
import { filenameEcho } from './filenameEcho.js';
import { bytesOf } from './fixtures.testSupport.js';
import { describeFile, simulateFile } from '../../app/src/headless/index.js';
import { decodeShareFragment } from '../../app/src/services/shareLink.js';

const APP_URL = 'https://mmrsim.mountainmanrockets.com';
const ctx = { waitUntil: (_p: Promise<unknown>) => {} };
const post = (route: string, filename: string, body: BodyInit, headers?: HeadersInit) => worker.fetch(
  new Request(`http://local${route}?filename=${encodeURIComponent(filename)}`, { method: 'POST', body, headers }), undefined, ctx);
const ROUTES = ['/experimental/fly', '/describe'] as const;

// Each listed code point a client's log or terminal could act on; JSON escapes only the first two.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const LONE_SURROGATE = /[\ud800-\udfff]/u;
const ROCKET = '\u{1f680}';
/**
 * 10,000 UTF-16 code units: NUL, ESC, RLO and the other listed characters up front, then
 * an astral character on code units 182 and 183, where a code-unit cut would split it, and
 * a .ork tail.
 */
function hostileName(length = 10_000) {
  const head = '\u0000\u001b\u202e\u007f\u0085\u2028\u2029\u2066\u061c\u200e\u200f';
  const before = head + 'a'.repeat(182 - head.length);
  const tail = '-final.ork';
  return before + ROCKET + 'b'.repeat(length - before.length - ROCKET.length - tail.length) + tail;
}
/** The echoed name: everything before the first ': ' of the message (the names here hold none). */
const echoOf = (message: string) => message.slice(0, message.indexOf(': '));
function expectBounded(message: string) {
  expect(message).toContain(APP_URL);
  const echo = echoOf(message);
  expect(Array.from(echo).length).toBeLessThanOrEqual(200);
  expect(echo).not.toMatch(UNSAFE);
  expect(echo).not.toMatch(LONE_SURROGATE);
  expect(echo.endsWith('.ork')).toBe(true);
  expect(echo).toContain('\u2026');
  return echo;
}
async function refused(response: Response, status: number, code: string) {
  const json = await response.json() as { error: { code: string; message: string } };
  expect(response.status, JSON.stringify(json)).toBe(status);
  expect(json.error.code).toBe(code);
  return json.error.message;
}

describe('a caller filename echoed in an error is bounded and made safe for display', () => {
  it.each(ROUTES)('%s: a body over 8 MiB', async route => {
    const name = hostileName();
    expect(name).toHaveLength(10_000);
    const message = await refused(await post(route, name, new Uint8Array(8 * 1024 * 1024 + 1)), 413, 'FILE_TOO_LARGE');
    expect(message).toMatch(/the API body limit is 8 MiB/);
    const echo = expectBounded(message);
    // The astral character on the code-unit cut survives whole.
    expect(echo).toContain(ROCKET);
  });

  it.each(ROUTES)('%s: XML inflating past 16 MiB', async route => {
    const body = zipSync({ 'rocket.ork': new Uint8Array(16 * 1024 * 1024 + 1) });
    const message = await refused(await post(route, hostileName(), body), 413, 'FILE_TOO_LARGE');
    expect(message).toMatch(/the API inflated XML limit is 16 MiB/);
    expectBounded(message);
  });

  it.each(ROUTES)('%s: the XML structure budget', async route => {
    const body = `<openrocket><rocket>${'<x/>'.repeat(50_000)}</rocket></openrocket>`;
    const message = await refused(await post(route, hostileName(), body), 413, 'FILE_TOO_LARGE');
    expect(message).toMatch(/XML element limit is 50,000\./);
    expectBounded(message);
  });

  it('/describe: a design too large for a share link', async () => {
    const reference = strFromU8(unzipSync(bytesOf('reference.ork'))['rocket.ork']!);
    const xml = reference.replace('<name>Nose Cone</name>', `<name>Nose Cone</name><comment>${'x'.repeat(4 * 1024 * 1024 + 1)}</comment>`);
    const message = await refused(await post('/describe', hostileName(), zipSync({ 'rocket.ork': strToU8(xml) })), 413, 'LINK_TOO_LARGE');
    expect(message).toMatch(/too large for a share link/);
    expectBounded(message);
  });

  it.each(ROUTES)('%s: a 200-code-point name is echoed unchanged; 201 is cut', async route => {
    // Astral characters count once each: 200 code points, 210 UTF-16 code units.
    const at = (points: number) => ROCKET.repeat(10) + 'n'.repeat(points - 10 - 4) + '.ork';
    const declared = { 'Content-Length': String(8 * 1024 * 1024 + 1) };
    const kept = await refused(await post(route, at(200), 'x', declared), 413, 'FILE_TOO_LARGE');
    expect(kept).toBe(`${at(200)}: the API body limit is 8 MiB; received 8,388,609 bytes. Use ${APP_URL} for larger files.`);
    const cut = echoOf(await refused(await post(route, at(201), 'x', declared), 413, 'FILE_TOO_LARGE'));
    expect(Array.from(cut)).toHaveLength(200);
    expect(cut).toBe(Array.from(at(201)).slice(0, 183).join('') + '\u2026' + 'n'.repeat(12) + '.ork');
  });

  it('keeps the full name for the importer: a cut name still opens as .rkt', async () => {
    // Every byte past 183 code points is cut from the echo, not from the dispatch: the .rkt
    // extension sits only in the tail, and the RockSim importer's own refusal names its format.
    const name = 'r'.repeat(300) + '.rkt';
    const response = await post('/experimental/fly', name, '<RockSimDocument><x></RockSimDocument>');
    const message = await refused(response, 400, 'INVALID_FILE');
    expect(message).toContain('Not a valid RockSim file');
  });

  it('names a generic design from the full filename, then bounds that name', async () => {
    // The fallback is computed from the WHOLE name and then cut: 5 + 300 code points keep
    // 183, the marker and the last 16. Passing the cut echo in as the filename instead would
    // leave only 12 of the tail's n (its last 4 being ".ork") and 196 code points.
    const reference = strFromU8(unzipSync(bytesOf('reference.ork'))['rocket.ork']!);
    const generic = reference.replace('<name>Reference Rocket</name>', '<name>Rocket</name>');
    expect(generic).not.toBe(reference);
    const response = await post('/describe', `Long_${'n'.repeat(300)}.ork`, zipSync({ 'rocket.ork': strToU8(generic) }));
    expect(response.status, await response.clone().text()).toBe(200);
    const { name } = (await response.json()) as { name: string };
    expect(name).toBe(`Long ${'n'.repeat(178)}\u2026${'n'.repeat(16)}`);
    expect(Array.from(name)).toHaveLength(200);
  });
});

/** Own-name text a design file can carry (XML 1.0 has no C0 but tab, LF, CR): 10,000 code points. */
function hostileText(points = 10_000) {
  const head = '\u0085\u202e\u007f\u2028\u2029\u2066\u061c\u200e\u200f\tx';
  const before = head + 'a'.repeat(182 - head.length);
  return before + ROCKET + 'b'.repeat(points - Array.from(before).length - 3) + 'zz';
}
const xmlText = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
/** A name the API returns: within the bound, safe, and exactly the rule's cut of what the importer read. */
function expectBoundedName(shown: string, read: string) {
  expect(Array.from(read).length).toBeGreaterThan(200);
  expect(Array.from(shown).length).toBeLessThanOrEqual(200);
  expect(shown).not.toMatch(UNSAFE);
  expect(shown).not.toMatch(LONE_SURROGATE);
  expect(shown).toBe(filenameEcho(read));
}
const referenceXml = () => strFromU8(unzipSync(bytesOf('reference.ork'))['rocket.ork']!);
const withOrkName = (xml: string, name: string) => xml.replace(/(<rocket>\s*<name>)[^<]*(<\/name>)/, `$1${xmlText(name)}$2`);
const ctxOracle = { network: 'forbid', reportSeries: 'summary', minTimeStepS: 0.05 } as const;

describe('the design name the API returns is bounded as a filename echo is (owner ruling 113-14a)', () => {
  const cases = [
    { label: 'a generic <name> named from a 10,000-code-point hostile filename', filename: hostileName(),
      body: () => zipSync({ 'rocket.ork': strToU8(withOrkName(referenceXml(), 'Rocket')) }) },
    { label: 'a hostile 10,000-code-point <name> of its own', filename: 'own.ork',
      body: () => zipSync({ 'rocket.ork': strToU8(withOrkName(referenceXml(), hostileText())) }) },
  ];

  it.each(cases)('/describe: $label: name, fragment and import note', async ({ filename, body }) => {
    const read = (await describeFile(body(), filename)).name;
    const response = await post('/describe', filename, body());
    expect(response.status, (await response.clone().text()).slice(0, 500)).toBe(200);
    const out = await response.json() as { name: string; fragment: string; notes: { import: { text: string } } };
    expectBoundedName(out.name, read);
    const fragmentXml = await decodeShareFragment(out.fragment);
    const fragmentName = /<rocket>\s*<name>([^<]*)<\/name>/.exec(fragmentXml)![1]!.replaceAll('&lt;', '<').replaceAll('&amp;', '&');
    expect(fragmentName).toBe(out.name);
    expect(out.notes.import.text.startsWith(`Loaded “${out.name}”.`)).toBe(true);
  });

  it.each(cases)('/experimental/fly: $label: import note', async ({ filename, body }) => {
    const read = (await simulateFile(body(), filename, ctxOracle)).state.tree.name!;
    const response = await post('/experimental/fly', filename, body());
    expect(response.status, (await response.clone().text()).slice(0, 500)).toBe(200);
    const out = await response.json() as { notes: { import: { text: string } } };
    const shown = /^Loaded “([^”]*)”\./.exec(out.notes.import.text)![1]!;
    expectBoundedName(shown, read);
  });

  it('/experimental/fly: an aborted flight names its branch with the bounded name', async () => {
    // Show-off.CDX1 aborts (recovery under thrust); a RASAero design is named by its comment's first line.
    const cdx = strFromU8(bytesOf('Show-off.CDX1')).replace('<Comments>Comments are for suckers.', `<Comments>${xmlText(hostileText())}`);
    const read = (await simulateFile(strToU8(cdx), 'Show-off.CDX1', ctxOracle)).state.tree.name!;
    const response = await post('/experimental/fly', 'Show-off.CDX1', strToU8(cdx));
    expect(response.status, (await response.clone().text()).slice(0, 500)).toBe(200);
    const out = await response.json() as { outcome: string; aborts: { branch: string }[] };
    expect(out.outcome).toBe('aborted');
    expect(out.aborts.length).toBeGreaterThan(0);
    for (const abort of out.aborts) expectBoundedName(abort.branch, read);
  });

  it('a 422 carries the bounded name in its import note', async () => {
    // unit-site-notes.ork names no motor: NO_MOTOR, with the import note.
    const xml = strFromU8(bytesOf('unit-site-notes.ork')).replace('<name>Unit site notes</name>', `<name>${xmlText(hostileText())}</name>`);
    const response = await post('/experimental/fly', 'notes.ork', strToU8(xml));
    const out = await response.json() as { error: { code: string; importNote: { text: string } } };
    expect(response.status).toBe(422);
    expect(out.error.code).toBe('NO_MOTOR');
    const shown = /^Loaded “([^”]*)”\./.exec(out.error.importNote.text)![1]!;
    const read = /^Loaded “([^”]*)”\./.exec((await simulateFile(strToU8(xml), 'notes.ork', ctxOracle)
      .catch((e: { importNote: { text: string } }) => e)).importNote.text)![1]!;
    expectBoundedName(shown, read);
  });

  it.each(ROUTES)('%s: a name within the bound with nothing to replace is unchanged', async route => {
    const name = `${ROCKET.repeat(10)}${'n'.repeat(190)}`;
    const response = await post(route, 'own.ork', zipSync({ 'rocket.ork': strToU8(withOrkName(referenceXml(), name)) }));
    expect(response.status).toBe(200);
    const text = ((await response.json()) as { notes: { import: { text: string } } }).notes.import.text;
    expect(text.startsWith(`Loaded “${name}”.`)).toBe(true);
  });
});

describe('filenameEcho for a direct caller', () => {
  it('shows every Unicode bidi control as ?, the marks ALM, LRM and RLM included', () => {
    const bidiControls = '؜‎‏‪‫‬‭‮⁦⁧⁨⁩';
    expect(Array.from(bidiControls).every(ch => /\p{Bidi_Control}/u.test(ch))).toBe(true);
    const all = Array.from({ length: 0x10000 }, (_, c) => String.fromCharCode(c)).filter(ch => /\p{Bidi_Control}/u.test(ch)).join('');
    expect(all).toBe(bidiControls);
    expect(filenameEcho(`a${bidiControls}b.ork`)).toBe(`a${'?'.repeat(12)}b.ork`);
  });

  it('shows a lone surrogate as ?, keeping a paired one, inside and past the bound', () => {
    // URL decoding never yields a lone surrogate (it gives U+FFFD), but a direct caller can pass one.
    expect(filenameEcho('a\ud800b\udc00c\u{1f680}.ork')).toBe('a?b?c\u{1f680}.ork');
    const long = filenameEcho('\udfff' + 'x'.repeat(300) + '\ud83d.ork');
    expect(long).not.toMatch(LONE_SURROGATE);
    expect(long.startsWith('?')).toBe(true);
    expect(long.endsWith('?.ork')).toBe(true);
    expect(Array.from(long)).toHaveLength(200);
  });
});
