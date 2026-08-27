import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { DragSweep, OrkRocket } from '@online-openrocket/engine';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi, siToUi, uiToSi } from '../prefs/units.js';
import { UnitChip } from './UnitChip.js';
import { chartInk, seriesPalette } from '../chartTheme.js';
import { panelHeight, panZoomPlugin, plotIsZoomed, resetPlots } from '../chartPanZoom.js';
import { formatReadout, tooltipPlugin } from '../chartTooltip.js';
import { downloadBlob, stampedName } from '../services/fileName.js';
import { GestureHints } from './FlightCharts.js';
import { APP_VERSION } from '../version.js';

/**
 * Drag analysis (RASAero-style Aero Plots): CD vs Mach with power-off/power-on
 * curves and a per-component (or per-drag-type) breakdown. A STATIC design
 * property — computed straight from the geometry, no flight needed. Collapsed by
 * default; the sweep is only computed while the panel is open (it runs ~3 aero
 * solves per Mach step).
 *
 * Honesty note surfaced in the UI: the kernel is Extended Barrowman — accurate
 * subsonic/transonic, approximate above ~Mach 1.5-2 (full supersonic fidelity
 * is the later supersonic-aero feature).
 */

// Validated categorical palette (same slots as FlightCharts) — swapped for the
// high-contrast set in daylight mode. See chartTheme.ts.

interface Line {
  label: string;
  color: string;
  values: number[];
  /** dashed stroke (for the power-on overlay) */
  dash?: boolean;
}

/** A single multi-series uPlot line chart (all series share the CD y-scale). */
function LineChart({ x, lines, xLabel, yLabel, height = 190, lockLegend = false, expanded = false, plotRef, onZoomChange }: {
  x: number[];
  lines: Line[];
  xLabel: string;
  /** y-axis label (uPlot renders it in the axis gutter). */
  yLabel?: string;
  height?: number;
  /**
   * Disables the legend's click-to-hide series toggle (the live value readout
   * stays). On a single-series chart that toggle is a trap — one click blanks
   * the chart's only line (a tester's "broken percent of body length button").
   */
  lockLegend?: boolean;
  /** ⤢ state from the heading buttons: a much taller canvas (panelHeight). */
  expanded?: boolean;
  /** Receives the live uPlot instance — the heading's ↺ Reset button target. */
  plotRef?: { current: uPlot | null };
  /** Reports whether the chart is zoomed in (drives ↺'s disabled state). */
  onZoomChange?: (zoomed: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { resolvedTheme, daylight } = usePrefs();
  // Read through a ref in the plugin closure so a new callback identity per
  // parent render can't force a plot recreate (kept out of the deps below).
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ink = chartInk(el);

    const data: uPlot.AlignedData = [x, ...lines.map((l) => l.values)];
    const chartH = () => (expanded ? panelHeight(el.clientWidth || 640, true) : height);
    const opts: uPlot.Options = {
      width: el.clientWidth || 640,
      height: chartH(),
      // Legend labels bind their toggle through cursor.bind.click (the only
      // "click" uPlot binds) — returning null unbinds it without touching
      // the legend's live readout, which rides mousemove.
      cursor: { points: { size: 6 }, ...(lockLegend ? { bind: { click: () => null } } : {}) },
      scales: { x: { time: false } },
      legend: { live: true },
      plugins: [panZoomPlugin(undefined, (u) => onZoomChangeRef.current?.(plotIsZoomed(u))), tooltipPlugin()],
      series: [
        { label: xLabel, value: (_u, v) => formatReadout(v) },
        ...lines.map((l): uPlot.Series => ({
          label: l.label,
          stroke: l.color,
          width: ink.strokeWidth,
          ...(l.dash ? { dash: [6, 4] } : {}),
          value: (_u, v) => formatReadout(v),
        })),
      ],
      axes: [
        { stroke: ink.axis, grid: { stroke: ink.grid, width: 1 }, ticks: { stroke: ink.tick, width: 1 }, font: ink.font },
        { stroke: ink.axis, grid: { stroke: ink.grid, width: 1 }, ticks: { stroke: ink.tick, width: 1 }, font: ink.font, size: 48, ...(yLabel ? { label: yLabel } : {}) },
      ],
    };
    const plot = new uPlot(opts, data, el);
    if (plotRef) plotRef.current = plot;
    const obs = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: chartH() }));
    obs.observe(el);
    return () => {
      obs.disconnect();
      if (plotRef) plotRef.current = null;
      plot.destroy();
    };
  }, [x, lines, xLabel, yLabel, height, lockLegend, resolvedTheme, daylight, expanded, plotRef]);

  return <div ref={ref} className={lockLegend ? 'chart-legend-locked' : undefined} />;
}

/**
 * The ↺ Reset / ⤢ Expand pair that rides in each drag-chart heading row —
 * the headings already exist, so discoverability costs no vertical space.
 * These charts are independent (no sync group), so each pair acts on its
 * own chart only.
 */
function ChartHeadButtons({ zoomed, expanded, plot, onToggleExpand }: {
  zoomed: boolean;
  expanded: boolean;
  plot: { current: uPlot | null };
  onToggleExpand: () => void;
}) {
  return (
    <span className="chart-head-btns">
      <button className="chart-btn" disabled={!zoomed}
        onClick={() => { if (plot.current) resetPlots([plot.current]); }}
        title="Show the full Mach range again (same as double-clicking the chart)"
        aria-label="Reset chart view">↺</button>
      <button className="chart-btn" onClick={onToggleExpand} aria-pressed={expanded}
        title={expanded ? 'Restore chart size' : 'Expand chart (taller)'}
        aria-label={expanded ? 'Restore chart size' : 'Expand chart'}>
        {expanded ? '⤡' : '⤢'}
      </button>
    </span>
  );
}

/**
 * Which atmosphere the sweep runs in.
 *
 * - `sealevel` — send NO `machAlt`, so the kernel uses `FlightConditions`'
 *   own default atmosphere (101325 Pa at 293.15 K). This is the historical
 *   behaviour and stays bit-identical to it: measured max |ΔCD| = 0 across a
 *   60-point sweep between `dragSweep({machMax})` and
 *   `dragSweep({machMax, machAlt: undefined})`.
 * - `altitude` — one ISA altitude for every Mach point.
 * - `file` — the design's own Mach-Alt table (a .CDX1 `<MachAlt>` import).
 *
 * NOTE the small discontinuity this implies, and why "sea level" is not the
 * same row as "altitude 0": ISA sea level is 288.15 K, the kernel default is
 * 293.15 K, and that 5 K is worth up to 0.0017 in CD (measured on the ARCAS
 * fixture, biggest subsonic). Entering 0 therefore falls back to the default
 * rather than manufacturing a second, almost-identical curve.
 */
type Conditions = 'sealevel' | 'altitude' | 'file';

/** `[mach, altitude m]` pairs — the shape `DragSweepOptions.machAlt` takes. */
type MachAlt = [number, number][];

/**
 * One comma-free sentence naming the atmosphere a curve was computed in.
 * Printed under the CD chart AND into the CSV metadata header, from the same
 * function so the two can never disagree — the failure that put a mislabeled
 * curve on The Rocketry Forum was exactly a chart and a file disagreeing about
 * what produced them. Commas are avoided for the same reason the design-name
 * line avoids them (naive CSV parsers read them as cells).
 */
function conditionsText(mode: Conditions, altM: number, table: MachAlt | undefined, distUnit: string): string {
  // fmtSi's precision ladder gives sub-1 values three decimals, so a sea-level
  // row would print as "0.000". Zero is just zero.
  const fmtAlt = (v: number) => (v === 0 ? '0' : fmtSi('distance', distUnit, v));
  if (mode === 'file' && table && table.length > 0) {
    const machs = table.map(([m]) => m);
    const alts = table.map(([, a]) => a);
    return `file Mach-Alt table — ${table.length} points from Mach ${Math.min(...machs)} to ${Math.max(...machs)}`
      + ` (${fmtAlt(Math.min(...alts))}–${fmtAlt(Math.max(...alts))} ${distUnit} ISA)`;
  }
  if (mode === 'altitude' && altM > 0) {
    return `ISA at ${fmtAlt(altM)} ${distUnit}`;
  }
  return 'sea level (101325 Pa; 20 °C — the kernel default)';
}

function exportCsv(sweep: DragSweep, meta: { design: string; aeroModel: string; lengthUnit: string; conditions: string }) {
  // RASAero feature #6: the full aerodynamic-coefficient table (CD both power
  // states + CP + CNa vs Mach) — usable as input to external trajectory codes.
  // The leading #-comment lines say which app, design and aero model produced
  // the table: a bare drag-analysis.csv travels (one was posted to a forum as
  // the Supersonic model's curve when it was the classic model's).
  const cols: [string, number[]][] = [
    ['mach', sweep.machs],
    ['cd_power_off', sweep.powerOff.total],
    ['cd_power_on', sweep.powerOn.total],
    [`cp_${meta.lengthUnit}_from_nose`,
      sweep.cp.map((v) => (v == null ? v : siToUi('length', meta.lengthUnit, v)))],
    ['cna_per_rad', sweep.cna],
    ['friction', sweep.powerOff.friction],
    ['pressure', sweep.powerOff.pressure],
    ['base_power_off', sweep.powerOff.base],
    ['base_power_on', sweep.powerOn.base],
    ...sweep.components.map((c): [string, number[]] => [`cd_${c.name.replace(/[,\s]+/g, '_')}`, c.cd]),
  ];
  // The design name is user text: a newline would break the four-line comment
  // block and a comma would read as extra CSV cells in naive parsers — flatten
  // both (same reason the conditions line avoids its own comma).
  const design = meta.design.replace(/[\r\n]+/g, ' ').replace(/,/g, ';');
  const rows = [
    `# MMRocket Sim ${APP_VERSION}`,
    `# design: ${design}`,
    `# aero model: ${meta.aeroModel}`,
    `# conditions: ${meta.conditions.replace(/[\r\n]+/g, ' ').replace(/,/g, ';')}`,
    cols.map(([h]) => h).join(','),
  ];
  for (let i = 0; i < sweep.machs.length; i++) {
    rows.push(cols.map(([, v]) => (v[i] == null ? '' : v[i])).join(','));
  }
  downloadBlob(new Blob([rows.join('\n')], { type: 'text/csv' }),
    stampedName(meta.design, 'drag-table', 'csv'));
}

type BreakdownMode = 'component' | 'type';
type CpView = 'pct' | 'unit';
type DragChartId = 'cd' | 'cp' | 'breakdown';

export function DragPanel({ rocket, supersonicModel, aeroLabel, designName, fileMachAlt }: {
  rocket: OrkRocket;
  /** Whether the opt-in supersonic aero model is active. */
  supersonicModel?: boolean;
  /**
   * The FULL model label for the CSV metadata header. Passed in rather than
   * reassembled here: the panel is handed only the supersonic half, and read
   * the Kbf half straight from prefs — which stopped being the same thing once
   * the vitals strip could override the model for a session, so an 'eb' sweep
   * would have exported a header claiming "+ Rogers Kbf".
   */
  aeroLabel?: string;
  /** Design name for the CSV metadata header (tree.name at the call site). */
  designName?: string;
  /**
   * The design's own Mach-Alt conditions table, when it came from a RASAero
   * .CDX1 that carries one (`importCdx1(...).machAlt`). Its only effect is to
   * OFFER a third Conditions choice — nothing is applied until the user picks
   * it, so a file with a table still sweeps at sea level until asked.
   */
  fileMachAlt?: MachAlt;
}) {
  const [open, setOpen] = useState(false);
  const [machMax, setMachMax] = useState(3);
  const [conditions, setConditions] = useState<Conditions>('sealevel');
  // The sweep altitude is stored in SI; the typed TEXT is kept beside it so
  // clearing the box (or typing "1e") doesn't snap the display back to 0.
  const [altM, setAltM] = useState(0);
  const [altText, setAltText] = useState('');
  const [mode, setMode] = useState<BreakdownMode>('component');
  const [cpView, setCpView] = useState<CpView>('pct');
  // ⤢-expanded charts and which are zoomed in (per-chart: these three don't
  // share an x window, unlike the flight group). Session-only, not persisted.
  const [bigCharts, setBigCharts] = useState<Set<DragChartId>>(new Set());
  const [zoomedCharts, setZoomedCharts] = useState<Set<DragChartId>>(new Set());
  const cdPlot = useRef<uPlot | null>(null);
  const cpPlot = useRef<uPlot | null>(null);
  const bdPlot = useRef<uPlot | null>(null);
  const toggleBig = (id: DragChartId) => {
    setBigCharts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const noteZoom = (id: DragChartId) => (zoomed: boolean) => {
    setZoomedCharts((prev) => {
      if (prev.has(id) === zoomed) return prev;
      const next = new Set(prev);
      if (zoomed) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const { prefs, daylight } = usePrefs();
  const C = seriesPalette(daylight);
  const lenUnit = prefs.units.length;
  const distUnit = prefs.units.distance;

  // High-Mach ranges only make sense with the supersonic model on.
  useEffect(() => {
    if (!supersonicModel && machMax > 5) setMachMax(5);
  }, [supersonicModel, machMax]);

  // Loading a design without a table must not leave the panel claiming to be
  // sweeping at one.
  useEffect(() => {
    if (conditions === 'file' && !(fileMachAlt && fileMachAlt.length > 0)) setConditions('sealevel');
  }, [conditions, fileMachAlt]);

  // Keep the typed altitude at the same PHYSICAL altitude when the distance
  // unit preference changes (10000 ft becomes 3048 m, not 10000 m). altM is the
  // stored SI value, so it is exactly what survives the unit switch; the text
  // is only the draft the user is editing.
  const prevDistUnit = useRef(distUnit);
  useEffect(() => {
    if (prevDistUnit.current === distUnit) return;
    prevDistUnit.current = distUnit;
    setAltText(altM > 0 ? fmtSi('distance', distUnit, altM, 3) : '');
  }, [distUnit, altM]);
  const commitAlt = (s: string) => {
    setAltText(s);
    const v = Number(s.trim());
    setAltM(s.trim() !== '' && Number.isFinite(v) && v > 0 ? uiToSi('distance', distUnit, v) : 0);
  };

  /**
   * The conditions table handed to the kernel. `undefined` — never `[]` — for
   * the default, because an empty array would still be a table: the engine
   * treats a present, non-empty machAlt as "pin the ISA atmosphere" and
   * anything else as "leave FlightConditions alone".
   */
  // Keyed on the table's CONTENT, not the prop's identity: a call site that
  // rebuilds the array each render would otherwise invalidate the memo below
  // every time and re-run a sweep that costs ~150 ms at Mach 25.
  const fileKey = fileMachAlt && fileMachAlt.length > 0 ? JSON.stringify(fileMachAlt) : '';
  const machAlt = useMemo<MachAlt | undefined>(() => {
    if (conditions === 'file') return fileKey ? JSON.parse(fileKey) as MachAlt : undefined;
    // Two rows at the same altitude = a constant atmosphere at every Mach the
    // sweep can reach (the engine interpolates between rows and clamps
    // outside them, so the ceiling only has to exceed machMax).
    if (conditions === 'altitude' && altM > 0) return [[0, altM], [100, altM]];
    return undefined;
  }, [conditions, fileKey, altM]);

  // Only pay the sweep cost while the panel is open. Recomputes when the design
  // (rocket handle), the range or the conditions change.
  const sweep = useMemo<DragSweep | { error: string } | null>(() => {
    if (!open) return null;
    try {
      // Default conditions pass the options object they always did — no
      // machAlt key at all, so the kernel path is byte-for-byte the old one.
      return rocket.dragSweep(machAlt ? { machMax, machAlt } : { machMax });
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [open, rocket, machMax, machAlt]);

  const condText = conditionsText(conditions, altM, fileMachAlt, distUnit);

  // CP as % of body length (the wind-tunnel convention for CP-vs-Mach plots,
  // so it's the default) or in the user's length unit from the nose — the
  // view toggle beside the chart heading switches.
  const cpLines = useMemo<Line[]>(() => {
    if (!sweep || 'error' in sweep) return [];
    let length = 0;
    try {
      length = rocket.staticInfo().length;
    } catch {
      return [];
    }
    if (length <= 0) return [];
    return [{
      label: 'CP',
      color: C[3]!,
      values: cpView === 'pct'
        ? sweep.cp.map((v) => (v / length) * 100)
        : sweep.cp.map((v) => siToUi('length', lenUnit, v)),
    }];
  }, [sweep, rocket, C, cpView, lenUnit]);

  const totalLines = useMemo<Line[]>(() => {
    if (!sweep || 'error' in sweep) return [];
    const lines: Line[] = [{ label: 'CD power-off', color: C[0]!, values: sweep.powerOff.total }];
    if (sweep.hasNozzle) {
      lines.push({ label: 'CD power-on', color: C[5]!, values: sweep.powerOn.total, dash: true });
    }
    return lines;
  }, [sweep, C]);

  const breakdownLines = useMemo<Line[]>(() => {
    if (!sweep || 'error' in sweep) return [];
    if (mode === 'type') {
      return [
        { label: 'Friction', color: C[1]!, values: sweep.powerOff.friction },
        { label: 'Pressure / wave', color: C[2]!, values: sweep.powerOff.pressure },
        { label: 'Base', color: C[4]!, values: sweep.powerOff.base },
      ];
    }
    return sweep.components.map((c, i) => ({ label: c.name, color: C[i % C.length]!, values: c.cd }));
  }, [sweep, mode, C]);

  return (
    <div className={open ? 'panel' : 'panel panel-dormant'}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <h2 style={{ flex: 1 }}>Drag analysis</h2>
        <button className="file-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Show CD vs Mach'}
        </button>
      </div>

      {open && (!sweep ? null : 'error' in sweep ? (
        <p className="stability-bad">{sweep.error}</p>
      ) : (
        <>
          <div className="series-picker" role="group" aria-label="Drag analysis controls">
            <label className="motor-inline-label" style={{ whiteSpace: 'nowrap' }}>
              Max Mach
              <select value={machMax} onChange={(e) => setMachMax(Number(e.target.value))} style={{ marginLeft: 4 }}>
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
                <option value={5}>5</option>
                {supersonicModel && <option value={10}>10</option>}
                {supersonicModel && <option value={25}>25</option>}
              </select>
            </label>
            <label className="motor-inline-label" style={{ whiteSpace: 'nowrap' }}>
              Conditions
              <select value={conditions} aria-label="Sweep conditions"
                title="The air the sweep runs in. Sea level is the default; matching a wind tunnel or a published curve means running at the altitude it was taken at."
                onChange={(e) => setConditions(e.target.value as Conditions)} style={{ marginLeft: 4 }}>
                <option value="sealevel">Sea level</option>
                <option value="altitude">At altitude…</option>
                {fileMachAlt && fileMachAlt.length > 0 && (
                  <option value="file">File Mach-Alt table ({fileMachAlt.length} pts)</option>
                )}
              </select>
            </label>
            {/* A <span>, not a <label>: two controls live in the altitude group
                (the unit chip and the box), and a label wrapping both would
                name the wrong one. Each carries its own aria-label instead. */}
            {conditions === 'altitude' && (
              <span className="motor-inline-label" style={{ whiteSpace: 'nowrap' }}>
                Altitude <UnitChip quantity="distance" />
                <input type="text" inputMode="decimal" value={altText}
                  aria-label={`Sweep altitude (${distUnit})`}
                  placeholder="0"
                  style={{ width: 76, marginLeft: 4 }}
                  onChange={(e) => commitAlt(e.target.value)} />
              </span>
            )}
            <span style={{ flex: 1 }} />
            <span className="download-caption">Drag vs Mach for this design:</span>
            <button className="file-btn" title="The full aerodynamic-coefficient table (CD power-off/on, CP, CNα) against Mach number — a static property of the geometry, NOT a time series. Opens with comment lines naming the design, the aero model and the conditions it ran in." onClick={() => exportCsv(sweep, {
              design: designName || 'Rocket',
              // Same wording as the launch report's "Aero model" row — the
              // model the sweep actually ran on, not a fixed string.
              aeroModel: aeroLabel ?? (supersonicModel
                ? 'Supersonic (our extended model)'
                : `Classic (Extended Barrowman${(prefs.rogersKbf ?? true) ? ' + Rogers Kbf' : ''})`),
              lengthUnit: lenUnit,
              // The SAME string the chart caption prints, so an exported table
              // and a screenshot of the chart can't claim different air.
              conditions: condText,
            })}>⬇ Drag table (.csv)</button>
          </div>

          <div className="chart-toolbar">
            <GestureHints />
          </div>

          <div className="chart-panel">
            <div className="chart-panel-head">
              <h3>Drag coefficient vs Mach</h3>
              <ChartHeadButtons zoomed={zoomedCharts.has('cd')} expanded={bigCharts.has('cd')}
                plot={cdPlot} onToggleExpand={() => toggleBig('cd')} />
            </div>
            <LineChart x={sweep.machs} lines={totalLines} xLabel="Mach" yLabel="CD"
              expanded={bigCharts.has('cd')} plotRef={cdPlot} onZoomChange={noteZoom('cd')} />
            {/* The caption rides INSIDE the chart panel so a screenshot of the
                chart carries its conditions with it — the same reason the CSV
                stamps them. It applies to all three charts. */}
            <p className="motor-db-meta" style={{ marginTop: 4 }}>
              <strong>Conditions:</strong> {condText}
              {machAlt
                ? ' — Reynolds number is matched to that air at every Mach point.'
                : '.'}
              {conditions === 'sealevel' && fileMachAlt && fileMachAlt.length > 0 && (
                <> This design came from a RASAero file with its own <strong>Mach-Alt table</strong>;
                  pick it above to compare against a curve computed at those altitudes.</>
              )}
            </p>
            {!sweep.hasNozzle && (
              <p className="motor-db-meta" style={{ marginTop: 4 }}>
                Set a stage <strong>nozzle exit diameter</strong> to see a distinct power-on curve
                (motor exhaust lowers base drag during boost).
              </p>
            )}
          </div>

          {cpLines.length > 0 && (
            <div className="chart-panel">
              <div className="chart-panel-head">
                <h3>
                  Center of pressure vs Mach ({cpView === 'pct' ? '% of length' : `${lenUnit} from nose`})
                </h3>
                <div className="view-toggle" role="tablist">
                  <button className={cpView === 'pct' ? 'active' : ''} role="tab"
                    aria-selected={cpView === 'pct'} onClick={() => setCpView('pct')}>% of length</button>
                  <button className={cpView === 'unit' ? 'active' : ''} role="tab"
                    aria-selected={cpView === 'unit'} onClick={() => setCpView('unit')}>{lenUnit} from nose</button>
                </div>
                <ChartHeadButtons zoomed={zoomedCharts.has('cp')} expanded={bigCharts.has('cp')}
                  plot={cpPlot} onToggleExpand={() => toggleBig('cp')} />
              </div>
              <LineChart x={sweep.machs} lines={cpLines} xLabel="Mach" height={160}
                yLabel={cpView === 'pct' ? '% of length' : `${lenUnit} from nose`} lockLegend
                expanded={bigCharts.has('cp')} plotRef={cpPlot} onZoomChange={noteZoom('cp')} />
              {supersonicModel ? (
                <p className="motor-db-meta" style={{ marginTop: 4 }}>
                  Supersonic CP travel is the stability hazard on fast flights — check your
                  margin at max Mach, not just at rest. High-performance practice: keep ≥ 2
                  calibers through the transonic and supersonic regime.
                </p>
              ) : (
                <p className="motor-db-meta" style={{ marginTop: 4 }}>
                  The Barrowman models freeze body CP above Mach 1 — pick
                  <strong> Auto</strong> or <strong>Supersonic</strong> in the
                  <strong> Aero</strong> selector (vitals strip, or Preferences →
                  Aerodynamics) for wind-tunnel-validated CP travel.
                </p>
              )}
            </div>
          )}

          <div className="chart-panel">
            <div className="chart-panel-head">
              <h3>Breakdown (power-off)</h3>
              <div className="view-toggle" role="tablist">
                <button className={mode === 'component' ? 'active' : ''} role="tab"
                  aria-selected={mode === 'component'} onClick={() => setMode('component')}>By component</button>
                <button className={mode === 'type' ? 'active' : ''} role="tab"
                  aria-selected={mode === 'type'} onClick={() => setMode('type')}>By type</button>
              </div>
              <ChartHeadButtons zoomed={zoomedCharts.has('breakdown')} expanded={bigCharts.has('breakdown')}
                plot={bdPlot} onToggleExpand={() => toggleBig('breakdown')} />
            </div>
            <LineChart x={sweep.machs} lines={breakdownLines} xLabel="Mach" yLabel="CD"
              expanded={bigCharts.has('breakdown')} plotRef={bdPlot} onZoomChange={noteZoom('breakdown')} />
          </div>

          {machMax > 1.5 && (supersonicModel ? (
            <p className="motor-db-meta" style={{ marginTop: 2 }}>
              Supersonic aero model active — CP and drag validated against NASA wind-tunnel
              data (ARCAS, Basic Finner) to ~Mach&nbsp;4.6 and physical to Mach&nbsp;25
              (above ~Mach&nbsp;10 treat as extrapolation). Transonic peak values
              (M0.95–1.2) run conservative-low against tunnel data.
            </p>
          ) : (
            <p className="motor-db-meta" style={{ marginTop: 2 }}>
              Above ~Mach&nbsp;1.5 these are classic Extended-Barrowman estimates
              (approximate). Pick <strong>Supersonic</strong> in the <strong>Aero</strong>
              selector (vitals strip, or Preferences&nbsp;→&nbsp;Aerodynamics) for the
              validated supersonic model.
            </p>
          ))}
        </>
      ))}
    </div>
  );
}
