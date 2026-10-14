import { describe, expect, it, vi } from 'vitest';
import type { FlightSeries } from '@online-openrocket/engine';
import { arbitraryCatalog, phaseData } from './flightChartModel.js';
import { eventMarkers, eventPlugin } from './flightPlotEvents.js';
import { METRIC_UNITS, IMPERIAL_UNITS } from './prefs/units.js';
import { SERIES } from './chartTheme.js';

const series = { time: [0, 1, 2, 3, 4, 5], altitude: [0, 1, 2, 3, 4, 5],
  velocity: [10, 11, 12, 13, 14, 15], Px: [0, 1, 1, -1, null, 2], Py: [0, 2, 3, 4, 5, 6],
  Cd: [0.2, 0.3], tc: [1, 2], future: [2, 3] } as unknown as FlightSeries;

describe('C-E7 recorded axes', () => {
  it('names and converts recorded symbols, excludes wall-clock noise, and labels unknown units', () => {
    const defs = arbitraryCatalog(series, { units: IMPERIAL_UNITS }, SERIES);
    expect(defs.find(d => d.key === 'Px')).toMatchObject({ title: 'Position East of launch', unit: 'ft' });
    expect(defs.find(d => d.key === 'Px')!.f!(1)).toBeCloseTo(1 / 0.3048, 10); // unit conversion rounding
    expect(defs.find(d => d.key === 'Cd')).toMatchObject({ title: 'Drag coefficient', unit: '' });
    expect(defs.some(d => d.key === 'tc')).toBe(false);
    expect(defs.find(d => d.key === 'future')?.unit).toBe('unit unknown');
  });
  it.each([METRIC_UNITS, IMPERIAL_UNITS])('reverses every converted custom axis, including compound and offset units', units => {
    const input = { ...series, qAlpha: [100, 200], aoa: [1, 2], T: [273.15, 300], P: [100, 200], 'θl': [1, 2] };
    const defs = arbitraryCatalog(input, { units }, SERIES);
    for (const def of defs.filter(d => d.f)) {
      expect(def.toSI, String(def.key)).toBeTypeOf('function');
      for (const sample of [0, 1, 273.15]) expect(def.toSI!(def.f!(sample))).toBeCloseTo(sample, 10); // unit arithmetic only
    }
    expect(defs.find(d => d.key === 'qAlpha')!.unit).toBe(`${units.pressure}·rad`);
    expect(defs.find(d => d.key === 'θl')!.unit).toBe(units.angle);
  });
  it('preserves repeated X, reversals, gaps and timestamps for a ground track without mutating SI', () => {
    const before = structuredClone(series);
    const defs = arbitraryCatalog(series, { units: METRIC_UNITS }, SERIES);
    const data = phaseData(series, defs.find(d => d.key === 'Px')!, defs.find(d => d.key === 'Py')!);
    expect(data.xs).toEqual([-1, 0, 1, 1, 2]);
    expect(data.runs.map(r => r.samples.map(s => s.index))).toEqual([[0, 1], [2, 3], [5]]);
    expect(data.values.map(v => v.times)).toEqual([[null, 0, 1, null, null], [3, null, null, 2, null], [null, null, null, null, 5]]);
    expect(data.values.map(v => v.row)).toEqual([[null, 0, 2, null, null], [4, null, null, 3, null], [null, null, null, null, 6]]);
    expect(data.values.map(v => v.segments)).toEqual([[[1, 2]], [[3, 0]], [[4]]]);
    expect(series).toEqual(before);
  });
});

describe('C-E7 branch event markers', () => {
  it('uses exact finite branch times, keeps separate deployments, and honours event selection', () => {
    const events = [{ type: 'LAUNCH', time: 0 }, { type: 'BURNOUT', time: 1.25 },
      { type: 'RECOVERY_DEVICE_DEPLOYMENT', time: 2, source: 'Drogue' },
      { type: 'RECOVERY_DEVICE_DEPLOYMENT', time: 3, source: 'Main' },
      { type: 'APOGEE', time: NaN }, { type: 'GROUND_HIT', time: 4 }, { type: 'TUMBLE', time: 1 }];
    expect(eventMarkers(events, ['BURNOUT', 'RECOVERY_DEVICE_DEPLOYMENT']).map(e => [e.time, e.label]))
      .toEqual([[1.25, 'Burnout'], [2, 'Deployment: Drogue'], [3, 'Deployment: Main']]);
  });
  it.each([1, 2])('clips markers and keeps labels readable at pixel ratio %s', ratio => {
    vi.stubGlobal('devicePixelRatio', ratio);
    const ctx = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
      stroke: vi.fn(), setLineDash: vi.fn(), fillText: vi.fn() };
    const plot = { ctx, bbox: { left: 10, top: 20, width: 100, height: 80 },
      valToPos: (v: number) => v * 10 + 10, scales: { x: { min: 1, max: 4 } } };
    const plugin = eventPlugin([{ type: 'LAUNCH', time: 0 }, { type: 'BURNOUT', time: 2.5 }], ['LAUNCH', 'BURNOUT'], '#000');
    const draw = plugin.hooks!.draw as (u: unknown) => void;
    draw(plot);
    expect(ctx.moveTo).toHaveBeenCalledExactlyOnceWith(35, 20);
    expect(ctx.fillText).toHaveBeenCalledWith('2', 35 + 3 * ratio, 20 + 26 * ratio);
    expect(ctx).toMatchObject({ font: `${12 * ratio}px system-ui`, lineWidth: ratio });
    vi.unstubAllGlobals();
  });
});
