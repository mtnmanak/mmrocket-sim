import { afterEach, describe, expect, it } from 'vitest';
import { WINDOWS_1252_CHUNK, decodeXml, setTextDecoderFactoryForTests } from './xmlUtil.js';

/**
 * decodeXml's windows-1252 reads must not depend on the runtime's TextDecoder:
 * Node 22.22.0 decodes 0x80-0x9F as C1 controls (0x99 as U+0099, not U+2122),
 * and a runtime without the label throws. Every case runs under a decoder that
 * throws, one that answers ISO-8859-1, and the real one; all three must give
 * the WHATWG table, written out literally here and never taken from a decoder.
 */
const C1 = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d,
  0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153,
  0x9d, 0x17e, 0x178];
const LABELS = ['ansi_x3.4-1968', 'ascii', 'cp1252', 'cp819', 'csisolatin1', 'ibm819', 'iso-8859-1', 'iso-ir-100',
  'iso8859-1', 'iso88591', 'iso_8859-1', 'iso_8859-1:1987', 'l1', 'latin1', 'us-ascii', 'windows-1252', 'x-cp1252'];
const CASED = ['WINDOWS-1252', 'Iso-8859-1', 'ISO_8859-1:1987', 'US-ASCII', 'Latin1', 'X-CP1252', 'L1'];
const NOTE_TAIL = ' — it is not UTF-8 and does not say which encoding it uses. Check the part and material names.';

/** The expected text of single bytes: the table for 0x80-0x9F, the same code point otherwise. */
const expected = (bytes: ArrayLike<number>) =>
  Array.from(bytes, b => String.fromCharCode(b >= 0x80 && b < 0xa0 ? C1[b - 0x80]! : b)).join('');
const ascii = (s: string) => Array.from(s, c => c.charCodeAt(0));
const ALL = Array.from({ length: 256 }, (_, i) => i);

type Factory = (label: string) => TextDecoder;
const WINDOWS_1252 = new Set(LABELS);
/** A runtime with no windows-1252 under any of its labels. */
const throwing: Factory = label => {
  if (WINDOWS_1252.has(label.trim().toLowerCase())) throw new RangeError(`The "${label}" encoding is not supported`);
  return new TextDecoder(label);
};
/** A runtime that takes the label but reads every byte as its own code point (ISO-8859-1). */
const latin1: Factory = label => {
  if (!WINDOWS_1252.has(label.trim().toLowerCase())) return new TextDecoder(label);
  return { encoding: 'windows-1252', fatal: false, ignoreBOM: false,
    decode: (input?: AllowSharedBufferSource) =>
      Array.from(input as Uint8Array, b => String.fromCharCode(b)).join('') } as TextDecoder;
};
const real: Factory = label => new TextDecoder(label);
const DECODERS = [['throwing', throwing], ['ISO-8859-1', latin1], ['real', real]] as const;

afterEach(() => setTextDecoderFactoryForTests(null));

describe.each(DECODERS)('decodeXml windows-1252 under a %s runtime decoder', (_name, factory) => {
  it.each([...LABELS, ...CASED])('reads every byte of a file declared %s by the WHATWG table', label => {
    setTextDecoderFactoryForTests(factory);
    for (const quote of ['"', "'"]) {
      const head = `<?xml version="1.0" encoding=${quote}${label}${quote}?>`;
      const bytes = Uint8Array.from([...ascii(`${head}<a>`), ...ALL, ...ascii('</a>')]);
      expect(decodeXml(bytes)).toEqual({ xml: `${head}<a>${expected(ALL)}</a>` });
    }
  });

  it('does not throw on a file with no declaration, and keeps the UTF-8 note for one that is not UTF-8', () => {
    setTextDecoderFactoryForTests(factory);
    expect(decodeXml(Uint8Array.from(ascii('<a>Fin</a>')))).toEqual({ xml: '<a>Fin</a>' });
    expect(decodeXml(Uint8Array.from(ascii(' \n<?xml version="1.0"?><a/>')))).toEqual({ xml: ' \n<?xml version="1.0"?><a/>' });
    expect(decodeXml(new Uint8Array(0))).toEqual({ xml: '' });
    expect(decodeXml(Uint8Array.from([...ascii('<a>Aero'), 0x99, 0x85, ...ascii('</a>')]))).toEqual({
      xml: '<a>Aero\u{FFFD}\u{FFFD}</a>', note: `2 characters in this file could not be read and were replaced${NOTE_TAIL}` });
  });

  it('reads a file longer than one decode chunk, with 0x99 on each side of the boundary', () => {
    setTextDecoderFactoryForTests(factory);
    const head = ascii('<?xml version="1.0" encoding="windows-1252"?><a>');
    const body = Array.from({ length: 2 * WINDOWS_1252_CHUNK + 7 - head.length }, (_, i) => 0x41 + (i % 26));
    const bytes = Uint8Array.from([...head, ...body]);
    for (const at of [WINDOWS_1252_CHUNK - 1, WINDOWS_1252_CHUNK, WINDOWS_1252_CHUNK + 1, 2 * WINDOWS_1252_CHUNK - 1,
      2 * WINDOWS_1252_CHUNK, bytes.length - 1]) bytes[at] = 0x99;
    bytes[bytes.length - 2] = 0x80;
    const xml = decodeXml(bytes).xml;
    expect(xml).toHaveLength(bytes.length);
    expect(xml).toBe(expected(bytes));
    expect(xml[WINDOWS_1252_CHUNK - 1]).toBe('\u2122');
    expect(xml[WINDOWS_1252_CHUNK]).toBe('\u2122');
  });

  it('keeps a UTF-16 label on single bytes, an unknown label and other legacy labels as they were', () => {
    setTextDecoderFactoryForTests(factory);
    const doc = (label: string) => Uint8Array.from([...ascii(`<?xml version="1.0" encoding="${label}"?><a>`), 0xe9, ...ascii('</a>')]);
    for (const label of ['utf-16', 'x-no-such-thing', 'utf-8']) {
      expect(decodeXml(doc(label))).toEqual({ xml: `<?xml version="1.0" encoding="${label}"?><a>\u{FFFD}</a>`,
        note: `1 character in this file could not be read and was replaced${NOTE_TAIL}` });
    }
    // Not windows-1252: still the runtime's own decoder, exactly as before.
    expect(decodeXml(doc('iso-8859-2')).xml).toBe('<?xml version="1.0" encoding="iso-8859-2"?><a>\u00e9</a>');
  });
});

describe('decodeXml windows-1252 runtime probe', () => {
  it('uses the runtime decoder when it passes the probe, and probes once', () => {
    const made: string[] = [];
    let decodes = 0;
    setTextDecoderFactoryForTests(label => {
      made.push(label);
      return { encoding: 'windows-1252', fatal: false, ignoreBOM: false,
        decode: (input?: AllowSharedBufferSource) => { decodes++; return expected(input as Uint8Array); } } as TextDecoder;
    });
    const bytes = Uint8Array.from([...ascii('<?xml version="1.0" encoding="cp1252"?><a>'), 0x99, ...ascii('</a>')]);
    for (let i = 0; i < 3; i++) expect(decodeXml(bytes).xml).toBe('<?xml version="1.0" encoding="cp1252"?><a>\u2122</a>');
    expect(made).toEqual(['windows-1252']);
    // The probe, then the declaration head and the document on each of the three reads.
    expect(decodes).toBe(1 + 3 * 2);
  });

  it('reads by the table a label only the runtime resolves to windows-1252', () => {
    setTextDecoderFactoryForTests(label => latin1(label === 'x-runtime-alias' ? 'windows-1252' : label));
    const bytes = Uint8Array.from([...ascii('<?xml version="1.0" encoding="x-runtime-alias"?><a>'), 0x99, ...ascii('</a>')]);
    expect(decodeXml(bytes)).toEqual({ xml: '<?xml version="1.0" encoding="x-runtime-alias"?><a>\u2122</a>' });
  });

  it('does not use a runtime decoder that fails the probe', () => {
    let decodes = 0;
    setTextDecoderFactoryForTests(label => {
      const inner = latin1(label);
      return { ...inner, encoding: inner.encoding,
        decode: (input?: AllowSharedBufferSource) => { decodes++; return inner.decode(input); } } as TextDecoder;
    });
    const bytes = Uint8Array.from([...ascii('<?xml version="1.0" encoding="windows-1252"?><a>'), 0x99, ...ascii('</a>')]);
    expect(decodeXml(bytes).xml).toBe('<?xml version="1.0" encoding="windows-1252"?><a>\u2122</a>');
    expect(decodeXml(bytes).xml).toBe('<?xml version="1.0" encoding="windows-1252"?><a>\u2122</a>');
    expect(decodes).toBe(1);
  });
});
