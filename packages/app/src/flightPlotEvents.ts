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

/** C-E7: exact event times, never rounded to the nearest recorded sample.
 * Numbers refer to the text key below each canvas, avoiding overlapping names.
 *
 * A marker is a SOLID 1 px HAIRLINE in the reference ink (chartTheme
 * ChartInk.reference), so it cannot be read as a series: every series is drawn
 * 2.5–3 px, and the only series in the reference ink (stability) is dashed 6 4.
 * It also differs from uPlot's cursor line, which is dashed. */
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
      ctx.beginPath(); ctx.moveTo(x, bbox.top); ctx.lineTo(x, bbox.top + bbox.height); ctx.stroke();
      ctx.fillText(String(i + 1), Math.min(x + 3 * ratio, bbox.left + bbox.width - 12 * ratio), bbox.top + (12 + (i % 3) * 14) * ratio);
    });
    ctx.restore();
  } } };
}
