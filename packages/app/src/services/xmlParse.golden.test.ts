// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { browserXmlParser } from './xmlParse.js';
import { jsXmlParser } from './xmlParseJs.js';
import { domDump, fixtureXml, formatOf, goldenRun, importFixture } from './xmlParseParity.js';
import { setXmlParser } from './xmlParse.js';
import { importerKey, importerKeyFiles, importVerdict, KEY_EXCLUDED } from '../../scripts/xml-golden-key.mjs';

/**
 * The committed fixtures, parsed and imported through the JS parser, held to
 * what REAL CHROME produced from the same bytes (critique F2): the DOM it
 * built (every element, attribute and text) and what each importer made of
 * the file. Recorded by packages/app/scripts/xml-chrome-golden.mjs into
 * `__fixtures__/xml-parity/chrome-golden.json` as SHA-256 hashes; numbers in
 * import results are cut to 14 significant digits first, because Node 24 and
 * Chrome 154 differ in the last bit of one cluster rotation (V8's Math).
 *
 * WHEN THIS FAILS. "golden is stale" — the JS parser and happy-dom agree with
 * each other but not with the golden — means something the key below does not
 * cover moved what a fixture imports to: regenerate the golden (the script's
 * header says how) and read its diff. Anything else is the JS parser
 * disagreeing with a browser.
 *
 * THE IMPORT HALF IS KEYED (verify-step2 finding 1, 2026-10-01). An import
 * result depends on the importers, their helpers and the motor and preset
 * catalogues as well as on the parser, so a bare hash went red on a motors
 * refresh — in the weekly motors-refresh workflow, whose `npm test` gate cannot
 * regenerate a Chrome golden. The golden records `importKey`
 * (scripts/xml-golden-key.mjs: a hash of every file the imports are computed
 * from, the parser excepted); while it matches, the import hashes are a hard
 * check, and once it moves they are SKIPPED with a warning until someone
 * regenerates. The DOM half below, the hostile table, the conformance probes
 * and the exact JS-against-happy-dom import comparison stay hard either way.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '__fixtures__');
const APP = join(here, '../..');
const golden = JSON.parse(readFileSync(join(FIXTURES, 'xml-parity/chrome-golden.json'), 'utf8')) as {
  chrome: string;
  importKey?: string;
  fixtures: Record<string, { elements: number; dom: string; importer: string; importerLength: number }>;
};
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hashOrThrow = (s: string) => (s.startsWith('THROW') ? s : sha(s));

const names = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((d) => d.isFile() && formatOf(d.name) !== null).map((d) => d.name).sort();
const fixtures = names.map((name) => ({ name, bytes: new Uint8Array(readFileSync(join(FIXTURES, name))) }));

describe('the fixture set', () => {
  it('is the set the golden was recorded from', () => {
    expect(Object.keys(golden.fixtures).sort()).toEqual(names);
  });

  it('keeps every format the importers read (critique F10)', () => {
    // Counted by distinct CONTENT, not by file name: two of the CDX1 fixtures
    // are byte-identical (38-54 2-stage, launch-stage-motorless), and a set
    // of copies would satisfy a name count while exercising nothing new.
    const unique = new Map<string, string>();
    for (const f of fixtures) unique.set(sha(Buffer.from(f.bytes).toString('latin1')), f.name);
    const byFormat: Record<string, number> = {};
    for (const name of unique.values()) byFormat[formatOf(name)!] = (byFormat[formatOf(name)!] ?? 0) + 1;
    // 2026-10-01: 23 files, 22 distinct — 5 .ork, 5 .rkt, 11 .CDX1, 1 .rse
    // (hand-written: no real RockSim engine file exists in the repo or docs/).
    expect(byFormat['ork']).toBeGreaterThanOrEqual(1);
    expect(byFormat['rkt']).toBeGreaterThanOrEqual(1);
    expect(byFormat['cdx1']).toBeGreaterThanOrEqual(1);
    expect(byFormat['rse']).toBeGreaterThanOrEqual(1);
    // and the zipped .ork that importOrk unzips is among them
    expect(fixtures.some((f) => formatOf(f.name) === 'ork' && f.bytes[0] === 0x50 && f.bytes[1] === 0x4b)).toBe(true);
    // and CDATA, which happy-dom refuses (spec §1.4), is among them
    expect(fixtures.some((f) => fixtureXml(f.name, f.bytes).includes('<![CDATA['))).toBe(true);
  });
});

describe('the key of the Chrome import check (verify-step2 finding 1)', () => {
  const key = importerKey(APP);

  it('covers the importers and the catalogues they read, and not the parser', () => {
    const files = importerKeyFiles(APP);
    for (const f of ['src/services/orkFile.ts', 'src/services/rocksimFile.ts', 'src/services/rasaeroFile.ts',
      'src/services/exMotors.ts', 'src/services/xmlUtil.ts', 'src/data/motors.json', 'src/data/presets.json']) {
      expect(files).toContain(f);
    }
    for (const f of KEY_EXCLUDED) expect(files).not.toContain(f);
  });

  it('the golden records a key at all (one without would leave the import check skipped for good)', () => {
    // NOT `toBe(key)`: a moved key is the very case that must stay green. When
    // it has moved, the import tests below skip and say so.
    expect(golden.importKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a catalogue refresh leaves the gate GREEN: the import check goes unchecked, not red', () => {
    // What .github/workflows/motors-refresh.yml does every Monday, simulated:
    // one motor's mass moves, the key moves, and a fixture whose import moved
    // with it is skipped rather than failed.
    const motors = readFileSync(join(APP, 'src/data/motors.json'), 'utf8');
    const refreshed = motors.replace(/"totalWeightG":\s*([\d.]+)/, (_, g: string) => `"totalWeightG":${Number(g) + 0.1}`);
    expect(refreshed).not.toBe(motors);
    const movedKey = importerKey(APP, { 'src/data/motors.json': refreshed });
    expect(movedKey).not.toBe(key);
    expect(importVerdict({ key: movedKey, goldenKey: key, got: 'moved', want: 'recorded' })).toBe('unchecked');
    const presets = readFileSync(join(APP, 'src/data/presets.json'), 'utf8');
    expect(importerKey(APP, { 'src/data/presets.json': `${presets} ` })).not.toBe(key);
  });

  it('a parser change does NOT move the key: the import check stays hard for what the golden watches', () => {
    expect(importerKey(APP, { 'src/services/xmlParse.ts': '// changed', 'src/services/xmlParseJs.ts': '// changed' }))
      .toBe(key);
    expect(importVerdict({ key, goldenKey: key, got: 'a', want: 'b' })).toBe('different');
    expect(importVerdict({ key, goldenKey: key, got: 'a', want: 'a' })).toBe('same');
  });

  it('line ends do not move the key (a core.autocrlf checkout keys as CI does)', () => {
    const ork = readFileSync(join(APP, 'src/services/orkFile.ts'), 'utf8');
    expect(importerKey(APP, { 'src/services/orkFile.ts': ork.replace(/\n/g, '\r\n') })).toBe(key);
  });
});

describe(`the committed fixtures through the JS parser, against Chrome ${golden.chrome}`, () => {
  const js = goldenRun(fixtures, jsXmlParser).fixtures;

  it.each(names)('%s: the same DOM', (name) => {
    expect(js[name]!.elements).toBe(golden.fixtures[name]!.elements);
    expect(hashOrThrow(js[name]!.dom)).toBe(golden.fixtures[name]!.dom);
  });

  const key = importerKey(APP);
  if (key !== golden.importKey) {
    console.warn('xml golden: the importers or the catalogues they read changed since the Chrome golden was '
      + 'recorded, so its IMPORT hashes are skipped (the DOM hashes are still checked). Regenerate with '
      + 'packages/app/scripts/xml-chrome-golden.mjs on a machine with Chrome, and read the diff.');
  }

  it.for(names)('%s: the same import', (name, ctx) => {
    const got = hashOrThrow(js[name]!.importer);
    const verdict = importVerdict({ key, goldenKey: golden.importKey, got, want: golden.fixtures[name]!.importer });
    if (verdict === 'unchecked') { ctx.skip(); return; }
    if (verdict === 'different') {
      // Tell a stale golden from a parser that disagrees with Chrome.
      setXmlParser(browserXmlParser);
      let happy: string;
      try { happy = importFixture(name, fixtures.find((f) => f.name === name)!.bytes, true); } finally { setXmlParser(null); }
      const stale = happy === js[name]!.importer;
      expect.fail(stale
        ? `golden is stale for ${name}: the JS parser and happy-dom agree (${js[name]!.importer.length} chars, `
          + `golden ${golden.fixtures[name]!.importerLength}). An importer change moved this import; `
          + 'regenerate with packages/app/scripts/xml-chrome-golden.mjs and read the diff.'
        : `the JS parser imports ${name} differently from Chrome AND from happy-dom.`);
    }
  });
});

describe('the committed fixtures: JS parser against happy-dom (secondary, same JS engine, exact)', () => {
  // Exact, unrounded: one engine, so not one bit may move. happy-dom is no
  // browser (see xmlParseParity.ts), so this is a second witness, not the
  // reference — the Chrome golden above is.
  it.each(names)('%s', (name) => {
    const f = fixtures.find((x) => x.name === name)!;
    setXmlParser(browserXmlParser);
    let happy: string;
    try { happy = importFixture(name, f.bytes, false); } finally { setXmlParser(null); }
    setXmlParser(jsXmlParser);
    let js: string;
    try { js = importFixture(name, f.bytes, false); } finally { setXmlParser(null); }
    expect(js).toBe(happy);
  });

  it('the DOM dump itself sees what it must (a dump that drops nodes would hash two different files alike)', () => {
    const { json, elements } = domDump(jsXmlParser('<a x="1"><b/>t<![CDATA[c]]><!-- no --><c y="&amp;">é</c></a>'));
    expect(json).toBe('["a",[["x","1"]],[["b",[],[]],"tc",["c",[["y","&"]],["é"]]]]');
    expect(elements).toBe(3);
  });
});
