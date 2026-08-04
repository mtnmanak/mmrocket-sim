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

/** High contrast on white: blue, teal, amber, red, purple, olive, magenta, cyan. */
export const SERIES_HC_LIGHT = ['#0b4ea2', '#00665c', '#8a5000', '#b00016', '#5b2d8e', '#3d5200', '#9c0069', '#005066'];

/** High contrast on black: the same hue order, lifted for a dark surface. */
export const SERIES_HC_DARK = ['#6ab7ff', '#3fe0b0', '#ffc046', '#ff8a86', '#c79bff', '#b6e04a', '#ff8ad1', '#57e0e0'];

/** The palette to draw with for the current theme + contrast mode. */
export function seriesPalette(highContrast: boolean, dark: boolean): string[] {
  if (!highContrast) return SERIES;
  return dark ? SERIES_HC_DARK : SERIES_HC_LIGHT;
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
