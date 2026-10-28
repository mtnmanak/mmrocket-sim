import { afterEach, describe, expect, it, vi } from 'vitest';
import { gzipSync, strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { SaxesParser } from 'saxes';
import { worker } from './index.js';
import { bytesOf, stampOf } from './fixtures.testSupport.js';

/**
 * The SAX gate's depth and node budgets on retained documents (no stored .ork
 * samples) at the API's own limits, for every format, through worker.fetch.
 * Each design is a committed fixture with filler appended inside its root, so
 * the boundary is the gate's and the design is otherwise real.
 */
afterEach(() => { vi.restoreAllMocks(); });

const FORMATS = [
  { file: 'TubeFins2.rkt', root: 'RockSimDocument', container: 'plain' },
  { file: 'Show-off.CDX1', root: 'RASAeroDocument', container: 'gzip' },
  { file: 'reference.ork', root: 'openrocket', container: 'zip' },
] as const;
type Format = (typeof FORMATS)[number];

/**
 * The fixture's XML without its declaration. The .ork reader drops the declaration before the
 * gate, and saxes counts the newline after one as a text node, so with it the count below would
 * be one over what the gate sees for .ork; without it, the bytes sent are the text every gate sees.
 */
const xmlOf = ({ file }: Format) => (file.endsWith('.ork') ? strFromU8(unzipSync(bytesOf(file))['rocket.ork']!) : strFromU8(bytesOf(file)))
  .replace(/^<\?xml[^?]*\?>\s*/, '');
/** The fixture with `filler` just inside its closing root tag, in the format's container. */
function withFiller(format: Format, filler: string) {
  const xml = xmlOf(format);
  const at = xml.lastIndexOf(`</${format.root}>`);
  const text = xml.slice(0, at) + filler + xml.slice(at);
  const bytes = strToU8(text);
  return { text, body: format.container === 'zip' ? zipSync({ 'rocket.ork': bytes }) : format.container === 'gzip' ? gzipSync(bytes) : bytes };
}
/** Independent of the gate: deepest element, elements, and nodes as the gate defines them (saxes events). */
function measure(text: string) {
  let depth = 0, maxDepth = 0, elements = 0, nodes = 0;
  const sax = new SaxesParser({ xmlns: true });
  sax.on('opentag', () => { elements++; nodes++; maxDepth = Math.max(maxDepth, ++depth); });
  sax.on('closetag', () => { depth--; });
  for (const event of ['attribute', 'comment', 'processinginstruction', 'text', 'cdata'] as const) sax.on(event, () => { nodes++; });
  sax.write(text).close();
  return { maxDepth, elements, nodes };
}
async function respond(format: Format, body: Uint8Array) {
  const filename = 'retained-' + format.file;
  const response = await worker.fetch(new Request(`http://local/experimental/fly?filename=${filename}`,
    { method: 'POST', body: new Uint8Array(body).buffer }), undefined, { waitUntil: () => undefined });
  return { filename, status: response.status, json: await response.json() as { error?: { code: string; message: string } } };
}
/** /health's version stamp, which every refusal carries beside its error (cloud lane 15). */
const STAMP = stampOf(await (await worker.fetch(new Request('http://local/health'), undefined,
  { waitUntil: () => undefined })).json());
const TOO_LARGE = (filename: string, what: string) => ({ ...STAMP, error: { code: 'FILE_TOO_LARGE',
  message: `${filename}: ${what} Use https://mmrsim.mountainmanrockets.com for larger files.` } });
const API_MAX_DEPTH = 64;
const API_MAX_NODES = 200_000;

describe('retained-document XML depth at the API limit', () => {
  // A chain under the root starts at depth 2: n nested elements reach depth n + 1.
  const chain = (n: number) => '<mmrdeep>'.repeat(n) + '</mmrdeep>'.repeat(n);

  it.each(FORMATS)('$file ($container): depth 64 passes the gate; 65 is refused before any DOM', async format => {
    const deepest = withFiller(format, chain(API_MAX_DEPTH - 1));
    expect(measure(deepest.text).maxDepth).toBe(API_MAX_DEPTH);
    const dom = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const opened = await respond(format, deepest.body);
    // Past the gate, each design here flies; a later refusal would also do, but never a 413.
    expect(opened.status, JSON.stringify(opened.json)).toBe(200);
    expect(dom).toHaveBeenCalled();
    dom.mockClear();
    const tooDeep = withFiller(format, chain(API_MAX_DEPTH));
    expect(measure(tooDeep.text).maxDepth).toBe(API_MAX_DEPTH + 1);
    const refused = await respond(format, tooDeep.body);
    expect(refused).toEqual({ filename: refused.filename, status: 413, json: TOO_LARGE(refused.filename, 'XML nesting limit is 64.') });
    expect(dom).not.toHaveBeenCalled();
  });
});

describe('retained-document XML nodes at the API limit', () => {
  /** `count` nodes of filler: elements of 999 attributes (1,000 nodes each), then one for the rest. */
  const nodesOf = (count: number) => {
    const pad = (attributes: number) => '<mmrpad' + Array.from({ length: attributes }, (_, i) => ` a${i}=""`).join('') + '/>';
    return pad(999).repeat(Math.floor(count / 1_000)) + (count % 1_000 ? pad(count % 1_000 - 1) : '');
  };
  const atNodes = (format: Format, total: number) => withFiller(format, nodesOf(total - measure(xmlOf(format)).nodes));

  it.each(FORMATS)('$file ($container): 200,000 nodes pass the gate; 200,001 is refused before any DOM', async format => {
    const full = atNodes(format, API_MAX_NODES);
    const counts = measure(full.text);
    expect(counts.nodes).toBe(API_MAX_NODES);
    expect(counts.elements).toBeLessThan(50_000);
    const dom = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const opened = await respond(format, full.body);
    // Past the gate, each design here flies; a later refusal would also do, but never a 413.
    expect(opened.status, JSON.stringify(opened.json)).toBe(200);
    expect(dom).toHaveBeenCalled();
    dom.mockClear();
    const past = atNodes(format, API_MAX_NODES + 1);
    expect(measure(past.text).nodes).toBe(API_MAX_NODES + 1);
    const refused = await respond(format, past.body);
    expect(refused).toEqual({ filename: refused.filename, status: 413, json: TOO_LARGE(refused.filename, 'XML node limit is 200,000.') });
    expect(dom).not.toHaveBeenCalled();
  });
});
