import { describe, expect, it } from 'vitest';
import type { FlightSeries } from '@online-openrocket/engine';
import { PRESETS, comparisonMembers, convertedValues, phaseData, phaseRuns, seriesCatalog, usableSeries, withStabilityPercent } from './flightChartModel.js';
import { stabilityPercent } from './services/simReport.js';
import { METRIC_UNITS, IMPERIAL_UNITS } from './prefs/units.js';
import { SERIES } from './chartTheme.js';

const catalog = (imperial = false) => seriesCatalog({ units: imperial ? IMPERIAL_UNITS : METRIC_UNITS }, SERIES);
const series = (altitude: (number | null)[], velocity = altitude.map((_, i) => i + 10)) => ({
  time: altitude.map((_, i) => i), altitude, velocity,
  acceleration: altitude.map(() => 3), Vz: altitude.map(() => -2),
  stability: altitude.map(() => 2), cpLocation: altitude.map(() => 1), cgLocation: altitude.map(() => 0.8),
}) as unknown as FlightSeries;

describe('N042 percent of active aerodynamic length', () => {
  it('agrees with the static percent definition at launch and follows active lengths without changing SI data', () => {
    const info = { cp: 1, cg: 0.8, length: 2.8, lengthAerodynamic: 2 };
    const input = { ...series([0, 2, 4]), activeLength: [2, 1, 0.5] };
    const before = structuredClone(input);
    const output = withStabilityPercent(input);
    expect(output.stabilityPercent?.[0]).toBeCloseTo(stabilityPercent(info)!, 12); // arithmetic rounding only
    expect(output.stabilityPercent?.[1]).toBeCloseTo(20, 12);
    expect(output.stabilityPercent?.[2]).toBeCloseTo(40, 12);
    expect(input).toEqual(before);
    expect(output.stability).toBe(input.stability);
    expect(catalog(true).find(d => d.key === 'stabilityPercent')?.unit).toBe('%');
  });
  it('keeps unknown legacy geometry and invalid samples missing, including recovery and tumbling', () => {
    expect(withStabilityPercent(series([0])).stabilityPercent).toEqual([null]);
    const input = { ...series([0, 1, 2, 3, 4, 5, 6, 7]), activeLength: [1, 0, -1, Infinity, null, 1, 1, 1],
      cpLocation: [1, 1, 1, 1, 1, null, 1, 1] } as unknown as FlightSeries;
    const output = withStabilityPercent(input, [{ type: 'RECOVERY_DEVICE_DEPLOYMENT', time: 6 }]);
    expect(output.stabilityPercent?.slice(1)).toEqual([null, null, null, null, null, null, null]);
    expect(withStabilityPercent(input, [{ type: 'TUMBLE', time: 0 }]).stabilityPercent).toEqual(Array(8).fill(null));
  });
});

describe('comparison definitions and SI copies', () => {
  it('N032 charts altitude in its own unit and keeps the recorded SI series', () => {
    const input = series([0, 304.8, null]);
    const before = structuredClone(input);
    const altitude = seriesCatalog({ units: { ...METRIC_UNITS, altitude: 'ft', distance: 'km' } }, SERIES).find(d => d.key === 'altitude')!;
    expect(altitude.unit).toBe('ft');
    expect(altitude.quantity).toBe('altitude');
    expect(convertedValues(input, altitude)).toEqual([0, 1000, null]);
    expect(input).toEqual(before);
  });
  it('uses only summary quantities on explicitly compatible axes', () => {
    const expected = [
      [['altitude'], ['velocity']], [['altitude'], ['Vz']], [['velocity'], ['acceleration']],
      [['stability'], ['cpLocation', 'cgLocation']], [['velocity'], []],
    ];
    expect(PRESETS).toHaveLength(5);
    PRESETS.forEach((p, i) => {
      expect([p.left, p.right]).toEqual(expected[i]);
      expect(usableSeries(series([0, 2, 0]), [...p.left, ...p.right], p.x)).toBe(true);
      const members = comparisonMembers(p, catalog());
      for (const axis of ['left', 'right']) expect(new Set(members.filter((m) => m.axis === axis).map((m) => m.unit)).size).toBeLessThanOrEqual(1);
    });
  });
  it('converts every dimensional member while leaving SI untouched and null gaps intact', () => {
    const input = series([0, 1, null]);
    const before = structuredClone(input);
    const c = catalog(true);
    const get = (key: string) => convertedValues(input, c.find((d) => d.key === key)!);
    expect(get('altitude')).toEqual([0, 1 / 0.3048, null]);
    expect(get('velocity')[1]).toBeCloseTo(11 / 0.3048, 10);
    expect(get('acceleration')[0]).toBeCloseTo(3 / 0.3048, 10);
    expect(get('cpLocation')[0]).toBeCloseTo(1 / 0.0254, 10);
    expect(get('cgLocation')[0]).toBeCloseTo(0.8 / 0.0254, 10);
    expect(input).toEqual(before);
    expect(comparisonMembers(PRESETS[1]!, c)[1]!.f!(-2)).toBeCloseTo(-2 / 0.3048, 10);
  });
  it('offers Vertical velocity as its own chart, right after Velocity, in velocity units (v0.172, @atestani)', () => {
    const c = catalog(true);
    expect(c.slice(1, 3).map((d) => [d.key, d.title])).toEqual([['velocity', 'Velocity'], ['Vz', 'Vertical velocity']]);
    const vz = c.find((d) => d.key === 'Vz')!;
    expect(vz.unit).toBe(c.find((d) => d.key === 'velocity')!.unit);
    expect(convertedValues(series([0, 1, 2]), vz)[0]).toBeCloseTo(-2 / 0.3048, 10);
    // The comparison preset draws the same definition the chip does.
    expect(comparisonMembers(PRESETS[1]!, c)[1]).toMatchObject({ key: 'Vz', title: 'Vertical velocity', color: vz.color });
  });
  it('requires aligned finite samples, not just nonempty arrays', () => {
    const input = series([null, 1]);
    input.velocity = [2, NaN];
    expect(usableSeries(input, ['altitude', 'velocity'])).toBe(false);
    input.velocity[1] = 3;
    expect(usableSeries(input, ['altitude', 'velocity'])).toBe(true);
    input.time[1] = Infinity;
    expect(usableSeries(input, ['altitude', 'velocity'])).toBe(false);
  });
});

describe('phase runs preserve physical chronology', () => {
  it('splits interleaved ascent/descent and local reversals without sorting a connected flight', () => {
    const runs = phaseRuns(series([0, 10, 20, 15, 5, 8, -2]));
    expect(runs.map((r) => r.direction)).toEqual(['Rising', 'Falling', 'Rising', 'Falling']);
    expect(runs.map((r) => r.samples.map((s) => s.index))).toEqual([[0, 1, 2], [2, 3, 4], [4, 5], [5, 6]]);
  });
  it('preserves repeated altitudes, plateaus and isolated samples with original timestamps', () => {
    const input = series([0, 0, 0, 1, 1, 0, null, -2]);
    const runs = phaseRuns(input);
    expect(runs.map((r) => r.samples.map((s) => s.index))).toEqual([[0], [1], [2, 3], [4, 5], [7]]);
    expect(runs[0]!.direction).toBe('Point');
    expect(runs.at(-1)!.samples[0]).toEqual({ index: 7, time: 7, altitude: -2, velocity: 17 });
  });
  it('breaks at missing velocity, altitude and time rather than spanning real gaps', () => {
    const input = series([0, 1, null, 3, 4, 5, 6, 7]);
    input.velocity[4] = Infinity;
    input.time[6] = NaN;
    expect(phaseRuns(input).map((r) => r.samples.map((s) => s.index))).toEqual([[0, 1], [3], [5], [7]]);
  });
  it('aligns each run on increasing altitude with holes but no collision overwrites', () => {
    const c = catalog();
    const data = phaseData(series([0, 0, 10, 20, 15, 5, -2]), c[0]!, c[1]!);
    expect(data.xs).toEqual([-2, 0, 5, 10, 15, 20]);
    expect(data.values.map((v) => v.row)).toEqual([
      [null, 10, null, null, null, null],
      [null, 11, null, 12, null, 13],
      [16, null, 15, null, 14, 13],
    ]);
    expect(data.values[2]!.times).toEqual([6, null, 5, null, 4, 3]);
    const imperial = catalog(true);
    const converted = phaseData(series([0, 10, -2]), imperial[0]!, imperial[1]!);
    expect(converted.xs[0]).toBeCloseTo(-2 / 0.3048, 10);
    expect(converted.values[0]!.row[2]).toBeCloseTo(11 / 0.3048, 10);
  });
  it('handles empty and one-point data', () => {
    expect(phaseRuns(series([]))).toEqual([]);
    expect(phaseRuns(series([-1]))[0]!.direction).toBe('Point');
  });
});

it('marks both repeated-altitude samples even at the boundary of nontrivial runs', () => {
  const c = catalog();
  const data = phaseData(series([0, 1, 1, 2]), c[0]!, c[1]!);
  expect(data.values.map((v) => v.points)).toEqual([[1], [1]]);
  expect(data.values.map((v) => v.times[1])).toEqual([1, 2]);
  expect(phaseData(series([0, 1, 2]), c[0]!, c[1]!).values[0]!.points).toEqual([]);
});

// Mutation guard: Number(null) / null-coalescing must not fabricate a tip CP or zero stability.
it('keeps undefined CP and stability missing in individual and comparison charts', () => {
  // Friendly series names share the nullable JSON wire contract.
  const input = { ...series([0, 1, 2]), cpLocation: [1, null, 1.2], stability: [2, null, 3] } as unknown as FlightSeries;
  for (const imperial of [false, true]) {
    const c = catalog(imperial);
    const cp = c.find((d) => d.key === 'cpLocation')!;
    expect(convertedValues(input, cp)[1]).toBeNull();
    const members = comparisonMembers(PRESETS.find((p) => p.id === 'stability')!, c);
    expect(members.map((m) => convertedValues(input, m)[1])).toEqual([null, null, imperial ? 0.8 / 0.0254 : 80]);
    expect(convertedValues(input, cp)[0]).toBeCloseTo(imperial ? 1 / 0.0254 : 100, 10);
  }
  const missing = { ...input, time: [1], cpLocation: [null], stability: [null], cgLocation: [0.8] } as unknown as FlightSeries;
  expect(usableSeries(missing, ['cpLocation'])).toBe(false);
  expect(usableSeries(missing, ['stability', 'cpLocation', 'cgLocation'])).toBe(false);
});
