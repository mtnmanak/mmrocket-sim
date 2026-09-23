import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { DragSweep, OrkRocket, StaticInfo } from '@online-openrocket/engine';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi, niceStep, siToUi, uiToSi } from '../prefs/units.js';
import { NumField } from './NumField.js';
import { UnitChip } from './UnitChip.js';
import { chartInk, seriesPalette, seriesStyle } from '../chartTheme.js';
import { panelHeight, panZoomPlugin, plotIsZoomed, resetPlots } from '../chartPanZoom.js';
import { formatReadout, tooltipPlugin } from '../chartTooltip.js';
import { chartSummary, nameChartCanvas } from '../chartSummary.js';
import { downloadBlob, stampedName } from '../services/fileName.js';
import { hasAerodynamicForce, shownCp } from '../services/simReport.js';
import { dragTableCsv, sweepCp, type DragTableMeta } from '../services/dragTable.js';
import { GestureHints } from './FlightCharts.js';

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
  /** `null` is a gap — uPlot draws no line through it (a CP with no lift). */
  values: (number | null)[];
  /**
   * Dashed stroke — `true` for the power-on overlay's classic [6,4]; a
   * pattern array for the 9th+ breakdown component, whose reused hue carries
   * the dash as its secondary encoding (see chartTheme.seriesStyle).
   */
  dash?: boolean | number[];
}

/** Said at the end of every drag chart's canvas name — the button is above them. */
const DRAG_CSV_NOTE = 'The Drag table (.csv) download above holds the same numbers.';

/** A single multi-series uPlot line chart (all series share the CD y-scale). */
function LineChart({ x, lines, title, xLabel, yLabel, height = 190, lockLegend = false, expanded = false, plotRef, onZoomChange }: {
  x: number[];
  lines: Line[];
  /**
   * What the chart plots, as its heading says it — the start of the canvas's
   * spoken summary (audit 2026-09-22: the canvases were unnamed, so a screen
   * reader got the heading and the legend and never the curve).
   */
  title: string;
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
  const summary = useMemo(() => chartSummary({
    title, x, at: (m) => `Mach ${formatReadout(m, 3)}`, series: lines, source: DRAG_CSV_NOTE,
  }), [title, x, lines]);

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
          ...(l.dash ? { dash: Array.isArray(l.dash) ? l.dash : [6, 4] } : {}),
          value: (_u, v) => formatReadout(v),
        })),
      ],
      axes: [
        { stroke: ink.axis, grid: { stroke: ink.grid, width: 1 }, ticks: { stroke: ink.tick, width: 1 }, font: ink.font },
        { stroke: ink.axis, grid: { stroke: ink.grid, width: 1 }, ticks: { stroke: ink.tick, width: 1 }, font: ink.font, size: 48, ...(yLabel ? { label: yLabel } : {}) },
      ],
    };
    const plot = new uPlot(opts, data, el);
    nameChartCanvas(el, summary);
    if (plotRef) plotRef.current = plot;
    const obs = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: chartH() }));
    obs.observe(el);
    return () => {
      obs.disconnect();
      if (plotRef) plotRef.current = null;
      plot.destroy();
    };
  }, [x, lines, xLabel, yLabel, height, lockLegend, resolvedTheme, daylight, expanded, plotRef, summary]);

  return <div ref={ref} className={lockLegend ? 'chart-legend-locked' : undefined} />;
}

/**
 * The ↺ Reset / ⤢ Expand pair that rides in each drag-chart heading row —
 * the headings already exist, so discoverability costs no vertical space.
 * These charts are independent (no sync group), so each pair acts on its
 * own chart only — and so each pair is NAMED for its chart (audit
 * 2026-09-22): all three said "Reset chart view" and "Expand chart", six
 * buttons with two names.
 */
function ChartHeadButtons({ chart, zoomed, expanded, plot, onToggleExpand }: {
  /** The chart in words, lower case: "drag coefficient". */
  chart: string;
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
        aria-label={`Reset the ${chart} chart view`}>↺</button>
      <button className="chart-btn" onClick={onToggleExpand} aria-pressed={expanded}
        title={expanded ? 'Restore chart size' : 'Expand chart (taller)'}
        aria-label={expanded ? `Restore the ${chart} chart size` : `Expand the ${chart} chart`}>
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
 * line avoids them (naive CSV parsers read them as cells). The CSV's copy has
 * its typography folded to ASCII (services/dragTable.ts) — the same words, "20 degC" for
 * "20 °C" — so the file opens clean in Excel.
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

/**
 * The forward CP the rest of the app flies on (simReport.shownCp), when this
 * design's CP depends on its roll angle — null when it does not.
 *
 * `dragSweep` measures CP in ONE roll plane, the fins as drawn; the tiles, the
 * views and every margin use the forward-most CP over all roll angles. With
 * three or more fins the two are one number. With fewer, or a part off the
 * axis, they are not, and the curve moves with a cosmetic clocking: measured
 * on the real kernel, a 70 mm ogive on a 300 mm x 24 mm tube with two fins
 * charts 8.7 % of length with the fins at 0 degrees and 81.4 % at 90, while the
 * app shows 8.7 % for both (audit 2026-09-22). The engine has no swept CP per
 * Mach to plot instead, so the chart and the file say which plane they are.
 * The 1e-9 is StatTiles' own "the plane differs" test.
 */
function rollDependentCp(info: StaticInfo): number | null {
  const worst = info.cpWorst;
  return worst !== undefined && Math.abs(worst - info.cp) > 1e-9 ? shownCp(info) : null;
}

/** Downloads the Drag table (.csv): the text is services/dragTable.ts's. */
function exportCsv(sweep: DragSweep, meta: DragTableMeta) {
  downloadBlob(new Blob([dragTableCsv(sweep, meta)], { type: 'text/csv' }),
    stampedName(meta.design, 'drag-table', 'csv'));
}

type BreakdownMode = 'component' | 'type';
type CpView = 'pct' | 'unit';
type DragChartId = 'cd' | 'cp' | 'breakdown';

/** The highest Max Mach the Barrowman models are offered (the menu stops here). */
const CLASSIC_MACH_MAX = 5;

/**
 * The sweep-altitude box. What is TYPED is held until the box lets go of focus
 * (blur, or Enter — NumField blurs itself on Enter), and only then handed on
 * to become the sweep's altitude (audit 2026-09-22, Performance).
 *
 * NumField commits every draft that parses, and each altitude is a new
 * atmosphere, so each keystroke re-ran the whole sweep synchronously in
 * render: typing "10000" at Mach 25 swept five times — 1.3-1.6 s of a frozen
 * page on LEM-IV with the real kernel, 210-390 ms a keystroke, four of them
 * for altitudes nobody asked about (1, 10, 100, 1000 ft). Now the keystrokes
 * cost ~1 ms each and the one sweep runs when the box is left.
 *
 * A spinner click is not typing: ▴/▾ never focus the box, so there is no blur
 * to wait for, and a click that finds the box unfocused sweeps at once. Held
 * state lives HERE, not in the panel, so a box that goes away while focused
 * takes its unfinished edit with it rather than leaving it to surface later.
 */
function SweepAltitudeBox({ altM, distUnit, onCommit }: {
  /** The altitude being swept (m); 0 is sea level. */
  altM: number;
  distUnit: string;
  onCommit: (altM: number) => void;
}) {
  const [held, setHeld] = useState<number | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  // Blank IS sea level: blank, 0 and anything below it sweep the default.
  const toSi = (v: number | null) => (v !== null && v > 0 ? uiToSi('distance', distUnit, v) : 0);
  return (
    // `inline-numfield` makes the input fill this 96 px wrapper (styles.css);
    // outside a `.field` nothing else sizes it. React's onBlur is focusout,
    // so it hears the input inside.
    <span ref={wrapRef} className="inline-numfield" style={{ width: 96 }}
      onBlur={() => {
        if (held === null) return;
        setHeld(null);
        onCommit(held);
      }}>
      <NumField
        ariaLabel={`Sweep altitude (${distUnit})`}
        value={altM > 0 ? siToUi('distance', distUnit, altM) : undefined}
        step={niceStep(siToUi('distance', distUnit, 100))}
        nullable
        // Blank IS sea level, so a spinner on the blank box steps
        // from 0 (NumField reads the base out of the placeholder).
        placeholder="0"
        onCommit={(v) => {
          if (wrapRef.current?.contains(document.activeElement)) setHeld(toSi(v));
          else onCommit(toSi(v));
        }}
      />
    </span>
  );
}

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
  // The sweep altitude, stored in SI so it is the same PHYSICAL altitude
  // whatever the distance unit (10000 ft becomes 3048 m, not 10000 m). The
  // box itself is a NumField, which keeps its own draft while typing.
  const [altM, setAltM] = useState(0);
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
  const { prefs, daylight, resolvedTheme } = usePrefs();
  const C = seriesPalette(daylight, resolvedTheme);
  const lenUnit = prefs.units.length;
  const distUnit = prefs.units.distance;

  // High-Mach ranges only make sense with the supersonic model on. The range
  // the sweep runs to is DERIVED, here in render (audit 2026-09-22). Clamped by
  // the effect alone it arrived one render late, and App rebuilds the rocket
  // when the model changes — so switching the supersonic model off at Mach 25
  // swept the new Barrowman handle all the way to Mach 25 first, then again to
  // 5 (LEM-IV, real kernel: 350-540 ms, against 160 for the one sweep to 5).
  // The effect stays, to bring the CHOICE down too, so switching the model
  // back on starts from 5 as it always has; by then the sweep is already the
  // right one and its memo does not re-run.
  const machTop = supersonicModel ? machMax : Math.min(machMax, CLASSIC_MACH_MAX);
  useEffect(() => {
    if (!supersonicModel && machMax > CLASSIC_MACH_MAX) setMachMax(CLASSIC_MACH_MAX);
  }, [supersonicModel, machMax]);

  // Loading a design without a table must not leave the panel claiming to be
  // sweeping at one.
  useEffect(() => {
    if (conditions === 'file' && !(fileMachAlt && fileMachAlt.length > 0)) setConditions('sealevel');
  }, [conditions, fileMachAlt]);

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
      return rocket.dragSweep(machAlt ? { machMax: machTop, machAlt } : { machMax: machTop });
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [open, rocket, machTop, machAlt]);

  const condText = conditionsText(conditions, altM, fileMachAlt, distUnit);

  // The design's static figures, read only while a sweep is showing: the CP
  // chart needs the length to scale by, and the roll note below needs the
  // single-plane and swept CPs.
  const info = useMemo<StaticInfo | null>(() => {
    if (!sweep || 'error' in sweep) return null;
    try {
      return rocket.staticInfo();
    } catch {
      return null;
    }
  }, [sweep, rocket]);
  const rollNote = info ? rollDependentCp(info) : null;

  // CP as % of body length (the wind-tunnel convention for CP-vs-Mach plots,
  // so it's the default) or in the user's length unit from the nose — the
  // view toggle beside the chart heading switches. Gaps where the sweep's
  // plane makes no lift (sweepCp).
  const cpLines = useMemo<Line[]>(() => {
    if (!sweep || 'error' in sweep || !info) return [];
    const length = info.length;
    if (length <= 0) return [];
    const cp = sweepCp(sweep);
    return [{
      label: 'CP',
      color: C[3]!,
      values: cpView === 'pct'
        ? cp.map((v) => (v == null ? null : (v / length) * 100))
        : cp.map((v) => (v == null ? null : siToUi('length', lenUnit, v))),
    }];
  }, [sweep, info, C, cpView, lenUnit]);
  const cpHasLift = cpLines.length > 0 && cpLines[0]!.values.some((v) => v != null);
  // With no CP to chart, WHICH sentence replaces it is decided by the force
  // itself, the tiles' own test (hasAerodynamicForce): "No lift yet" only for
  // a design with none at any roll angle, "this roll plane" for one with lift
  // only in others. (No figures at all — staticInfo threw, or no length — hides
  // the whole CP panel, since cpLines is then empty.)
  const cpNoLift = info != null && !hasAerodynamicForce(info);

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
    // Never a silent color cycle: past the palette a component's reused hue
    // carries a dash pattern (the two-Rail-Buttons-as-twins fix).
    return sweep.components.map((c, i) => {
      const s = seriesStyle(i, C);
      return { label: c.name, color: s.stroke, values: c.cd, ...(s.dash ? { dash: s.dash } : {}) };
    });
  }, [sweep, mode, C]);

  return (
    <div className={open ? 'panel' : 'panel panel-dormant'}>
      <div className="panel-head">
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
              <select value={machTop} onChange={(e) => setMachMax(Number(e.target.value))} style={{ marginLeft: 4 }}>
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
                {/* A NumField, not a bare input (audit 2026-09-22): the bare
                    box read "10,000" as NaN and silently swept at SEA LEVEL
                    while still showing 10,000 — only the caption under the
                    chart said so. A draft it cannot read is now marked
                    invalid and commits nothing, as in every other field.
                    What it does commit waits for the box to let go
                    (SweepAltitudeBox). */}
                <SweepAltitudeBox altM={altM} distUnit={distUnit} onCommit={setAltM} />
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
                : (prefs.rogersKbf ?? true) ? 'Rogers Modified Barrowman (Kbf)' : 'Classic Extended Barrowman'),
              lengthUnit: lenUnit,
              // The SAME string the chart caption prints, so an exported table
              // and a screenshot of the chart can't claim different air.
              conditions: condText,
              rollCp: rollNote,
            })}>⬇ Drag table (.csv)</button>
          </div>

          <div className="chart-toolbar">
            <GestureHints />
          </div>

          <div className="chart-panel">
            <div className="chart-panel-head">
              <h3>Drag coefficient vs Mach</h3>
              <ChartHeadButtons chart="drag coefficient" zoomed={zoomedCharts.has('cd')} expanded={bigCharts.has('cd')}
                plot={cdPlot} onToggleExpand={() => toggleBig('cd')} />
            </div>
            <LineChart x={sweep.machs} lines={totalLines} title="Drag coefficient vs Mach" xLabel="Mach" yLabel="CD"
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
                {/* role="group" with aria-pressed, NOT tablist/tab
                    (2026-09-08 audit). These are toggle buttons: there is no
                    tabpanel, no aria-controls, no roving tabindex and no arrow
                    handler, so declaring a tablist made a screen reader announce
                    "tab 1 of 2" and put the user in a widget where Arrow keys
                    are expected to move between tabs — and here did nothing at
                    all. aria-pressed describes what these actually are. */}
                <div className="view-toggle" role="group" aria-label="Center of pressure units">
                  <button className={cpView === 'pct' ? 'active' : ''}
                    aria-pressed={cpView === 'pct'} onClick={() => setCpView('pct')}>% of length</button>
                  <button className={cpView === 'unit' ? 'active' : ''}
                    aria-pressed={cpView === 'unit'} onClick={() => setCpView('unit')}>{lenUnit} from nose</button>
                </div>
                <ChartHeadButtons chart="center of pressure" zoomed={zoomedCharts.has('cp')} expanded={bigCharts.has('cp')}
                  plot={cpPlot} onToggleExpand={() => toggleBig('cp')} />
              </div>
              {cpHasLift ? (
                <LineChart x={sweep.machs} lines={cpLines} xLabel="Mach" height={160}
                  title={`Center of pressure vs Mach (${cpView === 'pct' ? '% of length' : `${lenUnit} from nose`})`}
                  yLabel={cpView === 'pct' ? '% of length' : `${lenUnit} from nose`} lockLegend
                  expanded={bigCharts.has('cp')} plotRef={cpPlot} onZoomChange={noteZoom('cp')} />
              ) : (
                // Not a flat line at 0 %: that reads as a CP at the nose tip,
                // and it is the kernel's "nothing to measure" (sweepCp).
                <p className="motor-db-meta" style={{ marginTop: 4 }}>
                  {cpNoLift
                    ? <><strong>No lift yet</strong> — this design makes no aerodynamic normal
                      force, so there is no CP to plot.</>
                    : <><strong>No CP to plot in this roll plane</strong> — with the fins as
                      drawn, the design makes no normal force in it.</>}
                </p>
              )}
              {rollNote != null && info && (
                <p className="motor-db-meta" style={{ marginTop: 4 }}>
                  <strong>This design&apos;s CP depends on its roll angle</strong> (fewer than
                  three fins, or a part off the axis), and{' '}
                  {cpHasLift
                    ? 'this chart is one roll plane'
                    : 'the CP-vs-Mach sweep is measured in one roll plane'}, with
                  the fins as drawn. The stability margin everywhere else in the app uses the
                  forward-most CP over every roll angle,{' '}
                  {cpView === 'pct'
                    ? `${((rollNote / info.length) * 100).toFixed(1)} % of length`
                    : `${fmtSi('length', lenUnit, rollNote, 3)} ${lenUnit} from nose`}
                  {' '}— the conservative figure.
                </p>
              )}
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
              {/* Same fix as the CP toggle above — toggle buttons, not tabs. */}
              <div className="view-toggle" role="group" aria-label="Drag breakdown grouping">
                <button className={mode === 'component' ? 'active' : ''}
                  aria-pressed={mode === 'component'} onClick={() => setMode('component')}>By component</button>
                <button className={mode === 'type' ? 'active' : ''}
                  aria-pressed={mode === 'type'} onClick={() => setMode('type')}>By type</button>
              </div>
              <ChartHeadButtons chart="drag breakdown" zoomed={zoomedCharts.has('breakdown')} expanded={bigCharts.has('breakdown')}
                plot={bdPlot} onToggleExpand={() => toggleBig('breakdown')} />
            </div>
            <LineChart x={sweep.machs} lines={breakdownLines} title="Drag breakdown (power-off) vs Mach" xLabel="Mach" yLabel="CD"
              expanded={bigCharts.has('breakdown')} plotRef={bdPlot} onZoomChange={noteZoom('breakdown')} />
          </div>

          {machTop > 1.5 && (supersonicModel ? (
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
