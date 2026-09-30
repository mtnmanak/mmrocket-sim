import { describe, expect, it } from 'vitest';
import type { FlightSeries } from '@online-openrocket/engine';
import { PRESETS, comparisonMembers, convertedValues, phaseData, phaseRuns, seriesCatalog, usableSeries } from './flightChartModel.js';
import { METRIC_UNITS, IMPERIAL_UNITS } from './prefs/units.js';
import { SERIES } from './chartTheme.js';

const catalog = (imperial = false) => seriesCatalog({ units: imperial ? IMPERIAL_UNITS : METRIC_UNITS, theme: 'light', radiusMode: 'diameter' }, SERIES);
const series = (altitude: (number | null)[], velocity = altitude.map((_, i) => i + 10)) => ({
  time: altitude.map((_, i) => i), altitude, velocity,
  acceleration: altitude.map(() => 3), Vz: altitude.map(() => -2),
  stability: altitude.map(() => 2), cpLocation: altitude.map(() => 1), cgLocation: altitude.map(() => 0.8),
}) as unknown as FlightSeries;

describe('comparison definitions and SI copies', () => {
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
