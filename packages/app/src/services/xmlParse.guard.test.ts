import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { XML_JS_EXCLUDED, XML_JS_SETUP, XML_JS_SUITES } from '../../scripts/xml-js-suites.mjs';

/**
 * What keeps the XML-parser seam a seam (headless step 2, 2026-10-01).
 *
 *  1. The browser never loads the JS parser. Ruling (a): no change to what
 *     ships and no new bundle weight (~53 KB gzip), so shipped source must not
 *     import xmlParseJs.ts, the test-only xmlParseParity.ts, or the three
 *     packages behind them — statically or with import(). Vite would bundle
 *     any of them without a word: they are devDependencies, and still
 *     resolvable. eslint.config.mjs refuses the static form too; this also
 *     sees a dynamic import(), which that rule does not.
 *  2. Only xmlParse.ts touches DOMParser. An importer that went back to
 *     `new DOMParser()` would work in the browser and in every happy-dom
 *     test, and throw a ReferenceError on a server.
 *  3. Every test file that calls an importer runs under BOTH parsers, unless
 *     scripts/xml-js-suites.mjs says why not.
 */
const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '../..');
const SRC = join(APP, 'src');

const walk = (d: string, out: string[] = []): string[] => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { if (n !== '__fixtures__') walk(p, out); } else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
};
const rel = (p: string) => relative(APP, p).replace(/\\/g, '/');
const all = walk(SRC);
const isTest = (p: string) => /\.test\.tsx?$/.test(p);
/** Comments out, so a sentence about DOMParser or a package is not a use. */
const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const NODE_SIDE = new Set(['src/services/xmlParseJs.ts', XML_JS_SETUP, 'src/services/xmlParseParity.ts']);
const FORBIDDEN = /(?:from\s+|import\s*\(\s*|import\s+)['"](?:saxes|@xmldom\/xmldom|css-select|[./]*(?:[\w-]+\/)*xmlParse(?:Js|Parity)(?:\.js|\.ts)?)['"]/;

describe('the XML parser seam', () => {
  it('finds the files it guards (a scan that reads nothing passes everything)', () => {
    expect(all.length).toBeGreaterThan(200);
    expect(all.map(rel)).toContain('src/services/orkFile.ts');
    expect(FORBIDDEN.test("import { jsXmlParser } from './xmlParseJs.js';")).toBe(true);
    expect(FORBIDDEN.test("const m = await import('./services/xmlParseJs.js');")).toBe(true);
    expect(FORBIDDEN.test("import { SaxesParser } from 'saxes';")).toBe(true);
    expect(FORBIDDEN.test("import { goldenRun } from '../services/xmlParseParity';")).toBe(true);
    expect(FORBIDDEN.test("import { parseXml } from './xmlParse.js';")).toBe(false);
  });

  it('shipped source never imports the JS parser, its packages, or the parity cases', () => {
    const offenders = all.filter((p) => !isTest(p) && !NODE_SIDE.has(rel(p)) && FORBIDDEN.test(code(p))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('only xmlParse.ts touches DOMParser in shipped source', () => {
    // (xmlParseJs.ts names xmldom's own DOMParser, not the global one.)
    const users = all.filter((p) => !isTest(p) && !NODE_SIDE.has(rel(p)) && /\bDOMParser\b/.test(code(p))).map(rel);
    expect(users).toEqual(['src/services/xmlParse.ts']);
  });

  it('every test file that calls an importer runs under both parsers, or says why not', () => {
    const CALLS = /\b(importOrk|importRkt|importCdx1|parseRse|rocksimMotorEvidence|xmlText|xmlNum)\s*\(/;
    const callers = all.filter((p) => isTest(p) && CALLS.test(code(p))).map(rel)
      .filter((p) => !p.startsWith('src/services/xmlParse.'));
    const listed = new Set([...XML_JS_SUITES, ...Object.keys(XML_JS_EXCLUDED)]);
    expect(callers.filter((p) => !listed.has(p))).toEqual([]);
    expect([...listed].filter((p) => !existsSync(join(APP, p)))).toEqual([]);
    expect(existsSync(join(APP, XML_JS_SETUP))).toBe(true);
  });
});
