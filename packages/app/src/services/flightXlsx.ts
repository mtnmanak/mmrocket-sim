import type { FlightResult } from '@online-openrocket/engine';
import type { UnitSelection } from '../prefs/units.js';
import { seriesColumns } from './flightDataCsv.js';
import { sheetsToXlsx, type Cell, type ChartSeriesSpec, type ChartSpec, type Sheet } from './xlsx.js';

/**
 * Flight-data Excel workbook (issue 2026-08-25, Eric's XLSX-with-graphs ask):
 * the same per-timestep columns as the flight-data CSV — the column specs and
 * unit mapping are IMPORTED from flightDataCsv, not duplicated — as typed
 * numeric cells under unit-labelled headers ("Altitude (ft)"), plus native
 * Excel chart tabs whose series reference the data sheet's cell ranges, so
 * editing the data re-draws the charts.
 *
 * Staged flights get one data sheet per branch (branch 0 is the sustainer
 * stack — the same data as the top-level series). Each booster is a separate
 * flight with its own time base, so a shared row axis would misalign samples;
 * per-branch sheets keep every branch honest, and each chart then carries one
 * series per stage (color follows the stage across all chart tabs).
 *
 * The charts are Excel "X Y Scatter with straight lines" (c:scatterChart),
 * deliberately NOT c:lineChart: the kernel's RK4 timestep is adaptive —
 * measured on a real exported flight (docs/User files/testa-flight-data.csv):
 * 594 distinct dt values over 726 samples, 0.0025 s to 0.456 s — and a
 * lineChart's category axis spaces samples evenly, which would compress the
 * fine-stepped boost phase ~3.5× against the coarse-stepped descent. A
 * numeric time axis is the only honest rendering; markers are off (a
 * multi-thousand-point series with markers is unreadable).
 */

/**
 * Charted quantities: the app's default plotted set (FlightCharts
 * DEFAULT_SELECTED), with the same validated-palette slot each quantity has
 * in the app's flight panels (chartTheme SERIES[0..2]) — the workbook chart
 * matches the on-screen chart the user just looked at.
 */
const CHART_QUANTITIES: { name: string; color: string }[] = [
  { name: 'Altitude', color: '2A78D6' },
  { name: 'Velocity', color: '1BAF7A' },
  { name: 'Acceleration', color: 'EDA100' },
];

/**
 * Per-stage series colors for staged flights — the full validated categorical
 * palette (chartTheme SERIES), assigned by stage in fixed order so a stage
 * keeps its color on every chart tab.
 */
const STAGE_COLORS = ['2A78D6', '1BAF7A', 'EDA100', '008300', '4A3AA7', 'E34948', 'E87BA4', 'EB6834'];

/**
 * Find a column by its spec name: headers are `${name} (${unit})` (or the
 * bare name when dimensionless), so match "name (" or exact "name". Symbol
 * columns ("Vz — Vertical velocity (ft/s)") never collide — they lead with
 * their symbol.
 */
function colIndex(headers: string[], name: string): number {
  return headers.findIndex((h) => h === name || h.startsWith(`${name} (`));
}

/** The whole flight as an .xlsx byte array (see module doc for the layout). */
export function flightXlsx(result: FlightResult, units?: UnitSelection): Uint8Array {
  const staged = (result.branches?.length ?? 0) >= 2;
  const branches = staged
    ? result.branches!.map((b) => ({ name: b.name, cols: seriesColumns(b.series, '', units) }))
    : [{ name: 'Flight data', cols: seriesColumns(result.series, '', units) }];

  const sheets: Sheet[] = branches.map((b) => {
    const rowCount = Math.max(0, ...b.cols.map((c) => c.values.length));
    const rows: Cell[][] = [];
    for (let i = 0; i < rowCount; i++) {
      // NaN samples (kernel: undefined at that step) become EMPTY cells, and
      // the charts render them as gaps (dispBlanksAs) — never as zeros.
      rows.push(b.cols.map((c) => {
        const v = c.values[i];
        return v == null || !Number.isFinite(v) ? null : v;
      }));
    }
    return { name: b.name, headers: b.cols.map((c) => c.header), rows };
  });

  const charts: ChartSpec[] = [];
  for (const q of CHART_QUANTITIES) {
    const series: ChartSeriesSpec[] = [];
    let xTitle = '';
    let yTitle = '';
    branches.forEach((b, bi) => {
      const headers = b.cols.map((c) => c.header);
      const xCol = colIndex(headers, 'Time');
      const yCol = colIndex(headers, q.name);
      if (xCol < 0 || yCol < 0) return;
      const n = Math.min(b.cols[xCol]!.values.length, b.cols[yCol]!.values.length);
      if (n < 2) return;
      if (!yTitle) {
        xTitle = headers[xCol]!;
        yTitle = headers[yCol]!;
      }
      series.push({
        name: staged ? b.name : headers[yCol]!,
        sheetIndex: bi,
        xCol,
        yCol,
        rowCount: n,
        color: staged ? STAGE_COLORS[bi % STAGE_COLORS.length]! : q.color,
      });
    });
    if (series.length === 0) continue;
    charts.push({ name: q.name, title: yTitle, xTitle, yTitle, series });
  }

  return sheetsToXlsx(sheets, charts);
}
