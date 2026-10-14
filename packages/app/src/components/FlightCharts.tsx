import { Note } from './Note.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { boosterBranches, type FlightResult, type FlightSeries } from '@online-openrocket/engine';
import { usePrefs } from '../prefs/PrefsContext.js';
import { arbitraryCatalog, seriesCatalog, PRESETS, usableSeries, withStabilityPercent, type ComparisonPreset, type SeriesDef } from '../flightChartModel.js';
import { ComparisonChart } from './ComparisonChart.js';
import { chartInk, seriesPalette } from '../chartTheme.js';
import {
  panelHeight, panZoomPlugin, plotIsZoomed, resetPlots, zoomPercent,
} from '../chartPanZoom.js';
import { formatReadout, tooltipPlugin } from '../chartTooltip.js';
import { chartSummary, nameChartCanvas } from '../chartSummary.js';
import { UnitChip } from './UnitChip.js';
import { flightDataCsv } from '../services/flightDataCsv.js';
import { flightXlsx } from '../services/flightXlsx.js';
import { CSV_BOM, downloadBlob, stampedName } from '../services/fileName.js';
import { XLSX_MIME } from '../services/xlsx.js';
import { FlightExportLayoutDialog } from './FlightExportLayoutDialog.js';
import { SavedFlightPlots } from './SavedFlightPlots.js';
import { emphasizeSeries } from '../chartEmphasis.js';
import { DEFAULT_PLOT_EVENTS, PLOT_EVENTS, eventPlugin } from '../flightPlotEvents.js';
import { PlotEventKey, eventCaptions } from './PlotEventKey.js';
import { PlotImage } from './PlotImage.js';

/**
 * Separate panels remain the default; optional comparisons use explicit
 * unit-compatible scales. Time plots share crosshairs and a window.
 * Colors are assigned per series identity from the validated categorical
 * palette (fixed, never re-assigned by selection); each panel is
 * single-series, so identity is carried by its visible title + live readout.
 * The picker row above the charts follows the filter-bar pattern.
 */
const SYNC_KEY = 'flight';

// Validated palette slots 1-8, then repeats (single-series panels: identity
// is text-carried, so repeats are safe). High contrast swaps in a darker /
// brighter set — see chartTheme.ts.

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

function Panel({ result, def, flightName, plots, expanded, onToggleExpand, onZoomChange, csvNote, emphasis, selectedEvents }: {
  selectedEvents: readonly string[];
  emphasis: keyof FlightSeries | null;
  result: FlightResult;
  def: SeriesDef;
  flightName: string;
  /**
   * The closing sentence of the canvas's spoken summary, naming the download
   * that holds the same data — absent where no download is offered, or where
   * it is refused for this flight.
   */
  csvNote?: string;
  /** Live registry of every mounted panel's uPlot — pan/zoom peers. */
  plots: Set<uPlot>;
  /** ⤢ state: full grid width + a much taller canvas. */
  expanded: boolean;
  onToggleExpand: () => void;
  /** Reports whether this panel (== the synced group) is zoomed in. */
  onZoomChange: (zoomed: boolean, percent: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const { resolvedTheme, daylight } = usePrefs();
  // Read through a ref inside the plugin closure so a parent re-render can't
  // force a plot recreate (the effect below deliberately omits it from deps).
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;
  // The x-window survives this panel's recreate (deliberate: a theme or
  // unit-chip change no longer resets a zoom) — restored only while the data
  // x-extent is unchanged, so a NEW flight always opens at full width.
  const savedWin = useRef<{ min: number; max: number; x0: number; x1: number } | null>(null);

  const values = useMemo(() => {
    const raw = result.series[def.key] ?? [];
    return def.f ? raw.map((v) => (v == null ? v : def.f!(v))) : raw;
  }, [result, def]);
  // The canvas's name (audit 2026-09-22): each plot was a bare canvas, so a
  // screen reader got its heading and the legend's series name, never the curve.
  const summary = useMemo(() => chartSummary({
    title: `${def.title}${def.unit ? ` (${def.unit})` : ''} over time — ${flightName}`,
    x: result.series.time,
    at: (t) => `${formatReadout(t, 3)} s`,
    series: [{ label: def.title, values }],
    source: csvNote,
  }), [result, def, values, csvNote, flightName]);
  // Read through a ref by the plot effect, and applied on its own below: the
  // download note changes when the design moves under a flight (staleReason),
  // and that must re-word the canvas, not destroy and rebuild the plot.
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  useEffect(() => {
    if (ref.current) nameChartCanvas(ref.current, summary);
  }, [summary]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ink = chartInk(el);
    const data: uPlot.AlignedData = [result.series.time, values];
    // Panels widen a lot on big screens — let height follow (capped) so a
    // 1500px-wide chart doesn't flatten into a ribbon. The ⤢ expanded state
    // switches to the much-taller policy (see panelHeight).
    const chartH = () => panelHeight(el.clientWidth || 640, expanded);
    const opts: uPlot.Options = {
      width: el.clientWidth || 640,
      height: chartH(),
      cursor: { sync: { key: SYNC_KEY, scales: ['x', null] }, points: { size: 7 }, bind: { click: () => null } },
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
      plugins: [
        panZoomPlugin(() => plots,
          (u) => onZoomChangeRef.current(plotIsZoomed(u), zoomPercent(u))),
        tooltipPlugin(),
        eventPlugin(result.events, selectedEvents, ink.axis),
      ],
    };
    const plot = new uPlot(opts, data, el);
    plotRef.current = plot;
    nameChartCanvas(el, summaryRef.current);
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
      plotRef.current = null;
    };
    // `expanded` recreates the plot the same way a theme change does — the
    // group window survives via the peer registry / savedWin restore above.
  }, [result, def, values, resolvedTheme, daylight, plots, expanded, selectedEvents]);

  useEffect(() => {
    if (plotRef.current && ref.current) emphasizeSeries(plotRef.current, [def.key], emphasis, ref.current);
  }, [emphasis, result, def, values, resolvedTheme, daylight, expanded, selectedEvents]);

  return (
    <div className={expanded ? 'chart-panel chart-panel-expanded' : 'chart-panel'}>
      <div className="chart-panel-head">
        <h3>
          {def.title}
          {def.quantity
            ? <> <UnitChip quantity={def.quantity} /></>
            : def.unit ? ` (${def.unit})` : ''}
          {' — '}{flightName}
        </h3>
        <PlotImage container={ref} title={`${def.title}${def.unit ? ` (${def.unit})` : ''} over Time (s) — ${flightName}`}
          captions={eventCaptions(result.events, selectedEvents)} />
        <button className="chart-btn" onClick={onToggleExpand} aria-pressed={expanded}
          title={expanded ? 'Restore chart size' : 'Expand chart (full width, taller)'}
          aria-label={expanded ? `Restore ${def.title} chart size` : `Expand ${def.title} chart`}>
          {expanded ? '⤡' : '⤢'}
        </button>
      </div>
      <div ref={ref} className="chart-legend-locked" />
      <PlotEventKey events={result.events} selected={selectedEvents} />
    </div>
  );
}

export function FlightCharts({ result, flightName, onFullSeries, designName, staleReason, flightRunning }: {
  result: FlightResult;
  /** Saved run label, shared with the launch report; never the edited design. */
  flightName: string;
  /**
   * Re-flies the shown flight with the full series payload. Absent = the
   * download pair is not offered (nothing here can produce it).
   */
  onFullSeries?: () => Promise<FlightResult>;
  designName?: string;
  /**
   * What has moved since the SHOWN flight was flown, as prose ("the weighed
   * pad mass"), or null when nothing has. The downloads REFUSE while it is
   * set: they work by re-flying the design as it stands NOW, so the file
   * would describe a different rocket from the plots it sits under and is
   * named after.
   *
   * It deliberately does NOT carry the aerodynamics model — that one the
   * re-fly restores from the run itself, so a model switch is a labelling
   * matter and not a reason to refuse.
   */
  staleReason?: string | null;
  /**
   * A Launch is flying the engine handle the downloads re-fly on. They wait
   * for it: a Launch yields between its auto-delay probes, and a re-fly in one
   * of those yields handed the handle back on the current model mid-Launch
   * (audit 2026-09-30). A stale reason outranks it in the caption — that one
   * outlasts the flight.
   */
  flightRunning?: boolean;
}) {
  const { prefs, setPrefs, daylight, resolvedTheme } = usePrefs();
  const exportLayout = prefs.flightExportLayouts?.find(l => l.id === prefs.flightExportLayoutId);
  const [layoutEditor, setLayoutEditor] = useState<null | 'new' | 'edit'>(null);
  const catalog = useMemo(
    () => seriesCatalog({ units: prefs.units }, seriesPalette(daylight, resolvedTheme)),
    // Other preferences do not change plotted series (audit 2026-10-11, S3b-2).
    [prefs.units, daylight, resolvedTheme],
  );
  const [comparison, setComparison] = useState('');
  const [custom, setCustom] = useState({ x: 'time', y: 'altitude' });
  const [selectedEvents, setSelectedEvents] = useState<string[]>(DEFAULT_PLOT_EVENTS);
  const [fullRecording, setFullRecording] = useState<{ original: FlightResult; full: FlightResult } | null>(null);
  const [plotError, setPlotError] = useState<string | null>(null);
  const recording = fullRecording?.original === result ? fullRecording.full : result;
  const [branchChoice, setBranchChoice] = useState({ result, index: 0, generation: 0 });
  if (branchChoice.result !== result) {
    setBranchChoice({ result, index: 0, generation: branchChoice.generation + 1 });
  }
  const boosters = boosterBranches(recording);
  const branchIndex = branchChoice.result === result ? branchChoice.index : 0;
  const branch = boosters[branchIndex - 1];
  const branchName = branch ? `Booster ${branchIndex}: ${branch.name}` : 'Sustainer stack';
  const plotIdentity = boosters.length > 0 ? `${flightName} · ${branchName}` : flightName;
  const shown = useMemo(() => ({ ...recording, events: branch?.events ?? recording.events,
    series: withStabilityPercent(branch?.series ?? recording.series, branch?.events ?? recording.events),
  }), [recording, branch]);
  const axesCatalog = useMemo(() => arbitraryCatalog(shown.series, { units: prefs.units }, seriesPalette(daylight, resolvedTheme)),
    [shown.series, prefs.units, daylight, resolvedTheme]);
  const plotCatalog = useMemo(() => [...catalog, ...axesCatalog.filter(d => !catalog.some(c => c.key === d.key))], [catalog, axesCatalog]);
  const panelKey = `${branchChoice.generation}-${branchIndex}`;
  const preset = useMemo<ComparisonPreset | undefined>(() => comparison === 'custom'
    ? { id: 'custom', title: 'Custom plot', x: custom.x, left: [custom.y], right: [] }
    : comparison === 'ground-track' ? { id: 'ground-track', title: 'Ground track', x: 'Px', left: ['Py'], right: [] }
      : PRESETS.find(p => p.id === comparison), [comparison, custom]);
  const [selected, setSelected] = useState<Set<keyof FlightSeries>>(new Set(DEFAULT_SELECTED));
  const [hovered, setHovered] = useState<keyof FlightSeries | null>(null);
  const [focused, setFocused] = useState<keyof FlightSeries | null>(null);
  const [pinned, setPinned] = useState<keyof FlightSeries | null>(null);
  // Which panels are ⤢-expanded. Lives here (not in Panel) so toggling a
  // series chip off and on doesn't forget the choice. Deliberately NOT
  // persisted — per-session UI state only.
  const [expandedKeys, setExpandedKeys] = useState<Set<keyof FlightSeries>>(new Set());
  // Whether the synced group is zoomed in (drives the Reset-view button).
  // Any panel's report speaks for the group — every gesture is broadcast to
  // all peers, so their windows agree.
  // The panels are peers — a zoom on one is applied to all of them — so there
  // is one depth for the grid, reported once beside the reset button rather
  // than repeated on every panel.
  const [zoomed, setZoomed] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
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

  const visible = catalog.filter((d) => selected.has(d.key) && usableSeries(shown.series, [String(d.key)]));
  const legend = plotCatalog.filter((d) => (visible.some((v) => v.key === d.key)
    || preset?.left.includes(String(d.key)) || preset?.right.includes(String(d.key))) && usableSeries(shown.series, [String(d.key)]));
  const requested = hovered ?? focused ?? pinned;
  const emphasis = legend.some((d) => d.key === requested) ? requested : null;

  // The raw flight-data downloads live HERE, beside the plots they belong to.
  // They used to sit in the launch report's header, where the pair read as
  // report exports; a third button up here wrote a 12-column subset under the
  // name `flight-data.csv`, so the file that SOUNDED canonical was the poorest
  // export on the page. That one is gone: it was a lossless subset of this
  // CSV, through the same unit conversion, minus the BOM and minus every
  // booster branch.
  const [exportBusy, setExportBusy] = useState<null | 'csv' | 'xlsx' | 'plots'>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  /**
   * False once this panel is gone. `onFullSeries` re-flies the whole simulation
   * and is measured in seconds, so the window in which the user can navigate
   * away is wide (2026-09-08 audit). The DOWNLOAD still happens either way —
   * the user asked for the file and it is theirs; only the state writes stop.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /** Re-fly for the full series, then hand the bytes off as a download. */
  const exportFlightData = (kind: 'csv' | 'xlsx') => {
    if (!onFullSeries) return;
    setExportBusy(kind);
    setExportError(null);
    onFullSeries()
      .then((full) => {
        const blob = kind === 'csv'
          ? new Blob([CSV_BOM, flightDataCsv(full, prefs.units, exportLayout)], { type: 'text/csv;charset=utf-8' })
          : new Blob([flightXlsx(full, prefs.units, exportLayout) as BlobPart], { type: XLSX_MIME });
        downloadBlob(blob, stampedName(designName, 'flight-data', kind === 'csv' ? 'csv' : 'xlsx'));
      })
      .catch((e: unknown) => {
        if (mounted.current) setExportError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (mounted.current) setExportBusy(null); });
  };

  return (
    <div className="panel" style={{ marginTop: 10 }}>
      {/* The plots block had no heading at all, which is part of why a
          download button floating above it read as ambiguous. */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ flex: 1 }}>Flight plots</h2>
        {onFullSeries && (
          <>
            {/* The caption carries the refusal, not the `title`: a browser
                shows no tooltip on a disabled button, and a dead button whose
                only explanation is an attribute is a dead button with no
                explanation. role="status" announces it the way the
                export-failure line below does. */}
            <span className="download-caption" id="flight-data-stale" role="status">
              {staleReason
                ? `Not available — ${staleReason} changed since this flight. Press Launch to fly the current design, then export.`
                : flightRunning
                  ? 'Not available while a flight is running.'
                  : exportLayout ? `Download this flight using “${exportLayout.name}”:` : 'Download this flight, every timestep:'}
            </span>
            <button className="file-btn" disabled={exportBusy !== null || !!staleReason || !!flightRunning}
              aria-describedby={staleReason || flightRunning ? 'flight-data-stale' : undefined}
              title={staleReason
                ? `Unavailable: ${staleReason} changed since this flight was flown. These files are produced by re-flying the design as it stands now, so this one would describe a different rocket from the plots above it. Press Launch to fly the current design.`
                : exportLayout ? 'Re-flies the shown flight, then exports the saved columns, order, units and event interval for each branch.'
                  : 'Re-flies the shown flight to capture every series the physics kernel records (deterministic — the same flight, more columns), one row per timestep, in your preferred units (each header names its unit; thrust and drag stay in newtons). Booster stages append as name-prefixed column groups. Not stored with run history.'}
              onClick={() => exportFlightData('csv')}>
              {exportBusy === 'csv' ? '⏳ Re-flying…' : '⬇ Flight data (.csv)'}
            </button>
            <button className="file-btn" disabled={exportBusy !== null || !!staleReason || !!flightRunning}
              aria-describedby={staleReason || flightRunning ? 'flight-data-stale' : undefined}
              title={staleReason
                ? `Unavailable: ${staleReason} changed since this flight was flown. These files are produced by re-flying the design as it stands now, so this one would describe a different rocket from the plots above it. Press Launch to fly the current design.`
                : exportLayout ? 'The saved export layout as numeric cells, with a chart per selected quantity when Time and at least two samples are included. Each branch has its own data sheet.'
                  : 'Excel workbook of the same flight data: typed numeric cells under unit-labelled headers, plus a live Excel chart tab for every exported column — the headline quantities one per tab, the coefficient and rate families grouped — referencing the data sheet. Booster stages get their own data sheets and their own chart tabs.'}
              onClick={() => exportFlightData('xlsx')}>
              {exportBusy === 'xlsx' ? '⏳ Re-flying…' : '⬇ Flight data + charts (.xlsx)'}
            </button>
          </>
        )}
      </div>
      {/* Downloads cover the whole flight; branch identity belongs to each chart. */}
      <p className="flight-identity chart-comparison-note">{flightName}</p>
      {onFullSeries && <div className="comparison-controls">
        <label>Export layout <select aria-label="Export layout" value={exportLayout?.id ?? ''}
          onChange={e => setPrefs({ ...prefs, flightExportLayoutId: e.target.value || undefined })}>
          <option value="">Full export</option>
          {prefs.flightExportLayouts?.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select></label>
        <button className="file-btn" onClick={() => setPrefs({ ...prefs, flightExportLayoutId: undefined })}>Full export</button>
        <button className="file-btn" onClick={() => setLayoutEditor('new')}>New layout</button>
        {exportLayout && <>
          <button className="file-btn" onClick={() => setLayoutEditor('edit')}>Edit layout</button>
          <button className="file-btn" onClick={() => setPrefs({ ...prefs, flightExportLayoutId: undefined,
            flightExportLayouts: prefs.flightExportLayouts?.filter(l => l.id !== exportLayout.id) })}>Remove layout</button>
        </>}
      </div>}
      {layoutEditor && <FlightExportLayoutDialog layout={layoutEditor === 'edit' ? exportLayout : undefined}
        onClose={() => setLayoutEditor(null)} />}
      {exportError && (
        // role="alert" (2026-09-08 audit): this is the outcome of a re-fly the
        // user pressed a button for and waited several seconds on, and it was
        // announced to nobody. PropertyPanel and MotorBrowser both use
        // role="alert" for the same situation.
        <Note as="p" tier="danger" className="simdet-comments stability-bad" role="alert" style={{ margin: '4px 0 0' }}>
          Flight-data export failed: {exportError}
        </Note>
      )}
      <div className="series-picker" role="group" aria-label="Plot series">
        {catalog.map((d) => {
          const available = usableSeries(shown.series, [String(d.key)]);
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
      <div className="comparison-controls">
        <label>Comparison chart
          <select value={comparison} onChange={(e) => setComparison(e.target.value)}>
            <option value="">None</option>
            {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            <option value="custom">Custom plot</option>
            <option value="ground-track">Ground track</option>
          </select>
        </label>
        <span className="chart-comparison-note">Add a comparison above the separate charts.</span>
        {boosters.length > 0 && <label>Flight branch
          <select value={branchIndex} onChange={(e) => {
            setBranchChoice({ ...branchChoice, index: Number(e.target.value) });
            setZoomed(false); setZoomPct(100);
          }}>
            <option value={0}>Sustainer stack</option>
            {boosters.map((b, i) => <option key={i + 1} value={i + 1}>Booster {i + 1}: {b.name}</option>)}
          </select>
        </label>}
      </div>
      {comparison === 'custom' && <div className="comparison-controls">
        {(['x', 'y'] as const).map(axis => <label key={axis}>Custom {axis.toUpperCase()} axis
          <select aria-label={`Custom ${axis.toUpperCase()} axis`} value={custom[axis]}
            onChange={e => setCustom({ ...custom, [axis]: e.target.value })}>
            {!axesCatalog.some(d => d.key === custom[axis]) && <option value={custom[axis]}>{custom[axis]} (no recorded data)</option>}
            {axesCatalog.map(d => <option key={String(d.key)} value={String(d.key)}>{d.title}{d.unit ? ` (${d.unit})` : ''}</option>)}
          </select>
        </label>)}
        {onFullSeries && <button className="chart-btn" disabled={exportBusy !== null || !!staleReason || !!flightRunning}
          aria-describedby={staleReason || flightRunning ? 'flight-data-stale' : undefined}
          onClick={() => {
            setExportBusy('plots'); setPlotError(null);
            onFullSeries().then(full => { if (mounted.current) setFullRecording({ original: result, full }); })
              .catch((e: unknown) => { if (mounted.current) setPlotError(e instanceof Error ? e.message : String(e)); })
              .finally(() => { if (mounted.current) setExportBusy(null); });
          }}>{exportBusy === 'plots' ? 'Re-flying…' : 'Load all plot series'}</button>}
        <span className="chart-comparison-note">Choose from this branch's recorded series.{onFullSeries ? ' Load all plot series re-flies the shown flight for additional quantities.' : ''}</span>
        {plotError && <Note as="p" tier="information" role="alert">Plot series could not be loaded: {plotError}</Note>}
      </div>}
      <div className="flight-event-picker" role="group" aria-label="Plot flight events">
        <span className="chart-comparison-note">Events on time charts:</span>
        {PLOT_EVENTS.map(([type, title]) => <button key={type} className="series-chip"
          aria-label={`Show event: ${title}`} aria-pressed={selectedEvents.includes(type)} onClick={() => {
            setSelectedEvents(prev => prev.includes(type) ? prev.filter(e => e !== type) : [...prev, type]);
          }}>{selectedEvents.includes(type) ? '✓ ' : ''}{title}</button>)}
      </div>
      {legend.length > 0 && <div className="flight-series-legend" role="group" aria-label="Emphasize plotted series">
        <span className="chart-comparison-note">Emphasize: hover, focus or tap. Tap again or press Escape to clear.</span>
        {legend.map((d) => <button key={String(d.key)} className={`series-chip ${emphasis === d.key ? 'series-emphasized' : ''}`}
          aria-label={`Emphasize ${d.title}`} aria-pressed={pinned === d.key}
          onMouseEnter={() => setHovered(d.key)} onMouseLeave={() => setHovered(null)}
          onFocus={() => { setHovered(null); setFocused(d.key); }} onBlur={() => setFocused(null)}
          onClick={() => { setHovered(null); setFocused(null); setPinned(pinned === d.key ? null : d.key); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { setHovered(null); setFocused(null); setPinned(null); } }}>
          <span className="series-dot" style={{ background: d.color }} />{d.title}
          <span className="series-emphasis-mark" aria-hidden="true" style={{ visibility: emphasis === d.key ? 'visible' : 'hidden' }}>✓</span>
        </button>)}
      </div>}
      {onFullSeries && <p className="chart-comparison-note">{exportLayout
        ? `Downloads use layout “${exportLayout.name}” for all flight branches. Missing series stay blank; a missing selected event leaves that branch without samples.`
        : 'Downloads include every recorded series and all flight branches.'} The comparison choice and zoom do not change the files.</p>}
      <SavedFlightPlots current={{ panels: [...selected].map(String), comparison, custom, events: selectedEvents }} onApply={layout => {
        setSelected(new Set(layout.panels)); setComparison(layout.comparison); setCustom(layout.custom ?? { x: 'time', y: 'altitude' });
        setSelectedEvents(layout.events ?? DEFAULT_PLOT_EVENTS);
      }} />
      {selected.has('stabilityPercent') && <Note as="p" tier="information" className="chart-comparison-note">
        Stability percentage uses the aerodynamic length of the stages flying at each recorded sample.
        It is not shown where CP, CG or that length is missing, or after recovery deployment or tumbling.
        The flight CP depends on speed and angle of attack, so it can differ from the static design value.
      </Note>}
      {(visible.length > 0 || preset?.x === 'time') && (
        <div className="chart-toolbar">
          <GestureHints />
          <button className="chart-btn" disabled={!zoomed}
            onClick={() => {
              resetPlots(plotsRef.current); setZoomed(false); setZoomPct(100);
            }}
            title="Show the whole flight again (same as double-clicking a chart)">
            Reset time charts
          </button>
          {/*
            How far in the wheel has gone. 100% is the whole flight. Deliberately
            NOT aria-live: it changes on every wheel event, which would make a
            screen reader announce dozens of times per gesture; the reset button
            beside it is the accessible way back.
          */}
          <span className="chart-zoom-pct" title="Zoom depth — 100% is the whole flight">
            {zoomPct < 1000 ? zoomPct.toFixed(0) : Math.round(zoomPct / 100) * 100}%
          </span>
        </div>
      )}
      {preset && <ComparisonChart key={`${panelKey}-${preset.id}-${preset.x}-${preset.left.join(',')}`} series={shown.series} preset={preset}
        emphasis={emphasis}
        flightName={plotIdentity} catalog={plotCatalog} plots={plotsRef.current}
        events={shown.events} selectedEvents={selectedEvents}
        onZoomChange={(z, pct) => { setZoomed(z); setZoomPct(pct); }}
        csvNote={onFullSeries && !staleReason ? exportLayout ? 'Choose Full export for every timestep in the Flight data (.csv) download.'
          : 'The Flight data (.csv) download above holds every timestep.' : undefined} />}
      <div className="charts-grid">
        {visible.map((d) => (
          <Panel key={`${panelKey}-${String(d.key)}`} result={shown} def={d} flightName={plotIdentity} plots={plotsRef.current}
            selectedEvents={selectedEvents}
            emphasis={emphasis}
            csvNote={onFullSeries && !staleReason
              ? exportLayout ? 'Choose Full export for every timestep in the Flight data (.csv) download.'
                : 'The Flight data (.csv) download above holds every timestep.' : undefined}
            expanded={expandedKeys.has(d.key)} onToggleExpand={() => toggleExpand(d.key)}
            onZoomChange={(z, pct) => { setZoomed(z); setZoomPct(pct); }} />
        ))}
      </div>
      {selected.size === 0 && (
        <div className="panel placeholder">Select at least one series to plot.</div>
      )}
    </div>
  );
}
