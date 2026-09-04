import type { StabilityState } from '../services/simReport.js';

/**
 * The words and glyphs that carry the under/over/ok verdict ALONGSIDE its
 * colour.
 *
 * They live in their own module because two views must not disagree about
 * them. The 2D schematic has said "⚠ 1.85 cal — under-stable" since the
 * callout lanes landed; the 3D view printed the bare number and left the
 * verdict to three hexes (#4dbd4d / #e0a53d / #f0716f), so a red-green
 * colour-blind reader — roughly 8 % of men — got no verdict at all in the one
 * view people rotate to inspect a build, while the same rocket in the 2D tab
 * said it in words. Colour is now the third carrier of that meaning in both,
 * after the glyph and the word.
 *
 * Same tiered vocabulary as StatTiles and SimResults.
 */
export const STABILITY_GLYPH: Record<StabilityState, string> = {
  under: '⚠', over: '△', ok: '✓',
};

export const STABILITY_WORD: Record<StabilityState, string> = {
  under: 'under-stable', over: 'over-stable', ok: 'ok',
};

/**
 * The one-line margin readout both views print: glyph, the formatted margin,
 * then the verdict in words.
 *
 * @param margin already formatted by `formatStability` — the unit and the
 *               precision are the caller's business, the wording is this
 *               module's.
 */
export function stabilityReadout(state: StabilityState, margin: string): string {
  return `${STABILITY_GLYPH[state]} ${margin} — ${STABILITY_WORD[state]}`;
}
