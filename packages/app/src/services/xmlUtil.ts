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
