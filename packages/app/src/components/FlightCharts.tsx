import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { FlightResult, FlightSeries } from '@online-openrocket/engine';
import { usePrefs, type Preferences } from '../prefs/PrefsContext.js';
import { siToUi } from '../prefs/units.js';

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
// is text-carried, so repeats are safe).
const C = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'];

interface SeriesDef {
  key: keyof FlightSeries;
  title: string;
  unit: string;
  color: string;
  /** display transform (SI -> UI unit) */
  f?: (v: number) => number;
}

/** Series defs in the user's units — the engine data underneath stays SI. */
function seriesCatalog(prefs: Preferences): SeriesDef[] {
  const u = prefs.units;
  return [
    { key: 'altitude', title: 'Altitude', unit: u.distance, color: C[0]!, f: (v) => siToUi('distance', u.distance, v) },
    { key: 'velocity', title: 'Velocity', unit: u.velocity, color: C[1]!, f: (v) => siToUi('velocity', u.velocity, v) },
    { key: 'acceleration', title: 'Acceleration', unit: u.acceleration, color: C[2]!, f: (v) => siToUi('acceleration', u.acceleration, v) },
    { key: 'mass', title: 'Mass', unit: u.mass, color: C[3]!, f: (v) => siToUi('mass', u.mass, v) },
    { key: 'thrust', title: 'Thrust', unit: 'N', color: C[4]! },
    { key: 'drag', title: 'Drag force', unit: 'N', color: C[5]! },
    { key: 'mach', title: 'Mach number', unit: '', color: C[6]! },
    { key: 'stability', title: 'Stability margin', unit: 'cal', color: C[7]! },
    { key: 'cpLocation', title: 'CP location', unit: u.length, color: C[0]!, f: (v) => siToUi('length', u.length, v) },
    { key: 'cgLocation', title: 'CG location', unit: u.length, color: C[1]!, f: (v) => siToUi('length', u.length, v) },
    { key: 'aoa', title: 'Angle of attack', unit: '°', color: C[2]!, f: (v) => (v * 180) / Math.PI },
  ];
}

const DEFAULT_SELECTED: (keyof FlightSeries)[] = ['altitude', 'velocity', 'acceleration'];

function Panel({ result, def }: { result: FlightResult; def: SeriesDef }) {
  const ref = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = usePrefs();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const dark = resolvedTheme === 'dark';
    const axis = dark ? '#8d8b82' : '#7a786f';
    const grid = dark ? '#2b2a27' : '#e8e6e1';
    const tick = dark ? '#3b3934' : '#dedcd7';
    const raw = result.series[def.key] ?? [];
    const values = def.f ? raw.map((v) => (v == null ? v : def.f!(v))) : raw;
    const data: uPlot.AlignedData = [result.series.time, values];
    const opts: uPlot.Options = {
      width: el.clientWidth || 640,
      height: 160,
      cursor: { sync: { key: SYNC_KEY }, points: { size: 7 } },
      scales: { x: { time: false } },
      legend: { live: true },
      series: [
        { label: 't (s)', value: (_u, v) => (v == null ? '–' : v.toFixed(2)) },
        {
          label: `${def.title}${def.unit ? ` (${def.unit})` : ''}`,
          stroke: def.color,
          width: 2,
          value: (_u, v) => (v == null ? '–' : v.toFixed(2)),
        },
      ],
      axes: [
        { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: tick, width: 1 }, font: '11px system-ui' },
        { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: tick, width: 1 }, font: '11px system-ui', size: 56 },
      ],
    };
    const plot = new uPlot(opts, data, el);
    const obs = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: 160 }));
    obs.observe(el);
    return () => {
      obs.disconnect();
      plot.destroy();
    };
  }, [result, def, resolvedTheme]);

  return (
    <div className="chart-panel">
      <h3>{def.title}{def.unit ? ` (${def.unit})` : ''}</h3>
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
  const { prefs } = usePrefs();
  const catalog = useMemo(() => seriesCatalog(prefs), [prefs]);
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
      {catalog.filter((d) => selected.has(d.key) && (result.series[d.key] ?? []).length > 0)
        .map((d) => <Panel key={String(d.key)} result={result} def={d} />)}
      {selected.size === 0 && (
        <div className="panel placeholder">Select at least one series to plot.</div>
      )}
    </div>
  );
}
