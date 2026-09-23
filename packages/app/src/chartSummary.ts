import { formatReadout } from './chartTooltip.js';

/**
 * A chart said in words, for the `aria-label` of its `role="img"` canvas
 * (audit 2026-09-22).
 *
 * uPlot draws into a bare <canvas>: to a screen reader the Drag and Flight
 * charts were nothing but their headings and the legend's series names, and
 * nothing said the CSV beside them holds the same numbers. This gives each
 * curve its shape — where it starts, its highest and lowest points, where it
 * ends — and points at the download that has every point.
 *
 * Three significant figures, as a reading, not a table: the CSV is the table.
 */
export interface SummarySeries {
  label: string;
  values: readonly (number | null | undefined)[];
}

export function chartSummary({ title, x, at, series, source }: {
  /** What the chart plots against what — "Drag coefficient vs Mach". */
  title: string;
  x: readonly number[];
  /** An x value as it should be said — "Mach 1.05", "5.6 s". */
  at: (x: number) => string;
  series: readonly SummarySeries[];
  /** A closing sentence naming the download that holds the same data. */
  source?: string;
}): string {
  const say = (v: number) => formatReadout(v, 3);
  const n = x.length;
  const out: string[] = [n > 1 ? `${title}, ${at(x[0]!)} to ${at(x[n - 1]!)}.` : `${title}.`];
  for (const s of series) {
    const idx: number[] = [];
    for (let i = 0; i < Math.min(n, s.values.length); i++) {
      const v = s.values[i];
      if (typeof v === 'number' && Number.isFinite(v)) idx.push(i);
    }
    if (idx.length === 0) {
      out.push(`${s.label}: no data.`);
      continue;
    }
    const v = (i: number) => s.values[i] as number;
    const first = idx[0]!;
    const last = idx[idx.length - 1]!;
    let hi = first;
    let lo = first;
    for (const i of idx) {
      if (v(i) > v(hi)) hi = i;
      if (v(i) < v(lo)) lo = i;
    }
    const parts = [`${say(v(first))} at ${at(x[first]!)}`];
    // The extremes only where they are not already an end of the curve.
    if (hi !== first && hi !== last) parts.push(`highest ${say(v(hi))} at ${at(x[hi]!)}`);
    if (lo !== first && lo !== last) parts.push(`lowest ${say(v(lo))} at ${at(x[lo]!)}`);
    if (last !== first) parts.push(`${say(v(last))} at ${at(x[last]!)}`);
    out.push(`${s.label}: ${parts.join(', ')}.`);
  }
  if (source) out.push(source);
  return out.join(' ');
}

/**
 * Names a uPlot chart's canvas: `role="img"` and the summary as its label.
 * The canvas, not the wrapper — `role="img"` makes its subtree
 * presentational, and the legend beside the canvas (series names, the live
 * readout) is the one part of the chart a screen reader could already use.
 */
export function nameChartCanvas(host: HTMLElement, summary: string): void {
  const canvas = host.querySelector('canvas');
  if (!canvas) return;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', summary);
}
