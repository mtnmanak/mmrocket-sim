import type uPlot from 'uplot';
import type { FlightEvent } from '@online-openrocket/engine';

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

/** C-E7: exact event times, never rounded to the nearest recorded sample.
 * Numbers refer to the text key below each canvas, avoiding overlapping names. */
export function eventPlugin(events: FlightEvent[], selected: readonly string[], ink: string): uPlot.Plugin {
  const markers = eventMarkers(events, selected);
  return { hooks: { draw: u => {
    const { ctx, bbox } = u;
    const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    ctx.save();
    ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineWidth = ratio;
    ctx.font = `${12 * ratio}px system-ui`; ctx.setLineDash([4 * ratio, 4 * ratio]);
    markers.forEach((e, i) => {
      if (e.time < u.scales['x']!.min! || e.time > u.scales['x']!.max!) return;
      const x = u.valToPos(e.time, 'x', true);
      ctx.beginPath(); ctx.moveTo(x, bbox.top); ctx.lineTo(x, bbox.top + bbox.height); ctx.stroke();
      ctx.fillText(String(i + 1), Math.min(x + 3 * ratio, bbox.left + bbox.width - 12 * ratio), bbox.top + (12 + (i % 3) * 14) * ratio);
    });
    ctx.restore();
  } } };
}
