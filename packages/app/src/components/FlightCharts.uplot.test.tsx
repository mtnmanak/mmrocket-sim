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
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
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
