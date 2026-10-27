/**
 * Tiny shared XML helpers for the file-format services (.ork/.rkt/.CDX1/SVG).
 * One escape implementation app-wide — the per-file copies had drifted (some
 * skipped the quote escape) — with an attribute-value variant beside it.
 */
import type { XmlElement } from './xmlParse.js';

/**
 * Everything XML 1.0's `Char` production does NOT allow: the C0 controls other
 * than TAB, LF and CR, U+FFFE/U+FFFF, and a UTF-16 surrogate that is not half
 * of a pair. Written as the complement of the allowed set, and with the `u`
 * flag, which is what makes the class see a well-formed pair as the one code
 * point it encodes (allowed) and only a LONE surrogate as a surrogate.
 */
const XML_ILLEGAL = /[^\t\n\r\u{20}-\u{D7FF}\u{E000}-\u{FFFD}\u{10000}-\u{10FFFF}]/gu;

/**
 * Text escaped for XML content (or a double-quoted attribute — but see
 * escapeXmlAttr), with the characters XML cannot carry at all REMOVED.
 *
 * Removed, because no escape exists for them: `&#2;` is as ill-formed as the
 * raw byte. Audit 2026-09-22: a name pasted from a vendor PDF can carry a
 * U+0002, and the name inputs keep it, so the saved .ork/.rkt/.CDX1 could be
 * reopened neither here ("Not a valid … file") nor in desktop OR, its share
 * link failed, and the XLSX needed Excel's repair — while the autosave, which
 * is JSON, stayed fine and hid it until the file was needed.
 *
 * A CR is written as `&#13;`, in text as well as in attributes: raw, a
 * parser's end-of-line handling reads it back as LF (and CRLF as one LF), so
 * a configuration id carrying a CR came back from its `<configid>` element as
 * a different id from the one its `configid="…"` attributes kept, and the two
 * no longer matched. A reference is not normalised, so the CR survives.
 */
export function escapeXml(s: string): string {
  return s.replace(XML_ILLEGAL, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/\r/g, '&#13;');
}

/**
 * escapeXml for a double-quoted ATTRIBUTE value: TAB and LF are also written
 * as character references (escapeXml already writes CR as one). Raw, a
 * parser's attribute-value normalisation reads each back as a space — so a
 * configuration id with a newline returned from its `configid="…"` attributes
 * as a different id from the one the same file carries as `<configid>` text,
 * and the two no longer matched (audit 2026-09-22).
 */
export function escapeXmlAttr(s: string): string {
  return escapeXml(s).replace(/\t/g, '&#9;').replace(/\n/g, '&#10;');
}

/**
 * A design file's bytes as text, decoded the way an XML parser decides the
 * encoding (XML 1.0 Appendix F) rather than always as UTF-8: a byte-order
 * mark first; then UTF-16 recognised by the NUL beside its opening `<`; then
 * the declaration's `encoding=`, honoured when it names a single-byte encoding
 * the browser can decode (windows-1252, ISO-8859-1, …), and windows-1252 by
 * the WHATWG table on any runtime (decodeWindows1252); otherwise UTF-8, the
 * XML default. A UTF-16 label on a declaration readable as single bytes is
 * ignored, since a real UTF-16 file cannot be read that way — .NET writes that
 * mismatch.
 *
 * `note` is set when the bytes are not valid UTF-8 and nothing said otherwise:
 * they are still decoded, with U+FFFD for what could not be read, and the note
 * says how many were replaced. Audit 2026-09-22 (carried from 8 September):
 * every importer assumed UTF-8 and discarded `encoding=`, so a windows-1252
 * name silently came in with replacement characters, and a UTF-16 file did
 * not open at all.
 */
export function decodeXml(bytes: Uint8Array): { xml: string; note?: string } {
  const [b0, b1, b2] = [bytes[0], bytes[1], bytes[2]];
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) return decodeUtf8(bytes);
  if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0x3c && b1 === 0x00)) {
    return { xml: new TextDecoder('utf-16le').decode(bytes) };
  }
  if ((b0 === 0xfe && b1 === 0xff) || (b0 === 0x00 && b1 === 0x3c)) {
    return { xml: new TextDecoder('utf-16be').decode(bytes) };
  }
  let declarationEnd = 0;
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x3f && bytes[i + 1] === 0x3e) { declarationEnd = i + 2; break; }
    if (bytes[i] === 0x3e) break;
  }
  // Only ASCII matters in the head; decodeWindows1252 cannot throw.
  const head = decodeWindows1252(bytes.subarray(0, declarationEnd));
  const label = /^\s*<\?xml\s[^>]*?\bencoding\s*=\s*["']([A-Za-z][\w.:-]*)["']/.exec(head)?.[1];
  if (label && WINDOWS_1252_LABELS.has(label.trim().toLowerCase())) return { xml: decodeWindows1252(bytes) };
  if (label) {
    let decoder: TextDecoder | null = null;
    try {
      decoder = makeDecoder(label);
    } catch {
      // A label the browser does not know: UTF-8 below, as for no label.
    }
    const enc = decoder?.encoding;
    if (enc === 'windows-1252') return { xml: decodeWindows1252(bytes) };
    if (decoder && enc !== 'utf-8' && enc !== 'replacement' && !enc?.startsWith('utf-16')) {
      return { xml: decoder.decode(bytes) };
    }
  }
  return decodeUtf8(bytes);
}

/**
 * The WHATWG Encoding Standard's labels for windows-1252, lower case. A file
 * declaring ISO-8859-1 or US-ASCII is read as windows-1252, as browsers read
 * it. Matched here, not by the runtime's TextDecoder, which may lack them.
 */
const WINDOWS_1252_LABELS = new Set(['ansi_x3.4-1968', 'ascii', 'cp1252', 'cp819', 'csisolatin1', 'ibm819',
  'iso-8859-1', 'iso-ir-100', 'iso8859-1', 'iso88591', 'iso_8859-1', 'iso_8859-1:1987', 'l1', 'latin1', 'us-ascii',
  'windows-1252', 'x-cp1252']);

/**
 * windows-1252 bytes 0x80-0x9F as code points (WHATWG index); every other byte
 * is its own code point. Five of them (0x81, 0x8D, 0x8F, 0x90, 0x9D) are C1
 * controls in the standard too.
 */
const WINDOWS_1252_C1 = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/** Bytes per String.fromCharCode call in the built-in windows-1252 decode. */
export const WINDOWS_1252_CHUNK = 0x8000;

let makeDecoder = (label: string): TextDecoder => new TextDecoder(label);
/** The runtime's windows-1252 decoder once it has passed the probe; null when it failed; undefined before. */
let runtime1252: TextDecoder | null | undefined;

/**
 * Test seam, not app API: the TextDecoder constructor decodeXml uses for a
 * declared legacy label (null restores the real one), and a fresh probe.
 */
export function setTextDecoderFactoryForTests(make: ((label: string) => TextDecoder) | null): void {
  makeDecoder = make ?? ((label: string) => new TextDecoder(label));
  runtime1252 = undefined;
}

function decodeWithTable(bytes: Uint8Array): string {
  const window = new Uint16Array(Math.min(WINDOWS_1252_CHUNK, bytes.length));
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; start += WINDOWS_1252_CHUNK) {
    const n = Math.min(WINDOWS_1252_CHUNK, bytes.length - start);
    for (let i = 0; i < n; i++) {
      const b = bytes[start + i]!;
      window[i] = b >= 0x80 && b < 0xa0 ? WINDOWS_1252_C1[b - 0x80]! : b;
    }
    parts.push(String.fromCharCode(...window.subarray(0, n)));
  }
  return parts.join('');
}

/**
 * Bytes as windows-1252 by the WHATWG table, whatever the runtime: its own
 * decoder when that decodes every byte as the table does (probed once, the
 * same call shape as the real decode), else the table here. Node 22.22.0
 * returned 0x80-0x9F as C1 controls from a non-streaming decode (0x99 as
 * U+0099, not U+2122); a runtime without the label would throw. Never throws.
 */
function decodeWindows1252(bytes: Uint8Array): string {
  if (runtime1252 === undefined) {
    runtime1252 = null;
    try {
      const decoder = makeDecoder('windows-1252');
      const all = Uint8Array.from({ length: 256 }, (_, i) => i);
      if (decoder.decode(all) === decodeWithTable(all)) runtime1252 = decoder;
    } catch {
      // No windows-1252 in this runtime: the table below.
    }
  }
  return runtime1252 ? runtime1252.decode(bytes) : decodeWithTable(bytes);
}

function decodeUtf8(bytes: Uint8Array): { xml: string; note?: string } {
  try {
    return { xml: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    const xml = new TextDecoder('utf-8').decode(bytes);
    let n = 0;
    for (let i = xml.indexOf('\u{FFFD}'); i >= 0; i = xml.indexOf('\u{FFFD}', i + 1)) n++;
    return {
      xml,
      note: `${n.toLocaleString('en-US')} character${n === 1 ? '' : 's'} in this file could not be read and `
        + `${n === 1 ? 'was' : 'were'} replaced — it is not UTF-8 and does not say which encoding it uses. `
        + 'Check the part and material names.',
    };
  }
}

/** Trimmed text of the first selector match; null when absent or empty. */
export function xmlText(el: XmlElement, selector: string): string | null {
  const t = el.querySelector(selector)?.textContent;
  return t == null || t.trim() === '' ? null : t.trim();
}

/**
 * Plain decimal: sign, digits, optional fraction, optional exponent. The
 * integer part is `\d+(?:\.\d*)?` and not `\d+\.?\d*` on purpose: that
 * spelling is ambiguous, and a long run of digits followed by one bad
 * character backtracks quadratically — a denial of service from one field.
 */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * A number as a design file writes one, or NaN.
 *
 * NOT `Number()`, which also reads `0x10` as 16, `0b11` as 3 and `0o17` as 15,
 * and a blank or whitespace-only string as 0. The desktop parses every one of
 * these fields with Java's `Double.parseDouble`, which rejects all three
 * prefixes and a blank, so the same file must not import here as a different
 * number (audit 2026-09-22). Callers keep their own `Number.isFinite` test:
 * `1e999` is decimal and still Infinity.
 */
export function parseDecimal(s: string | null | undefined): number {
  if (s == null) return NaN;
  const t = s.trim();
  return DECIMAL.test(t) ? Number(t) : NaN;
}

/** Numeric content of a DIRECT child tag, with fallback. */
export function xmlNum(el: XmlElement, tag: string, fb: number): number {
  const t = xmlText(el, `:scope > ${tag}`);
  if (t === null) return fb;
  const v = parseDecimal(t);
  return Number.isFinite(v) ? v : fb;
}

/**
 * A lookup table with NO PROTOTYPE, for maps indexed by untrusted file text.
 *
 * A plain object literal inherits from `Object.prototype`, so
 * `MAP['constructor']` returns a FUNCTION — truthy — and every
 * `MAP[fileText] ?? DEFAULT` fallback silently fails to fire, as does every
 * `MAP[fileText] === undefined` "did I know this value?" check beside it.
 * Measured on the RASAero importer before this existed (2026-09-08 audit):
 *
 *   <Surface>constructor</Surface> -> node.finish became a function, the
 *   "unknown surface finish" note did NOT fire, re-export wrote
 *   `<finish>function Object() { [native code] }</finish>`, and JSON.stringify
 *   dropped it from the session autosave entirely.
 *   <Shape>constructor</Shape>    -> nose cone imported with no shape at all.
 *
 * Not injection — native-code text carries no XML metacharacters — but data
 * corruption and a non-string on a model node, from a one-word edit to a file.
 * Wrapping the DECLARATION fixes every read site at once, which is why it is
 * done here rather than at the dozen lookups.
 */
export function lookupTable<T>(entries: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, entries);
}

/**
 * The most `<point>`/PointList vertices a freeform fin outline may carry.
 *
 * Real freeform fins have TENS. The validator every importer runs,
 * `finOutlineProblem` -> `finOutlineIntersection`, is a double loop with no
 * early exit on a NON-self-intersecting outline: measured 1,000 points 27 ms,
 * 3,000 64 ms, 9,000 276 ms. A monotone staircase of 90,000 points is about
 * 3 MB of XML — well inside every cap this app has — and takes ~27 s, with the
 * outline then handed to the kernel as well (2026-09-08 audit).
 *
 * 5,000 is two orders of magnitude above any real fin and ~0.1 s of validation.
 *
 * Past it an outline is REFUSED, never truncated, by both importers: the
 * first 5,000 points of a longer list are a different fin, and flying one
 * silently is worse than declining to read it. The count is of what the file
 * WROTE — every `<point>`, every PointList pair — so a malformed or duplicate
 * entry can neither slip past the cap nor keep a loop running under it.
 */
export const MAX_FIN_POINTS = 5000;

/** The refusal both importers put in their fin-set note, as one sentence. */
export const TOO_MANY_FIN_POINTS =
  `It has more than ${MAX_FIN_POINTS.toLocaleString('en-US')} points, the most this app reads.`;

/**
 * The deepest a design file's components may nest below their stage; both
 * importers leave out anything deeper, with TOO_DEEP_NESTING as the note.
 *
 * Audit 2026-09-22: import took any depth the exporter could not give back —
 * the .ork writer recurses AND indents per level, so depth 500 saved as
 * 5.7 MB and 1,500 as 50 MB (after a 15.7 s import), and in a browser's
 * smaller stack Save threw RangeError on the user's own design. Only .ork was
 * capped at first; a .rkt 500 levels deep still imported whole (1.2 s) and
 * saved as an 8.9 MB .ork, and at 1,500 levels its import overflowed the
 * stack. The deepest real design in the corpus nests 5 levels.
 */
export const MAX_NESTING = 64;

/** The note an importer adds when it left out components past MAX_NESTING. */
export const TOO_DEEP_NESTING = `Components nested more than ${MAX_NESTING} levels deep were left out — `
  + 'no real design nests that far, so the file is probably damaged or crafted.';

/**
 * The rest of a fin-set note (after `Fin set "name": `) when an importer left
 * out `n` points it could not read as a pair of decimals. Both importers keep
 * the readable points and fly them, as both desktop importers do — each warns
 * and skips the point (FinSetPointHandler for .ork, the RockSim FinSetHandler's
 * "Fin point not in numeric format.") — so the note is what makes that visible.
 */
export const unreadableFinPoints = (n: number): string =>
  `${n === 1 ? 'one point' : `${n.toLocaleString('en-US')} points`} of its outline could not be read as `
  + `a pair of numbers and ${n === 1 ? 'was' : 'were'} left out, as desktop OpenRocket also does — `
  + 'check the outline in the fin editor.';
/** Inline CDATA for parsers that lack it, skipping comments and processing instructions. */
export function inlineXmlCdata(xml: string): string {
  if (xml.includes('<![CDATA[')) {
    const OPEN = '<![CDATA[';
    const CLOSE = ']]>';
    let rebuilt = '';
    let at = 0;
    let scan = 0;
    for (;;) {
      const open = xml.indexOf('<', scan);
      if (open < 0) break;
      const skip = xml.startsWith('<!--', open) ? '-->' : xml.startsWith('<?', open) ? '?>' : null;
      if (skip) {
        const end = xml.indexOf(skip, open + (skip === '-->' ? 4 : 2));
        if (end < 0) break;
        scan = end + skip.length;
        continue;
      }
      if (!xml.startsWith(OPEN, open)) { scan = open + 1; continue; }
      const close = xml.indexOf(CLOSE, open + OPEN.length);
      if (close < 0) break;
      rebuilt += xml.slice(at, open) + xml.slice(open + OPEN.length, close)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      at = close + CLOSE.length;
      scan = at;
    }
    xml = rebuilt + xml.slice(at);
  }
  return xml;
}
