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

/** Validated categorical palette (the default, both light and dark). */
export const SERIES = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'];

/**
 * Daylight palette: blue, teal, amber, red, purple, olive, magenta, cyan —
 * every one dark enough to hold its own against the white page daylight mode
 * forces. There is no dark variant, because daylight mode has no dark variant.
 */
export const SERIES_DAYLIGHT = ['#0b4ea2', '#00665c', '#8a5000', '#b00016', '#5b2d8e', '#3d5200', '#9c0069', '#005066'];

/** The palette to draw with. Daylight overrides the theme, so it's the only input. */
export function seriesPalette(daylight: boolean): string[] {
  return daylight ? SERIES_DAYLIGHT : SERIES;
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
