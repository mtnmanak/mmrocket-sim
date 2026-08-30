import { describe, expect, it } from 'vitest';
import { SERIES, SERIES_DARK, SERIES_DAYLIGHT, seriesPalette, seriesStyle } from './chartTheme.js';

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

// The recessed plot-area surface each theme's lines actually draw on
// (--surface-1 in styles.css). Values asserted here so a token change that
// invalidates the palette validation fails loudly instead of silently.
const DARK_PLOT = '#1a1917';

describe('chart palettes', () => {
  it('keeps the slot count aligned across palettes', () => {
    expect(SERIES_DAYLIGHT).toHaveLength(SERIES.length);
    expect(SERIES_DARK).toHaveLength(SERIES.length);
  });

  // The v0.075 defect this guards against: the dark theme drew the palette
  // that was validated against WHITE (its own comment said ~3:1 on white),
  // putting the thrust line at 1.9:1 on the panel. Every dark-stepped hue
  // must clear 3:1 — the non-text minimum — against the dark plot surface.
  it('dark hues clear 3:1 against the dark plot surface', () => {
    for (const c of SERIES_DARK) expect(contrast(c, DARK_PLOT)).toBeGreaterThanOrEqual(3);
  });

  it('dark hues are unique', () => {
    expect(new Set(SERIES_DARK).size).toBe(SERIES_DARK.length);
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

  // Daylight still overrides everything; otherwise the THEME picks the
  // palette — dark stopped borrowing light's hues in v0.076.
  it('picks the palette from daylight first, then theme', () => {
    expect(seriesPalette(true, 'light')).toBe(SERIES_DAYLIGHT);
    expect(seriesPalette(true, 'dark')).toBe(SERIES_DAYLIGHT);
    expect(seriesPalette(false, 'light')).toBe(SERIES);
    expect(seriesPalette(false, 'dark')).toBe(SERIES_DARK);
  });

  // Slot-for-slot hue identity: a trace keeps its slot across themes, so
  // switching theme re-steps a line's color but never re-labels the data.
  it('dark palette is a per-slot re-step of the light palette, not a reorder', () => {
    // Spot anchors: slot 1 stays the blue family, the green slot is the one
    // hue dark enough to survive both surfaces unchanged.
    expect(SERIES[0]).toBe('#2a78d6');
    expect(SERIES_DARK[0]).toBe('#3987e5');
    expect(SERIES_DARK[SERIES.indexOf('#008300')]).toBe('#008300');
  });
});

describe('seriesStyle — many-series charts never silently cycle colors', () => {
  const C = SERIES;

  it('first 8 series draw solid in slot order', () => {
    for (let i = 0; i < C.length; i++) {
      const s = seriesStyle(i, C);
      expect(s.stroke).toBe(C[i]);
      expect(s.dash).toBeUndefined();
    }
  });

  // The per-component drag breakdown used C[i % 8]: component 9 became an
  // exact twin of component 1 (LEM-IV's two Rail Buttons were the reported
  // case). Reused hues now carry a dash pattern as the secondary encoding.
  it('series 8–15 reuse the hues with a dash pattern', () => {
    for (let i = C.length; i < C.length * 2; i++) {
      const s = seriesStyle(i, C);
      expect(s.stroke).toBe(C[i % C.length]);
      expect(s.dash).toEqual([6, 4]);
    }
  });

  it('series 16–23 get the second dash pattern', () => {
    const s = seriesStyle(17, C);
    expect(s.stroke).toBe(C[1]);
    expect(s.dash).toEqual([2, 3]);
  });

  it('no two of the first 24 series share both hue and dash', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const s = seriesStyle(i, C);
      const key = `${s.stroke}|${(s.dash ?? []).join(',')}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
