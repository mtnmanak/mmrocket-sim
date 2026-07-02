import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { FlightResult } from '@online-openrocket/engine';

/**
 * Three stacked single-series panels (altitude / velocity / acceleration vs
 * time) with synchronized crosshairs. Three measures of different scale are
 * NEVER dual-axed — each gets its own panel and y-scale; the shared x cursor
 * links them. Colors: validated categorical slots 1–3; each panel is
 * single-series so identity is carried by its visible title (relief rule for
 * the below-3:1 slots) and the live value readout in the legend.
 */
const SYNC_KEY = 'flight';

interface PanelSpec {
  title: string;
  unit: string;
  color: string;
  values: (r: FlightResult) => number[];
}

const PANELS: PanelSpec[] = [
  { title: 'Altitude', unit: 'm', color: '#2a78d6', values: (r) => r.series.altitude },
  { title: 'Velocity', unit: 'm/s', color: '#1baf7a', values: (r) => r.series.velocity },
  { title: 'Acceleration', unit: 'm/s²', color: '#eda100', values: (r) => r.series.acceleration },
];

function Panel({ result, spec }: { result: FlightResult; spec: PanelSpec }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const data: uPlot.AlignedData = [result.series.time, spec.values(result)];
    const opts: uPlot.Options = {
      width: el.clientWidth || 640,
      height: 170,
      title: undefined,
      cursor: { sync: { key: SYNC_KEY }, points: { size: 7 } },
      scales: { x: { time: false } },
      legend: { live: true },
      series: [
        { label: 't (s)', value: (_u, v) => (v == null ? '–' : v.toFixed(2)) },
        {
          label: `${spec.title} (${spec.unit})`,
          stroke: spec.color,
          width: 2,
          value: (_u, v) => (v == null ? '–' : v.toFixed(1)),
        },
      ],
      axes: [
        {
          stroke: '#7a786f',
          grid: { stroke: '#e8e6e1', width: 1 },
          ticks: { stroke: '#dedcd7', width: 1 },
          font: '11px system-ui',
        },
        {
          stroke: '#7a786f',
          grid: { stroke: '#e8e6e1', width: 1 },
          ticks: { stroke: '#dedcd7', width: 1 },
          font: '11px system-ui',
          size: 52,
        },
      ],
    };
    const plot = new uPlot(opts, data, el);

    const onResize = () => plot.setSize({ width: el.clientWidth, height: 170 });
    const obs = new ResizeObserver(onResize);
    obs.observe(el);
    return () => {
      obs.disconnect();
      plot.destroy();
    };
  }, [result, spec]);

  return (
    <div className="chart-panel">
      <h3>{spec.title} ({spec.unit})</h3>
      <div ref={ref} />
    </div>
  );
}

export function FlightCharts({ result }: { result: FlightResult }) {
  return (
    <div>
      {PANELS.map((p) => (
        <Panel key={p.title} result={result} spec={p} />
      ))}
    </div>
  );
}
