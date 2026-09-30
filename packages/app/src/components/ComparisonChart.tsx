import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import type { FlightSeries } from '@online-openrocket/engine';
import { usePrefs } from '../prefs/PrefsContext.js';
import { siToUi, uiToSi } from '../prefs/units.js';
import { chartInk } from '../chartTheme.js';
import { chartSummary, nameChartCanvas } from '../chartSummary.js';
import { formatReadout, tooltipPlugin } from '../chartTooltip.js';
import { panelHeight, panZoomPlugin, plotIsZoomed, resetPlots, zoomPercent } from '../chartPanZoom.js';
import { comparisonMembers, convertedValues, phaseData, usableSeries,
  type ComparisonPreset, type SeriesDef } from '../flightChartModel.js';
import { UnitChip } from './UnitChip.js';

const labelled = (d: SeriesDef) => `${d.title}${d.unit ? ` (${d.unit})` : ''}`;

/** One branch, real scales. Phase plots never enter either time-sync bus. */
export function ComparisonChart({ series, preset, catalog, branchName, plots, onZoomChange, csvNote }: {
  series: FlightSeries;
  preset: ComparisonPreset;
  catalog: SeriesDef[];
  branchName: string;
  plots: Set<uPlot>;
  onZoomChange: (zoomed: boolean, percent: number) => void;
  csvNote?: string;
}) {
  const { prefs, daylight, resolvedTheme } = usePrefs();
  const ref = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const saved = useRef<{ min: number; max: number } | null>(null);
  const notify = useRef(onZoomChange);
  notify.current = onZoomChange;
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState({ zoomed: false, percent: 100 });
  const [tableOpen, setTableOpen] = useState(false);
  const [page, setPage] = useState(0);
  const phase = preset.x === 'altitude';
  const altitude = catalog.find((d) => d.key === 'altitude')!;
  const members = useMemo(() => comparisonMembers(preset, catalog), [preset, catalog]);
  const values = useMemo(() => members.map((d) => convertedValues(series, d)), [series, members]);
  const altitudeValues = useMemo(() => convertedValues(series, altitude), [series, altitude]);
  const prepared = useMemo(() => phase ? phaseData(series, altitude, members[0]!) : null,
    [phase, series, altitude, members]);
  const available = usableSeries(series, members.map((d) => String(d.key)), preset.x);
  const summary = useMemo(() => {
    const axes = members.map((d) => `${d.axis} axis: ${labelled(d)}`).join('; ');
    if (prepared) {
      const range = prepared.xs.length ? `${formatReadout(prepared.xs[0])} to ${formatReadout(prepared.xs.at(-1))} ${altitude.unit}` : 'no data';
      return `${preset.title}. Flight branch: ${branchName}. ${axes}. Altitude above launch: ${range}. `
        + prepared.runs.map((run, i) => chartSummary({
          title: `${run.direction} portion ${i + 1}`, x: run.samples.map((s) => s.time),
          at: (t) => `${formatReadout(t)} s`,
          series: [{ label: labelled(members[0]!), values: run.samples.map((s) => members[0]!.f?.(s.velocity) ?? s.velocity) }],
        })).join(' ') + (csvNote ? ` ${csvNote}` : '');
    }
    return chartSummary({ title: `${preset.title}. Flight branch: ${branchName}. ${axes}. Time (s)`,
      x: series.time, at: (t) => `${formatReadout(t)} s`,
      series: members.map((d, i) => ({ label: labelled(d), values: values[i]! })), source: csvNote });
  }, [members, prepared, altitude.unit, preset.title, branchName, series, values, csvNote]);
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  useEffect(() => { if (ref.current) nameChartCanvas(ref.current, summary); }, [summary]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !available) return;
    const ink = chartInk(el);
    const distanceUnit = prefs.units.distance;
    const fromSI = (x: number) => phase ? siToUi('distance', distanceUnit, x) : x;
    const toSI = (x: number) => phase ? uiToSi('distance', distanceUnit, x) : x;
    const height = () => Math.max(300, panelHeight(el.clientWidth || 640, expanded));
    const phaseLabel = (seriesIndex: number, idx: number) => {
      const run = prepared!.runs[seriesIndex - 1]!;
      return `${run.direction} ${seriesIndex}, t = ${formatReadout(prepared!.values[seriesIndex - 1]?.times[idx])} s`;
    };
    const data: uPlot.AlignedData = prepared
      ? [prepared.xs, ...prepared.values.map((v) => v.row)] : [series.time, ...values];
    const ySeries: uPlot.Series[] = prepared ? prepared.runs.map((run, i) => ({
      label: `${labelled(members[0]!)} - ${run.direction} ${i + 1}`,
      scale: 'left', stroke: members[0]!.color, width: ink.strokeWidth,
      dash: run.direction === 'Falling' ? [6, 4] : undefined,
      spanGaps: true,
      points: { show: true, filter: prepared.values[i]!.points, size: 6 },
      value: (_u, v, si, idx) => idx == null || v == null ? formatReadout(v)
        : `${formatReadout(v)} (${phaseLabel(si, idx)})`,
    })) : members.map((d) => ({
      label: labelled(d), scale: d.axis, stroke: d.color, width: ink.strokeWidth,
      dash: d.dash, value: (_u, v) => formatReadout(v),
    }));
    const axis = (side: 'left' | 'right'): uPlot.Axis => {
      const defs = members.filter((d) => d.axis === side);
      return { scale: side, side: side === 'left' ? 3 : 1,
        label: `${defs.map((d) => d.title).join(' / ')} (${defs[0]!.unit})`, labelSize: 20,
        stroke: defs.length === 1 ? defs[0]!.color : ink.axis,
        grid: { show: side === 'left', stroke: ink.grid }, ticks: { stroke: ink.tick }, font: ink.font, size: 48 };
    };
    const opts: uPlot.Options = {
      width: el.clientWidth || 640, height: height(),
      cursor: { ...(phase ? {} : { sync: { key: 'flight', scales: ['x', null] } }), points: { size: 7 }, bind: { click: () => null } },
      scales: { x: { time: false }, left: { auto: true }, ...(preset.right.length ? { right: { auto: true } } : {}) },
      legend: { live: true },
      series: [{ label: phase ? labelled(altitude) : 't (s)', value: (_u, v) => formatReadout(v) }, ...ySeries],
      axes: [
        { label: phase ? labelled(altitude) : 'Time (s)', labelSize: 20,
          stroke: ink.axis, grid: { stroke: ink.grid }, ticks: { stroke: ink.tick }, font: ink.font },
        axis('left'), ...(preset.right.length ? [axis('right')] : []),
      ],
      plugins: [panZoomPlugin(phase ? undefined : () => plots, (u) => {
        if (phase) setZoom({ zoomed: plotIsZoomed(u), percent: zoomPercent(u) });
        else notify.current(plotIsZoomed(u), zoomPercent(u));
      }), tooltipPlugin(prepared ? (si, idx, label) => `${label}; ${phaseLabel(si, idx)}` : undefined)],
    };
    const plot = new uPlot(opts, data, el);
    plotRef.current = plot;
    nameChartCanvas(el, summaryRef.current);
    const peer = phase ? undefined : plots.values().next().value;
    if (peer?.scales['x']?.min != null && peer.scales['x'].max != null) {
      plot.setScale('x', { min: peer.scales['x'].min, max: peer.scales['x'].max });
    } else if (saved.current) {
      plot.setScale('x', { min: fromSI(saved.current.min), max: fromSI(saved.current.max) });
    }
    if (!phase) plots.add(plot);
    const observer = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: height() }));
    observer.observe(el);
    return () => {
      observer.disconnect();
      plots.delete(plot);
      const sc = plot.scales['x'];
      saved.current = sc?.min != null && sc.max != null ? { min: toSI(sc.min), max: toSI(sc.max) } : null;
      plotRef.current = null;
      plot.destroy();
    };
  }, [available, phase, series, values, prepared, members, altitude, preset, prefs.units.distance, daylight, resolvedTheme, expanded, plots]);

  const tableMembers = phase ? [altitude, ...members] : members;
  const tableValues = phase ? [altitudeValues, ...values] : values;
  const pageSize = 100;
  const start = Math.min(page * pageSize, Math.max(0, Math.floor((series.time.length - 1) / pageSize) * pageSize));
  return <section className="chart-panel comparison-panel">
    <div className="chart-panel-head">
      <h3>{preset.title}</h3>
      <button className="chart-btn" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}
        aria-label={`${expanded ? 'Restore' : 'Expand'} ${preset.title} chart`}>{expanded ? 'Restore size' : 'Expand'}</button>
    </div>
    <div className="comparison-axis-keys">
      {phase && <span>Horizontal: Altitude <UnitChip quantity="distance" /></span>}
      {(['left', 'right'] as const).filter((side) => members.some((d) => d.axis === side)).map((side) =>
        <span className="comparison-axis-key" key={side}>
          {side === 'left' ? 'Left' : 'Right'}:
          {members.filter((d) => d.axis === side).map((d) => <span key={String(d.key)}>
            <svg width="22" height="10" aria-hidden="true"><line x1="0" y1="5" x2="22" y2="5"
              stroke={d.color} strokeWidth="3" strokeDasharray={d.dash?.join(' ')} /></svg>
            {d.title} {d.quantity ? <UnitChip quantity={d.quantity} /> : `(${d.unit})`}
          </span>)}
        </span>)}
    </div>
    {preset.right.length > 0 && <p className="chart-comparison-note">Each side has its own scale. Read each curve against its labelled axis; a crossing does not mean equal values.</p>}
    {members.some((d) => d.key === 'velocity') && <p className="chart-comparison-note">Velocity is total speed over the ground, including horizontal motion.</p>}
    {phase && <p className="chart-comparison-note">Altitude is above the launch point. Solid lines show rising altitude; dashed lines show falling altitude. The readout gives the time of each sample. Repeated-altitude and isolated samples appear as points.</p>}
    {!available ? <p role="status">This flight branch has no usable data for this comparison.</p> : <>
      {phase && <div className="chart-toolbar">
        <button className="chart-btn" disabled={!zoom.zoomed} onClick={() => { if (plotRef.current) resetPlots([plotRef.current]); }}>Reset altitude chart</button>
        <span className="chart-zoom-pct">{formatReadout(zoom.percent, 3)}%</span>
      </div>}
      <div ref={ref} className="chart-legend-locked" />
      <details onToggle={(e) => setTableOpen(e.currentTarget.open)}>
        <summary>Show comparison data</summary>
        {tableOpen && <>
          <div className="comparison-table-scroll" tabIndex={0} role="region" aria-label="Comparison samples">
            <table>
              <caption>{preset.title} - {branchName}. Recorded samples, six significant digits.</caption>
              <thead><tr><th scope="col">Time (s)</th>{tableMembers.map((d) => <th scope="col" key={String(d.key)}>{labelled(d)}</th>)}</tr></thead>
              <tbody>{series.time.slice(start, start + pageSize).map((t, i) => <tr key={start + i}>
                <td>{formatReadout(t)}</td>{tableValues.map((v, j) => <td key={j}>{formatReadout(v[start + i])}</td>)}
              </tr>)}</tbody>
            </table>
          </div>
          <div className="chart-toolbar">
            <span>Samples {start + 1}-{Math.min(start + pageSize, series.time.length)} of {series.time.length}</span>
            <button className="chart-btn" disabled={start === 0} onClick={() => setPage(Math.max(0, page - 1))}>Previous samples</button>
            <button className="chart-btn" disabled={start + pageSize >= series.time.length} onClick={() => setPage(page + 1)}>Next samples</button>
          </div>
        </>}
      </details>
    </>}
  </section>;
}
