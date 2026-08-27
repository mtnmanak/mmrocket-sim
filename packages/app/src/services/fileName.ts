/**
 * One home for the download-filename convention.
 *
 * Every export names the DESIGN first and what the file holds second, so a
 * folder of exports from a flight day sorts by rocket and a file that travels
 * onward still says which design it came from. The Results tab used to write
 * bare `flight-data.csv`, `drag-analysis.csv` and `simulations.csv`; the drag
 * export's own code comment records one of those being posted to a forum with
 * nothing in it saying which rocket — or which aero model — produced it.
 */

/** File-name-safe part name, matching what the .ork/.rkt exports have always used. */
export function safeName(name: string): string {
  return name.replace(/[^\w-]+/g, '_');
}

/**
 * `<design>-<base>.<ext>`, with the design sanitized and a sane fallback.
 *
 * `safeName` keeps `\w`, which is ASCII-only — so a name written entirely in
 * Cyrillic, Greek, Japanese or Arabic collapses to underscores and every
 * export from every such design would land on the same filename. When nothing
 * usable survives, fall back to the generic stem rather than shipping a name
 * that silently collides.
 */
export function stampedName(design: string | undefined | null, base: string, ext: string): string {
  const d = safeName((design ?? '').trim() || 'rocket');
  return `${/[A-Za-z0-9]/.test(d) ? d : 'rocket'}-${base}.${ext}`;
}

// The download primitive itself lives in saveFile.ts — it is no longer a bare
// anchor click, and every export routes through the same Save-As dialog.
export { downloadBlob } from './saveFile.js';

/**
 * UTF-8 BOM. Without it Excel's double-click import assumes the ANSI codepage
 * and garbles the Greek and typographic characters in the headers (θl, dΦ, ρ,
 * —); every other reader ignores it.
 *
 * Prepended by the CSVs whose headers actually carry those characters — the
 * flight data, the run table, the component table and the batch results. The
 * drag table and the preset CSV are plain ASCII and deliberately do not
 * (the drag table's leading `#` comment block is parsed by other tools).
 */
export const CSV_BOM = '\uFEFF';
