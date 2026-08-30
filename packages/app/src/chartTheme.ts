/**
 * Chart ink and series palettes — shared by every uPlot chart (flight plots,
 * drag sweep).
 *
 * Axis/grid/tick ink is READ FROM the live CSS custom properties on the chart's
 * own container, so charts follow whatever theme + contrast mode the root
 * carries without a second copy of the palette living in JS.
 *
 * Series colors have to be JS strings (uPlot takes them directly), so the
 * high-contrast variants are declared here. The default mid-tone hues sit at
 * roughly 3:1 against white — fine indoors, unreadable on a phone in direct
 * sunlight; every high-contrast hue below clears 4.5:1 against its surface.
 */

/**
 * Validated categorical palette, LIGHT theme. v0.076 re-ordered the slots:
 * the hues were always validated as a set, but the old order put orange
 * beside pink (adjacent-pair ΔE 12.9, below the 15 floor even for full color
 * vision) and red beside pink for CVD readers. This order passes every
 * adjacent-pair gate in both themes (dataviz validator, run against the real
 * plot surfaces — light #f1efea-ish, dark #1a1917). Slot order is the
 * colorblind-safety mechanism: do not re-order casually, re-validate.
 */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

/**
 * The SAME eight hues stepped for the dark plot surface — slot-for-slot, so a
 * trace keeps its identity across themes. Until v0.076 dark drew the light
 * palette (self-documented at ~3:1 against WHITE), which put the violet slot
 * at 1.9:1 on the dark panel — the "can't see the lines" report. Every step
 * here clears 3:1 on --surface-1 dark (#1a1917); pinned by chartTheme.test.
 */
export const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

/**
 * Daylight palette: every hue dark enough to hold its own against the white
 * page daylight mode forces. There is no dark variant, because daylight mode
 * has no dark variant. (Slot order untouched by the v0.076 re-order — its
 * slots were never hue-matched to the theme palettes.)
 */
export const SERIES_DAYLIGHT = ['#0b4ea2', '#00665c', '#8a5000', '#b00016', '#5b2d8e', '#3d5200', '#9c0069', '#005066'];

/** The palette to draw with: daylight overrides everything, then the theme. */
export function seriesPalette(daylight: boolean, theme: 'light' | 'dark' = 'light'): string[] {
  if (daylight) return SERIES_DAYLIGHT;
  return theme === 'dark' ? SERIES_DARK : SERIES;
}

/**
 * Stroke + dash for the i-th series of a many-series chart. The first 8 draw
 * solid in slot order; past the palette the hues REPEAT WITH A DASH — never a
 * silent color cycle, which made component 9 an exact twin of component 1
 * (LEM-IV's two Rail Buttons, 2026-08-29). Two dash tiers cover 24 series;
 * beyond that the third tier repeats, which no real design reaches.
 */
const DASH_TIERS: (number[] | undefined)[] = [undefined, [6, 4], [2, 3]];

export function seriesStyle(i: number, palette: string[]): { stroke: string; dash?: number[] } {
  const tier = Math.floor(i / palette.length);
  const dash = DASH_TIERS[Math.min(tier, DASH_TIERS.length - 1)];
  return dash ? { stroke: palette[i % palette.length]!, dash } : { stroke: palette[i % palette.length]! };
}

export interface ChartInk {
  axis: string;
  grid: string;
  tick: string;
  /** Data-line stroke width — thicker in high contrast. */
  strokeWidth: number;
  /** uPlot axis label font shorthand. */
  font: string;
}

const FALLBACK: ChartInk = {
  axis: '#7a786f',
  grid: '#e8e6e1',
  tick: '#dedcd7',
  strokeWidth: 2,
  font: '11px system-ui',
};

/**
 * Pull the chart ink from the CSS variables in scope at `el`. Custom properties
 * inherit, so any descendant of `.viz-root` resolves the active theme's values.
 */
export function chartInk(el: Element | null): ChartInk {
  if (!el || typeof getComputedStyle === 'undefined') return FALLBACK;
  const cs = getComputedStyle(el);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    axis: v('--chart-axis') || FALLBACK.axis,
    grid: v('--chart-grid') || FALLBACK.grid,
    tick: v('--chart-tick') || FALLBACK.tick,
    strokeWidth: Number(v('--chart-series-width')) || FALLBACK.strokeWidth,
    font: v('--chart-axis-font') || FALLBACK.font,
  };
}
