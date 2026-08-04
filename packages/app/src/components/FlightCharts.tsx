import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { FlightResult, FlightSeries } from '@online-openrocket/engine';
import { usePrefs, type Preferences } from '../prefs/PrefsContext.js';
import { siToUi, type Quantity } from '../prefs/units.js';
import { chartInk, seriesPalette } from '../chartTheme.js';
import { UnitChip } from './UnitChip.js';

/**
 * Stacked single-series panels with synchronized crosshairs. Different-scale
 * measures are NEVER dual-axed — every series gets its own panel and y-scale.
 * Colors are assigned per series identity from the validated categorical
 * palette (fixed, never re-assigned by selection); each panel is
 * single-series, so identity is carried by its visible title + live readout.
 * The picker row above the charts follows the filter-bar pattern.
 */
const SYNC_KEY = 'flight';

// Validated palette slots 1-8, then repeats (single-series panels: identity
// is text-carried, so repeats are safe). High contrast swaps in a darker /
// brighter set — see chartTheme.ts.

interface SeriesDef {
  key: keyof FlightSeries;
  title: string;
  unit: string;
  color: string;
  /** set for unit-preference-driven series: the title unit becomes a click-to-change chip */
  quantity?: Quantity;
  /** display transform (SI -> UI unit) */
  f?: (v: number) => number;
}

/** Series defs in the user's units — the engine data underneath stays SI. */
function seriesCatalog(prefs: Preferences, C: string[]): SeriesDef[] {
  const u = prefs.units;
  return [
    { key: 'altitude', title: 'Altitude', unit: u.distance, quantity: 'distance', color: C[0]!, f: (v) => siToUi('distance', u.distance, v) },
    { key: 'velocity', title: 'Velocity', unit: u.velocity, quantity: 'velocity', color: C[1]!, f: (v) => siToUi('velocity', u.velocity, v) },
    { key: 'acceleration', title: 'Acceleration', unit: u.acceleration, quantity: 'acceleration', color: C[2]!, f: (v) => siToUi('acceleration', u.acceleration, v) },
    { key: 'mass', title: 'Mass', unit: u.mass, quantity: 'mass', color: C[3]!, f: (v) => siToUi('mass', u.mass, v) },
    { key: 'thrust', title: 'Thrust', unit: 'N', color: C[4]! },
    { key: 'drag', title: 'Drag force', unit: 'N', color: C[5]! },
    { key: 'mach', title: 'Mach number', unit: '', color: C[6]! },
    { key: 'stability', title: 'Stability margin', unit: 'cal', color: C[7]! },
    { key: 'cpLocation', title: 'CP location', unit: u.length, quantity: 'length', color: C[0]!, f: (v) => siToUi('length', u.length, v) },
    { key: 'cgLocation', title: 'CG location', unit: u.length, quantity: 'length', color: C[1]!, f: (v) => siToUi('length', u.length, v) },
    { key: 'aoa', title: 'Angle of attack', unit: '°', color: C[2]!, f: (v) => (v * 180) / Math.PI },
  ];
}

const DEFAULT_SELECTED: (keyof FlightSeries)[] = ['altitude', 'velocity', 'acceleration'];

function Panel({ result, def }: { result: FlightResult; def: SeriesDef }) {
  const ref = useRef<HTMLDivElement>(null);
  const { resolvedTheme, highContrast } = usePrefs();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ink = chartInk(el);
    const raw = result.series[def.key] ?? [];
    const values = def.f ? raw.map((v) => (v == null ? v : def.f!(v))) : raw;
    const data: uPlot.AlignedData = [result.series.time, values];
    // Panels widen a lot on big screens — let height follow (capped) so a
    // 1500px-wide chart doesn't flatten into a ribbon.
    const chartH = () => Math.max(160, Math.min(240, Math.round((el.clientWidth || 640) * 0.22)));
    const opts: uPlot.Options = {
      width: el.clientWidth || 640,
      height: chartH(),
      cursor: { sync: { key: SYNC_KEY }, points: { size: 7 } },
      scales: { x: { time: false } },
      legend: { live: true },
      series: [
        { label: 't (s)', value: (_u, v) => (v == null ? '–' : v.toFixed(2)) },
        {
          label: `${def.title}${def.unit ? ` (${def.unit})` : ''}`,
          stroke: def.color,
          width: ink.strokeWidth,
          value: (_u, v) => (v == null ? '–' : v.toFixed(2)),
        },
      ],
      axes: [
        { stroke: ink.axis, grid: { stroke: ink.grid, width: 1 }, ticks: { stroke: ink.tick, width: 1 }, font: ink.font },
        { stroke: ink.axis, grid: { stroke: ink.grid, width: 1 }, ticks: { stroke: ink.tick, width: 1 }, font: ink.font, size: 56 },
      ],
    };
    const plot = new uPlot(opts, data, el);
    const obs = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: chartH() }));
    obs.observe(el);
    return () => {
      obs.disconnect();
      plot.destroy();
    };
  }, [result, def, resolvedTheme, highContrast]);

  return (
    <div className="chart-panel">
      <h3>
        {def.title}
        {def.quantity
          ? <> <UnitChip quantity={def.quantity} /></>
          : def.unit ? ` (${def.unit})` : ''}
      </h3>
      <div ref={ref} />
    </div>
  );
}

function exportCsv(result: FlightResult, catalog: SeriesDef[]) {
  const cols = catalog.filter((d) => (result.series[d.key] ?? []).length > 0);
  const header = ['time_s', ...cols.map((d) => `${String(d.key)}${d.unit ? `_${d.unit.replace('²', '2').replace('°', 'deg')}` : ''}`)];
  const rows = [header.join(',')];
  const t = result.series.time;
  for (let i = 0; i < t.length; i++) {
    const row = [t[i], ...cols.map((d) => {
      const v = result.series[d.key]?.[i];
      return v == null ? '' : (d.f ? d.f(v) : v);
    })];
    rows.push(row.join(','));
  }
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'flight-data.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

export function FlightCharts({ result }: { result: FlightResult }) {
  const { prefs, resolvedTheme, highContrast } = usePrefs();
  const catalog = useMemo(
    () => seriesCatalog(prefs, seriesPalette(highContrast, resolvedTheme === 'dark')),
    [prefs, highContrast, resolvedTheme],
  );
  const [selected, setSelected] = useState<Set<keyof FlightSeries>>(new Set(DEFAULT_SELECTED));

  const toggle = (key: keyof FlightSeries) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div>
      <div className="series-picker" role="group" aria-label="Plot series">
        {catalog.map((d) => {
          const available = (result.series[d.key] ?? []).length > 0;
          if (!available) return null;
          const on = selected.has(d.key);
          return (
            <button key={String(d.key)}
              className={`series-chip ${on ? 'series-chip-on' : ''}`}
              onClick={() => toggle(d.key)}
              aria-pressed={on}>
              <span className="series-dot" style={{ background: d.color }} />
              {d.title}
            </button>
          );
        })}
        <button className="file-btn" style={{ marginLeft: 'auto' }} onClick={() => exportCsv(result, catalog)}>
          ⬇ CSV
        </button>
      </div>
      <div className="charts-grid">
        {catalog.filter((d) => selected.has(d.key) && (result.series[d.key] ?? []).length > 0)
          .map((d) => <Panel key={String(d.key)} result={result} def={d} />)}
      </div>
      {selected.size === 0 && (
        <div className="panel placeholder">Select at least one series to plot.</div>
      )}
    </div>
  );
}
