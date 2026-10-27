// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type uPlot from 'uplot';
import type { FlightResult, FlightSeries } from '@online-openrocket/engine';
import { FlightCharts } from './FlightCharts.js';
import { PrefsProvider, usePrefs } from '../prefs/PrefsContext.js';
import { METRIC_UNITS } from '../prefs/units.js';
import { lineStyle, slotOf } from '../chartTheme.js';
import { strFromU8, unzipSync } from 'fflate';
import { flightXlsx } from '../services/flightXlsx.js';
import * as fileName from '../services/fileName.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const registry = vi.hoisted(() => ({ plots: [] as Plot[] }));
interface Plot {
  opts: uPlot.Options; data: uPlot.AlignedData; scales: Record<string, { min: number; max: number }>;
  series: uPlot.Series[]; over: HTMLElement; dead: boolean;
  setScale: (key: string, win: { min: number; max: number }) => void;
}
vi.mock('uplot', () => ({ default: class {
  opts: uPlot.Options; data: uPlot.AlignedData; scales: Plot['scales']; series: uPlot.Series[];
  over = document.createElement('div'); cursor = { idx: 0, top: 10, left: 10 }; dead = false;
  constructor(opts: uPlot.Options, data: uPlot.AlignedData, el: HTMLElement) {
    this.opts = opts; this.data = data; this.series = opts.series;
    this.scales = { x: { min: data[0][0] ?? 0, max: data[0].at(-1) ?? 1 }, left: { min: 0, max: 1 }, y: { min: 0, max: 1 } };
    el.append(document.createElement('canvas'), this.over); registry.plots.push(this);
    for (const plugin of opts.plugins ?? []) {
      const init = plugin.hooks?.init;
      if (typeof init === 'function') init(this as unknown as uPlot, opts, data);
    }
  }
  setScale(key: string, win: { min: number; max: number }) {
    this.scales[key] = win;
    for (const plugin of this.opts.plugins ?? []) {
      const hook = plugin.hooks?.setScale;
      if (typeof hook === 'function') hook(this as unknown as uPlot, key);
    }
  }
  valToPos(v: number) { return v; }
  posToVal(v: number) { return v; }
  setSize() {}
  redraw() {}
  destroy() { this.dead = true; this.over.parentElement?.replaceChildren(); }
} }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
const live = () => registry.plots.filter((p) => !p.dead);
const overlay = () => live().find((p) => p.series[1]?.scale === 'left')!;
const timePlots = () => live().filter((p) => p.opts.cursor?.sync?.key === 'flight');
const select = (name: string, value: string) => act(() => {
  const el = [...host.querySelectorAll('label')].find((l) => l.textContent?.startsWith(name))!.querySelector('select')!;
  el.value = value; el.dispatchEvent(new Event('change', { bubbles: true }));
});
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
const data = (offset = 0): FlightSeries => ({
  time: [offset, offset + 1, offset + 2, offset + 3, offset + 4],
  altitude: [0, 10, 20, 15, -2], velocity: [0, 11, 22, 13, 4], acceleration: [1, 2, 3, 2, 1],
  Vz: [0, 10, 0, -10, -2], stability: [2, 2, 2, 2, 2], cpLocation: [1, 1, 1, 1, 1], cgLocation: [0.8, 0.8, 0.8, 0.8, 0.8],
}) as unknown as FlightSeries;
const result = (): FlightResult => ({ series: data(), events: [], summary: {} }) as unknown as FlightResult;
function ThemeControl() {
  const { prefs, setPrefs } = usePrefs();
  return <><button onClick={() => setPrefs({ ...prefs, theme: 'light', themeExplicit: true })}>Light</button>
    <button onClick={() => setPrefs({ ...prefs, daylight: true })}>Sun</button></>;
}
const render = (flight: FlightResult, full?: () => Promise<FlightResult>, flightName = 'Test rocket · C6 (Estes)') => act(() => root.render(
  <PrefsProvider><ThemeControl /><FlightCharts result={flight} onFullSeries={full} flightName={flightName} /></PrefsProvider>,
));
const wheel = (p: Plot) => act(() => { p.over.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { deltaY: -100, deltaMode: 0, clientX: 1 })); });
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: METRIC_UNITS }));
  registry.plots.length = 0; host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe('flight comparisons wiring', () => {
  it('updates an established status when a selected branch lacks comparison data', () => {
    const flight = result(); flight.branches = [
      { name: 'Core', series: flight.series, events: [] },
      { name: 'Booster', series: { ...data(), velocity: [] }, events: [] },
    ];
    render(flight); select('Comparison chart', 'phase');
    const regions = new Set(host.querySelectorAll('[role="status"]'));
    select('Flight branch', '1');
    const note = [...host.querySelectorAll('[role="status"]')].find(el => el.textContent?.includes('no usable data'))!;
    expect(note).toBeDefined();
    expect(regions.has(note)).toBe(true);
  });
  it('C-E7 custom axes and ground tracks preserve chronology, isolated zoom, emphasis and saved choices', () => {
    const flight = result(); flight.series.Px = [0, 1, 1, -1, 0]; flight.series.Py = [0, 2, 3, 4, 5];
    const before = structuredClone(flight);
    render(flight); select('Comparison chart', 'custom');
    select('Custom X axis', 'Px'); select('Custom Y axis', 'Py');
    expect(overlay().series[0]!.label).toBe('Position East of launch (m)');
    expect(overlay().opts.cursor?.sync).toBeUndefined();
    const windows = timePlots().map(p => ({ ...p.scales['x'] }));
    wheel(overlay());
    expect(timePlots().map(p => p.scales['x'])).toEqual(windows);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Emphasize Position North of launch"]')!.click());
    expect(overlay().series.slice(1).every(s => s.alpha === 1)).toBe(true);
    const input = host.querySelector('.saved-flight-plots input') as HTMLInputElement;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Track');
      input.dispatchEvent(new Event('input', { bubbles: true })); });
    act(() => button('Save current plots').click()); select('Comparison chart', '');
    act(() => button('Apply').click());
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Custom X axis"]')!.value).toBe('Px');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Custom Y axis"]')!.value).toBe('Py');
    expect(overlay().series[1]!.label).toContain('Position North');
    select('Comparison chart', 'ground-track');
    expect(host.textContent).toContain('Ground track');
    expect(host.textContent).toContain('axes can have different scales');
    expect(flight).toEqual(before);
  });
  it('C-E7 events belong to the selected branch, toggle separately from quantities, and never mark phase charts', () => {
    const flight = result(); flight.events = [{ type: 'LAUNCH', time: 0 }, { type: 'APOGEE', time: 2 }];
    flight.branches = [{ name: 'Core', series: flight.series, events: flight.events },
      { name: 'Booster', series: data(), events: [{ type: 'BURNOUT', time: 0.5 }] }];
    render(flight); select('Comparison chart', 'altitude-velocity');
    const drawnTimes = (plot: Plot) => {
      const ctx = { save() {}, restore() {}, beginPath() {}, moveTo: vi.fn(), lineTo: vi.fn(), stroke() {}, setLineDash() {}, fillText() {},
        closePath() {}, fill() {} };
      for (const plugin of plot.opts.plugins ?? []) {
        const draw = plugin.hooks?.draw;
        if (typeof draw === 'function') draw({ ...plot, ctx, bbox: { left: 0, top: 0, width: 200, height: 100 },
          valToPos: (t: number) => t } as unknown as uPlot);
      }
      // Each marker's hairline: a moveTo with a lineTo straight down from it
      // (its cap's moveTo, half a cap to the left, has none).
      return ctx.moveTo.mock.calls.filter(([x, y]) => ctx.lineTo.mock.calls.some(([lx, ly]) => lx === x && ly !== y))
        .map(call => call[0]);
    };
    for (const plot of timePlots()) expect(drawnTimes(plot)).toEqual([0, 2]);
    expect(host.querySelectorAll('[aria-label="Flight event key"]')).toHaveLength(4);
    expect(host.querySelector('[aria-label="Flight event key"]')!.textContent).toContain('Apogee at 2 s');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Show event: Apogee"]')!.click());
    expect(host.querySelector('[aria-label="Flight event key"]')!.textContent).not.toContain('Apogee');
    expect(timePlots()).toHaveLength(4);
    select('Flight branch', '1');
    for (const plot of timePlots()) expect(drawnTimes(plot)).toEqual([0.5]);
    expect(host.querySelector('[aria-label="Flight event key"]')!.textContent).toContain('Burnout at 0.5 s');
    expect(host.querySelector('[aria-label="Flight event key"]')!.textContent).not.toContain('Launch');
    select('Comparison chart', 'phase');
    expect(host.querySelector('.comparison-panel [aria-label="Flight event key"]')).toBeNull();
    expect(host.querySelectorAll('.chart-panel button[aria-label^="Save image:"]')).toHaveLength(4);
  });
  it('C-E7 loads full plot quantities only on request, reports failure, and shares export busy protection', async () => {
    const flight = result(); const full = { ...flight, series: { ...flight.series, Cd: [0.3, 0.4, 0.5, 0.4, 0.3] } };
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(full);
    render(flight, load); select('Comparison chart', 'custom');
    expect(load).not.toHaveBeenCalled();
    await act(async () => button('Load all plot series').click());
    expect(host.textContent).toContain('offline');
    await act(async () => button('Load all plot series').click());
    select('Custom Y axis', 'Cd');
    expect(overlay().series[1]!.label).toBe('Drag coefficient');
    expect(overlay().data[1]).toEqual(full.series.Cd);
    expect(flight.series.Cd).toBeUndefined();
    render(result(), load); select('Comparison chart', 'custom');
    expect(host.textContent).toContain('no usable data');
  });
  it('C-E7 custom time charts join time zoom; changing X starts an independent window', () => {
    render(result()); select('Comparison chart', 'custom');
    expect(timePlots()).toHaveLength(4); wheel(overlay());
    expect(timePlots().every(p => p.scales['x']!.max < 4)).toBe(true);
    select('Custom X axis', 'altitude');
    expect(overlay().scales['x']).toEqual({ min: -2, max: 20 });
    expect(timePlots()).toHaveLength(3);
    select('Custom X axis', 'time');
    expect(overlay().scales['x']).toEqual(timePlots()[0]!.scales['x']);
  });
  it.each(['stale', 'running'])('C-E7 refuses to load extra quantities while %s', condition => {
    const load = vi.fn();
    act(() => root.render(<PrefsProvider><FlightCharts result={result()} flightName="Protected flight" onFullSeries={load}
      staleReason={condition === 'stale' ? 'the weighed pad mass' : null} flightRunning={condition === 'running'} /></PrefsProvider>));
    select('Comparison chart', 'custom');
    expect(button('Load all plot series').disabled).toBe(true);
    act(() => button('Load all plot series').click()); expect(load).not.toHaveBeenCalled();
  });
  it('C-E7 extra-series loading disables downloads until it settles', async () => {
    let finish!: (flight: FlightResult) => void;
    render(result(), () => new Promise(resolve => { finish = resolve; }));
    select('Comparison chart', 'custom'); act(() => button('Load all plot series').click());
    expect(button('⬇ Flight data (.csv)').disabled).toBe(true);
    expect(button('Re-flying…').disabled).toBe(true);
    await act(async () => finish(result()));
    expect(button('⬇ Flight data (.csv)').disabled).toBe(false);
  });
  it('C-E7 identical custom axes retain chronological samples without duplicate table keys', () => {
    render(result()); select('Comparison chart', 'custom'); select('Custom X axis', 'velocity'); select('Custom Y axis', 'velocity');
    const error = vi.spyOn(console, 'error');
    const details = host.querySelector<HTMLDetailsElement>('.comparison-panel details')!;
    act(() => { details.open = true; details.dispatchEvent(new Event('toggle')); });
    expect(host.querySelectorAll('.comparison-panel th')).toHaveLength(3);
    expect(error).not.toHaveBeenCalled();
  });
  it('N032 time and phase altitude axes follow Altitude and keep SI samples', () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { ...METRIC_UNITS, altitude: 'ft', distance: 'km' } }));
    const flight = result(), before = structuredClone(flight);
    render(flight);
    const height = live().find(p => String(p.series[1]?.label).startsWith('Altitude'))!;
    expect(height.series[1]?.label).toContain('(ft)');
    expect(height.data[1]?.[1]).toBeCloseTo(10 / 0.3048, 12); // conversion arithmetic only
    select('Comparison chart', 'phase');
    expect(overlay().data[0].some(v => Math.abs(v - 20 / 0.3048) < 1e-10)).toBe(true);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Altitude unit"]')?.value).toBe('ft');
    const chip = host.querySelector<HTMLSelectElement>('[aria-label="Altitude unit"]')!;
    act(() => { chip.value = 'm'; chip.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(overlay().data[0]).toContain(20);
    expect(JSON.parse(localStorage.getItem('online-openrocket.prefs.v1')!).units.distance).toBe('km');
    expect(flight).toEqual(before);
  });
  it('recalls panel and comparison selections across units and missing branch data without changing the flight', () => {
    const flight = result();
    flight.branches = [{ name: 'Core', series: flight.series, events: [] },
      { name: 'Booster', series: { ...data(), velocity: [] }, events: [] }];
    const before = structuredClone(flight);
    render(flight);
    select('Comparison chart', 'phase');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Emphasize Velocity"]')!.click());
    act(() => button('Velocity').click());
    const input = host.querySelector('.saved-flight-plots input') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'My coast');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => button('Save current plots').click());
    select('Comparison chart', '');
    act(() => button('Velocity').click());
    select('Flight branch', '1');
    act(() => button('Apply').click());
    expect(host.textContent).toContain('This flight branch has no usable data for this comparison.');
    expect(host.querySelector('[aria-label="Emphasize Velocity"]')).toBeNull();
    select('Flight branch', '0');
    expect(overlay().series[1]!.label).toContain('Velocity');
    expect(overlay().series.slice(1).every(s => s.alpha === 1 && s.width === 3)).toBe(true);
    expect(host.querySelectorAll('.charts-grid .chart-panel')).toHaveLength(2);
    act(() => {
      const unit = host.querySelector<HTMLSelectElement>('[aria-label="Velocity unit"]')!;
      unit.value = 'ft/s'; unit.dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => button('Apply').click());
    expect(overlay().series[1]!.label).toContain('ft/s');
    expect(overlay().series.slice(1).every(s => s.alpha === 1 && s.width === 3)).toBe(true);
    expect(flight).toEqual(before);
    const stored = JSON.parse(localStorage.getItem('online-openrocket.prefs.v1')!);
    expect(stored.flightPlots[0]).toMatchObject({ name: 'My coast', panels: ['altitude', 'acceleration'], comparison: 'phase' });
  });
  it('plots percent stability using each branch recording and preserves the caliber series', () => {
    const flight = result(); flight.series.activeLength = [2, 2, 1, 1, 1];
    flight.branches = [{ name: 'Core', series: flight.series, events: [] },
      { name: 'Booster', series: { ...data(), activeLength: [2, 2, 0.5, 0.5, 0.5] }, events: [] }];
    const before = structuredClone(flight);
    render(flight);
    act(() => button('Stability margin (% of active length)').click());
    const percent = () => live().find(p => String(p.series[1]?.label).includes('% of active length'))!;
    expect(percent().data[1]![2]).toBeCloseTo(20, 12);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Emphasize Stability margin (% of active length)"]')!.click());
    expect(percent().series[1]!.alpha).toBe(1);
    expect(live().find(p => String(p.series[1]?.label).startsWith('Altitude'))!.series[1]!.alpha).toBe(0.35);
    select('Flight branch', '1');
    expect(percent().data[1]![2]).toBeCloseTo(40, 12);
    expect(percent().series[1]!.alpha).toBe(1);
    expect(live().find(p => String(p.series[1]?.label).startsWith('Altitude'))!.series[1]!.alpha).toBe(0.35);
    act(() => button('Stability margin').click());
    expect(live().find(p => p.series[1]?.label === 'Stability margin (cal)')!.data[1]).toEqual([2, 2, 2, 2, 2]);
    expect(host.textContent).toContain('after recovery deployment or tumbling');
    expect(flight).toEqual(before);
  });
  it('N012 keeps Emphasize swatches at full opacity in sun mode without filling plot-selection chips', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8');
    document.head.append(style);
    host.className = 'viz-root';
    host.dataset['contrast'] = 'high';
    try {
      render(result());
      act(() => button('Sun').click());
      // Line samples since brand v1 (they were colour dots).
      const dots = host.querySelectorAll('.flight-series-legend .line-sample');
      expect(dots.length).toBeGreaterThan(1);
      for (const dot of dots) expect(getComputedStyle(dot).opacity).toBe('1');
      const offDot = host.querySelector('[aria-label="Plot series"] .series-chip:not(.series-chip-on) .line-sample')!;
      expect(offDot).not.toBeNull();
      expect(getComputedStyle(offDot).opacity).toBe('0.55');
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="Emphasize Velocity"]')!.click());
      for (const dot of dots) expect(getComputedStyle(dot).opacity).toBe('1');
    } finally {
      style.remove();
      host.className = '';
      delete host.dataset['contrast'];
    }
  });
  it('N012 emphasizes on hover, focus and tap without changing selection, data or zoom', () => {
    render(result()); select('Comparison chart', 'altitude-velocity'); wheel(overlay());
    const plots = live();
    const before = plots.map((p) => ({ data: structuredClone(p.data), scales: structuredClone(p.scales) }));
    const selected = [...host.querySelectorAll('[aria-label="Plot series"] button')].map((b) => b.getAttribute('aria-pressed'));
    const entry = () => host.querySelector<HTMLButtonElement>('[aria-label="Emphasize Velocity"]')!;
    expect(entry()).not.toBeNull();
    act(() => { entry().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect(overlay().series[1]!.alpha).toBeLessThan(1);
    expect(overlay().series[2]!.alpha).toBe(1);
    expect(overlay().series[2]!.width).toBeGreaterThan(overlay().series[1]!.width!);
    act(() => { entry().dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
    expect(overlay().series.slice(1).every((s) => s.alpha === 1)).toBe(true);
    const altitudeEntry = host.querySelector<HTMLButtonElement>('[aria-label="Emphasize Altitude"]')!;
    act(() => { altitudeEntry.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect(overlay().series[2]!.alpha).toBeLessThan(1);
    act(() => entry().focus());
    expect(overlay().series[1]!.alpha).toBeLessThan(1);
    expect(overlay().series[2]!.alpha).toBe(1);
    act(() => entry().blur());
    act(() => entry().click());
    expect(entry().getAttribute('aria-pressed')).toBe('true');
    expect(overlay().series[1]!.alpha).toBeLessThan(1);
    act(() => entry().click());
    expect(entry().getAttribute('aria-pressed')).toBe('false');
    expect(overlay().series.slice(1).every((s) => s.alpha === 1)).toBe(true);
    act(() => entry().click());
    act(() => { entry().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(entry().getAttribute('aria-pressed')).toBe('false');
    expect(overlay().series.slice(1).every((s) => s.alpha === 1)).toBe(true);
    expect(live()).toEqual(plots);
    plots.forEach((p, i) => { expect(p.data).toEqual(before[i]!.data); expect(p.scales).toEqual(before[i]!.scales); });
    expect([...host.querySelectorAll('[aria-label="Plot series"] button')].map((b) => b.getAttribute('aria-pressed'))).toEqual(selected);
  });
  it('N012 keeps emphasis through theme changes and applies it to every phase segment', () => {
    render(result()); select('Comparison chart', 'phase');
    const velocity = host.querySelector<HTMLButtonElement>('[aria-label="Emphasize Velocity"]')!;
    act(() => velocity.click());
    expect(overlay().series.slice(1).every((s) => s.alpha === 1 && s.width === 3)).toBe(true);
    act(() => button('Light').click());
    expect(overlay().series.slice(1).every((s) => s.alpha === 1 && s.width === 3)).toBe(true);
    // Re-pinned for brand v1: the colour is READ FROM CSS (--chart-velocity at
    // the app root), not picked from a TS palette, so a theme switch re-reads it.
    host.className = 'viz-root';
    host.style.setProperty('--chart-velocity', '#005a32');
    act(() => button('Sun').click());
    expect(overlay().series.slice(1).every((s) => s.alpha === 1 && s.width === 3)).toBe(true);
    expect(overlay().series[1]!.stroke).toBe('#005a32');
    host.className = '';
    host.style.removeProperty('--chart-velocity');
    expect(velocity.querySelector<HTMLElement>('.series-emphasis-mark')!.style.visibility).toBe('visible');
    const altitude = host.querySelector<HTMLButtonElement>('[aria-label="Emphasize Altitude"]')!;
    act(() => altitude.click());
    expect(overlay().series.slice(1).every((s) => s.alpha === 0.35)).toBe(true);
  });
  it('identifies every single-stage plot in normal, expanded and zoomed views', () => {
    render(result());
    const check = () => {
      const headings = [...host.querySelectorAll('.chart-panel h3')];
      expect(headings.length).toBeGreaterThanOrEqual(3);
      for (const h of headings) {
        expect(h.textContent).toContain('Test rocket · C6 (Estes)');
        expect(h.textContent).not.toContain('Sustainer stack');
      }
      for (const c of host.querySelectorAll('canvas')) expect(c.getAttribute('aria-label')).toContain('Test rocket · C6 (Estes)');
    };
    check();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Expand Altitude chart"]')!.click());
    wheel(timePlots()[0]!); check();
    for (const preset of ['altitude-velocity', 'altitude-vertical', 'velocity-acceleration', 'stability', 'phase']) {
      select('Comparison chart', preset); check();
      act(() => button('Expand').click()); wheel(overlay()); check();
    }
  });
  it('identifies the selected staged branch, including duplicate names, and resets for a new flight', () => {
    const flight = result();
    flight.branches = [{ name: 'Same', series: flight.series, events: [] },
      { name: 'Same', series: data(10), events: [] }, { name: 'Same', series: data(20), events: [] }];
    render(flight); select('Comparison chart', 'phase');
    const check = (identity: string, flightName = 'Test rocket · C6 (Estes)') => {
      expect(host.querySelector('h2')!.textContent).toBe('Flight plots');
      expect(host.querySelector('.flight-identity')?.textContent).toBe(flightName);
      for (const h of host.querySelectorAll('.chart-panel h3')) expect(h.textContent).toContain(identity);
      for (const c of host.querySelectorAll('canvas')) expect(c.getAttribute('aria-label')).toContain(identity);
    };
    check('Test rocket · C6 (Estes) · Sustainer stack');
    select('Flight branch', '1'); check('Test rocket · C6 (Estes) · Booster 1: Same');
    select('Flight branch', '2'); check('Test rocket · C6 (Estes) · Booster 2: Same');
    act(() => button('Expand').click()); wheel(overlay());
    check('Test rocket · C6 (Estes) · Booster 2: Same');
    render(result(), undefined, 'Next rocket · D12 (Estes)');
    check('Next rocket · D12 (Estes)', 'Next rocket · D12 (Estes)');
    expect(host.querySelector('.chart-panel h3')!.textContent).not.toContain('Booster');
  });
  it('keeps three separate defaults and all five optional presets with summary Vz', () => {
    render(result()); expect(live()).toHaveLength(3); expect(host.querySelector('.comparison-panel')).toBeNull();
    expect([...host.querySelector('.comparison-controls select')!.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'None', 'Altitude + velocity', 'Altitude + vertical velocity', 'Velocity + acceleration', 'Stability + CP + CG', 'Velocity vs altitude', 'Custom plot', 'Ground track',
    ]);
    select('Comparison chart', 'altitude-vertical'); expect(live()).toHaveLength(4);
    expect(overlay().data[2]).toEqual([0, 10, 0, -10, -2]); expect(overlay().series[2]!.label).toBe('Vertical velocity (m/s)');
    select('Comparison chart', ''); expect(live()).toHaveLength(3);
  });
  it('labels compatible axes in the axis ink, with distinct CP/CG keys and dashes', () => {
    render(result()); select('Comparison chart', 'stability'); const p = overlay();
    expect(p.opts.axes?.map((a) => a.scale)).toEqual([undefined, 'left', 'right']);
    expect(p.opts.axes?.[2]?.side).toBe(1); expect(p.opts.axes?.[2]?.grid?.show).toBe(false);
    expect(p.series.slice(1).map((s) => s.scale)).toEqual(['left', 'right', 'right']);
    expect(p.series[2]!.dash).not.toEqual(p.series[3]!.dash);
    expect(host.querySelectorAll('.comparison-axis-key svg')).toHaveLength(3);
    // Re-pinned for brand v1 (SPEC §3.2, labels in the text colour): a
    // single-member axis was inked in its series colour; every axis now takes
    // the axis ink, and the axis keys carry the line samples.
    for (const a of p.opts.axes ?? []) expect(a.stroke).toBe(p.opts.axes![0]!.stroke);
    expect(p.opts.axes?.[1]?.stroke).not.toBe(p.series[1]!.stroke);
    expect(p.series.slice(1).map((s) => String(s.dash))).toEqual(['6,4', String(p.series[2]!.dash), String(p.series[3]!.dash)]);
    const summary = host.querySelector('.comparison-panel canvas')!.getAttribute('aria-label');
    for (const text of ['left axis: Stability margin (cal)', 'right axis: CP location (cm)', 'right axis: CG location (cm)']) expect(summary).toContain(text);
  });
  it('locks every flight legend against hiding a fixed curve', () => {
    render(result()); select('Comparison chart', 'altitude-velocity');
    for (const p of live()) expect(p.opts.cursor?.bind?.click?.(p as unknown as uPlot, p.over, () => null)).toBeNull();
    expect(host.querySelectorAll('.chart-legend-locked')).toHaveLength(4);
  });
  it('syncs time overlays while phase wheel and both reset actions remain independent', () => {
    render(result()); select('Comparison chart', 'altitude-velocity'); wheel(overlay());
    expect(new Set(timePlots().map((p) => JSON.stringify(p.scales['x']))).size).toBe(1);
    expect(timePlots()[0]!.scales['x']!.max).toBeLessThan(4);
    select('Comparison chart', 'phase'); const phase = overlay();
    expect(phase.opts.cursor?.sync).toBeUndefined(); expect(phase.series.slice(1).every((s) => typeof s.paths === 'function')).toBe(true);
    // Re-pinned for brand v1 (fix pass): rising is velocity's own long dash,
    // falling a second velocity-coloured style — never the reference 6 4 —
    // and not vertical velocity's dots (velocity's tier 1), so it is velocity's
    // tier 2, solid. It was solid rising and the reference 6 4 falling.
    expect(phase.series[1]!.dash).toEqual(lineStyle(slotOf('velocity')));
    expect(phase.series[2]!.dash).toEqual(lineStyle(slotOf('velocity'), 2));
    expect(phase.series[2]!.dash).toBeUndefined();
    expect(phase.series.slice(1).map((s) => String(s.dash))).not.toContain('6,4');
    const before = JSON.stringify(timePlots().map((p) => p.scales['x'])); wheel(phase);
    expect(JSON.stringify(timePlots().map((p) => p.scales['x']))).toBe(before);
    const phaseBefore = { ...phase.scales['x']! }; wheel(timePlots()[0]!); expect(phase.scales['x']).toEqual(phaseBefore);
    act(() => button('Reset time charts').click()); expect(phase.scales['x']).toEqual(phaseBefore);
    act(() => button('Reset altitude chart').click()); expect(phase.scales['x']).toEqual({ min: -2, max: 20 });
    expect(timePlots()[0]!.scales['x']).toEqual({ min: 0, max: 4 });
  });
  it('preserves phase bounds physically across units, theme and expansion', () => {
    render(result()); select('Comparison chart', 'phase'); act(() => overlay().setScale('x', { min: 2, max: 8 }));
    const distance = host.querySelector('.comparison-panel select[aria-label="Altitude unit"]') as HTMLSelectElement;
    act(() => { distance.value = 'ft'; distance.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(overlay().scales['x']!.min).toBeCloseTo(2 / 0.3048, 10); expect(overlay().scales['x']!.max).toBeCloseTo(8 / 0.3048, 10);
    act(() => button('Light').click()); act(() => button('Expand').click());
    expect(overlay().scales['x']!.min).toBeCloseTo(2 / 0.3048, 10);
  });
  it('uses booster indices and own recordings, resets branch windows, discards old result selections', () => {
    const flight = result(); flight.branches = [{ name: 'Same', series: flight.series, events: [] },
      { name: 'Same', series: data(10), events: [] }, { name: 'Same', series: data(20), events: [] }];
    render(flight); select('Comparison chart', 'phase');
    expect(host.querySelectorAll('.comparison-controls label:last-child option')).toHaveLength(3);
    act(() => overlay().setScale('x', { min: 2, max: 8 })); select('Flight branch', '2');
    expect(timePlots()[0]!.data[0]).toEqual([20, 21, 22, 23, 24]); expect(overlay().scales['x']).toEqual({ min: -2, max: 20 });
    expect(host.querySelector('.comparison-panel canvas')!.getAttribute('aria-label')).toContain('Booster 2: Same');
    render(result()); expect(timePlots()[0]!.data[0][0]).toBe(0);
    expect([...host.querySelectorAll('label')].some((l) => l.textContent?.startsWith('Flight branch'))).toBe(false);
  });
  it('explains missing aligned data without a full re-flight', () => {
    const flight = result(); flight.series.Vz = [null]; render(flight); select('Comparison chart', 'altitude-vertical');
    expect(host.textContent).toContain('This flight branch has no usable data for this comparison.'); expect(overlay()).toBeUndefined();
  });
  it('names physical altitude extent, phase timestamps and chronological table samples', () => {
    render(result()); select('Comparison chart', 'phase'); const p = overlay();
    const summary = host.querySelector('.comparison-panel canvas')!.getAttribute('aria-label');
    expect(summary).toContain('Altitude above launch: -2 to 20 m'); expect(summary).toContain('Falling portion');
    const value = p.series[2]!.value;
    expect(typeof value === 'function' && value(p as unknown as uPlot, 13, 2, 3)).toContain('t = 3 s');
    const details = host.querySelector('details')!; act(() => { details.open = true; details.dispatchEvent(new Event('toggle')); });
    expect(host.querySelector('table')!.textContent).toContain('Altitude (m)'); expect(host.querySelector('table')!.textContent).toContain('Velocity (m/s)');
    expect([...host.querySelectorAll('tbody tr')].map((r) => r.firstElementChild?.textContent)).toEqual(['0', '1', '2', '3', '4']);
  });
  it('downloads the whole recording regardless of branch, comparison and zoom, with flight-only block identity', async () => {
    const flight = result(); flight.branches = [{ name: 'S', series: flight.series, events: [] }, { name: 'B', series: data(10), events: [] }];
    const fullFlight = structuredClone(flight);
    fullFlight.series['Cdf'] = [0.01, 0.02, 0.03, 0.02, 0.01];
    fullFlight.branches![0]!.series = fullFlight.series;
    const full = vi.fn(async () => fullFlight); const download = vi.spyOn(fileName, 'downloadBlob').mockImplementation(() => {});
    render(flight, full); select('Comparison chart', 'phase'); select('Flight branch', '1'); wheel(overlay());
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Flight data (.csv)'))!.click());
    expect(full).toHaveBeenCalledOnce(); const blob = download.mock.calls[0]![0] as Blob; const csv = await blob.text();
    expect(csv).toContain('Acceleration');
    const lines = csv.replace(/^\uFEFF/, '').split('\n');
    const headers = lines[0]!.split(',');
    expect(headers.filter((h) => h.startsWith('Acceleration ('))).toHaveLength(1);
    expect(headers.some((h) => h.startsWith('Cdf '))).toBe(true);
    const boosterTime = headers.findIndex((h) => h.startsWith('B ') && h.includes('Time (s)'));
    expect(boosterTime).toBeGreaterThan(0);
    expect(lines[1]!.split(',')[0]).toBe('0');
    expect(lines[1]!.split(',')[boosterTime]).toBe('10');
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Flight data + charts (.xlsx)'))!.click());
    const workbook = unzipSync(new Uint8Array(await (download.mock.calls[1]![0] as Blob).arrayBuffer()));
    const canonical = unzipSync(flightXlsx(fullFlight, METRIC_UNITS));
    expect(Object.keys(workbook).sort()).toEqual(Object.keys(canonical).sort());
    for (const key of Object.keys(canonical)) expect(strFromU8(workbook[key]!)).toBe(strFromU8(canonical[key]!));
    // The block names the whole flight exported above; only chart headings
    // name the branch whose samples are currently plotted.
    const checkIdentity = (branchName: string) => {
      const heading = host.querySelector('h2')!;
      const identity = host.querySelector('.flight-identity');
      expect(identity?.textContent).toBe('Test rocket · C6 (Estes)');
      expect(heading.parentElement!.nextElementSibling).toBe(identity);
      expect(heading.parentElement!.textContent).not.toContain(branchName);
      for (const h of host.querySelectorAll('.chart-panel h3')) {
        expect(h.textContent).toContain(`Test rocket · C6 (Estes) · ${branchName}`);
      }
    };
    checkIdentity('Booster 1: B');
    select('Flight branch', '0'); checkIdentity('Sustainer stack');
    select('Flight branch', '1'); checkIdentity('Booster 1: B');
  });
});

it('pages comparison samples without truncating the recording', () => {
  const flight = result();
  flight.series = { ...data(), time: Array.from({ length: 205 }, (_, i) => i),
    altitude: Array.from({ length: 205 }, (_, i) => i), velocity: Array<number>(205).fill(3) };
  render(flight); select('Comparison chart', 'altitude-velocity');
  const details = host.querySelector('details')!;
  act(() => { details.open = true; details.dispatchEvent(new Event('toggle')); });
  expect(host.querySelectorAll('tbody tr')).toHaveLength(100);
  act(() => button('Next samples').click());
  expect(host.querySelector('tbody td')!.textContent).toBe('100');
  act(() => button('Next samples').click());
  expect(host.querySelectorAll('tbody tr')).toHaveLength(5);
  expect(button('Next samples').disabled).toBe(true);
  act(() => button('Previous samples').click());
  expect(host.querySelector('tbody td')!.textContent).toBe('100');
});

it('renders constant-altitude samples as separate points and retains their times', () => {
  const flight = result(); flight.series.altitude = [0, 0, 0, 0, 0];
  render(flight); select('Comparison chart', 'phase');
  expect(overlay().series).toHaveLength(2);
  expect(overlay().series.slice(1).every((s) => s.points?.show === true)).toBe(true);
  expect(overlay().data).toEqual([[0, 0, 0, 0, 0], [0, 11, 22, 13, 4]]);
  const plot = overlay();
  const value = plot.series[1]!.value as (u: uPlot, v: number, si: number, idx: number) => string;
  expect(Array.from(plot.data[1]!).map((v, i) => value(plot as unknown as uPlot, v!, 1, i)))
    .toEqual(['0 (Point, t = 0 s)', '11 (Point, t = 1 s)', '22 (Point, t = 2 s)', '13 (Point, t = 3 s)', '4 (Point, t = 4 s)']);
});

it('time comparisons preserve the current group window across theme and expansion', () => {
  render(result()); select('Comparison chart', 'altitude-velocity'); wheel(overlay());
  const before = { ...overlay().scales['x']! };
  act(() => button('Light').click()); act(() => button('Expand').click());
  for (const p of timePlots()) expect(p.scales['x']).toEqual(before);
});

it('pans every synced time chart with a shift-drag on the comparison chart (audit 2026-09-30)', () => {
  // The pointer path through the mounted charts; chartPanZoom.pan.test.ts
  // drives the plugin's gestures one by one.
  render(result()); select('Comparison chart', 'altitude-velocity'); wheel(overlay());
  const before = { ...timePlots()[0]!.scales['x']! };
  const drag = (type: string, x: number) => act(() => {
    overlay().over.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0,
      buttons: type === 'pointerup' ? 0 : 1, shiftKey: true, clientX: x,
    }));
  });
  drag('pointerdown', 2); drag('pointermove', 2.5); drag('pointerup', 2.5);
  expect(new Set(timePlots().map((p) => JSON.stringify(p.scales['x']))).size).toBe(1);
  expect(timePlots()[0]!.scales['x']).not.toEqual(before);
});

it('synchronizes only x across time charts with incompatible vertical dimensions', () => {
  render(result()); select('Comparison chart', 'altitude-velocity');
  for (const p of timePlots()) expect(p.opts.cursor?.sync?.scales).toEqual(['x', null]);
});

it('passes explicit collision marker indices to uPlot without marking every sample', () => {
  const flight = result(); flight.series.altitude = [0, 1, 1, 2, 3];
  render(flight); select('Comparison chart', 'phase');
  expect(overlay().series.slice(1).map((s) => s.points?.filter)).toEqual([[1, 2]]);
});
