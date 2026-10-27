/**
 * Series legends: a short LINE SAMPLE in the series colour, drawn with the
 * series' own dash, beside a label in the TEXT colour (mmr-brand SPEC §3.2:
 * "Direct labels are set in --mmr-text beside a short line sample, not in the
 * series colour" — `mach` light and four dark series are under 4.5:1 as text).
 * One geometry for every place a series is named: the flight chips and
 * emphasis legend (components/LineSample.tsx), uPlot's own legend
 * (legendSamplePlugin), the point readout (chartTooltip.ts) and the saved plot
 * image (PlotImage.tsx).
 */
import type uPlot from 'uplot';

/** Sample size in CSS px: 28 px holds a whole period of every LINE_STYLES dash. */
export const SAMPLE_WIDTH = 28;
export const SAMPLE_HEIGHT = 10;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A series as a legend names it. */
export interface LegendEntry {
  label: string;
  color: string;
  dash?: number[];
}

/**
 * The sample as a DOM node. Its stroke width comes from CSS
 * (`.line-sample line { stroke-width: var(--chart-series-width) }`), so it
 * thickens with the plotted lines under Daylight.
 */
export function lineSampleSvg(color: string, dash?: readonly number[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'line-sample');
  svg.setAttribute('width', String(SAMPLE_WIDTH));
  svg.setAttribute('height', String(SAMPLE_HEIGHT));
  svg.setAttribute('viewBox', `0 0 ${SAMPLE_WIDTH} ${SAMPLE_HEIGHT}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('x1', '0');
  line.setAttribute('y1', String(SAMPLE_HEIGHT / 2));
  line.setAttribute('x2', String(SAMPLE_WIDTH));
  line.setAttribute('y2', String(SAMPLE_HEIGHT / 2));
  line.setAttribute('stroke', color);
  if (dash?.length) line.setAttribute('stroke-dasharray', dash.join(' '));
  svg.append(line);
  return svg;
}

/** A uPlot series' resolved stroke (uPlot wraps option values in functions). */
export function seriesStroke(u: uPlot, i: number): string | null {
  const s = u.series[i] as { stroke?: unknown } | undefined;
  const v = typeof s?.stroke === 'function' ? (s.stroke as (u: uPlot, i: number) => unknown)(u, i) : s?.stroke;
  return typeof v === 'string' ? v : null;
}

/**
 * uPlot plugin: each legend row's marker box (a square bordered in the series
 * colour) becomes the series' line sample, so the legend shows the dash as
 * well as the colour. The label beside it keeps the legend's text colour
 * (styles.css `.u-legend`); uPlot colours label TEXT only when markers are off,
 * and they stay on.
 */
export function legendSamplePlugin(): uPlot.Plugin {
  return { hooks: { init: (u) => {
    const rows = u.root?.querySelectorAll?.('.u-legend .u-series') ?? [];
    // A live inline legend has a row for the x series too; a multi-value one does not.
    const offset = rows.length === u.series.length ? 0 : 1;
    rows.forEach((row, r) => {
      const i = r + offset;
      if (i === 0) return;
      const marker = row.querySelector<HTMLElement>('.u-marker');
      const color = seriesStroke(u, i);
      if (!marker || !color) return;
      marker.classList.add('u-marker-sample');
      marker.style.border = 'none';
      marker.style.background = 'none';
      marker.replaceChildren(lineSampleSvg(color, u.series[i]!.dash));
    });
  } } };
}

/**
 * The same sample on a canvas (the saved plot image): `scale` is the image's
 * device-pixel ratio, `width` the series' CSS stroke width.
 */
export function drawLineSample(ctx: CanvasRenderingContext2D, x: number, y: number, entry: LegendEntry,
  width: number, scale: number) {
  ctx.save();
  ctx.strokeStyle = entry.color;
  ctx.lineWidth = width * scale;
  ctx.setLineDash((entry.dash ?? []).map((d) => d * scale));
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + SAMPLE_WIDTH * scale, y);
  ctx.stroke();
  ctx.restore();
}
