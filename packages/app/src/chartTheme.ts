/**
 * Chart ink and series palettes — shared by every uPlot chart (flight plots,
 * drag sweep).
 *
 * Axis/grid/tick ink is READ FROM the live CSS custom properties on the chart's
 * own container, so charts follow whatever theme + contrast mode the root
 * carries without a second copy of the palette living in JS.
 *
 * Series colors have to be JS strings (uPlot takes them directly), so the
 * high-contrast variants are declared here. The brand hues clear 3:1 (the
 * non-text floor) on their plot surface; the Daylight hues clear 4.5:1 on
 * white, for a phone in direct sunlight.
 */

/**
 * Brand palette (mmr-brand 1.0.2, `brand/tokens.json` → `chart.light`), LIGHT
 * theme. Slot identity is fixed by the quantity, not by validation order:
 * 0 altitude, 1 velocity, 2 acceleration, 3 pressure (mass, dynamic
 * pressure), 4 thrust, 7 stability = the brand's REFERENCE ink, always drawn
 * dashed (REFERENCE_DASH). The brand has no hue for slots 5 (drag) and 6
 * (Mach) yet, so they keep the pre-brand hues.
 *
 * Hue alone does NOT separate every pair for colour-blind readers (the brand
 * says so itself: "every series also gets a distinct dash or marker"), and
 * slots cannot be re-ordered without moving a quantity off its brand hue, so
 * SLOT_DASH below is the secondary encoding. chartTheme.test holds both: the
 * literals equal the vendored tokens.json, and every pair under 15 ΔE76 in any
 * simulated vision carries different dashes. Literals, not CSS reads: uPlot
 * takes strings.
 */
export const SERIES = [
  '#006aab', // 0 chart.light.altitude
  '#226b47', // 1 chart.light.velocity
  '#7049a8', // 2 chart.light.acceleration
  '#855300', // 3 chart.light.pressure
  '#ad3c00', // 4 chart.light.thrust
  '#008300', // 5 drag: pending mmr-brand 1.0.3 (no brand hue yet)
  '#4a3aa7', // 6 Mach: pending mmr-brand 1.0.3 (no brand hue yet)
  '#45637b', // 7 chart.light.reference (stability, dashed)
];

/**
 * The SAME slots stepped for the dark plot surface (`chart.dark`) —
 * slot-for-slot, so a trace keeps its identity across themes. Every hue clears
 * 3:1 on the dark plot surface (--surface-1 → brand navy #03254F); pinned by
 * chartTheme.test.
 */
export const SERIES_DARK = [
  '#6bc6f3', // 0 chart.dark.altitude
  '#78ce9a', // 1 chart.dark.velocity
  '#c0a0f2', // 2 chart.dark.acceleration
  '#ffb23e', // 3 chart.dark.pressure
  '#ff6509', // 4 chart.dark.thrust
  '#008300', // 5 drag: pending mmr-brand 1.0.3 (no brand hue yet)
  '#9085e9', // 6 Mach: pending mmr-brand 1.0.3 (no brand hue yet)
  '#a9c3d9', // 7 chart.dark.reference (stability, dashed)
];

/**
 * Daylight palette: every hue dark enough to hold its own against the white
 * page daylight mode forces. There is no dark variant, because daylight mode
 * has no dark variant. The brand has no Daylight chart set, so these are the
 * pre-brand hues, unchanged.
 */
export const SERIES_DAYLIGHT = ['#0b4ea2', '#00665c', '#8a5000', '#b00016', '#5b2d8e', '#3d5200', '#9c0069', '#005066'];

/** The palette to draw with: daylight overrides everything, then the theme. */
export function seriesPalette(daylight: boolean, theme: 'light' | 'dark' = 'light'): string[] {
  if (daylight) return SERIES_DAYLIGHT;
  return theme === 'dark' ? SERIES_DARK : SERIES;
}

/** The brand's reference-line dash (chart.css `.reference`), for stability and event markers. */
export const REFERENCE_DASH = [6, 4];

/**
 * The three line patterns a series can carry: solid, the reference dash, dots.
 * A slot's own pattern comes first; a palette that repeats (more than 8
 * series) rotates through the other two.
 */
const PATTERNS: (number[] | undefined)[] = [undefined, REFERENCE_DASH, [2, 3]];

/**
 * Each slot's pattern (an index into PATTERNS) when it shares a chart with
 * other slots — the colour-blind secondary encoding. Chosen so that every slot
 * pair that sits under 15 ΔE76 in normal, protan, deutan or tritan vision in
 * ANY of the three palettes (light, dark, Daylight) draws a different pattern;
 * the same pattern in every palette, so a line keeps its look across themes.
 * Slot 7 is the reference dash by brand rule. chartTheme.test re-derives it.
 */
export const SLOT_PATTERN = [0, 2, 1, 2, 1, 0, 0, 1] as const;

/** The dash a slot draws with when several slots share a chart (undefined = solid). */
export function slotDash(slot: number): number[] | undefined {
  return PATTERNS[SLOT_PATTERN[slot % SLOT_PATTERN.length]!];
}

/**
 * Stroke + dash for the i-th series of a many-series chart. The first 8 draw
 * in slot order with their slot's pattern; past the palette the hues REPEAT
 * WITH THE NEXT PATTERN — never a silent color cycle, which made component 9
 * an exact twin of component 1 (LEM-IV's two Rail Buttons, 2026-08-29). The
 * rotation keeps every slot's three repeats distinct, and keeps conflicting
 * slots distinct within each group of 8; beyond 24 series the third tier
 * repeats, which no real design reaches.
 */
export function seriesStyle(i: number, palette: string[]): { stroke: string; dash?: number[] } {
  const slot = i % palette.length;
  const tier = Math.min(Math.floor(i / palette.length), PATTERNS.length - 1);
  const dash = PATTERNS[(SLOT_PATTERN[slot % SLOT_PATTERN.length]! + tier) % PATTERNS.length];
  return dash ? { stroke: palette[slot]!, dash } : { stroke: palette[slot]! };
}

export interface ChartInk {
  axis: string;
  /** Reference ink (brand `--mmr-chart-reference`): event markers, the worst-angle line. */
  reference: string;
  grid: string;
  tick: string;
  /** Data-line stroke width — thicker in high contrast. */
  strokeWidth: number;
  /** uPlot axis label font shorthand. */
  font: string;
}

/** Light brand values, for a chart with no stylesheet in scope (tests, a detached node). */
const FALLBACK: ChartInk = {
  axis: '#03254f', // --mmr-text
  reference: '#45637b', // --mmr-chart-reference
  grid: '#b3cadc', // --mmr-chart-grid
  tick: '#b3cadc', // --mmr-border
  strokeWidth: 2,
  // uPlot draws on a canvas, which needs a concrete font string, not var().
  font: "500 12px 'IBM Plex Mono', Consolas, monospace",
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
    reference: v('--mmr-chart-reference') || FALLBACK.reference,
    grid: v('--chart-grid') || FALLBACK.grid,
    tick: v('--chart-tick') || FALLBACK.tick,
    strokeWidth: Number(v('--chart-series-width')) || FALLBACK.strokeWidth,
    font: v('--chart-axis-font') || FALLBACK.font,
  };
}
