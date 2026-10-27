/**
 * Chart ink, series colours and line styles — shared by every uPlot chart
 * (flight plots, comparison chart, drag analysis).
 *
 * EVERY COLOUR IS READ FROM CSS at the chart's own container, so charts follow
 * whatever theme + contrast mode the root carries without a second copy of the
 * palette living in JS. styles.css defines the app's chart variables
 * (`--chart-altitude` … `--chart-reference`, `--chart-axis`, …) as aliases of
 * the vendored brand tokens (`brand/chart.css`, mmr-brand 1.0.3); the Daylight
 * block overrides only what Daylight must. There is NO colour literal in this
 * file (chartTheme.test enforces it): the one fallback, for a chart with no
 * stylesheet in scope (tests, a detached node) and for the workbook export, is
 * the brand's LIGHT set, imported from `brand/tokens.json` at build time.
 */
import tokens from 'virtual:mmr-brand-tokens';

/**
 * The eight brand series tokens, in the brand's SLOT ORDER (SPEC §3.2). A
 * series that IS one of these quantities always takes its named token,
 * wherever it sits; a many-series chart with no quantities (the drag
 * breakdown) assigns them in this order.
 */
export const CHART_TOKENS = [
  'altitude', 'velocity', 'acceleration', 'pressure', 'thrust', 'drag', 'mach', 'reference',
] as const;
export type ChartToken = (typeof CHART_TOKENS)[number];

/** A token's slot (its index in the slot order). */
export const slotOf = (token: ChartToken): number => CHART_TOKENS.indexOf(token);

/**
 * The app's CSS variable for each token — styles.css defines each as an alias
 * of the brand's chart token of the same name. Spelled out, not built from
 * the token, so cssCustomProperties.test can see every name the charts read.
 */
const CHART_VARS: Record<ChartToken, string> = {
  altitude: '--chart-altitude',
  velocity: '--chart-velocity',
  acceleration: '--chart-acceleration',
  pressure: '--chart-pressure',
  thrust: '--chart-thrust',
  drag: '--chart-drag',
  mach: '--chart-mach',
  reference: '--chart-reference',
};

/** The app's CSS variable for a token. */
export const chartVar = (token: ChartToken): string => CHART_VARS[token];

/**
 * The brand's LIGHT series in slot order, from tokens.json → chart.light. Used
 * where no stylesheet is in scope, and by the workbook export (a spreadsheet
 * is white paper).
 */
export const LIGHT_PALETTE: readonly string[] = CHART_TOKENS.map((t) => tokens.chart.light[t]);

/**
 * The series colours in scope at `el`, in slot order. Custom properties
 * inherit, so any descendant of `.viz-root` resolves the active theme's
 * values; a variable the stylesheet does not define falls back to its light
 * brand value.
 */
export function chartPalette(el: Element | null): string[] {
  if (!el || typeof getComputedStyle === 'undefined') return [...LIGHT_PALETTE];
  const cs = getComputedStyle(el);
  return CHART_TOKENS.map((t, i) => cs.getPropertyValue(chartVar(t)).trim() || LIGHT_PALETTE[i]!);
}

/** The brand's reference-line dash (chart.css `.reference`): the stability series. */
export const REFERENCE_DASH = [6, 4];

/**
 * EIGHT LINE STYLES, one per slot — colour is never the only cue (SPEC §3.2:
 * under simulated colour-vision deficiency altitude/acceleration and
 * pressure/thrust fall to ΔE 1–3). Dash arrays in CSS px (`undefined` =
 * solid). uPlot does NOT scale a series dash by the device ratio — it scales
 * the line width, then hands `dash` to setLineDash as given, so on a 2x screen
 * every pattern would draw at half its length under a twice-as-thick line.
 * plotDash converts to device px, and chartLegend's deviceDashPlugin applies
 * it to every plotted series; the legend samples (SVG) stay in CSS px, so a
 * series looks the same in its chip, its chart and its saved image at any
 * ratio. Four families — solid, dashes, dots,
 * dash-and-dot — so a pair hue alone cannot separate always differs in KIND,
 * not only in spacing: altitude solid vs acceleration dots, pressure dash-dot
 * vs thrust sparse dots. Every pattern repeats within 26 px, so the 28 px
 * legend sample (chartLegend.ts) shows a whole period.
 */
export const LINE_STYLES: readonly (number[] | undefined)[] = [
  undefined, //          0 altitude      solid
  [12, 4], //            1 velocity      long dash
  [2, 3], //             2 acceleration  dots
  [10, 3, 2, 3], //      3 pressure      dash-dot
  [2, 7], //             4 thrust        sparse dots
  [10, 3, 2, 3, 2, 3], // 5 drag         dash-dot-dot
  [14, 3, 6, 3], //      6 mach          long-short dash
  REFERENCE_DASH, //     7 reference     the brand's 6 4
];

/**
 * Which LINE_STYLES entry slot s draws in repeat tier t (series 8–15 are tier
 * 1, 16–23 tier 2, …): a Latin square, so a colour never meets the same style
 * twice in 64 series, and tier 0 is each slot's own style. Rows 0 and 1 were
 * searched so that, in the first 16 series, no two slots whose hues fall
 * under 15 ΔE76 in normal, protan, deutan or tritan vision (light, dark or
 * Daylight) share a style — chartTheme.test re-measures it. Row 1 puts the
 * reference dash on Mach's hue (never on CP/CG/mass's tier-1 hues), and the
 * flight catalog's StyleAllocator never hands that pair, or any reference-ink
 * pair, to anything but the reference series, so its only 6 4 line is
 * stability (cal).
 */
const TIER_STYLE: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7],
  [3, 2, 1, 0, 5, 4, 7, 6],
  [1, 0, 3, 2, 6, 7, 4, 5],
  [2, 3, 0, 1, 7, 6, 5, 4],
  [4, 5, 6, 7, 0, 1, 2, 3],
  [5, 4, 7, 6, 1, 0, 3, 2],
  [6, 7, 4, 5, 2, 3, 0, 1],
  [7, 6, 5, 4, 3, 2, 1, 0],
];

/**
 * The CSS-px dash each device-px dash was made from (plotDash), so a legend
 * sample read off a live uPlot series is drawn at its CSS size.
 */
const CSS_DASH = new WeakMap<readonly number[], readonly number[]>();

/**
 * A CSS-px dash in DEVICE px for a canvas drawn at `ratio` (uPlot.pxRatio):
 * what uPlot must be given, since it scales line widths by the ratio but
 * passes `dash` to setLineDash unscaled. undefined (solid) stays undefined.
 */
export function plotDash(dash: readonly number[] | undefined, ratio: number): number[] | undefined {
  if (!dash?.length) return undefined;
  const out = dash.map((v) => v * ratio);
  CSS_DASH.set(out, CSS_DASH.get(dash) ?? dash);
  return out;
}

/** The CSS-px dash behind a dash plotDash made; any other dash is CSS px already. */
export function cssDash(dash: readonly number[] | undefined): readonly number[] | undefined {
  return dash?.length ? CSS_DASH.get(dash) ?? dash : undefined;
}

/** The dash for slot `slot` in repeat tier `tier` (undefined = solid). */
export function lineStyle(slot: number, tier = 0): number[] | undefined {
  const s = ((slot % CHART_TOKENS.length) + CHART_TOKENS.length) % CHART_TOKENS.length;
  return LINE_STYLES[TIER_STYLE[tier % TIER_STYLE.length]![s]!];
}

/**
 * Stroke + dash for the i-th series of a many-series chart (the drag panel):
 * slot order with each slot's own style; past 8 the hues REPEAT WITH THE NEXT
 * TIER'S STYLE — never a silent colour cycle, which made component 9 an exact
 * twin of component 1 (LEM-IV's two Rail Buttons, 2026-08-29). No colour +
 * style pair repeats within 64 series.
 */
export function seriesStyle(i: number, palette: readonly string[]): { stroke: string; dash?: number[] } {
  const n = CHART_TOKENS.length;
  const slot = i % n;
  const dash = lineStyle(slot, Math.floor(i / n));
  return dash ? { stroke: palette[slot]!, dash } : { stroke: palette[slot]! };
}

export interface ChartInk {
  axis: string;
  /**
   * Reference ink: event markers and the worst-angle line, drawn as a solid
   * 1 px HAIRLINE — the one stroke no series uses (every series is 2.5–3 px,
   * and the reference SERIES, stability, is dashed 6 4). The app's
   * `--chart-reference` (= brand `--mmr-chart-reference`; 6.32:1 on white
   * under Daylight, so the markers' numbered labels pass as text too).
   */
  reference: string;
  grid: string;
  tick: string;
  /** Data-line stroke width — thicker in high contrast. */
  strokeWidth: number;
  /** uPlot axis label font shorthand: the data face (event-marker labels use it too). */
  font: string;
}

/** Light brand values, for a chart with no stylesheet in scope (tests, a detached node). */
const FALLBACK: ChartInk = {
  axis: tokens.theme.light.text,
  reference: tokens.chart.light.reference,
  grid: tokens.chart.light.grid,
  tick: tokens.theme.light.border,
  strokeWidth: 2,
  // uPlot draws on a canvas, which needs a concrete font string, not var().
  font: `500 12px ${tokens.font.data}`,
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
    reference: v('--chart-reference') || FALLBACK.reference,
    grid: v('--chart-grid') || FALLBACK.grid,
    tick: v('--chart-tick') || FALLBACK.tick,
    strokeWidth: Number(v('--chart-series-width')) || FALLBACK.strokeWidth,
    font: v('--chart-axis-font') || FALLBACK.font,
  };
}
