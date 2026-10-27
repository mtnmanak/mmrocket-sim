import { gzipSync, strFromU8, unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { unstable_startWorker } from 'wrangler';
import { bytesOf } from './fixtures.testSupport.js';

/**
 * Design files that declare windows-1252 (or ISO-8859-1, US-ASCII: the same
 * encoding under WHATWG) through real local workerd, plain, ZIP and gzip. The
 * expected text is the WHATWG table written out here, never a runtime decoder:
 * Node 22.22.0's own decoder returned 0x80-0x9F as C1 controls. Bodies are
 * built byte by byte; TextEncoder and strToU8 would re-encode them as UTF-8.
 */
type LocalWorker = Awaited<ReturnType<typeof unstable_startWorker>>;
let normal: LocalWorker | undefined;
let probe: LocalWorker | undefined;
let table: LocalWorker | undefined;

beforeAll(async () => {
  process.env['WRANGLER_SEND_METRICS'] = 'false';
  process.env['WRANGLER_HIDE_BANNER'] = 'true';
  process.env['CLOUDFLARE_CF_FETCH_ENABLED'] = 'false';
  process.env['WRANGLER_LOG_PATH'] = fileURLToPath(new URL('../.wrangler/test.log', import.meta.url));
  process.env['XDG_CONFIG_HOME'] = fileURLToPath(new URL('../.wrangler/config', import.meta.url));
  const { unstable_startWorker: start } = await import('wrangler');
  const options = {
    config: fileURLToPath(new URL('../wrangler.toml', import.meta.url)),
    dev: { remote: false, persist: false, watch: false, inspector: false,
      server: { hostname: '127.0.0.1', port: 0 }, logLevel: 'error' },
  };
  normal = await start(options);
  await normal.ready;
  probe = await start({ ...options,
    entrypoint: fileURLToPath(new URL('./decoderProbe.testSupport.ts', import.meta.url)) });
  await probe.ready;
  table = await start({ ...options,
    entrypoint: fileURLToPath(new URL('./tableDecoderWorker.testSupport.ts', import.meta.url)) });
  await table.ready;
});
afterAll(async () => { await Promise.all([normal?.dispose(), probe?.dispose(), table?.dispose()]); });

const C1 = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d,
  0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153,
  0x9d, 0x17e, 0x178];
/** All 32 bytes 0x80-0x9F and a few above, as one-byte characters. */
const RAW_NAME = `Aero${String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 0x80 + i))}\xa9\xb0\xe9\xff Test`;
const NAME = `Aero${String.fromCharCode(...C1)}©°éÿ Test`;
const NOT_UTF8 = /characters? in this file could not be read and (was|were) replaced/;

/** One byte per character; every character must be at most U+00FF. */
function singleBytes(text: string): Uint8Array {
  expect([...text].every(c => c.charCodeAt(0) <= 0xff)).toBe(true);
  return Uint8Array.from(text, c => c.charCodeAt(0));
}
const latin = (bytes: Uint8Array) => strFromU8(bytes, true);
const declaration = (encoding: string) => `<?xml version="1.0" encoding="${encoding}"?>\n`;

function rkt(encoding: string | null, mountName = 'Body tube'): string {
  const xml = latin(bytesOf('rocksimTestRocket1.rkt')).replace('<Name>FooBar Test</Name>', `<Name>${RAW_NAME}</Name>`);
  // The motor mount: the last component name before the first motor.
  const at = xml.lastIndexOf('<Name>', xml.indexOf('<EngineCode>'));
  const mounted = `${xml.slice(0, at)}${xml.slice(at).replace(/<Name>[^<]*<\/Name>/, `<Name>${mountName}</Name>`)}`;
  return `${encoding === null ? '' : declaration(encoding)}${mounted}`;
}
function ork(encoding: string): string {
  return latin(unzipSync(bytesOf('reference.ork'))['rocket.ork']!)
    .replace("encoding='utf-8'", `encoding='${encoding}'`)
    .replace('<name>Reference Rocket</name>', `<name>${RAW_NAME}</name>`);
}
function cdx1(encoding: string): string {
  return `${declaration(encoding)}${latin(bytesOf('Show-off.CDX1'))
    .replace('<Comments>Comments are for suckers.', `<Comments>${RAW_NAME}\nComments are for suckers.`)}`;
}
const packed = {
  plain: (bytes: Uint8Array) => bytes,
  zip: (bytes: Uint8Array, member: string) => zipSync({ [member]: bytes }),
  gzip: (bytes: Uint8Array) => gzipSync(bytes),
} as const;

type Described = { name: string; notes: { import: { text: string } } };
async function describeBody(filename: string, body: Uint8Array, worker = normal!): Promise<Described> {
  const response = await worker.fetch(`http://local/describe?filename=${encodeURIComponent(filename)}`,
    { method: 'POST', body });
  expect(response.status, await response.clone().text()).toBe(200);
  return await response.json() as Described;
}

describe('a declared windows-1252 design through workerd', () => {
  it('records what workerd\'s own TextDecoder does (not asserted beyond its shape)', async ({ annotate }) => {
    const response = await probe!.fetch('http://local/');
    const rows = await response.json() as { label: string; encoding?: string; decoded?: number[]; threw?: string }[];
    expect(rows.map(row => row.label)).toContain('windows-1252');
    await annotate(`workerd TextDecoder: ${JSON.stringify(rows.map(row =>
      [row.label, row.threw ?? row.encoding, row.decoded?.map(n => n.toString(16)).join(' ')]))}`);
  });

  const formats = [
    ['rkt', 'design.rkt', (encoding: string) => rkt(encoding)],
    ['ork', 'rocket.ork', ork],
    ['CDX1', 'design.CDX1', cdx1],
  ] as const;
  const cases = formats.flatMap(([ext, member, build]) =>
    (['plain', 'zip', 'gzip'] as const).map(pack => [ext, pack, member, build] as const));

  // The table worker has no windows-1252 TextDecoder: decodeXml's built-in table answers there.
  it.each(cases)('.%s %s: /describe returns the name by the WHATWG table', async (ext, pack, member, build) => {
    const body = packed[pack](singleBytes(build('windows-1252')), member);
    for (const worker of [normal!, table!]) {
      const out = await describeBody(`design.${ext}`, body, worker);
      expect(out.name).toBe(NAME);
      expect(out.notes.import.text).not.toMatch(NOT_UTF8);
    }
  });

  it.each(['ISO-8859-1', 'us-ascii', 'L1'])('a .rkt and an .ork declared %s read the same way', async encoding => {
    for (const worker of [normal!, table!]) {
      expect((await describeBody('design.rkt', singleBytes(rkt(encoding)), worker)).name).toBe(NAME);
      expect((await describeBody('design.ork', zipSync({ 'rocket.ork': singleBytes(ork(encoding)) }), worker)).name)
        .toBe(NAME);
    }
  });

  it('an undeclared body that is not UTF-8 is still read as UTF-8, with the note', async () => {
    for (const worker of [normal!, table!]) {
      const out = await describeBody('design.rkt', singleBytes(rkt(null)), worker);
      expect(out.name).toBe(`Aero${'\u{FFFD}'.repeat(36)} Test`);
      expect(out.notes.import.text).toContain('36 characters in this file could not be read and were replaced — it is '
        + 'not UTF-8 and does not say which encoding it uses. Check the part and material names.');
    }
  });

  it('/experimental/fly returns a declared mount name by the table, and the note for an undeclared one', async () => {
    const fly = async (body: Uint8Array, worker = normal!) => {
      const response = await worker.fetch('http://local/experimental/fly?filename=design.rkt', { method: 'POST', body });
      expect(response.status, await response.clone().text()).toBe(200);
      return await response.json() as { motors: { mount: string }[]; notes: { import: { text: string } } };
    };
    for (const worker of [normal!, table!]) {
      const declared = await fly(gzipSync(singleBytes(rkt('windows-1252', RAW_NAME))), worker);
      expect(declared.motors.map(motor => motor.mount)).toEqual([NAME]);
      expect(declared.notes.import.text).not.toMatch(NOT_UTF8);
    }
    const undeclared = await fly(singleBytes(rkt(null, RAW_NAME)));
    expect(undeclared.motors.map(motor => motor.mount)).toEqual([`Aero${'\u{FFFD}'.repeat(36)} Test`]);
    expect(undeclared.notes.import.text).toContain('72 characters in this file could not be read and were replaced');
  });
});
