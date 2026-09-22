/**
 * Tiny shared XML helpers for the file-format services (.ork/.rkt/.CDX1/SVG).
 * One escape implementation app-wide — the per-file copies had drifted (some
 * skipped the quote escape) — with an attribute-value variant beside it.
 */

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
 * the browser can decode (windows-1252, ISO-8859-1, …); otherwise UTF-8, the
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
  const head = String.fromCharCode(...bytes.subarray(0, 256));
  const label = /^\s*<\?xml\s[^>]*?\bencoding\s*=\s*["']([A-Za-z][\w.:-]*)["']/.exec(head)?.[1];
  if (label) {
    let decoder: TextDecoder | null = null;
    try {
      decoder = new TextDecoder(label);
    } catch {
      // A label the browser does not know: UTF-8 below, as for no label.
    }
    const enc = decoder?.encoding;
    if (decoder && enc !== 'utf-8' && enc !== 'replacement' && !enc?.startsWith('utf-16')) {
      return { xml: decoder.decode(bytes) };
    }
  }
  return decodeUtf8(bytes);
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
export function xmlText(el: Element, selector: string): string | null {
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
export function xmlNum(el: Element, tag: string, fb: number): number {
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
