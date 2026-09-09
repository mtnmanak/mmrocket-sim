/**
 * Tiny shared XML helpers for the file-format services (.ork/.rkt/.CDX1/SVG).
 * One escape implementation app-wide — the per-file copies had drifted (some
 * skipped the quote escape).
 */

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Trimmed text of the first selector match; null when absent or empty. */
export function xmlText(el: Element, selector: string): string | null {
  const t = el.querySelector(selector)?.textContent;
  return t == null || t.trim() === '' ? null : t.trim();
}

/** Numeric content of a DIRECT child tag, with fallback. */
export function xmlNum(el: Element, tag: string, fb: number): number {
  const t = xmlText(el, `:scope > ${tag}`);
  if (t === null) return fb;
  const v = Number(t);
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
 */
export const MAX_FIN_POINTS = 5000;
