/** Longest caller filename an error message repeats, in code points, the cut marker included. */
export const FILENAME_ECHO_MAX = 200;
/** Code points kept from the end of a cut name, so its extension stays visible. */
const FILENAME_ECHO_TAIL = 16;
const CUT = '\u2026';

/**
 * C0 and C1 controls, DEL, the line and paragraph separators, and the bidi
 * embeddings, overrides and isolates: JSON leaves all but C0 raw, and each
 * can rewrite a client's log or terminal line.
 */
const unsafe = (c: number) => c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029
  || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);

/**
 * The caller's filename as an error message shows it: display only (the full
 * name still picks the importer and names a generic design). Unsafe code
 * points become `?`; a name over the bound keeps its head and its last code
 * points around a U+2026 ellipsis. Cut by code point, so no surrogate pair is
 * split. A name within the bound with nothing to replace is returned unchanged.
 */
export function filenameEcho(filename: string): string {
  const points = Array.from(filename, ch => unsafe(ch.codePointAt(0)!) ? '?' : ch);
  if (points.length <= FILENAME_ECHO_MAX) return points.join('');
  return points.slice(0, FILENAME_ECHO_MAX - FILENAME_ECHO_TAIL - 1).join('') + CUT
    + points.slice(-FILENAME_ECHO_TAIL).join('');
}
