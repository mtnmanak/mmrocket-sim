import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { createJsXmlParser, xmlGate } from '../../app/src/services/xmlParseJs.js';
import { currentXmlParser, DOCTYPE_REFUSAL, setXmlParser, XmlDoctypeRefused, XmlParseError } from '../../app/src/services/xmlParse.js';
import { importOrk } from '../../app/src/services/orkFile.js';
import { importRkt } from '../../app/src/services/rocksimFile.js';
import { importCdx1 } from '../../app/src/services/rasaeroFile.js';

describe('importer preflight with the API parser budgets', () => {
  const saved = currentXmlParser();
  afterEach(() => { setXmlParser(saved); vi.restoreAllMocks(); });
  const limits = { maxElements: 50_000, maxDepth: 64 };
  const importers = [
    { ext: 'ork', root: 'openrocket', open: importOrk, file: 'reference.ork' },
    { ext: 'rkt', root: 'RockSimDocument', open: importRkt, file: 'TubeFins2.rkt' },
    { ext: 'CDX1', root: 'RASAeroDocument', open: importCdx1, file: 'Show-off.CDX1' },
  ];

  it.each(importers.flatMap(importer => [
    { ...importer, kind: 'complete', xml: `<!DOCTYPE ${importer.root}><${importer.root}/>` },
    { ...importer, kind: 'lowercase', xml: `<!doctype ${importer.root}><${importer.root}/>` },
    { ...importer, kind: 'truncated', xml: `<!DOCTYPE ${importer.root} [` },
    { ...importer, kind: 'internal subset', xml: `<!DOCTYPE ${importer.root} [<!--${'x'.repeat(64 * 1024)}-->]><${importer.root}/>` },
  ]))('refuses $ext $kind DOCTYPE before entering the parser preflight', ({ open, xml }) => {
    const parser = createJsXmlParser(limits);
    const preflight = vi.spyOn(parser, 'preflight');
    setXmlParser(parser);
    expect(() => open(xml)).toThrow(XmlDoctypeRefused);
    expect(() => open(xml)).toThrow(DOCTYPE_REFUSAL);
    expect(preflight.mock.calls.length).toBe(0);
  });

  it.each(importers)('opens a BOM-prefixed $ext string through the limited API parser', ({ open, file }) => {
    setXmlParser(createJsXmlParser(limits));
    const bytes = new Uint8Array(readFileSync(new URL(`../../app/src/services/__fixtures__/${file}`, import.meta.url)));
    const xml = strFromU8(file.endsWith('.ork') ? unzipSync(bytes)['rocket.ork']! : bytes);
    const plain = open(xml);
    const withBom = open('\uFEFF' + xml);
    expect(withBom.name).toBe(plain.name);
    expect(withBom.tree.components.length).toBeGreaterThan(0);
    expect(withBom.tree.components).toHaveLength(plain.tree.components.length);
  });

  it('accepts one leading BOM without bypassing syntax or structural budgets', () => {
    const parser = createJsXmlParser({ maxElements: 3, maxDepth: 2 });
    expect(() => parser.preflight!('\uFEFF<r><x/></r>')).not.toThrow();
    expect(() => parser.preflight!('\uFEFF\uFEFF<r/>')).toThrow(XmlParseError);
    expect(() => parser.preflight!('\uFEFF<r><x></r>')).toThrow(XmlParseError);
    expect(() => parser.preflight!('\uFEFF<r><x/><x/><x/></r>')).toThrow(/XML element limit/);
    expect(() => parser.preflight!('\uFEFF<r><x><y/></x></r>')).toThrow(/XML nesting limit/);
  });
});

it('accepts the element/depth boundary and ignores markup in comments and CDATA', () => {
  expect(() => xmlGate('<r><!-- <x/><x/> --><![CDATA[<x><x>]]><x/></r>', { maxElements: 2, maxDepth: 2 })).not.toThrow();
});

it.each([
  ['element count', '<r><x/><x/></r>', { maxElements: 2, maxDepth: 4 }],
  ['depth', '<r><x><y/></x></r>', { maxElements: 4, maxDepth: 2 }],
])('refuses XML past its %s budget', (_kind, text, limits) => {
  expect(() => xmlGate(text, limits)).toThrow(/XML.*limit/);
});

it('keeps the unrestricted parser default for browser-parity and other hosts', () => {
  expect(() => xmlGate('<r>' + '<x/>'.repeat(50_000) + '</r>')).not.toThrow();
  expect(() => xmlGate('<r>'.repeat(65) + '</r>'.repeat(65))).not.toThrow();
});

const largest = new URL('../../../docs/User files/TRF RASAero Files/Wildman Mach 2 this one.ork', import.meta.url);
it.skipIf(!existsSync(largest))('accepts the largest measured real stored-flight XML at the API budgets', () => {
  const xml = strFromU8(unzipSync(new Uint8Array(readFileSync(largest)))['rocket.ork']!);
  expect(() => xmlGate(xml, { maxElements: 50_000, maxDepth: 64 })).not.toThrow();
});
