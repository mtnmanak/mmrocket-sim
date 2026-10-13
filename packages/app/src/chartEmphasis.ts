import type uPlot from 'uplot';
import type { FlightSeries } from '@online-openrocket/engine';
import { chartInk } from './chartTheme.js';

/** N012: redraw only the ink; data, visibility and scale bounds stay intact. */
export function emphasizeSeries(plot: uPlot, keys: (keyof FlightSeries)[], key: keyof FlightSeries | null, el: Element) {
  const width = chartInk(el).strokeWidth;
  keys.forEach((member, i) => {
    const series = plot.series[i + 1]!;
    series.alpha = key === null || key === member ? 1 : 0.35;
    series.width = key === member ? width * 1.5 : width;
  });
  plot.redraw();
}
