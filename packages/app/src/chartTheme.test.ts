import { describe, expect, it } from 'vitest';
import { SERIES, SERIES_DAYLIGHT, seriesPalette } from './chartTheme.js';

/** WCAG relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => {
    const s = parseInt(hex.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
}

describe('chart palettes', () => {
  it('keeps the slot count aligned across palettes', () => {
    expect(SERIES_DAYLIGHT).toHaveLength(SERIES.length);
  });

  // The whole point of daylight mode: every plotted line has to stay readable
  // on a phone in direct sun. 4.5:1 is the WCAG AA text threshold — a chart
  // line is thinner than text, so treat it as the floor, not the target. The
  // surface is always white; daylight mode forces the light palette.
  it('daylight hues clear 4.5:1 against the white page', () => {
    for (const c of SERIES_DAYLIGHT) expect(contrast(c, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('daylight hues stay distinguishable from each other', () => {
    expect(new Set(SERIES_DAYLIGHT).size).toBe(SERIES_DAYLIGHT.length);
  });

  it('picks the palette from daylight mode alone', () => {
    expect(seriesPalette(false)).toBe(SERIES);
    expect(seriesPalette(true)).toBe(SERIES_DAYLIGHT);
  });
});
