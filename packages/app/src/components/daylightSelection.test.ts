// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../styles.css'), 'utf8');

/** The declaration block of the first rule whose selector list contains `sel`. */
function block(sel: string): string {
  const at = css.indexOf(sel);
  if (at < 0) return '';
  const open = css.indexOf('{', at);
  return open < 0 ? '' : css.slice(open + 1, css.indexOf('}', open));
}

/**
 * SELECTED HAD NO FILL IN DAYLIGHT, so a user filtering the motor list by
 * diameter could not see which chips were on (the owner, 2026-09-18: "they
 * will have no idea which ones are selected and which ones are not").
 *
 * The state was carried by `outline: 2px solid var(--border); outline-offset:
 * -2px` plus `font-weight: 700`. In this theme neither distinguishes anything:
 * every hairline is already doubled to 2px of the same black, so the outline
 * lands exactly on the border the chip already has, and an earlier rule in the
 * same block already sets font-weight 700 on ALL chips. Both chips painted
 * white on white.
 */
describe('Daylight: a selected series chip is filled', () => {
  it('gives .series-chip-on a background in the Daylight block', () => {
    const rule = block(".viz-root[data-contrast='high'] .series-chip-on");
    expect(rule).not.toBe('');
    // The whole defect was a selected state that set no background.
    expect(rule).toMatch(/background:\s*var\(--selected\)/);
  });

  it('no longer shares that rule with the view toggle', () => {
    // The toggle was never broken, and folding it back in would mean any fix
    // here has to be safe for a control with different geometry.
    const at = css.indexOf(".viz-root[data-contrast='high'] .series-chip-on");
    expect(css.slice(at, css.indexOf('{', at))).not.toContain('view-toggle');
  });

  it('keeps a hover state that survives the pointer leaving', () => {
    expect(css).toContain('.series-chip:not(.series-chip-on):hover');
  });
});

/**
 * THE DRAG-TO-ZOOM BOX was uPlot's own `rgba(0, 0, 0, 0.07)` — it ships that in
 * uPlot.min.css, which FlightCharts and DragPanel both import. Measured against
 * the plot surface it is 1.17:1 in Daylight and 1.02:1 in dark. Dark is the
 * worse of the two and nobody reported it, because an invisible selection box
 * reads as a twitchy zoom rather than as a bug.
 */
describe('the chart drag-selection box is visible', () => {
  it('overrides uPlot default with a themed tint', () => {
    const rule = block('.chart-panel .u-select');
    expect(rule).not.toBe('');
    expect(rule).toContain('color-mix(in srgb, var(--accent)');
    // Per-theme via tokens, never a baked literal.
    expect(rule).not.toMatch(/rgba?\(/);
  });

  it('draws its edge with an INSET SHADOW, never a border', () => {
    // uPlot hides this div by zeroing width and height and does not remove it.
    // A border on a 0x0 box still paints: a permanent accent square in the
    // corner of every plot, in every theme. This is the regression worth an
    // assertion of its own.
    const rule = block('.chart-panel .u-select');
    expect(rule).toMatch(/box-shadow:\s*inset/);
    expect(rule).not.toMatch(/(^|[\s;])border\s*:/);
  });

  it('doubles that edge in Daylight, and keeps it off the axis colour', () => {
    const rule = block(".viz-root[data-contrast='high'] .chart-panel .u-select");
    expect(rule).not.toBe('');
    expect(rule).toMatch(/box-shadow:\s*inset 0 0 0 2px var\(--accent\)/);
  });
});
