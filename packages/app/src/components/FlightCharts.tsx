import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { FlightResult, FlightSeries } from '@online-openrocket/engine';
import { usePrefs, type Preferences } from '../prefs/PrefsContext.js';
import { siToUi, type Quantity } from '../prefs/units.js';
import { chartInk, seriesPalette } from '../chartTheme.js';
import { panelHeight, panZoomPlugin, plotIsZoomed, resetPlots } from '../chartPanZoom.js';
import { formatReadout, tooltipPlugin } from '../chartTooltip.js';
import { UnitChip } from './UnitChip.js';
import { flightDataCsv } from '../services/flightDataCsv.js';
import { flightXlsx } from '../services/flightXlsx.js';
import { CSV_BOM, downloadBlob, stampedName } from '../services/fileName.js';
import { XLSX_MIME } from '../services/xlsx.js';

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

/**
 * The one compact line naming the pan/zoom gestures — testers could not
 * guess shift-drag/middle-drag (Eric's point 3), so the hints are always on
 * screen, but only ONE line for the whole chart group so discoverability
 * doesn't tax the vertical space the too-small charts need. Pointer-aware:
 * CSS shows the mouse wording on fine pointers, the touch wording on coarse
 * ones. Shared with the Drag-analysis charts (imported by DragPanel).
 */
export function GestureHints() {
  return (
    <>
      <span className="chart-hints chart-hints-mouse">
        Zoom: scroll wheel or drag a box &middot; Pan: Shift-drag or middle-button drag
        &middot; Reset: double-click or ↺
      </span>
      <span className="chart-hints chart-hints-touch">
        Drag sideways to pan &middot; ↺ resets the view
      </span>
    </>
  );
}

function Panel({ result, def, plots, expanded, onToggleExpand, onZoomChange }: {
  result: FlightResult;
  def: SeriesDef;
  /** Live registry of every mounted panel's uPlot — pan/zoom peers. */
  plots: Set<uPlot>;
  /** ⤢ state: full grid width + a much taller canvas. */
  expanded: boolean;
  onToggleExpand: () => void;
  /** Reports whether this panel (== the synced group) is zoomed in. */
  onZoomChange: (zoomed: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { resolvedTheme, daylight } = usePrefs();
  // Read through a ref inside the plugin closure so a parent re-render can't
  // force a plot recreate (the effect below deliberately omits it from deps).
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;
  // The x-window survives this panel's recreate (deliberate: a theme or
  // unit-chip change no longer resets a zoom) — restored only while the data
  // x-extent is unchanged, so a NEW flight always opens at full width.
  const savedWin = useRef<{ min: number; max: number; x0: number; x1: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ink = chartInk(el);
    const raw = result.series[def.key] ?? [];
    const values = def.f ? raw.map((v) => (v == null ? v : def.f!(v))) : raw;
    const data: uPlot.AlignedData = [result.series.time, values];
    // Panels widen a lot on big screens — let height follow (capped) so a
    // 1500px-wide chart doesn't flatten into a ribbon. The ⤢ expanded state
    // switches to the much-taller policy (see panelHeight).
    const chartH = () => panelHeight(el.clientWidth || 640, expanded);
    const opts: uPlot.Options = {
      width: el.clientWidth || 640,
      height: chartH(),
      cursor: { sync: { key: SYNC_KEY }, points: { size: 7 } },
      scales: { x: { time: false } },
      legend: { live: true },
      series: [
        { label: 't (s)', value: (_u, v) => formatReadout(v) },
        {
          label: `${def.title}${def.unit ? ` (${def.unit})` : ''}`,
          stroke: def.color,
          width: ink.strokeWidth,
          value: (_u, v) => formatReadout(v),
        },
      ],
      axes: [
        { stroke: ink.axis, grid: { stroke: ink.grid, width: 1 }, ticks: { stroke: ink.tick, width: 1 }, font: ink.font },
        { stroke: ink.axis, grid: { stroke: ink.grid, width: 1 }, ticks: { stroke: ink.tick, width: 1 }, font: ink.font, size: 56 },
      ],
      plugins: [panZoomPlugin(() => plots, (u) => onZoomChangeRef.current(plotIsZoomed(u))), tooltipPlugin()],
    };
    const plot = new uPlot(opts, data, el);
    const t = result.series.time;
    const x0 = t[0];
    const x1 = t[t.length - 1];
    // A panel joining a live group takes the group's window (all panels share
    // the same time base) — the peers, not this panel's own snapshot, know
    // whether the group zoomed or reset while it was toggled off. On a full
    // recreate (theme/unit change) React runs every cleanup before any setup,
    // so the registry is empty and each panel restores its own snapshot.
    const peer: uPlot | undefined = plots.values().next().value;
    const saved = savedWin.current;
    if (peer && peer.scales['x']!.min != null && peer.scales['x']!.max != null) {
      plot.setScale('x', { min: peer.scales['x']!.min, max: peer.scales['x']!.max });
    } else if (saved && saved.x0 === x0 && saved.x1 === x1) {
      plot.setScale('x', { min: saved.min, max: saved.max });
    }
    plots.add(plot);
    const obs = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: chartH() }));
    obs.observe(el);
    return () => {
      obs.disconnect();
      plots.delete(plot);
      const sc = plot.scales['x']!;
      savedWin.current = x0 != null && x1 != null && sc.min != null && sc.max != null
        ? { min: sc.min, max: sc.max, x0, x1 }
        : null;
      plot.destroy();
    };
    // `expanded` recreates the plot the same way a theme change does — the
    // group window survives via the peer registry / savedWin restore above.
  }, [result, def, resolvedTheme, daylight, plots, expanded]);

  return (
    <div className={expanded ? 'chart-panel chart-panel-expanded' : 'chart-panel'}>
      <div className="chart-panel-head">
        <h3>
          {def.title}
          {def.quantity
            ? <> <UnitChip quantity={def.quantity} /></>
            : def.unit ? ` (${def.unit})` : ''}
        </h3>
        <button className="chart-btn" onClick={onToggleExpand} aria-pressed={expanded}
          title={expanded ? 'Restore chart size' : 'Expand chart (full width, taller)'}
          aria-label={expanded ? `Restore ${def.title} chart size` : `Expand ${def.title} chart`}>
          {expanded ? '⤡' : '⤢'}
        </button>
      </div>
      <div ref={ref} />
    </div>
  );
}

export function FlightCharts({ result, onFullSeries, designName }: {
  result: FlightResult;
  /**
   * Re-flies the shown flight with the full series payload. Absent = the
   * download pair is not offered (nothing here can produce it).
   */
  onFullSeries?: () => Promise<FlightResult>;
  designName?: string;
}) {
  const { prefs, daylight, resolvedTheme } = usePrefs();
  const catalog = useMemo(
    () => seriesCatalog(prefs, seriesPalette(daylight, resolvedTheme)),
    [prefs, daylight, resolvedTheme],
  );
  const [selected, setSelected] = useState<Set<keyof FlightSeries>>(new Set(DEFAULT_SELECTED));
  // Which panels are ⤢-expanded. Lives here (not in Panel) so toggling a
  // series chip off and on doesn't forget the choice. Deliberately NOT
  // persisted — per-session UI state only.
  const [expandedKeys, setExpandedKeys] = useState<Set<keyof FlightSeries>>(new Set());
  // Whether the synced group is zoomed in (drives the Reset-view button).
  // Any panel's report speaks for the group — every gesture is broadcast to
  // all peers, so their windows agree.
  const [zoomed, setZoomed] = useState(false);
  // One Set instance for the component's whole life: Panels register their
  // uPlot in it and the pan/zoom plugin broadcasts window changes to every
  // member (programmatic setScale does not ride uPlot's cursor-sync bus).
  const plotsRef = useRef<Set<uPlot>>(new Set());

  const toggle = (key: keyof FlightSeries) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleExpand = (key: keyof FlightSeries) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const visible = catalog.filter((d) => selected.has(d.key) && (result.series[d.key] ?? []).length > 0);

  // The raw flight-data downloads live HERE, beside the plots they belong to.
  // They used to sit in the launch report's header, where the pair read as
  // report exports; a third button up here wrote a 12-column subset under the
  // name `flight-data.csv`, so the file that SOUNDED canonical was the poorest
  // export on the page. That one is gone: it was a lossless subset of this
  // CSV, through the same unit conversion, minus the BOM and minus every
  // booster branch.
  const [exportBusy, setExportBusy] = useState<null | 'csv' | 'xlsx'>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  /** Re-fly for the full series, then hand the bytes off as a download. */
  const exportFlightData = (kind: 'csv' | 'xlsx') => {
    if (!onFullSeries) return;
    setExportBusy(kind);
    setExportError(null);
    onFullSeries()
      .then((full) => {
        const blob = kind === 'csv'
          ? new Blob([CSV_BOM, flightDataCsv(full, prefs.units)], { type: 'text/csv;charset=utf-8' })
          : new Blob([flightXlsx(full, prefs.units) as BlobPart], { type: XLSX_MIME });
        downloadBlob(blob, stampedName(designName, 'flight-data', kind === 'csv' ? 'csv' : 'xlsx'));
      })
      .catch((e: unknown) => setExportError(e instanceof Error ? e.message : String(e)))
      .finally(() => setExportBusy(null));
  };

  return (
    <div className="panel" style={{ marginTop: 10 }}>
      {/* The plots block had no heading at all, which is part of why a
          download button floating above it read as ambiguous. */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ flex: 1 }}>Flight plots</h2>
        {onFullSeries && (
          <>
            <span className="download-caption">Download this flight, every timestep:</span>
            <button className="file-btn" disabled={exportBusy !== null}
              title={'Re-flies the shown flight to capture every series the physics kernel records (deterministic — the same flight, more columns), one row per timestep, in your preferred units (each header names its unit; thrust and drag stay in newtons). Booster stages append as name-prefixed column groups. Not stored with run history.'}
              onClick={() => exportFlightData('csv')}>
              {exportBusy === 'csv' ? '⏳ Re-flying…' : '⬇ Flight data (.csv)'}
            </button>
            <button className="file-btn" disabled={exportBusy !== null}
              title={'Excel workbook of the same flight data: typed numeric cells under unit-labelled headers, plus a live Excel chart tab for every exported column — the headline quantities one per tab, the coefficient and rate families grouped — referencing the data sheet. Booster stages get their own data sheets and their own chart tabs.'}
              onClick={() => exportFlightData('xlsx')}>
              {exportBusy === 'xlsx' ? '⏳ Re-flying…' : '⬇ Flight data + charts (.xlsx)'}
            </button>
          </>
        )}
      </div>
      {exportError && (
        <p className="simdet-comments stability-bad" style={{ margin: '4px 0 0' }}>
          Flight-data export failed: {exportError}
        </p>
      )}
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
      </div>
      {visible.length > 0 && (
        <div className="chart-toolbar">
          <GestureHints />
          <button className="chart-btn" disabled={!zoomed}
            onClick={() => { resetPlots(plotsRef.current); setZoomed(false); }}
            title="Show the whole flight again (same as double-clicking a chart)">
            ↺ Reset view
          </button>
        </div>
      )}
      <div className="charts-grid">
        {visible.map((d) => (
          <Panel key={String(d.key)} result={result} def={d} plots={plotsRef.current}
            expanded={expandedKeys.has(d.key)} onToggleExpand={() => toggleExpand(d.key)}
            onZoomChange={setZoomed} />
        ))}
      </div>
      {selected.size === 0 && (
        <div className="panel placeholder">Select at least one series to plot.</div>
      )}
    </div>
  );
}
