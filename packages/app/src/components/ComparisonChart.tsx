import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import type { FlightEvent, FlightSeries } from '@online-openrocket/engine';
import { usePrefs } from '../prefs/PrefsContext.js';
import { REFERENCE_DASH, chartInk } from '../chartTheme.js';
import { legendSamplePlugin, type LegendEntry } from '../chartLegend.js';
import { LineSample } from './LineSample.js';
import { chartSummary, nameChartCanvas } from '../chartSummary.js';
import { formatReadout, tooltipPlugin } from '../chartTooltip.js';
import { panelHeight, panZoomPlugin, plotIsZoomed, resetPlots, zoomPercent } from '../chartPanZoom.js';
import { comparisonMembers, convertedValues, phaseData, usableSeries,
  type ComparisonPreset, type SeriesDef } from '../flightChartModel.js';
import { UnitChip } from './UnitChip.js';
import { emphasizeSeries } from '../chartEmphasis.js';
import { eventPlugin } from '../flightPlotEvents.js';
import { PlotEventKey, eventCaptions } from './PlotEventKey.js';
import { PlotImage } from './PlotImage.js';

const NO_EVENTS: FlightEvent[] = [];
const NO_SELECTION: string[] = [];

const labelled = (d: SeriesDef) => `${d.title}${d.unit ? ` (${d.unit})` : ''}`;

/** A phase plot's one series is split by direction: rising solid, falling dashed. */
const phaseDash = (direction: string) => direction === 'Falling' ? REFERENCE_DASH : undefined;

/** One branch, real scales. Phase plots never enter either time-sync bus. */
export function ComparisonChart({ series, preset, catalog, flightName, plots, onZoomChange, onStatus, csvNote, emphasis = null,
  events = NO_EVENTS, selectedEvents = NO_SELECTION }: {
  events?: FlightEvent[];
  selectedEvents?: readonly string[];
  emphasis?: keyof FlightSeries | null;
  series: FlightSeries;
  preset: ComparisonPreset;
  catalog: SeriesDef[];
  flightName: string;
  plots: Set<uPlot>;
  onZoomChange: (zoomed: boolean, percent: number) => void;
  onStatus?: (message: string) => void;
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
  const phase = preset.x !== 'time';
  const altitude = useMemo(() => catalog.find(d => d.key === preset.x)
    ?? { key: preset.x, title: preset.x, unit: 'unit unknown', color: '' }, [catalog, preset.x]);
  const members = useMemo(() => comparisonMembers(preset, catalog), [preset, catalog]);
  const values = useMemo(() => members.map((d) => convertedValues(series, d)), [series, members]);
  const altitudeValues = useMemo(() => convertedValues(series, altitude), [series, altitude]);
  const prepared = useMemo(() => phase ? phaseData(series, altitude, members[0]!) : null,
    [phase, series, altitude, members]);
  const available = usableSeries(series, members.map((d) => String(d.key)), preset.x);
  const status = available ? '' : 'This flight branch has no usable data for this comparison.';
  useEffect(() => {
    onStatus?.(status);
    return () => onStatus?.('');
  }, [onStatus, status]);
  const summary = useMemo(() => {
    const axes = members.map((d) => `${d.axis} axis: ${labelled(d)}`).join('; ');
    if (prepared) {
      const range = prepared.xs.length ? `${formatReadout(prepared.xs[0])} to ${formatReadout(prepared.xs.at(-1))} ${altitude.unit}` : 'no data';
      return `${preset.title} — ${flightName}. ${axes}. ${preset.x === 'altitude' ? 'Altitude above launch' : labelled(altitude)}: ${range}. `
        + prepared.runs.map((run, i) => chartSummary({
          title: `${run.direction} portion ${i + 1}`, x: run.samples.map((s) => s.time),
          at: (t) => `${formatReadout(t)} s`,
          series: [{ label: labelled(members[0]!), values: run.samples.map((s) => members[0]!.f?.(s.velocity) ?? s.velocity) }],
        })).join(' ') + (csvNote ? ` ${csvNote}` : '');
    }
    return chartSummary({ title: `${preset.title} — ${flightName}. ${axes}. Time (s)`,
      x: series.time, at: (t) => `${formatReadout(t)} s`,
      series: members.map((d, i) => ({ label: labelled(d), values: values[i]! })), source: csvNote });
  }, [members, prepared, altitude, preset.title, preset.x, flightName, series, values, csvNote]);
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  useEffect(() => { if (ref.current) nameChartCanvas(ref.current, summary); }, [summary]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !available) return;
    const ink = chartInk(el);
    const fromSI = (x: number) => phase ? altitude.f?.(x) ?? x : x;
    const toSI = (x: number) => phase ? altitude.toSI?.(x) ?? x : x;
    const height = () => Math.max(300, panelHeight(el.clientWidth || 640, expanded));
    const phaseLabel = (seriesIndex: number, idx: number) => {
      const group = prepared!.values[seriesIndex - 1]!;
      return `${group.direction}, t = ${formatReadout(group.times[idx])} s`;
    };
    const data: uPlot.AlignedData = prepared
      ? [prepared.xs, ...prepared.values.map((v) => v.row)] : [series.time, ...values];
    const ySeries: uPlot.Series[] = prepared ? prepared.values.map((group) => ({
      label: `${labelled(members[0]!)} - ${group.direction}`,
      scale: 'left', stroke: members[0]!.color, width: ink.strokeWidth,
      dash: phaseDash(group.direction),
      paths: (u) => {
        const stroke = new Path2D();
        // C-E7: independent subpaths preserve gaps even when many runs share ink.
        for (const segment of group.segments) {
          segment.forEach((idx, i) => {
            const x = u.valToPos(prepared.xs[idx]!, 'x', true);
            const y = u.valToPos(group.row[idx]!, 'left', true);
            if (i === 0) stroke.moveTo(x, y);
            else stroke.lineTo(x, y);
          });
        }
        return { stroke };
      },
      points: { show: true, filter: group.points, size: 6 },
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
        // Axis text in the text ink, never a series colour (mmr-brand §3.2:
        // light Mach and four dark series are under 4.5:1 as text). The axis
        // keys above the plot carry each side's line samples.
        stroke: ink.axis,
        grid: { show: side === 'left', stroke: ink.grid }, ticks: { stroke: ink.tick }, font: ink.font, size: 48 };
    };
    const opts: uPlot.Options = {
      width: el.clientWidth || 640, height: height(),
      cursor: { ...(prepared ? { dataIdx: (u: uPlot, si: number, idx: number) => {
        if (idx == null) return null;
        if (si === 0) {
          // Equal X can have distinct Y and times. Choose the sample under the
          // pointer rather than making the other samples unreachable.
          let first = idx, last = idx, nearest = idx, distance = Infinity;
          while (first > 0 && prepared.xs[first - 1] === prepared.xs[idx]) first--;
          while (last + 1 < prepared.xs.length && prepared.xs[last + 1] === prepared.xs[idx]) last++;
          for (let i = first; i <= last; i++) {
            const y = prepared.values.find(g => g.row[i] != null)?.row[i];
            if (y == null) continue;
            const d = Math.abs(u.valToPos(y, 'left') - (u.cursor.top ?? 0));
            if (d < distance) { distance = d; nearest = i; }
          }
          u.cursor.idx = nearest;
        }
        return u.cursor.idx ?? idx;
      } } : { sync: { key: 'flight', scales: ['x', null] } }), points: { size: 7 }, bind: { click: () => null } },
      scales: { x: { time: false }, left: { auto: true, range: prepared ? (u, min, max) => {
        // Sorted duplicate X slots alone can omit a crossing run's Y extrema
        // during zoom. Fit every intersecting segment, including its endpoints.
        const xMin = u.scales['x']!.min ?? prepared.xs[0]!;
        const xMax = u.scales['x']!.max ?? prepared.xs.at(-1)!;
        let low = Infinity, high = -Infinity;
        const include = (y: number) => { low = Math.min(low, y); high = Math.max(high, y); };
        for (const group of prepared.values) for (const segment of group.segments) {
          segment.forEach((idx, i) => {
            const x = prepared.xs[idx]!, y = group.row[idx]!;
            if (x >= xMin && x <= xMax) include(y);
            if (i > 0) {
              const prev = segment[i - 1]!, prevX = prepared.xs[prev]!;
              if (Math.max(x, prevX) >= xMin && Math.min(x, prevX) <= xMax) {
                include(y); include(group.row[prev]!);
              }
            }
          });
        }
        return uPlot.rangeNum(low === Infinity ? min : low, high === -Infinity ? max : high, 0.1, true);
      } : undefined }, ...(preset.right.length ? { right: { auto: true } } : {}) },
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
      }), tooltipPlugin(prepared ? (si, idx, label) => `${label}; ${phaseLabel(si, idx)}` : undefined),
      ...(!phase ? [eventPlugin(events, selectedEvents, ink)] : []), legendSamplePlugin()],
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
  }, [available, phase, series, values, prepared, members, altitude, preset, prefs.units, daylight, resolvedTheme, expanded, plots, events, selectedEvents]);

  useEffect(() => {
    if (plotRef.current && ref.current) emphasizeSeries(plotRef.current,
      prepared ? prepared.values.map(() => members[0]!.key) : members.map((d) => d.key), emphasis, ref.current);
  }, [emphasis, available, phase, series, values, prepared, members, altitude, preset, prefs.units, daylight, resolvedTheme, expanded, events, selectedEvents]);

  const legendEntries: LegendEntry[] = prepared
    ? prepared.values.map((group) => ({ label: `${labelled(members[0]!)} - ${group.direction}`, color: members[0]!.color,
      ...(phaseDash(group.direction) ? { dash: phaseDash(group.direction) } : {}) }))
    : members.map((d) => ({ label: labelled(d), color: d.color, ...(d.dash ? { dash: d.dash } : {}) }));
  const tableMembers = phase ? [altitude, ...members] : members;
  const tableValues = phase ? [altitudeValues, ...values] : values;
  const pageSize = 100;
  const start = Math.min(page * pageSize, Math.max(0, Math.floor((series.time.length - 1) / pageSize) * pageSize));
  return <section className="chart-panel comparison-panel">
    <div className="chart-panel-head">
      <h3>{preset.title} — {flightName}</h3>
      {available && <PlotImage container={ref} title={`${preset.title} — ${flightName}. X: ${phase ? labelled(altitude) : 'Time (s)'}. ${members.map(labelled).join('; ')}`}
        captions={phase ? [] : eventCaptions(events, selectedEvents)} legend={legendEntries} />}
      <button className="chart-btn" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}
        aria-label={`${expanded ? 'Restore' : 'Expand'} ${preset.title} chart`}>{expanded ? 'Restore size' : 'Expand'}</button>
    </div>
    <div className="comparison-axis-keys">
      {phase && <span>Horizontal: {altitude.title} {altitude.quantity ? <UnitChip quantity={altitude.quantity} /> : `(${altitude.unit})`}</span>}
      {(['left', 'right'] as const).filter((side) => members.some((d) => d.axis === side)).map((side) =>
        <span className="comparison-axis-key" key={side}>
          {side === 'left' ? 'Left' : 'Right'}:
          {members.filter((d) => d.axis === side).map((d) => <span key={String(d.key)}>
            <LineSample color={d.color} dash={d.dash} />
            {d.title} {d.quantity ? <UnitChip quantity={d.quantity} /> : `(${d.unit})`}
          </span>)}
        </span>)}
    </div>
    {preset.right.length > 0 && <p className="chart-comparison-note">Each side has its own scale. Read each curve against its labelled axis; a crossing does not mean equal values.</p>}
    {members.some((d) => d.key === 'velocity') && <p className="chart-comparison-note">Velocity is total speed over the ground, including horizontal motion.</p>}
    {phase && <p className="chart-comparison-note">{preset.x === 'altitude' ? 'Altitude is above the launch point. Solid lines show rising altitude; dashed lines show falling altitude.'
      : 'Solid lines show increasing X; dashed lines show decreasing X.'} The readout gives the time of each sample. Repeated-X and isolated samples appear as points.</p>}
    {preset.id === 'ground-track' && <p className="chart-comparison-note">Positions are relative to launch. East is horizontal; North is vertical. The axes can have different scales, so this plot does not show the landing bearing to scale.</p>}
    {!available && <p>{status}</p>}
    {available && <>
      {phase && <div className="chart-toolbar">
        <button className="chart-btn" disabled={!zoom.zoomed} onClick={() => { if (plotRef.current) resetPlots([plotRef.current]); }}>{preset.x === 'altitude' ? 'Reset altitude chart' : 'Reset X chart'}</button>
        <span className="chart-zoom-pct">{formatReadout(zoom.percent, 3)}%</span>
      </div>}
      <div ref={ref} className="chart-legend-locked" />
      {!phase && <PlotEventKey events={events} selected={selectedEvents} />}
      <details onToggle={(e) => setTableOpen(e.currentTarget.open)}>
        <summary>Show comparison data</summary>
        {tableOpen && <>
          <div className="comparison-table-scroll" tabIndex={0} role="region" aria-label="Comparison samples">
            <table>
              <caption>{preset.title} — {flightName}. Recorded samples, six significant digits.</caption>
              <thead><tr><th scope="col">Time (s)</th>{tableMembers.map((d, i) => <th scope="col" key={`${i}-${String(d.key)}`}>{labelled(d)}</th>)}</tr></thead>
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
