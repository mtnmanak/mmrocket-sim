// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import uPlot from 'uplot';
import type { FlightResult } from '@online-openrocket/engine';
import { FlightCharts } from './FlightCharts.js';
import { PrefsProvider, usePrefs } from '../prefs/PrefsContext.js';
import { IMPERIAL_UNITS, METRIC_UNITS } from '../prefs/units.js';
import { emphasizeSeries } from '../chartEmphasis.js';
import { ComparisonChart } from './ComparisonChart.js';
import { arbitraryCatalog } from '../flightChartModel.js';
import { SERIES } from '../chartTheme.js';

// Capture instances without replacing uPlot's asynchronous scale/draw lifecycle.
const registry = vi.hoisted(() => ({ plots: [] as uPlot[] }));
vi.mock('uplot', async (importOriginal) => {
  const real = await importOriginal<{ default: typeof uPlot }>();
  return { default: class extends real.default {
    constructor(opts: uPlot.Options, data: uPlot.AlignedData, el: HTMLElement) {
      super(opts, data, el);
      registry.plots.push(this);
    }
  } };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoPath {
  commands: [string, number, number][] = [];
  moveTo(x: number, y: number) { this.commands.push(['M', x, y]); }
  lineTo(x: number, y: number) { this.commands.push(['L', x, y]); }
  closePath() {} rect() {} arc() {} addPath() {}
}
let host: HTMLDivElement;
let root: Root;
let strokes: { color: unknown; width: unknown; alpha: unknown }[];
const live = () => registry.plots.filter((p) => p.root.isConnected);
const bounds = (p: uPlot) => [p.scales['x']!.min, p.scales['x']!.max];
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const flight = { series: {
  time: [0, 1, 2, 3, 4], altitude: [0, 10, 20, 15, 0],
  velocity: [0, 11, 22, 13, 0], acceleration: [1, 2, 3, 2, 1],
}, events: [], summary: {} } as unknown as FlightResult;

function Preferences() {
  const { prefs, setPrefs } = usePrefs();
  return <>
    <button onClick={() => setPrefs({ ...prefs, theme: 'dark', themeExplicit: true })}>Dark</button>
    <button onClick={() => setPrefs({ ...prefs, units: IMPERIAL_UNITS })}>Imperial</button>
    <button onClick={() => setPrefs({ ...prefs, daylight: true })}>Sun</button>
    <button onClick={() => setPrefs({ ...prefs, units: { ...prefs.units, pressure: 'Pa' } })}>Pa</button>
    <button onClick={() => setPrefs({ ...prefs, units: { ...prefs.units, pressure: 'mbar' } })}>mbar</button>
  </>;
}
async function renderCharts() {
  await act(async () => { root.render(<PrefsProvider><Preferences />
    <FlightCharts result={flight} flightName="Scheduling fixture" />
  </PrefsProvider>); });
}
async function compare() {
  await act(async () => {
    const el = host.querySelector<HTMLSelectElement>('.comparison-controls select')!;
    el.value = 'altitude-velocity';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({
    units: METRIC_UNITS, theme: 'light', themeExplicit: true,
  }));
  // happy-dom has no canvas rendering. Keep real uPlot calculations and scheduling.
  strokes = [];
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, prop) => {
      if (prop === 'stroke') return () => strokes.push({
        color: target['strokeStyle'], width: target['lineWidth'], alpha: target['globalAlpha'],
      });
      return target[prop] ?? (prop === 'measureText' ? () => ({ width: 10 }) : () => undefined);
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('Path2D', NoPath);
  registry.plots.length = 0;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const plot of live()) plot.destroy();
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function CustomChart({ series, x }: { series: FlightResult['series']; x: string }) {
  const { prefs } = usePrefs();
  const catalog = arbitraryCatalog(series, prefs, SERIES);
  return <ComparisonChart series={series} preset={{ id: 'custom', title: 'Custom plot', x, left: ['altitude'], right: [] }}
    catalog={catalog} flightName="Regression fixture" plots={new Set()} onZoomChange={() => {}} />;
}

describe('C-E7 custom X regressions with real uPlot', () => {
  it('keeps the physical q-alpha X window when pressure units change in both directions', async () => {
    const series = { ...flight.series, time: [0, 1, 2, 3], altitude: [0, 1, 2, 3], qAlpha: [0, 100, 200, 300] };
    const before = structuredClone(series);
    await act(async () => root.render(<PrefsProvider><Preferences /><CustomChart series={series} x="qAlpha" /></PrefsProvider>));
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'mbar')!.click());
    expect(live()[0]!.data[0]).toEqual([0, 1, 2, 3]);
    await act(async () => live()[0]!.setScale('x', { min: 0.5, max: 1.5 }));
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Pa')!.click());
    expect(live()[0]!.data[0]).toEqual([0, 100, 200, 300]);
    expect(bounds(live()[0]!)).toEqual([50, 150]);
    expect(live()[0]!.series[0]!.label).toContain('Pa·rad');
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'mbar')!.click());
    expect(bounds(live()[0]!)).toEqual([0.5, 1.5]);
    expect(live()[0]!.series[0]!.label).toContain('mbar·rad');
    expect(series).toEqual(before);
  });

  it('bounds plot series and legend rows for thousands of X reversals', async () => {
    const count = 1000;
    const series = { ...flight.series, time: Array.from({ length: count }, (_, i) => i / 100),
      Cd: Array.from({ length: count }, (_, i) => i % 2 ? 1 + i / count / 10 : i / count / 10),
      altitude: Array.from({ length: count }, (_, i) => i) };
    await act(async () => root.render(<PrefsProvider><CustomChart series={series} x="Cd" /></PrefsProvider>));
    const plot = live()[0]!;
    expect(plot.series.length).toBeLessThanOrEqual(4);
    expect(host.querySelectorAll('.u-legend tr').length).toBeLessThanOrEqual(4);
    expect(plot.data.reduce((total, row) => total + row.length, 0)).toBeLessThanOrEqual(count * 4);
    expect(bounds(plot)[0]).toBe(0);
    expect(bounds(plot)[1]).toBeCloseTo(1.0999, 10); // synthetic arithmetic, not kernel output
  });

  it('draws separate chronological paths across gaps and repeated X, retaining timestamps at turns', async () => {
    const series = { ...flight.series, time: [0, 1, 2, 3, 4, 5, 6, 7, 8],
      Cd: [0, 1, 2, null, 3, 4, 4, 5, 2], altitude: [0, 10, 20, 30, 40, 50, 60, 70, 80] };
    await act(async () => root.render(<PrefsProvider><CustomChart series={series} x="Cd" /></PrefsProvider>));
    const plot = live()[0]!;
    const rising = plot.series.findIndex(s => typeof s.label === 'string' && s.label.includes('Rising'));
    const falling = plot.series.findIndex(s => typeof s.label === 'string' && s.label.includes('Falling'));
    const commands = (si: number) => (plot.series[si]!.paths!(plot, si, 0, plot.data[0].length - 1)!.stroke as unknown as NoPath).commands;
    const projected = (points: [string, number, number][]) => points.map(([op, x, y]) => [op, plot.valToPos(x, 'x', true), plot.valToPos(y, 'left', true)]);
    expect(commands(rising)).toEqual(projected([['M', 0, 0], ['L', 1, 10], ['L', 2, 20],
      ['M', 3, 40], ['L', 4, 50], ['M', 4, 60], ['L', 5, 70]]));
    expect(commands(falling)).toEqual(projected([['M', 5, 70], ['L', 2, 80]]));
    expect(plot.series[falling]!.dash).toEqual([6, 4]);
    // Duplicate X has two independently retained values and sample times.
    const repeated = Array.from(plot.data[0]).flatMap((x, i) => x === 4 ? [i] : []);
    expect(repeated.map(i => plot.data[rising]![i])).toEqual([50, 60]);
    const value = plot.series[rising]!.value as uPlot.Series.Value & ((u: uPlot, v: number, si: number, idx: number) => string);
    expect(repeated.map(i => value(plot, plot.data[rising]![i]!, rising, i))).toEqual(['50 (Rising, t = 5 s)', '60 (Rising, t = 6 s)']);
    plot.over.dispatchEvent(new Event('pointerenter'));
    for (const [y, time] of [[50, 5], [60, 6]]) {
      await act(async () => plot.setCursor({ left: plot.valToPos(4, 'x'), top: plot.valToPos(y!, 'left') }));
      expect(host.querySelector('.u-legend')!.textContent).toContain(`t = ${time} s`);
      expect(host.querySelector('.chart-tooltip')!.textContent).toContain(`t = ${time} s`);
    }
    const turn = plot.data[0].indexOf(5);
    expect(plot.data[rising]![turn]).toBe(70);
    expect(plot.data[falling]![turn]).toBe(70);
    await act(async () => plot.setScale('x', { min: 1.5, max: 3.5 }));
    expect(bounds(plot)).toEqual([1.5, 3.5]);
    // The segment crossing the window survives; uPlot clips it to the viewport.
    expect(commands(falling)).toEqual(projected([['M', 5, 70], ['L', 2, 80]]));
  });

  it('keeps every crossing path in the Y range when zooming between repeated X coordinates', async () => {
    const series = { ...flight.series, time: [0, 1, 2, 3, 4, 5],
      Cd: [0, 10, 0, 10, 0, 10], altitude: [100, 100, 0, 0, 200, 200] };
    await act(async () => root.render(<PrefsProvider><CustomChart series={series} x="Cd" /></PrefsProvider>));
    const plot = live()[0]!;
    await act(async () => plot.setScale('x', { min: 4, max: 6 }));
    expect(plot.scales['left']!.min).toBeLessThanOrEqual(0);
    expect(plot.scales['left']!.max).toBeGreaterThanOrEqual(200);
  });
});

describe('N012 emphasis with real uPlot scheduling', () => {
  it('redraws emphasis ink on cached paths without changing data or settled bounds', async () => {
    const plot = new uPlot({ width: 640, height: 300, scales: { x: { time: false } },
      series: [{}, { stroke: 'blue', width: 2 }, { stroke: 'red', width: 2 }] },
    [[0, 1, 2, 3, 4], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2]], host);
    await Promise.resolve();
    const before = structuredClone(plot.data);
    strokes.length = 0;
    emphasizeSeries(plot, ['altitude', 'velocity'], 'velocity', host);
    await Promise.resolve();
    expect(strokes).toContainEqual({ color: 'blue', width: 2, alpha: 0.35 });
    expect(strokes).toContainEqual({ color: 'red', width: 3, alpha: 1 });
    expect(bounds(plot)).toEqual([0, 4]); expect(plot.data).toEqual(before);
    strokes.length = 0;
    emphasizeSeries(plot, ['altitude', 'velocity'], null, host);
    await Promise.resolve();
    expect(strokes).toContainEqual({ color: 'blue', width: 2, alpha: 1 });
    expect(strokes).toContainEqual({ color: 'red', width: 2, alpha: 1 });
  });

  it('preserves a pending restored window even on an already initialized plot', async () => {
    const plot = new uPlot({ width: 640, height: 300, scales: { x: { time: false } },
      series: [{}, { stroke: 'blue' }] }, [[0, 1, 2, 3, 4], [0, 1, 2, 1, 0]], host);
    await Promise.resolve();
    expect(bounds(plot)).toEqual([0, 4]);
    plot.setScale('x', { min: 1, max: 2 });
    emphasizeSeries(plot, ['altitude'], 'altitude', host);
    await Promise.resolve();
    expect(bounds(plot)).toEqual([1, 2]);
  });

  it('initializes all three flight plots with finite time bounds', async () => {
    await renderCharts();
    expect(live()).toHaveLength(3);
    for (const plot of live()) expect(bounds(plot)).toEqual([0, 4]);
  });

  it('initializes a comparison with finite bounds and retains zoom while emphasizing', async () => {
    await renderCharts(); await compare();
    expect(live()).toHaveLength(4);
    for (const plot of live()) expect(bounds(plot)).toEqual([0, 4]);
    await act(async () => { for (const plot of live()) plot.setScale('x', { min: 1, max: 2 }); });
    const before = live().map((p) => structuredClone(p.data));
    const selection = [...host.querySelectorAll('[aria-label="Plot series"] button')].map((b) => b.getAttribute('aria-pressed'));
    await act(async () => button('Emphasize Velocity').click());
    live().forEach((plot, i) => {
      expect(bounds(plot)).toEqual([1, 2]); expect(plot.data).toEqual(before[i]);
    });
    const comparison = live().find((p) => p.series[1]!.scale === 'left')!;
    expect(comparison.series[1]!.alpha).toBe(0.35);
    expect(comparison.series[2]!.alpha).toBe(1);
    expect(comparison.series[2]!.width).toBeGreaterThan(comparison.series[1]!.width!);
    expect([...host.querySelectorAll('[aria-label="Plot series"] button')].map((b) => b.getAttribute('aria-pressed'))).toEqual(selection);
  });

  it.each(['Dark', 'Imperial', 'Sun', 'Expand Altitude chart', 'Expand Altitude + velocity chart'])(
    'preserves restored bounds and emphasis after %s recreation', async (action) => {
      await renderCharts(); await compare();
      await act(async () => button('Emphasize Velocity').click());
      // Seed a settled zoom even against the broken mount to isolate recreation.
      await act(async () => { for (const plot of live()) plot.setScale('x', { min: 1, max: 2 }); });
      const previous = live();
      await act(async () => {
        const control = action.startsWith('Expand') ? button(action)
          : [...host.querySelectorAll('button')].find((b) => b.textContent === action)!;
        control.click();
      });
      expect(live()).toHaveLength(4);
      expect(live().some((p) => !previous.includes(p))).toBe(true);
      for (const plot of live()) expect(bounds(plot)).toEqual([1, 2]);
      const comparison = live().find((p) => p.series[1]!.scale === 'left')!;
      expect(comparison.series[1]!.alpha).toBe(0.35);
      expect(comparison.series[2]!.width).toBeGreaterThan(comparison.series[1]!.width!);
    },
  );
});
