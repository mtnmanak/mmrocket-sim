/** Longest caller filename or design name the API repeats, in code points, the cut marker included. */
export const FILENAME_ECHO_MAX = 200;
/** Code points kept from the end of a cut name, so its extension stays visible. */
const FILENAME_ECHO_TAIL = 16;
const CUT = '\u2026';

/**
 * C0 and C1 controls, DEL, the line and paragraph separators, and every bidi
 * control (Unicode's Bidi_Control set: the marks ALM, LRM and RLM as well as
 * the embeddings, overrides and isolates; the three marks were missing until
 * the Gemini review of 28 Oct): JSON leaves all but C0 raw, and each can
 * rewrite a client's log or terminal line. Also a lone surrogate (never from
 * URL decoding, which gives U+FFFD, but possible from a direct caller): the
 * echo stays well-formed. A paired surrogate arrives as one code point.
 */
const unsafe = (c: number) => c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029
  || c === 0x061c || c === 0x200e || c === 0x200f
  || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || (c >= 0xd800 && c <= 0xdfff);

/**
 * Caller- or file-controlled text as the API shows it: the caller's filename in
 * an error message, and the design's name (the filename fallback or the file's
 * own name, owner ruling 113-14a). Display only: the full filename still picks
 * the importer and names a generic design before this runs. Unsafe code
 * points become `?`; text over the bound keeps its head and its last code
 * points around a U+2026 ellipsis. Cut by code point, so no surrogate pair is
 * split. Text within the bound with nothing to replace is returned unchanged.
 */
export function displayEcho(text: string): string {
  const points: string[] = [];
  for (const ch of text) {
    points.push(unsafe(ch.codePointAt(0)!) ? '?' : ch);
    if (points.length > FILENAME_ECHO_MAX) break;
  }
  if (points.length <= FILENAME_ECHO_MAX) return points.join('');
  const tail: string[] = [];
  for (let at = text.length; at > 0 && tail.length < FILENAME_ECHO_TAIL;) {
    let start = at - 1;
    const last = text.charCodeAt(start);
    if (last >= 0xdc00 && last <= 0xdfff && start > 0) {
      const first = text.charCodeAt(start - 1);
      if (first >= 0xd800 && first <= 0xdbff) start--;
    }
    const ch = text.slice(start, at);
    tail.push(unsafe(ch.codePointAt(0)!) ? '?' : ch);
    at = start;
  }
  return points.slice(0, FILENAME_ECHO_MAX - FILENAME_ECHO_TAIL - 1).join('') + CUT
    + tail.reverse().join('');
}

/** The filename echo of an error message: {@link displayEcho}. */
export const filenameEcho = displayEcho;
