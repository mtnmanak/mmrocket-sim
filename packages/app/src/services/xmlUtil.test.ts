// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { decodeXml, escapeXml, escapeXmlAttr, parseDecimal, xmlNum, xmlText } from './xmlUtil.js';
import { exportOrk } from './orkFile.js';
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

  it('drops the characters XML cannot carry at all, and only those', () => {
    // Audit 2026-09-22: a U+0002 pasted from a vendor PDF passed straight
    // through, and the saved file could not be reopened here or on the
    // desktop. No escape exists for it (`&#2;` is just as ill-formed).
    expect(escapeXml('Nose\u0002cone')).toBe('Nosecone');
    expect(escapeXml('a\u0000b\u0008c\u000Bd\u000Ce\u001Ff')).toBe('abcdef');
    expect(escapeXml('x\u{FFFE}y\u{FFFF}z')).toBe('xyz');
    // A LONE surrogate goes; a pair is one legal character and stays.
    expect(escapeXml('a\uD800b\uDC00c')).toBe('abc');
    expect(escapeXml('fin \u{1F680} set')).toBe('fin \u{1F680} set');
    // TAB, LF and CR are legal XML and are kept in text.
    expect(escapeXml('a\tb\nc\rd')).toBe('a\tb\nc\rd');
    // C1 controls and U+FFFD are legal (if unusual) and are kept.
    expect(escapeXml('\u0085\u{FFFD}')).toBe('\u0085\u{FFFD}');
  });
});

describe('escapeXmlAttr', () => {
  it('writes TAB, LF and CR as character references, which normalisation leaves alone', () => {
    // Raw in an attribute, each reads back as a space.
    expect(escapeXmlAttr('a\tb\nc\rd')).toBe('a&#9;b&#10;c&#13;d');
    expect(escapeXmlAttr('Main & "backup"\u0002')).toBe('Main &amp; &quot;backup&quot;');
  });
});

/** Every character in `s` is one XML 1.0's `Char` production allows. */
const xmlLegal = (s: string): boolean => !/[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/u.test(s);

/**
 * The writers end to end. happy-dom's DOMParser is lenient here and accepts
 * these characters, so it cannot show the failure; a browser's parser and
 * the desktop's refuse the file, and the XML 1.0 `Char` production is what
 * they apply — so that is what is asserted.
 */
describe('no writer emits a character XML forbids', () => {
  const PDF_NAME = 'Nose\u0002cone \uD800v2';
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

  it('.rkt', () => {
    const out = exportRkt({ name: PDF_NAME, tree: tree(PDF_NAME), motors: {} });
    expect(xmlLegal(out)).toBe(true);
    expect(out).toContain('Nosecone v2');
  });

  it('.CDX1', () => {
    const out = exportCdx1({ name: PDF_NAME, tree: tree(PDF_NAME), motors: {} });
    expect(xmlLegal(out)).toBe(true);
  });

  it('.ork', () => {
    const out = exportOrk({ name: PDF_NAME, tree: tree(PDF_NAME) });
    expect(xmlLegal(out)).toBe(true);
    expect(out).toContain('<name>Nosecone v2</name>');
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

  it('falls back on a hex, binary or octal literal, as the desktop does', () => {
    // `Number('0x10')` is 16. Desktop's Double.parseDouble throws on it, so
    // the field is unreadable there and must fall back here, not import as a
    // different number (audit 2026-09-22).
    const el = doc('<r><a>0x10</a><b>0b11</b><c>0o17</c><d>0X1F</d></r>');
    for (const tag of ['a', 'b', 'c', 'd']) expect(xmlNum(el, tag, 0.3)).toBe(0.3);
  });
});

describe('parseDecimal', () => {
  it('reads every decimal spelling a file writes', () => {
    expect(parseDecimal('0.42')).toBe(0.42);
    expect(parseDecimal(' 12 ')).toBe(12);
    expect(parseDecimal('-.5')).toBe(-0.5);
    expect(parseDecimal('+5.')).toBe(5);
    expect(parseDecimal('1.0E-4')).toBe(1e-4); // Java's Double.toString form
    expect(parseDecimal('2e+3')).toBe(2000);
    expect(parseDecimal('007')).toBe(7);
  });

  it('is NaN for a blank, a prefix literal, a comma decimal or text', () => {
    // Blank is the one that mattered most: `Number('')` is 0, which put a fin
    // vertex on x = 0 from `x=""`.
    for (const s of ['', '   ', null, undefined, '0x10', '0b11', '0o17', '2,5', 'NaN', 'auto', '1e', '.']) {
      expect(parseDecimal(s), String(s)).toBeNaN();
    }
  });

  it('stays linear on a long run of digits with one bad character', () => {
    // The grammar is unambiguous, so this cannot backtrack quadratically.
    const s = `${'1'.repeat(2_000_000)}x`;
    const t0 = performance.now();
    expect(parseDecimal(s)).toBeNaN();
    expect(performance.now() - t0).toBeLessThan(1000);
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

/** Bytes from ASCII text and raw byte runs, in order. */
const bytesOf = (...parts: (string | number[])[]): Uint8Array =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
/** UTF-16 code units as little- or big-endian byte pairs. */
const utf16 = (s: string, le: boolean): number[] =>
  [...s].flatMap((c) => { const u = c.charCodeAt(0); return le ? [u & 255, u >> 8] : [u >> 8, u & 255]; });

describe('decodeXml — the encoding a file declares, not always UTF-8', () => {
  // Audit 2026-09-22 (carried from 8 September): every importer read the
  // bytes as UTF-8 and discarded `encoding=`. A windows-1252 name came in with
  // replacement characters and no word about it; a UTF-16 file did not parse.
  const DEG = 'Fin 30° cant';

  it('reads plain UTF-8, with or without a byte-order mark, and says nothing', () => {
    const utf8 = [...new TextEncoder().encode(`<a>${DEG}</a>`)];
    expect(decodeXml(bytesOf(utf8))).toEqual({ xml: `<a>${DEG}</a>` });
    expect(decodeXml(bytesOf([0xef, 0xbb, 0xbf], utf8))).toEqual({ xml: `<a>${DEG}</a>` });
  });

  it('honours a single-byte encoding the declaration names', () => {
    for (const enc of ['windows-1252', 'ISO-8859-1', 'latin1']) {
      const b = bytesOf(`<?xml version="1.0" encoding="${enc}"?><a>Fin 30`, [0xb0], ' cant</a>');
      expect(decodeXml(b).xml).toBe(`<?xml version="1.0" encoding="${enc}"?><a>${DEG}</a>`);
      expect(decodeXml(b).note).toBeUndefined();
    }
  });

  it('reads UTF-16 by its byte-order mark, or by the NUL beside its first "<"', () => {
    const doc = `<?xml version="1.0" encoding="utf-16"?><a>${DEG}</a>`;
    expect(decodeXml(bytesOf([0xff, 0xfe], utf16(doc, true))).xml).toBe(doc);
    expect(decodeXml(bytesOf([0xfe, 0xff], utf16(doc, false))).xml).toBe(doc);
    expect(decodeXml(bytesOf(utf16(doc, true))).xml).toBe(doc);
    expect(decodeXml(bytesOf(utf16(doc, false))).xml).toBe(doc);
  });

  it('ignores a UTF-16 label on a file written in single bytes, as .NET can write it', () => {
    const b = bytesOf('<?xml version="1.0" encoding="utf-16"?><a>', [...new TextEncoder().encode(DEG)], '</a>');
    expect(decodeXml(b).xml).toBe(`<?xml version="1.0" encoding="utf-16"?><a>${DEG}</a>`);
  });

  it('keeps reading, and says how many characters it replaced, when the bytes are not UTF-8', () => {
    const r = decodeXml(bytesOf('<a>Fin 30', [0xb0], ' cant, 12', [0xbd], ' in</a>'));
    expect(r.xml).toBe('<a>Fin 30\u{FFFD} cant, 12\u{FFFD} in</a>');
    expect(r.note).toBe('2 characters in this file could not be read and were replaced — it is not UTF-8 '
      + 'and does not say which encoding it uses. Check the part and material names.');
  });

  it('falls back to UTF-8 for a label the browser does not know', () => {
    const b = bytesOf('<?xml version="1.0" encoding="x-no-such-thing"?><a>', [...new TextEncoder().encode(DEG)], '</a>');
    expect(decodeXml(b)).toEqual({ xml: `<?xml version="1.0" encoding="x-no-such-thing"?><a>${DEG}</a>` });
  });
});
