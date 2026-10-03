import { describe, expect, it } from 'vitest';
import type { FlightResult, FlightSeries } from '@online-openrocket/engine';
import { strFromU8, unzipSync } from 'fflate';
import { flightLoads, loadSeries, withLoadSeries } from './flightLoads.js';
import { flightDataCsv } from './flightDataCsv.js';
import { flightXlsx } from './flightXlsx.js';
import { runsToTable } from './simStore.js';
import type { SimRun } from './simReport.js';
import { INITIAL_UNITS } from '../prefs/units.js';
import { seriesCatalog } from '../flightChartModel.js';
import { DEFAULT_PREFS } from '../prefs/preferences.js';

const series = (): FlightSeries => ({
  time: [0, 1, 2, 3, 4, 5], altitude: [0, 20, 50, 80, 100, 90],
  velocity: [900, 900, 900, 900, 900, 900], // Ground speed must not enter q.
  mach: [0, 0.5, 1, 0.5, 3, 4], aoa: [0, 0.2, 0.01, 0.8, 1, 1],
  'ρ': [1.2, 1.2, 1, 1, 1, 1], Vs: [340, 320, 300, 280, 270, 260],
  acceleration: [], mass: [], thrust: [], drag: [], stability: [], cpLocation: [], cgLocation: [],
});
const result = (): FlightResult => ({ series: series(), events: [
  { type: 'BURNOUT', time: 1.5 }, { type: 'APOGEE', time: 4 },
  { type: 'RECOVERY_DEVICE_DEPLOYMENT', time: 4 },
], summary: {} as FlightResult['summary'] });

describe('sampled ascent loads', () => {
  it('uses the flown density and air-relative speed and picks independent maxima through coast', () => {
    const r = result();
    // Hand-computed from three different local atmospheres (rho in kg/m³, Vs in m/s):
    // t=1: 0.5*1.2*(0.5*320)^2=15360 Pa; t=2: 0.5*1*(1*300)^2=45000 Pa;
    // t=3: 0.5*1*(0.5*280)^2=9800 Pa. Neither ground speed nor a fixed Vs works.
    expect(loadSeries(r.series, r.events)['dynamicPressure']).toEqual([0, 15360, 45000, 9800, null, null]);
    const loads = flightLoads(r);
    expect(loads.maxQ).toEqual({ value: 45000, time: 2, altitude: 50, mach: 1, aoa: 0.01 });
    expect(loads.maxQAlpha).toEqual({ value: 7840, time: 3, altitude: 80, mach: 0.5, aoa: 0.8 });
    expect(loadSeries(r.series, r.events)['qAlpha']).toEqual([0, 3072, 450, 7840, null, null]);
  });
  it('excludes the deployment sample even before apogee (mutation guard)', () => {
    const r = result(); r.events[2]!.time = 2;
    expect(flightLoads(r).maxQ?.time).toBe(1);
    expect(loadSeries(r.series, r.events)['dynamicPressure']?.slice(2)).toEqual([null, null, null, null]);
  });
  it('includes apogee without recovery, excludes later samples and stops at tumbling', () => {
    const r = result(); r.events.pop();
    expect(flightLoads(r).maxQ?.time).toBe(4);
    r.events.push({ type: 'TUMBLE', time: 2 });
    expect(flightLoads(r).maxQ?.time).toBe(1);
  });
  it('leaves missing/null/nonfinite atmosphere unavailable and does not mutate source arrays', () => {
    const r = result(), original = structuredClone(r);
    const out = withLoadSeries(r);
    expect(out.series).not.toBe(r.series);
    expect(r).toEqual(original);
    delete r.series['Vs'];
    expect(flightLoads(r)).toEqual({ maxQ: null, maxQAlpha: null });
    r.series['Vs'] = [null, NaN, Infinity, -1, 300, 300];
    expect(flightLoads(r)).toEqual({ maxQ: null, maxQAlpha: null });
  });
  it('uses each booster branch’s own recovery window', () => {
    const r = result(); r.branches = [{ name: 'Sustainer', events: r.events, series: r.series },
      { name: 'Booster', events: [{ type: 'RECOVERY_DEVICE_DEPLOYMENT', time: 1 }], series: series() }];
    expect(withLoadSeries(r).branches?.[1]?.series['dynamicPressure']).toEqual([0, null, null, null, null, null]);
  });
  it('falls back to recorded peak altitude without an apogee event and refuses an unknown window', () => {
    const r = result(); r.events = [];
    expect(flightLoads(r).maxQ?.time).toBe(4);
    r.series.altitude = [];
    expect(flightLoads(r)).toEqual({ maxQ: null, maxQAlpha: null });
  });
});

it('converts pressure and pressure-times-radians consistently in plots, CSV, XLSX and run tables', () => {
  const r = result(), units = { ...INITIAL_UNITS, pressure: 'bar' };
  const csv = flightDataCsv(r, units).split('\n').map(l => l.split(','));
  const q = csv[0]!.indexOf('Dynamic pressure (bar)'), qa = csv[0]!.indexOf('q·α (bar·rad)');
  expect(q).toBeGreaterThan(0); expect(qa).toBeGreaterThan(q);
  expect(Number(csv[3]![q])).toBeCloseTo(0.45, 10);
  expect(Number(csv[4]![qa])).toBeCloseTo(0.0784, 10);
  expect(csv[5]![q]).toBe('');
  const files = unzipSync(flightXlsx(r, units));
  const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
  expect(sheet).toContain('Dynamic pressure (bar)'); expect(sheet).toContain('q·α (bar·rad)');
  expect(sheet).toContain('<v>0.45</v>'); expect(sheet).toContain('<v>0.0784</v>');
  const table = runsToTable([{ when: 0, loads: flightLoads(r) } as SimRun], units);
  expect(table.headers).toContain('Max dynamic pressure (bar)');
  expect(table.rows[0]![table.headers.indexOf('Max dynamic pressure (bar)')]).toBe(0.45);
  expect(table.rows[0]![table.headers.indexOf('Max q·α (bar·rad)')]).toBe(0.0784);
  const catalog = seriesCatalog({ ...DEFAULT_PREFS, units }, ['red','blue','green','gray','orange','pink','black','purple']);
  expect(catalog.find(d => d.key === 'dynamicPressure')?.f?.(45000)).toBe(0.45);
  expect(catalog.find(d => d.key === 'qAlpha')?.unit).toBe('bar·rad');
});
