// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserXmlParser, currentXmlParser, parseXml, setXmlParser, XmlParseError, type XmlParser,
} from './xmlParse.js';
import { jsXmlParser, xmlDom, xmlGate } from './xmlParseJs.js';
import { importOrk } from './orkFile.js';
import { importRkt } from './rocksimFile.js';
import { importCdx1 } from './rasaeroFile.js';
import { parseRse } from './exMotors.js';

/**
 * The parser seam (headless step 2, 2026-10-01): what each importer says when
 * its file is not XML must not depend on which parser read it, and the
 * browser path must be the code it always was. The tables of what each
 * parser accepts are in xmlParse.hostile.test.ts and xmlParse.conformance.test.ts.
 */
const initial = currentXmlParser();
afterEach(() => {
  setXmlParser(initial);
  vi.unstubAllGlobals();
});

/** Each importer's refusal of malformed XML — word for word what each threw
 *  before the seam existed. A user sees these; none may change. */
const REFUSALS: [string, (text: string) => unknown, string][] = [
  ['importOrk', (t) => importOrk(t), 'Not a valid .ork file (XML parse error)'],
  ['importRkt', (t) => importRkt(t), 'Not a valid RockSim file (XML parse error)'],
  ['importCdx1', (t) => importCdx1(t), 'Not a valid RASAero file (XML parse error)'],
  ['parseRse', (t) => parseRse(t), 'Not valid XML (.rse)'],
];
const PARSERS: [string, XmlParser][] = [['browser (happy-dom)', browserXmlParser], ['JS', jsXmlParser]];

describe('the seam', () => {
  it('defaults to the browser DOMParser, and setXmlParser(null) restores it', () => {
    expect(currentXmlParser()).toBe(process.env['VITEST_XML_PARSER'] === 'js' ? jsXmlParser : browserXmlParser);
    setXmlParser(jsXmlParser);
    expect(currentXmlParser()).toBe(jsXmlParser);
    setXmlParser(null);
    expect(currentXmlParser()).toBe(browserXmlParser);
  });

  it('turns an XmlParseError into the caller\'s message, keeping the cause, and passes anything else through', () => {
    setXmlParser(() => { throw new XmlParseError('detail'); });
    const err = (() => { try { parseXml('<a/>', 'Not a valid thing'); } catch (e) { return e as Error; } return null; })();
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(XmlParseError);
    expect(err!.message).toBe('Not a valid thing');
    expect(err!.cause).toBeInstanceOf(XmlParseError);
    const other = new TypeError('a bug, not a bad file');
    setXmlParser(() => { throw other; });
    expect(() => parseXml('<a/>', 'Not a valid thing')).toThrow(other);
  });

  it('says plainly that no parser is installed where there is no DOMParser — not "not a valid file"', () => {
    vi.stubGlobal('DOMParser', undefined);
    setXmlParser(null);
    expect(() => importOrk('<openrocket/>')).toThrow(/No XML parser is installed.*setXmlParser\(jsXmlParser\)/);
    // the JS parser needs no global at all
    setXmlParser(jsXmlParser);
    expect(() => importOrk('<openrocket><rocket/></openrocket>')).not.toThrow(/No XML parser/);
  });
});

describe.each(PARSERS)('each importer refuses malformed XML with its own message — %s parser', (_name, parser) => {
  it.each(REFUSALS)('%s', (_fn, run, message) => {
    setXmlParser(parser);
    // Truncated mid-tag: every parser refuses it.
    expect(() => run('<engine-database><RockSimDocument><openrocket><RASAeroDocument')).toThrow(new Error(message));
    // Mismatched close tag.
    expect(() => run('<a><b></a>')).toThrow(new Error(message));
  });
});

describe('the JS parser', () => {
  it.each(REFUSALS)('%s: a file only the JS path refuses still gets the importer\'s message (unbound prefix, critique F3)', (_fn, run, message) => {
    setXmlParser(jsXmlParser);
    expect(() => run('<x:openrocket/>')).toThrow(new Error(message));
    expect(() => run('<a xmlns:xml="urn:bad"/>')).toThrow(new Error(message));
  });

  it('converts EVERY xmldom throw into the one XmlParseError (critique F3: it wraps them in its own ParseError)', () => {
    // xmldom on its own, without the gate that would refuse these first.
    for (const text of ['<x:a/>', '<a p:x="1"/>', '﻿<a/>', '<a/><b/>', '<a>&foo;</a>', '']) {
      let thrown: unknown = null;
      try { xmlDom(text); } catch (e) { thrown = e; }
      expect(thrown, text).toBeInstanceOf(XmlParseError);
    }
  });

  it('strips ONE leading BOM, as Blob.text() and TextDecoder do in the browser (critique F4)', () => {
    expect(jsXmlParser('﻿<a>t</a>').documentElement.textContent).toBe('t');
    expect(() => jsXmlParser('﻿﻿<a>t</a>')).toThrow(XmlParseError);
    // A server reading a .rse with readFileSync(p, 'utf8') keeps the BOM.
    setXmlParser(jsXmlParser);
    expect(parseRse('﻿<engine-database><engine-list><engine code="A1" mfg="M" dia="29" len="100" '
      + 'initWt="50" propWt="20" delays="5"><data><eng-data t="0" f="0" m="20"/><eng-data t="1" f="10" m="0"/>'
      + '</data></engine></engine-list></engine-database>')).toHaveLength(1);
  });

  it('refuses ANY DOCTYPE structurally, wherever it sits (critique F5: the 4 KiB regex was bypassed twice)', () => {
    for (const text of [
      '<!DOCTYPE a><a/>',
      `<!--${'x'.repeat(5000)}--><!DOCTYPE a [<!ENTITY e "X">]><a>&e;</a>`,
      '<!DOCTYPE a SYSTEM "x>y" [<!ENTITY e "X">]><a>&e;</a>',
    ]) expect(() => xmlGate(text), text.slice(0, 30)).toThrow(/DOCTYPE is not accepted/);
  });

  it('refuses an XML declaration of any version but 1.0 (critique F4: saxes would read 1.1)', () => {
    expect(() => jsXmlParser('<?xml version="1.1"?><a>&#1;</a>')).toThrow(/version 1\.1 is not accepted/);
    expect(() => jsXmlParser('<?xml version="1.1"?><a>t</a>')).toThrow(XmlParseError);
    expect(jsXmlParser('<?xml version="1.0"?><a>t</a>').documentElement.textContent).toBe('t');
    expect(jsXmlParser("<?xml version='1.0' encoding='utf-8'?><a>t</a>").documentElement.textContent).toBe('t');
  });

  it('normalises line ends as XML 1.0 does — CRLF and CR only; U+0085, U+2028, U+2029 stay (critique F4)', () => {
    expect(jsXmlParser('<a>1\r\n2\r3\u00854 5 6</a>').documentElement.textContent)
      .toBe('1\n2\n3\u00854 5 6');
    expect(jsXmlParser('<a x="1\r\n2\t3"/>').documentElement.getAttribute('x')).toBe('1 2 3');
  });

  it('refuses what xmldom alone accepts silently: a bare & and a raw control character', () => {
    expect(() => jsXmlParser('<a>R & D</a>')).toThrow(XmlParseError);
    expect(() => jsXmlParser('<a>\u0002</a>')).toThrow(XmlParseError);
    expect(() => xmlDom('<a>R & D</a>')).not.toThrow(); // why the gate exists
  });
});
