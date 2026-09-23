/**
 * Text going into a TEXT-FORMAT FILE HEADER: the OBJ `#` comment block, the
 * DXF label block, the drag table's `#` block. One home for the folding, so
 * each writer stops growing its own partial copy (audit 2026-09-22).
 *
 * Two different defects live here, and a writer may need either or both:
 *
 * - A LINE BREAK in user text splits the header. Rocket and component names
 *   come from imported files and share links, where a raw newline or an
 *   `&#10;` survives, so they are not guaranteed single-line even though the
 *   in-app name field is. In an OBJ that turns the tail of a name into live
 *   `v`/`f` records — three.js's OBJLoader then resolves every later face
 *   against shifted absolute vertex indices. JavaScript's `\s` already covers
 *   CR, LF, U+2028 and U+2029, but not NEL (U+0085) or the FS/GS/RS controls,
 *   all of which Python's `str.splitlines()` — the obvious way to read one of
 *   these headers in a script — treats as line ends.
 *
 * - NON-ASCII TYPOGRAPHY the app itself emits (em dash, degree sign, middle
 *   dot, the ⌀ diameter mark) mojibakes in any reader that assumes the ANSI
 *   code page: an R12 DXF by definition, and Excel opening a CSV that carries
 *   no BOM (`Â°`). These fold to the ASCII a person would have typed.
 */

/** Every line terminator anyone's reader honours, plus ordinary whitespace runs. */
const BREAKS = /[\s\x1c-\x1e\x85]+/g;

/** Fold every line break and whitespace run to one space, trimmed. */
export function oneLine(s: string): string {
  return s.replace(BREAKS, ' ').trim();
}

/**
 * The app's own typography, folded to ASCII. Anything else non-ASCII — a name
 * written in Cyrillic, say — passes through untouched: that is the user's
 * text, and replacing it is a decision for a writer that has to (asciiOnly).
 */
export function foldTypography(s: string): string {
  return s
    .replace(/[‐-―−]/g, '-') // hyphen .. horizontal bar (en/em dash), minus sign
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/·/g, '-') // middle dot — the app's own separator
    .replace(/×/g, 'x')
    .replace(/ ?°/g, ' deg') // '20 °C' -> '20 degC', '45°' -> '45 deg'
    .replace(/⌀/g, 'dia');
}

/**
 * Strictly printable 7-bit ASCII on one line: the typography folded, the
 * breaks folded, and whatever is still outside 0x20-0x7E forced to `?`. For a
 * format that cannot carry anything else (R12 DXF).
 */
export function asciiOnly(s: string): string {
  return oneLine(foldTypography(s)).replace(/[^\x20-\x7e]/g, '?');
}
