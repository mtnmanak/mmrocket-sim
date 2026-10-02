// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { browserXmlParser, setXmlParser } from './xmlParse.js';
import { jsXmlParser } from './xmlParseJs.js';
import { fixtureXml, formatOf, importFixture } from './xmlParseParity.js';
import { importOrk } from './orkFile.js';
import { importRkt } from './rocksimFile.js';
import { importCdx1 } from './rasaeroFile.js';
import { parseRse } from './exMotors.js';

/**
 * Every design file in the local-only corpus — docs/User files (the testers'
 * uploads), docs/testing and docs/Flight Data, and the design members of any
 * .zip there — imported once through happy-dom's DOMParser and once through
 * the JS parser, and the results compared exactly (same JS engine). Skipped
 * where docs/ is absent, as in CI, like the other corpus tests; the Chrome
 * golden over the committed fixtures (xmlParse.golden.test.ts) is CI's check.
 *
 * Measured 2026-10-01 on the laptop: 114 inputs, of which 99 are distinct —
 * 32 .ork, 9 .rkt, 58 .CDX1, and no .rse. (The spec's "136" also counted the
 * 22 committed fixtures, and its critique's "120 distinct" likewise; over half
 * the set is CDX1, the format with the smallest DOM surface — critique F10.)
 * Quote the distinct count, which this test prints, not the file count.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../../..');
const ROOTS = ['docs/User files', 'docs/testing', 'docs/Flight Data'].map((d) => join(repo, d));
const present = ROOTS.some((d) => existsSync(d));

interface Input { name: string; bytes: Uint8Array }
function corpus(): Input[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ork|rkt|cdx1|rse|zip)$/i.test(n)) files.push(p);
    }
  };
  for (const r of ROOTS) if (existsSync(r)) walk(r);
  const inputs: Input[] = [];
  for (const f of files.sort()) {
    const bytes = new Uint8Array(readFileSync(f));
    if (extname(f).toLowerCase() !== '.zip') { inputs.push({ name: f, bytes }); continue; }
    let members: Record<string, Uint8Array>;
    try { members = unzipSync(bytes); } catch { continue; }
    for (const [m, b] of Object.entries(members)) if (formatOf(m)) inputs.push({ name: `${f}!${m}`, bytes: b });
  }
  return inputs;
}

const withParser = <T>(parser: typeof jsXmlParser, run: () => T): T => {
  setXmlParser(parser);
  try { return run(); } finally { setXmlParser(null); }
};

describe('the local corpus: JS parser against happy-dom', () => {
  it.skipIf(!present)('imports every file identically, or refuses it with the same message', () => {
    const inputs = corpus();
    const distinct = new Map<string, string>();
    for (const i of inputs) distinct.set(createHash('sha256').update(i.bytes).digest('hex'), i.name);
    const byFormat: Record<string, number> = {};
    for (const n of distinct.values()) byFormat[formatOf(n)!] = (byFormat[formatOf(n)!] ?? 0) + 1;
    console.log(`xml corpus: ${inputs.length} inputs, ${distinct.size} distinct: ${JSON.stringify(byFormat)}`);
    expect(inputs.length).toBeGreaterThan(100);

    const differ: string[] = [];
    for (const i of inputs) {
      const happy = withParser(browserXmlParser, () => importFixture(i.name, i.bytes, false));
      const js = withParser(jsXmlParser, () => importFixture(i.name, i.bytes, false));
      if (happy !== js) differ.push(i.name.slice(repo.length));
    }
    expect(differ).toEqual([]);
  }, 300_000);

  /**
   * The importers' contract: malformed XML is REFUSED, with their own message,
   * never imported partially. linkedom, the fastest candidate, failed exactly
   * this — it imported all 136 files truncated at 60 % (spec §1.3).
   */
  it.skipIf(!present)('refuses every file truncated at 60 %, or with one closing tag dropped, under both parsers', () => {
    const run = (name: string, xml: string) => {
      switch (formatOf(name)) {
        case 'ork': return importOrk(xml);
        case 'rkt': return importRkt(xml);
        case 'cdx1': return importCdx1(xml);
        default: return parseRse(xml);
      }
    };
    const damaged = {
      truncate60: (x: string) => x.slice(0, Math.floor(x.length * 0.6)),
      dropOneCloseTag: (x: string) => x.replace(/<\/(subcomponents|AttachedParts|RocketDesign|engine-list)>/, ''),
    };
    const notRefused: string[] = [];
    let cases = 0;
    for (const i of corpus()) {
      const xml = fixtureXml(i.name, i.bytes);
      for (const [how, damage] of Object.entries(damaged)) {
        const text = damage(xml);
        if (text === xml) continue;
        for (const [pn, parser] of [['happy-dom', browserXmlParser], ['JS', jsXmlParser]] as const) {
          cases++;
          let msg = 'imported';
          try { withParser(parser, () => run(i.name, text)); } catch (e) { msg = (e as Error).message; }
          if (!/XML parse error|Not valid XML \(\.rse\)/.test(msg)) notRefused.push(`${how} ${pn} ${i.name.slice(repo.length)}: ${msg}`);
        }
      }
    }
    expect(cases).toBeGreaterThan(400);
    expect(notRefused).toEqual([]);
  }, 300_000);
});
