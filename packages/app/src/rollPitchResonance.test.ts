import { describe, expect, it } from 'vitest';
import type { FlightSeries } from '@online-openrocket/engine';
import { arbitraryCatalog, flightChartCatalogs, seriesCatalog, StyleAllocator, rollPitchResonance, withRollPitchRatio, withStabilityDiagnostics } from './flightChartModel.js';
import { LIGHT_PALETTE } from './chartTheme.js';
import { INITIAL_UNITS } from './prefs/units.js';
import { exportColumnCatalog } from './services/flightDataCsv.js';

const series = (time: number[], ratio: (number | null)[]) => ({ time, rollPitchRatio: ratio }) as unknown as FlightSeries;

describe('display-only roll–pitch ratio', () => {
  it('gives the merged UI catalogue unique styles and one shared ratio definition', () => {
    const raw = { time: [0, 1], ...Object.fromEntries(seriesCatalog({ units: INITIAL_UNITS }, LIGHT_PALETTE,
      undefined, false).map(d => [d.key, [1, 2]])), 'dΦ': [1, 3], Px: [1, 2], Py: [2, 3],
      Cd: [0.5, 0.6], Cdf: [0.1, 0.2], Il: [1, 1], Ir: [1, 1], 'ρ': [1, 1],
    } as unknown as FlightSeries;
    const { catalog, axesCatalog, plotCatalog } = flightChartCatalogs(
      withRollPitchRatio(withStabilityDiagnostics(raw)), { units: INITIAL_UNITS }, LIGHT_PALETTE);
    const looks = plotCatalog.map(d => `${d.color}|${(d.dash ?? []).join(',')}`);
    expect(new Set(looks).size).toBe(plotCatalog.length);
    const ratio = axesCatalog.find(d => d.key === 'rollPitchRatio');
    expect(ratio).toBeDefined();
    expect(catalog.find(d => d.key === 'rollPitchRatio')).toBe(ratio);
    expect(plotCatalog.find(d => d.key === 'rollPitchRatio')).toBe(ratio);
  });

  it('keeps every pre-ratio style identical to v0.209 and XLSX before and after full loading', () => {
    const prefs = { units: INITIAL_UNITS };
    const raw = { time: [0, 1], altitude: [1, 2], Cn: [1, 1], 'ωn': [2, 2], 'dΦ': [1, 3],
      Px: [1, 2], Py: [2, 3], Cd: [0.5, 0.6], Cdf: [0.1, 0.2], Il: [1, 1], Ir: [1, 1], 'ρ': [1, 1],
    } as unknown as FlightSeries;
    // v0.209: allocate the named definitions, then each raw extra in key order.
    const allocator = new StyleAllocator(LIGHT_PALETTE);
    const legacy = seriesCatalog(prefs, LIGHT_PALETTE, allocator, false);
    const columns = new Map(exportColumnCatalog().map(c => [c.key, c]));
    for (const key of Object.keys(raw)) {
      if (legacy.some(d => d.key === key)) continue;
      const quantity = columns.get(key)?.quantity;
      const token = quantity === 'altitude' ? 'altitude' : quantity === 'velocity' || quantity === 'windspeed' ? 'velocity'
        : quantity === 'acceleration' ? 'acceleration' : quantity === 'pressure' ? 'pressure' : null;
      legacy.push({ key, title: key, unit: '', ...allocator.next(token) });
    }
    const look = ({ color, dash }: (typeof legacy)[number]) => ({ color, dash });
    const screen = arbitraryCatalog(withRollPitchRatio(withStabilityDiagnostics(raw)), prefs, LIGHT_PALETTE);
    const xlsx = arbitraryCatalog(raw, prefs, LIGHT_PALETTE);
    const summary = { ...raw }; delete summary['ωn'];
    const beforeLoad = arbitraryCatalog(withRollPitchRatio(withStabilityDiagnostics(summary)), prefs, LIGHT_PALETTE);
    for (const def of screen.filter(d => d.key !== 'rollPitchRatio')) {
      expect(look(def), String(def.key)).toEqual(look(legacy.find(d => d.key === def.key)!));
      expect(look(def), String(def.key)).toEqual(look(xlsx.find(d => d.key === def.key)!));
      const previous = beforeLoad.find(d => d.key === def.key);
      if (previous) expect(look(def), String(def.key)).toEqual(look(previous));
    }
  });
  it('preserves existing series styles and export extra styles when the display ratio is absent', () => {
    const prefs = { units: INITIAL_UNITS };
    const old = seriesCatalog(prefs, LIGHT_PALETTE, undefined, false);
    const current = seriesCatalog(prefs, LIGHT_PALETTE);
    const looks = (catalog: typeof old) => catalog.map(({ key, color, dash, token }) => ({ key, color, dash, token }));
    expect(looks(current.filter(d => d.key !== 'rollPitchRatio'))).toEqual(looks(old));
    expect(current.map(d => d.key).slice(current.findIndex(d => d.key === 'ωn'), current.findIndex(d => d.key === 'ωn') + 2))
      .toEqual(['ωn', 'rollPitchRatio']);
    const styles = new StyleAllocator(LIGHT_PALETTE);
    seriesCatalog(prefs, LIGHT_PALETTE, styles, false);
    styles.next(null); // The raw time key precedes extra in arbitraryCatalog.
    const extraLook = styles.next(null);
    const raw = { time: [0], extra: [1] } as unknown as FlightSeries;
    const catalog = arbitraryCatalog(raw, prefs, LIGHT_PALETTE);
    expect(catalog).not.toContainEqual(expect.objectContaining({ key: 'rollPitchRatio' }));
    expect(catalog.find(d => d.key === 'extra')).toMatchObject(extraLook);
  });

  it('uses absolute roll and gated positive frequency, preserves absence and leaves the recording untouched', () => {
    const raw = { time: [0, 1, 2, 3, 4, 5, 6, 7], Cn: [null, 1, 1, 1, 1, 1, 1, 1],
      'dΦ': [1, -4, 1, 1, Infinity, 1, 1, Number.MAX_VALUE], 'ωn': [0, 2, 0, -1, 2, null, 2, Number.MIN_VALUE] } as unknown as FlightSeries;
    const before = structuredClone(raw);
    expect(withRollPitchRatio(withStabilityDiagnostics(raw, [{ type: 'TUMBLE', time: 6 }])).rollPitchRatio)
      .toEqual([null, 2, null, null, null, null, null, null]);
    expect(withRollPitchRatio(raw).rollPitchRatio?.[7]).toBeNull();
    expect(raw).toEqual(before);
    for (const key of ['dΦ', 'ωn']) {
      const missing = { ...raw }; delete missing[key];
      expect(withRollPitchRatio(missing)).not.toHaveProperty('rollPitchRatio');
    }
  });
});

describe('linearly interpolated resonance figures', () => {
  it('requires an in-window segment for an exact unity hit at apogee', () => {
    const events = [{ type: 'APOGEE', time: 1 }];
    const result = rollPitchResonance(series([0, 1, 2], [null, 1, 2]), events);
    expect(result).toEqual({ crossings: [], secondsInBand: 0, windowEnd: 1, sampled: true });
    expect(rollPitchResonance(series([0, 1, 2], [0, 1, null]), events).crossings).toEqual([1]);
    expect(rollPitchResonance(series([0, 1, 2], [null, 1, 2]), [{ type: 'APOGEE', time: 1.5 }]).crossings).toEqual([1]);
  });

  it('detects opposite signs even when the interpolated fraction rounds to an endpoint', () => {
    const crossings = rollPitchResonance(series([0, 1, 2], [3, 1 - Number.EPSILON / 2, 0.5]), []).crossings;
    expect(crossings).toHaveLength(1);
    expect(crossings[0]).toBeGreaterThanOrEqual(0);
    expect(crossings[0]).toBeLessThanOrEqual(1);
  });

  it('requires at least one finite neighbour for an exact unity sample', () => {
    expect(rollPitchResonance(series([0, 1, 2], [null, 1, null]), []).crossings).toEqual([]);
    expect(rollPitchResonance(series([1], [1]), []).crossings).toEqual([]);
    expect(rollPitchResonance(series([0, 1, 2], [null, 1, 2]), []).crossings).toEqual([1]);
    expect(rollPitchResonance(series([0, 1, 2], [0, 1, null]), []).crossings).toEqual([1]);
  });
  it('integrates a ramp exactly rather than counting samples', () => {
    const result = rollPitchResonance(series([0, 2], [0, 2]), []);
    expect(result.crossings).toEqual([1]);
    expect(result.secondsInBand).toBeCloseTo(0.3, 12);
    expect(result.windowEnd).toBe(2);
    expect(result.sampled).toBe(true);
  });

  it('counts exact hits and plateaus once, including a sine around one', () => {
    const time = Array.from({ length: 9 }, (_, i) => i * Math.PI / 2);
    const ratio = time.map((t, i) => i % 2 === 0 ? 1 : 1 + 0.5 * Math.sin(t));
    expect(rollPitchResonance(series(time, ratio), []).crossings).toEqual(time.filter((_, i) => i % 2 === 0));
    const plateau = rollPitchResonance(series([0, 1, 2, 3], [0, 1, 1, 2]), []);
    expect(plateau.crossings).toEqual([1]);
    expect(plateau.secondsInBand).toBeCloseTo(1.3, 12);
  });

  it('does not bridge nulls, invalid samples or invalid times', () => {
    const result = rollPitchResonance(series([0, 1, 2, 3, 4], [0, null, 2, 1, 0]), []);
    expect(result.crossings).toEqual([3]);
    expect(result.secondsInBand).toBeCloseTo(0.3, 12);
    for (const gap of [null, NaN, Infinity]) {
      expect(rollPitchResonance(series([0, 1, 2], [0, gap, 2]), []).crossings).toEqual([]);
    }
    expect(rollPitchResonance(series([0, NaN, 2], [0, 1, 2]), []).secondsInBand).toBe(0);
  });

  it('reports never-near and wholly-in-band intervals honestly', () => {
    expect(rollPitchResonance(series([0, 2], [0, 0.2]), []).secondsInBand).toBe(0);
    expect(rollPitchResonance(series([0, 2], [0, 0.2]), []).crossings).toEqual([]);
    expect(rollPitchResonance(series([0, 2], [0.9, 0.9]), []).secondsInBand).toBe(2);
    expect(rollPitchResonance(series([0, 2], [2, 0]), []).secondsInBand).toBeCloseTo(0.3, 12);
  });

  it('clips the last segment at apogee, including crossings only up to that instant', () => {
    const input = series([0, 2, 4], [0, 2, 0]);
    const result = rollPitchResonance(input, [{ type: 'APOGEE', time: 1.1 }]);
    expect(result.crossings).toEqual([1]);
    expect(result.secondsInBand).toBeCloseTo(0.25, 12);
    expect(result.windowEnd).toBe(1.1);
    expect(rollPitchResonance(input, [{ type: 'APOGEE', time: 0.5 }]).crossings).toEqual([]);
    expect(rollPitchResonance(input, [{ type: 'APOGEE', time: 1 }]).crossings).toEqual([1]);
  });

  it('handles absent/all-null data, isolated samples and a window before data begins', () => {
    const empty = { crossings: [], secondsInBand: 0, windowEnd: null, sampled: false };
    expect(rollPitchResonance(series([0, 1], [null, null]), [])).toEqual(empty);
    expect(rollPitchResonance({ time: [0, 1] } as FlightSeries, [])).toEqual(empty);
    expect(rollPitchResonance(series([2], [0.9]), [{ type: 'APOGEE', time: 1 }])).toEqual(empty);
    expect(rollPitchResonance(series([2], [0.9]), [])).toEqual({ ...empty, windowEnd: 2, sampled: true });
    expect(rollPitchResonance(series([0, 1, 2, 3], [null, 0, 2, null]), []).windowEnd).toBe(2);
  });
});
