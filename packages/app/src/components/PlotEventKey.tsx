import type { FlightEvent } from '@online-openrocket/engine';
import { eventMarkers } from '../flightPlotEvents.js';
import { formatReadout } from '../chartTooltip.js';

export function eventCaptions(events: FlightEvent[], selected: readonly string[]) {
  return eventMarkers(events, selected).map((e, i) => `${i + 1}: ${e.label} at ${formatReadout(e.time)} s`);
}

export function PlotEventKey({ events, selected }: { events: FlightEvent[]; selected: readonly string[] }) {
  const captions = eventCaptions(events, selected);
  return captions.length > 0 ? <p className="chart-comparison-note plot-event-key" aria-label="Flight event key">
    {captions.join(' · ')}
  </p> : null;
}
