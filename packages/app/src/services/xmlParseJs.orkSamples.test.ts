import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { SaxesParser } from 'saxes';
import { createJsXmlParser, jsXmlParser, xmlGate, type XmlLimits } from './xmlParseJs.js';
import { XmlBudgetExceededError, XmlParseError, type XmlDocument, type XmlElement, type XmlList } from './xmlParse.js';

// The API's opt-in (packages/api/src/index.ts) and main's E1 budgets without it.
const E1: XmlLimits = { maxElements: 50_000, maxDepth: 64 };
const OMIT: XmlLimits = { ...E1, omitOrkSamples: { maxElements: 1_000_000 } };

const ork = (flight: string, after = '') => '<openrocket version="1.10"><rocket><name>R</name></rocket><simulations>'
  + `<simulation status="loaded"><name>S</name><conditions><configid>a</configid></conditions>`
  + `<flightdata maxaltitude="182.3" flighttime="40.2">${flight}</flightdata>${after}</simulation></simulations></openrocket>`;
const branch = (inner: string, attrs = 'name="Sustainer" types="Time,Altitude"') => `<databranch ${attrs}>${inner}</databranch>`;
const points = (n: number) => '<datapoint>0.01,1.5</datapoint>'.repeat(n);

afterEach(() => { vi.restoreAllMocks(); });

/** What xmldom is handed, and what it builds: the DOM boundary itself. */
function atDom(parse: (text: string) => XmlDocument, xml: string) {
  const spy = vi.spyOn(DOMParser.prototype, 'parseFromString');
  try {
    // Both parsers' documents are xmldom's, which has getElementsByTagName.
    const doc = parse(xml) as XmlDocument & { getElementsByTagName(name: string): XmlList };
    expect(spy).toHaveBeenCalledTimes(1);
    return { text: spy.mock.calls[0]![0], doc, elements: doc.getElementsByTagName('*').length };
  } finally { spy.mockRestore(); }
}
/** Source elements, counted from saxes events (never a regex). */
const sourceElements = (xml: string) => {
  let n = 0;
  const sax = new SaxesParser({ xmlns: true });
  sax.on('opentag', () => { n++; });
  sax.write(xml).close();
  return n;
};

/**
 * Elements, attributes and non-whitespace text outside each sample branch, in
 * document order: what any importer can read. A branch keeps its attributes.
 */
function readable(doc: XmlDocument): string[] {
  const out: string[] = [];
  const walk = (el: XmlElement, path: string[]) => {
    const attrs = Array.from((el as unknown as { attributes: ArrayLike<{ name: string; value: string }> }).attributes,
      a => `${a.name}=${a.value}`);
    out.push(`${path.join('>')}>${el.tagName}[${attrs.join(' ')}]`);
    if (path.join('>') === 'openrocket>simulations>simulation>flightdata' && el.tagName === 'databranch') return;
    for (const node of Array.from((el as unknown as { childNodes: ArrayLike<{ nodeType: number; data?: string }> }).childNodes)) {
      if (node.nodeType === 1) walk(node as unknown as XmlElement, [...path, el.tagName]);
      else if (node.data?.trim()) out.push(`${node.nodeType}:${node.data}`);
    }
  };
  walk(doc.documentElement, []);
  return out;
}

describe('omitOrkSamples: stored .ork sample content never reaches xmldom', () => {
  it('cuts each sample branch to a self-closing element before DOM construction', () => {
    const xml = ork(`<warning>w</warning>${branch(`<event time="0" type="launch"/>${points(500)}`)}`
      + branch(points(300), 'name="Booster"'), '<simwarnings version="1">[]</simwarnings>');
    const { text, doc, elements } = atDom(createJsXmlParser(OMIT), xml);
    expect(text).not.toContain('<datapoint');
    expect(text).not.toContain('<event');
    expect(doc.getElementsByTagName('datapoint')).toHaveLength(0);
    const branches = Array.from(doc.getElementsByTagName('databranch'));
    expect(branches.map(b => [b.getAttribute('name'), b.getAttribute('types'), b.children.length]))
      .toEqual([['Sustainer', 'Time,Altitude', 0], ['Booster', null, 0]]);
    // The DOM holds the source minus every branch's content: 801 elements never built.
    expect(elements).toBe(sourceElements(xml) - 801);
    expect(readable(doc)).toEqual(readable(createJsXmlParser(E1)(xml)));
  });

  it('hands xmldom the very same string on the default, E1 and browser-parity paths', () => {
    const xml = ork(branch(points(50)));
    for (const parse of [jsXmlParser, createJsXmlParser(E1)]) {
      const { text, doc } = atDom(parse, xml);
      expect(text).toBe(xml);
      expect(doc.getElementsByTagName('datapoint')).toHaveLength(50);
    }
  });

  it.each([
    ['branch directly under simulation', `<openrocket><simulations><simulation>${branch(points(3))}</simulation></simulations></openrocket>`],
    ['prefixed flightdata', `<openrocket><simulations><simulation><x:flightdata xmlns:x="u">${branch(points(3))}</x:flightdata></simulation></simulations></openrocket>`],
    ['prefixed databranch', ork(`<x:databranch xmlns:x="u">${points(3)}</x:databranch>`)],
    ['flightdata inside conditions', `<openrocket><simulations><simulation><conditions><flightdata>${branch(points(3))}</flightdata></conditions></simulation></simulations></openrocket>`],
    ['simulations inside rocket', `<openrocket><rocket><simulations><simulation><flightdata>${branch(points(3))}</flightdata></simulation></simulations></rocket></openrocket>`],
    ['another root', `<RockSimDocument><simulations><simulation><flightdata>${branch(points(3))}</flightdata></simulation></simulations></RockSimDocument>`],
    ['upper-case lookalike', ork(`<DataBranch>${points(3)}</DataBranch>`)],
    ['self-closing branch', ork('<databranch name="S"/>')],
    ['branch holding an extension', ork(branch(`${points(3)}<extension extensionid="x"/>${points(3)}`))],
    ['branch holding a prefixed extension', ork(branch(`${points(3)}<p:extension xmlns:p="u"/>`))],
  ])('keeps a %s whole', (_kind, xml) => {
    const { text, doc } = atDom(createJsXmlParser(OMIT), xml);
    expect(text).toBe(xml);
    expect(doc.getElementsByTagName('datapoint')).toHaveLength(xml.includes('<datapoint') ? (xml.match(/<datapoint>/g) ?? []).length : 0);
  });

  it('keeps a literal parsererror inside a branch, so both paths refuse the file', () => {
    const xml = ork(branch(`${points(2)}<parsererror/>`));
    expect(() => createJsXmlParser(E1)(xml)).toThrow(XmlParseError);
    expect(() => createJsXmlParser(OMIT)(xml)).toThrow(XmlParseError);
  });

  it('cuts a branch nested in a branch with its parent, and every simulation\'s branches', () => {
    const sim = (id: string) => `<simulation><conditions><configid>${id}</configid></conditions><flightdata maxaltitude="1">`
      + `${branch(`${points(2)}${branch(points(2))}`)}</flightdata></simulation>`;
    const xml = `<openrocket><simulations>${sim('a')}${sim('b')}<simulation><name>empty</name></simulation></simulations></openrocket>`;
    const { text, doc } = atDom(createJsXmlParser(OMIT), xml);
    expect(text).not.toContain('<datapoint');
    expect(doc.getElementsByTagName('databranch')).toHaveLength(2);
    expect(readable(doc)).toEqual(readable(createJsXmlParser(E1)(xml)));
  });

  it.each([
    ['comments and CDATA naming tags', '<!-- </databranch><datapoint> --><![CDATA[</databranch></flightdata>]]><datapoint>1</datapoint>'],
    ['processing instructions', '<?mark </databranch>?><datapoint>1</datapoint>'],
    ['quoted ">" and "/>" in attributes', '<event type="a>b" source="/>"/><datapoint note=\'a>b/>\'>1</datapoint>'],
    ['namespaces declared on the branch content', '<q:point xmlns:q="urn:q"><q:v>1</q:v></q:point>'],
    ['entities and character references', '<datapoint>&amp;&lt;&#x41;&#66;</datapoint>'],
    ['CRLF and CR line ends', '\r\n<datapoint>1</datapoint>\r<datapoint>2</datapoint>\r\n'],
    ['astral and non-ASCII characters', '<datapoint>\u{1F680}é </datapoint><event type="ü\u{10000}"/>'],
  ])('keeps everything readable identical around %s', (_kind, inner) => {
    // Non-ASCII before and after the branch moves no offset: cuts are string indices from saxes.
    const xml = ork(`<warning>\u{1F680} first</warning>${branch(inner)}<warning>last é</warning>`,
      '<simwarnings version="1">[\u{1F680}]</simwarnings>');
    const { text, doc } = atDom(createJsXmlParser(OMIT), xml);
    expect(text).not.toContain('datapoint>');
    expect(readable(doc)).toEqual(readable(createJsXmlParser(E1)(xml)));
    expect(text.endsWith('<warning>last é</warning></flightdata><simwarnings version="1">[\u{1F680}]</simwarnings></simulation></simulations></openrocket>')).toBe(true);
  });

  it.each([
    ['a mismatched end tag', '<datapoint>1</datapint>'],
    ['an unclosed element', '<datapoint>1'],
    ['a bare ampersand', '<datapoint>R & D</datapoint>'],
    ['an undefined entity', '<datapoint>&nbsp;</datapoint>'],
    ['a control character', '<datapoint>\u0002</datapoint>'],
    ['a lone surrogate', '<datapoint>\uD800</datapoint>'],
    ['an unbound prefix', '<x:datapoint>1</x:datapoint>'],
    ['a rebound xml prefix', '<datapoint xmlns:xml="urn:wrong">1</datapoint>'],
    ['a duplicate attribute', '<event a="1" a="2"/>'],
    ['a DOCTYPE in content', '<!DOCTYPE x>'],
    ['an unterminated comment', '<!-- 1'],
    ['"]]>" in text', '<datapoint>]]></datapoint>'],
    ['an invalid name', '<1point/>'],
    ['an XML declaration mid-document', '<?xml version="1.0"?>'],
  ])('refuses %s inside an omitted branch, as main does', (_kind, inner) => {
    const xml = ork(branch(inner));
    const spy = vi.spyOn(DOMParser.prototype, 'parseFromString');
    expect(() => createJsXmlParser(E1)(xml)).toThrow(XmlParseError);
    expect(() => createJsXmlParser(OMIT)(xml)).toThrow(XmlParseError);
    expect(() => createJsXmlParser(OMIT).preflight!(xml)).toThrow(XmlParseError);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ['in a later branch, after an earlier one was cut', ork(branch(points(3)) + branch('<datapoint>R & D</datapoint>'))],
    ['in a later simulation\'s branch', ork(branch(points(3))).replace('</simulations>',
      `<simulation><flightdata>${branch('<datapoint>1</datapint>')}</flightdata></simulation></simulations>`)],
    ['after the cut, outside any branch', ork(branch(points(3)), '<simwarnings>&nbsp;</simwarnings>')],
    ['as an unclosed document after a cut', ork(branch(points(3))).replace('</openrocket>', '')],
  ])('still refuses malformed XML %s', (_kind, xml) => {
    const spy = vi.spyOn(DOMParser.prototype, 'parseFromString');
    expect(() => createJsXmlParser(E1)(xml)).toThrow(XmlParseError);
    expect(() => createJsXmlParser(OMIT)(xml)).toThrow(XmlParseError);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('omitOrkSamples budgets', () => {
  const small = (maxElements: number, skipped: number, maxDepth = 64): XmlLimits =>
    ({ maxElements, maxDepth, omitOrkSamples: { maxElements: skipped } });
  // openrocket rocket name simulations simulation name conditions configid flightdata databranch.
  const RETAINED = 10;

  it('applies the DOM element budget to retained elements, and counts the skipped ones apart', () => {
    const xml = ork(branch(points(100)));
    expect(sourceElements(xml)).toBe(RETAINED + 100);
    expect(() => createJsXmlParser(small(RETAINED, 100))(xml)).not.toThrow();
    expect(() => createJsXmlParser(small(RETAINED - 1, 100))(xml)).toThrow(`XML element limit is ${RETAINED - 1}.`);
    expect(() => createJsXmlParser(small(RETAINED, 99))(xml)).toThrow(new XmlBudgetExceededError('Stored flight data element limit is 99.'));
    expect(() => xmlGate(xml, small(RETAINED, 99))).toThrow(XmlBudgetExceededError);
    // Without the opt-in, main's accounting: every source element is a DOM element.
    expect(() => createJsXmlParser({ maxElements: RETAINED + 100, maxDepth: 64 })(xml)).not.toThrow();
    expect(() => createJsXmlParser({ maxElements: RETAINED + 99, maxDepth: 64 })(xml)).toThrow(`XML element limit is ${RETAINED + 99}.`);
  });

  it('opens a stored flight past E1\'s 50,000 elements that main refuses, never building the samples', () => {
    const xml = ork(branch(points(60_000)));
    expect(() => createJsXmlParser(E1)(xml)).toThrow('XML element limit is 50,000.');
    const { elements } = atDom(createJsXmlParser(OMIT), xml);
    expect(elements).toBe(RETAINED);
  });

  it('refuses past either budget before xmldom is reached', () => {
    const spy = vi.spyOn(DOMParser.prototype, 'parseFromString');
    expect(() => createJsXmlParser(small(RETAINED, 10))(ork(branch(points(11))))).toThrow('Stored flight data element limit is 10.');
    expect(() => createJsXmlParser(small(RETAINED - 1, 1000))(ork(branch(points(11))))).toThrow(`XML element limit is ${RETAINED - 1}.`);
    expect(spy).not.toHaveBeenCalled();
  });

  it('bounds skipped nodes on their own, with their own message', () => {
    const limits: XmlLimits = { maxElements: 50, maxDepth: 64, omitOrkSamples: { maxElements: 10, maxNodes: 20 } };
    expect(() => createJsXmlParser(limits)(ork(branch('<!---->'.repeat(20))))).not.toThrow();
    expect(() => createJsXmlParser(limits)(ork(branch('<!---->'.repeat(21))))).toThrow('Stored flight data node limit is 20.');
    // Default: four nodes per budgeted element, as main's DOM budget.
    expect(() => createJsXmlParser(small(50, 10))(ork(branch('<?p?>'.repeat(41))))).toThrow('Stored flight data node limit is 40.');
    // Retained nodes keep main's message and count; branch content is not in it.
    expect(() => createJsXmlParser({ maxElements: 50, maxDepth: 64, maxNodes: 25, omitOrkSamples: { maxElements: 10 } })(
      ork(branch('<!---->'.repeat(30))))).not.toThrow();
  });

  it('counts source depth, inside an omitted branch too', () => {
    // A branch sits at depth 5; its content at 6 and deeper.
    const nested = (n: number) => '<v>'.repeat(n) + '</v>'.repeat(n);
    expect(() => createJsXmlParser(small(50, 50, 8))(ork(branch(nested(3))))).not.toThrow();
    expect(() => createJsXmlParser(small(50, 50, 8))(ork(branch(nested(4))))).toThrow('XML nesting limit is 8.');
  });

  it('moves a kept branch back under the DOM budget', () => {
    const xml = ork(branch(`${points(20)}<extension extensionid="x"/>${points(20)}`));
    expect(() => createJsXmlParser(small(RETAINED + 41, 1000))(xml)).not.toThrow();
    expect(() => createJsXmlParser(small(RETAINED + 40, 1000))(xml)).toThrow(`XML element limit is ${RETAINED + 40}.`);
    // Its elements were never left on the skipped count.
    expect(() => createJsXmlParser(small(RETAINED + 41, 21))(xml)).not.toThrow();
  });

  it('keeps main\'s first-error precedence while streaming', () => {
    // Budget first, then malformed: the budget refusal; malformed first (an unquoted
    // attribute fails at once, an unclosed tag only at the end): the parse error.
    expect(() => createJsXmlParser(small(50, 5))(ork(branch(`${points(6)}<bad>`)))).toThrow(XmlBudgetExceededError);
    expect(() => createJsXmlParser(small(50, 5))(ork(branch(`<a b=1/>${points(6)}`)))).toThrow(XmlParseError);
    expect(() => createJsXmlParser(small(RETAINED - 1, 5))(ork(branch(points(1)) + '<bad>'))).toThrow(XmlBudgetExceededError);
  });

  it('preflight accepts and refuses exactly what the parser does', () => {
    for (const xml of [ork(branch(points(60_000))), ork(branch(points(5) + '<x>'))]) {
      let parsed: unknown, preflighted: unknown;
      try { createJsXmlParser(OMIT)(xml); } catch (e) { parsed = (e as Error).constructor; }
      try { createJsXmlParser(OMIT).preflight!(xml); } catch (e) { preflighted = (e as Error).constructor; }
      expect(preflighted).toBe(parsed);
    }
  });
});
