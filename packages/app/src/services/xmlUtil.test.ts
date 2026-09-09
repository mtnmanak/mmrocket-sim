// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { escapeXml, xmlNum, xmlText } from './xmlUtil.js';
import { exportRkt } from './rocksimFile.js';
import { exportCdx1 } from './rasaeroFile.js';
import type { RocketTree } from '@online-openrocket/engine';

/**
 * 24 lines with no direct test, imported by all six file writers
 * (docs/AUDIT.md, 2026-09-08). `escapeXml` decides whether an exported
 * `.ork`/`.rkt`/`.CDX1`/`.xlsx` PARSES AT ALL — an unescaped `&` in a rocket
 * name produces a file the program it was exported for refuses to open — and
 * escaping was asserted only on the `.ork` and `.xlsx` paths. A grep for
 * `&amp;` across `rocksimFile.test.ts` and `rasaeroFile.test.ts` returned
 * nothing, so RockSim and RASAero export escaping was entirely unasserted.
 */
describe('escapeXml', () => {
  it('escapes the four characters that break a document or an attribute', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
    expect(escapeXml('a < b')).toBe('a &lt; b');
    expect(escapeXml('a > b')).toBe('a &gt; b');
    expect(escapeXml('say "hi"')).toBe('say &quot;hi&quot;');
  });

  it('escapes the ampersand FIRST, so an escape is not double-escaped', () => {
    // The classic ordering bug: `<` -> `&lt;` -> `&amp;lt;`. Doing `&` last
    // would corrupt every other escape in the string.
    expect(escapeXml('<')).toBe('&lt;');
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
    expect(escapeXml('&amp;')).toBe('&amp;amp;');
  });

  it("does NOT escape the apostrophe, which is correct here and load-bearing", () => {
    // Every attribute emitted by all three exporters is DOUBLE-quoted, so `'`
    // needs no escaping. That is an invariant of the writers, not of this
    // function: a single-quoted attribute added anywhere would break it, which
    // is why it is written down.
    expect(escapeXml("Eric's rocket")).toBe("Eric's rocket");
  });

  it('leaves ordinary text, including non-ASCII, alone', () => {
    expect(escapeXml('Ласточка 76 mm')).toBe('Ласточка 76 mm');
    expect(escapeXml('')).toBe('');
  });
});

describe('xmlText', () => {
  const doc = (xml: string): Element =>
    new DOMParser().parseFromString(xml, 'text/xml').documentElement;

  it('trims, and returns null for absent, empty and whitespace-only text', () => {
    const el = doc('<r><a>  hi  </a><b></b><c>   </c></r>');
    expect(xmlText(el, 'a')).toBe('hi');
    expect(xmlText(el, 'b')).toBeNull();
    expect(xmlText(el, 'c')).toBeNull();
    expect(xmlText(el, 'missing')).toBeNull();
  });

  it('is why `Number("") === 0` is not a trap in the importers', () => {
    // The whole reason the empty/whitespace cases return null rather than '':
    // every `num`/`xmlNum` reader in the three importers falls through to its
    // own default instead of reading a blank tag as zero.
    const el = doc('<r><length>   </length></r>');
    expect(xmlText(el, 'length')).toBeNull();
    expect(xmlNum(el, 'length', 0.3)).toBe(0.3);
  });
});

describe('xmlNum', () => {
  const doc = (xml: string): Element =>
    new DOMParser().parseFromString(xml, 'text/xml').documentElement;

  it('reads a DIRECT child only, never a nested one', () => {
    // `:scope >` matters: a <length> inside a child component must not be read
    // as this component's own.
    const el = doc('<r><child><length>9</length></child></r>');
    expect(xmlNum(el, 'length', 0.3)).toBe(0.3);
  });

  it('falls back on absent, blank and unparseable values', () => {
    const el = doc('<r><a>0.42</a><b></b><c>oops</c><d>NaN</d></r>');
    expect(xmlNum(el, 'a', 0.3)).toBe(0.42);
    expect(xmlNum(el, 'b', 0.3)).toBe(0.3);
    expect(xmlNum(el, 'c', 0.3)).toBe(0.3);
    expect(xmlNum(el, 'd', 0.3)).toBe(0.3);
  });

  it('reads a real zero as zero, not as a fallback', () => {
    const el = doc('<r><a>0</a></r>');
    expect(xmlNum(el, 'a', 0.3)).toBe(0);
  });

  it('rejects an infinity rather than propagating it into the geometry', () => {
    const el = doc('<r><a>1e999</a></r>');
    expect(xmlNum(el, 'a', 0.3)).toBe(0.3);
  });
});

/**
 * The gap the audit actually named: the `.ork` and `.xlsx` writers had escaping
 * tests and the other two did not. A rocket called `Bob & Sons <test>` is a
 * perfectly ordinary name and it must not produce a file RockSim or RASAero
 * refuses to open.
 */
describe('the .rkt and .CDX1 writers escape what they emit', () => {
  const tree = (name: string): RocketTree => ({
    name,
    components: [{
      type: 'stage', id: 's', name,
      children: [
        { type: 'nosecone', id: 'n', name, length: 0.1, aftRadius: 0.024, shape: 'ogive' },
        { type: 'bodytube', id: 'b', name, length: 0.3, outerRadius: 0.024 },
      ],
    }],
  } as unknown as RocketTree);

  const NASTY = 'Bob & Sons <test> "v2"';

  const parses = (xml: string): boolean => {
    const d = new DOMParser().parseFromString(xml, 'text/xml');
    return d.querySelector('parsererror') === null;
  };

  it('.rkt survives a name with &, < and quotes', () => {
    const out = exportRkt({ name: NASTY, tree: tree(NASTY), motors: {} });
    expect(out).toContain('&amp;');
    expect(out).not.toMatch(/<[A-Za-z]+>[^<]*&(?!amp;|lt;|gt;|quot;)/);
    expect(parses(out), 'the exported .rkt must be well-formed XML').toBe(true);
  });

  it('.CDX1 survives the same name', () => {
    const out = exportCdx1({ name: NASTY, tree: tree(NASTY), motors: {} });
    expect(out).toContain('&amp;');
    expect(parses(out), 'the exported .CDX1 must be well-formed XML').toBe(true);
  });
});
