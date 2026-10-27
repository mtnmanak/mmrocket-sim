import type uPlot from 'uplot';
import type { FlightEvent } from '@online-openrocket/engine';
import type { ChartInk } from './chartTheme.js';

export const PLOT_EVENTS = [
  ['LAUNCH', 'Launch'], ['BURNOUT', 'Burnout'], ['APOGEE', 'Apogee'],
  ['RECOVERY_DEVICE_DEPLOYMENT', 'Deployment'], ['GROUND_HIT', 'Ground hit'],
] as const;
export const DEFAULT_PLOT_EVENTS = PLOT_EVENTS.map(([type]) => type);

export function eventMarkers(events: FlightEvent[], selected: readonly string[]) {
  return events.flatMap(e => {
    const name = PLOT_EVENTS.find(([type]) => type === e.type)?.[1];
    return name && selected.includes(e.type) && Number.isFinite(e.time)
      ? [{ time: e.time, label: name + (e.source ? `: ${e.source}` : '') }] : [];
  }).sort((a, b) => a.time - b.time);
}

/**
 * The marker font: the chart's own axis font (the data face, IBM Plex Mono, at
 * the theme's weight) with its pixel size scaled to the canvas.
 */
export function markerFont(axisFont: string, ratio: number): string {
  return /\d+(?:\.\d+)?px/.test(axisFont)
    ? axisFont.replace(/(\d+(?:\.\d+)?)px/, (_m, px: string) => `${Number(px) * ratio}px`)
    : `${12 * ratio}px ${axisFont}`;
}

/** The marker cap, in CSS px: a filled triangle hanging from the plot top. */
export const MARKER_CAP = { width: 7, height: 5 } as const;

/**
 * One vertical marker: a SOLID 1 px HAIRLINE in the reference ink (chartTheme
 * ChartInk.reference), CAPPED by a small filled triangle at the plot top.
 *  - The hairline keeps it from reading as a series: every series is drawn
 *    2.5–3 px, and the only series in the reference ink (stability) is dashed
 *    6 4. It also differs from uPlot's cursor line, which is dashed.
 *  - The cap keeps it from reading as a GRID line, which is also a solid 1 px
 *    vertical (the x grid is on in every chart) and differs only in colour —
 *    #45637B against the #B3CADC grid in light (3.73:1), #A9C3D9 against the
 *    #33597C grid in dark (4.02:1; mmr-brand 1.1.0 quietened the dark grid,
 *    which was 2.59:1 from this ink), #45637B against Daylight's #9A9A9A
 *    (2.25:1).
 *    Shape is the non-colour cue, and the worst-plane marker has no number
 *    beside it.
 * The caller sets strokeStyle and fillStyle (the reference ink), lineWidth
 * (= ratio) and a solid dash. `ratio` is the canvas's device ratio.
 */
export function drawMarker(ctx: CanvasRenderingContext2D, x: number, top: number, height: number, ratio: number) {
  ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
  const half = (MARKER_CAP.width / 2) * ratio;
  ctx.beginPath(); ctx.moveTo(x - half, top); ctx.lineTo(x + half, top); ctx.lineTo(x, top + MARKER_CAP.height * ratio);
  ctx.closePath(); ctx.fill();
}

/** C-E7: exact event times, never rounded to the nearest recorded sample.
 * Numbers refer to the text key below each canvas, avoiding overlapping names.
 * Each marker is drawMarker's capped hairline; its number sits beside the cap. */
export function eventPlugin(events: FlightEvent[], selected: readonly string[],
  ink: Pick<ChartInk, 'reference' | 'font'>): uPlot.Plugin {
  const markers = eventMarkers(events, selected);
  return { hooks: { draw: u => {
    const { ctx, bbox } = u;
    const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    ctx.save();
    ctx.strokeStyle = ink.reference; ctx.fillStyle = ink.reference; ctx.lineWidth = ratio;
    ctx.font = markerFont(ink.font, ratio); ctx.setLineDash([]);
    markers.forEach((e, i) => {
      if (e.time < u.scales['x']!.min! || e.time > u.scales['x']!.max!) return;
      const x = u.valToPos(e.time, 'x', true);
      drawMarker(ctx, x, bbox.top, bbox.height, ratio);
      // Clear of the cap (half its width is 3.5 px): the label starts 5 px right.
      ctx.fillText(String(i + 1), Math.min(x + 5 * ratio, bbox.left + bbox.width - 12 * ratio), bbox.top + (12 + (i % 3) * 14) * ratio);
    });
    ctx.restore();
  } } };
}
