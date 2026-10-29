import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { authenticatedWorker as worker } from './auth.testSupport.js';
import { bytesOf, stampOf } from './fixtures.testSupport.js';
import { decodeShareFragment } from '../../app/src/services/shareLink.js';

/**
 * Parser error text never reaches a response (lanes 14/15 closure check, item F).
 * saxes interpolates element, attribute and prefix names into its messages; the
 * importers turn every XmlParseError into their own fixed refusal, and the open's
 * wording reads only that message, so the parser's text rides as `cause` alone.
 * These pin each refusal exactly, so an appended echo would fail.
 */
const ctx = { waitUntil: (_p: Promise<unknown>) => {} };
const post = (route: string, filename: string, body: BodyInit) => worker.fetch(
  new Request(`http://local${route}?filename=${encodeURIComponent(filename)}`, { method: 'POST', body }), undefined, ctx);
const ROUTES = ['/experimental/fly', '/describe'] as const;
const STAMP = stampOf(await (await worker.fetch(new Request('http://local/health'), undefined, ctx)).json());

/** 10,000 code points that saxes accepts in a name: an astral name character, then a long run. */
const LONG = 'Q\u{10000}' + 'q'.repeat(9_997) + 'Z';
/** A name carrying what a log or terminal could act on: saxes refuses each, naming what it read. */
const HOSTILE = 'Q‮\u0085⁦' + 'q'.repeat(9_990) + 'Z';
const FORMATS = [
  { ext: 'ork', open: '<openrocket><rocket>', close: '</rocket></openrocket>', refusal: 'Could not open that .ork file: Not a valid .ork file (XML parse error)' },
  { ext: 'rkt', open: '<RockSimDocument><DesignInformation>', close: '</DesignInformation></RockSimDocument>', refusal: 'Could not open that .rkt file: Not a valid RockSim file (XML parse error)' },
  { ext: 'CDX1', open: '<RASAeroDocument><RocketDesign>', close: '</RocketDesign></RASAeroDocument>', refusal: 'Could not open that .CDX1 file: Not a valid RASAero file (XML parse error)' },
] as const;
const SHAPES = [
  ['an unclosed tag', (n: string) => `<${n}>`],
  ['an unmatched closing tag', (n: string) => `<x></${n}>`],
  ['a duplicate attribute', (n: string) => `<x ${n}="" ${n}=""/>`],
  ['an unbound namespace prefix', (n: string) => `<${n}:x/>`],
  ['a disallowed name character', () => `<${HOSTILE}/>`],
] as const;

describe('parser error text never reaches a 400 INVALID_FILE', () => {
  it.each(FORMATS.flatMap(format => SHAPES.flatMap(([shape, payload]) => ROUTES.map(route => ({ ...format, shape, payload, route })))))(
    '$route $ext: $shape', async ({ ext, open, close, refusal, payload, route }) => {
      const response = await post(route, `broken.${ext}`, open + payload(LONG) + close);
      const text = await response.text();
      expect(response.status, text.slice(0, 300)).toBe(400);
      expect(JSON.parse(text)).toEqual({ error: { code: 'INVALID_FILE', message: refusal }, ...STAMP });
      expect(text).not.toContain('qqqqqqqq');
    });
});

describe('a stored extension that cannot stand alone is reported without its parser text', () => {
  // The prefix is bound on the root, so the document parses; the extension's own slice does not.
  const body = () => {
    const xml = strFromU8(unzipSync(bytesOf('reference.ork'))['rocket.ork']!)
      .replace('<openrocket ', `<openrocket xmlns:${LONG}="urn:x" `)
      .replace('<simulations>\n  </simulations>', `<simulations><simulation status="notsimulated"><name>S</name>`
        + `<extension extensionid="e"><${LONG}:x/></extension></simulation></simulations>`);
    expect(xml).toContain('<extension extensionid="e">');
    return zipSync({ 'rocket.ork': strToU8(xml) });
  };

  it.each(ROUTES)('%s', async route => {
    const response = await post(route, 'extension.ork', body());
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(200);
    const out = JSON.parse(text) as { notes: { import: { text: string } }; fragment?: string };
    expect(out.notes.import.text).toContain('A simulation extension was not preserved because its XML cannot stand alone '
      + 'without the original document’s namespace declarations.');
    expect(text).not.toContain('qqqqqqqq');
    if (out.fragment) expect(await decodeShareFragment(out.fragment)).not.toContain('qqqqqqqq');
  });
});

describe('an embedded EX archive refusal sanitises V8\'s JSON message', () => {
  // V8 quotes the file around a JSON syntax error: the shared importer must strip controls.
  it.each(ROUTES)('%s', async route => {
    const xml = strFromU8(unzipSync(bytesOf('reference.ork'))['rocket.ork']!)
      .replace('<rocket>', '<rocket><mmrexmotors version="1">[{"a":‮qqqqqqqqqqqqqqqqqqqq}]</mmrexmotors>');
    const response = await post(route, 'archive.ork', zipSync({ 'rocket.ork': strToU8(xml) }));
    const out = await response.json() as { notes: { import: { text: string } } };
    expect(response.status).toBe(200);
    const line = out.notes.import.text.split('\n').find(l => l.startsWith('Embedded EX motors were refused: '))!;
    expect(line).toBeDefined();
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u);
    expect(line.length).toBeLessThan(300);
  });
});
