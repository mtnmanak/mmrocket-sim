import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { DragSweep, OrkRocket } from '@online-openrocket/engine';
import { usePrefs } from '../prefs/PrefsContext.js';
import { siToUi } from '../prefs/units.js';
import { chartInk, seriesPalette } from '../chartTheme.js';
import { panZoomPlugin } from '../chartPanZoom.js';
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
function LineChart({ x, lines, xLabel, yLabel, height = 190, lockLegend = false }: {
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
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { resolvedTheme, daylight } = usePrefs();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ink = chartInk(el);

    const data: uPlot.AlignedData = [x, ...lines.map((l) => l.values)];
    const opts: uPlot.Options = {
      width: el.clientWidth || 640,
      height,
      // Legend labels bind their toggle through cursor.bind.click (the only
      // "click" uPlot binds) — returning null unbinds it without touching
      // the legend's live readout, which rides mousemove.
      cursor: { points: { size: 6 }, ...(lockLegend ? { bind: { click: () => null } } : {}) },
      scales: { x: { time: false } },
      legend: { live: true },
      plugins: [panZoomPlugin()],
      series: [
        { label: xLabel, value: (_u, v) => (v == null ? '–' : v.toFixed(2)) },
        ...lines.map((l): uPlot.Series => ({
          label: l.label,
          stroke: l.color,
          width: ink.strokeWidth,
          ...(l.dash ? { dash: [6, 4] } : {}),
          value: (_u, v) => (v == null ? '–' : v.toFixed(3)),
        })),
      ],
      axes: [
        { stroke: ink.axis, grid: { stroke: ink.grid, width: 1 }, ticks: { stroke: ink.tick, width: 1 }, font: ink.font },
        { stroke: ink.axis, grid: { stroke: ink.grid, width: 1 }, ticks: { stroke: ink.tick, width: 1 }, font: ink.font, size: 48, ...(yLabel ? { label: yLabel } : {}) },
      ],
    };
    const plot = new uPlot(opts, data, el);
    const obs = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height }));
    obs.observe(el);
    return () => {
      obs.disconnect();
      plot.destroy();
    };
  }, [x, lines, xLabel, yLabel, height, lockLegend, resolvedTheme, daylight]);

  return <div ref={ref} className={lockLegend ? 'chart-legend-locked' : undefined} />;
}

function exportCsv(sweep: DragSweep, meta: { design: string; aeroModel: string; lengthUnit: string }) {
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
    '# conditions: sea level ISA',
    cols.map(([h]) => h).join(','),
  ];
  for (let i = 0; i < sweep.machs.length; i++) {
    rows.push(cols.map(([, v]) => (v[i] == null ? '' : v[i])).join(','));
  }
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'drag-analysis.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

type BreakdownMode = 'component' | 'type';
type CpView = 'pct' | 'unit';

export function DragPanel({ rocket, supersonicModel, designName }: {
  rocket: OrkRocket;
  /** Whether the opt-in supersonic aero model is active (Preferences → Aerodynamics). */
  supersonicModel?: boolean;
  /** Design name for the CSV metadata header (tree.name at the call site). */
  designName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [machMax, setMachMax] = useState(3);
  const [mode, setMode] = useState<BreakdownMode>('component');
  const [cpView, setCpView] = useState<CpView>('pct');
  const { prefs, daylight } = usePrefs();
  const C = seriesPalette(daylight);
  const lenUnit = prefs.units.length;

  // High-Mach ranges only make sense with the supersonic model on.
  useEffect(() => {
    if (!supersonicModel && machMax > 5) setMachMax(5);
  }, [supersonicModel, machMax]);

  // Only pay the sweep cost while the panel is open. Recomputes when the design
  // (rocket handle) or the range changes.
  const sweep = useMemo<DragSweep | { error: string } | null>(() => {
    if (!open) return null;
    try {
      return rocket.dragSweep({ machMax });
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [open, rocket, machMax]);

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
            <span style={{ flex: 1 }} />
            <button className="file-btn" onClick={() => exportCsv(sweep, {
              design: designName || 'Rocket',
              // Same wording as the launch report's "Aero model" row — the
              // model the sweep actually ran on, not a fixed string.
              aeroModel: supersonicModel
                ? 'Supersonic (our extended model)'
                : `Classic (Extended Barrowman${(prefs.rogersKbf ?? true) ? ' + Rogers Kbf' : ''})`,
              lengthUnit: lenUnit,
            })}>⬇ CSV</button>
          </div>

          <div className="chart-panel">
            <h3>Drag coefficient vs Mach</h3>
            <LineChart x={sweep.machs} lines={totalLines} xLabel="Mach" yLabel="CD" />
            {!sweep.hasNozzle && (
              <p className="motor-db-meta" style={{ marginTop: 4 }}>
                Set a stage <strong>nozzle exit diameter</strong> to see a distinct power-on curve
                (motor exhaust lowers base drag during boost).
              </p>
            )}
          </div>

          {cpLines.length > 0 && (
            <div className="chart-panel">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <h3 style={{ flex: 1 }}>
                  Center of pressure vs Mach ({cpView === 'pct' ? '% of length' : `${lenUnit} from nose`})
                </h3>
                <div className="view-toggle" role="tablist">
                  <button className={cpView === 'pct' ? 'active' : ''} role="tab"
                    aria-selected={cpView === 'pct'} onClick={() => setCpView('pct')}>% of length</button>
                  <button className={cpView === 'unit' ? 'active' : ''} role="tab"
                    aria-selected={cpView === 'unit'} onClick={() => setCpView('unit')}>{lenUnit} from nose</button>
                </div>
              </div>
              <LineChart x={sweep.machs} lines={cpLines} xLabel="Mach" height={160}
                yLabel={cpView === 'pct' ? '% of length' : `${lenUnit} from nose`} lockLegend />
              {supersonicModel ? (
                <p className="motor-db-meta" style={{ marginTop: 4 }}>
                  Supersonic CP travel is the stability hazard on fast flights — check your
                  margin at max Mach, not just at rest. High-performance practice: keep ≥ 2
                  calibers through the transonic and supersonic regime.
                </p>
              ) : (
                <p className="motor-db-meta" style={{ marginTop: 4 }}>
                  The Barrowman models freeze body CP above Mach 1 — pick
                  <strong> Auto</strong> or <strong>Supersonic</strong> in Preferences →
                  Aerodynamics for wind-tunnel-validated CP travel.
                </p>
              )}
            </div>
          )}

          <div className="chart-panel">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <h3 style={{ flex: 1 }}>Breakdown (power-off)</h3>
              <div className="view-toggle" role="tablist">
                <button className={mode === 'component' ? 'active' : ''} role="tab"
                  aria-selected={mode === 'component'} onClick={() => setMode('component')}>By component</button>
                <button className={mode === 'type' ? 'active' : ''} role="tab"
                  aria-selected={mode === 'type'} onClick={() => setMode('type')}>By type</button>
              </div>
            </div>
            <LineChart x={sweep.machs} lines={breakdownLines} xLabel="Mach" yLabel="CD" />
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
              (approximate). Enable <strong>Supersonic aerodynamics</strong> in
              Preferences&nbsp;→&nbsp;Aerodynamics for the validated supersonic model.
            </p>
          ))}
        </>
      ))}
    </div>
  );
}
