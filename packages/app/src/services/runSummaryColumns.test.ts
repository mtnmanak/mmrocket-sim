import { describe, expect, it } from 'vitest';
import { INITIAL_UNITS, IMPERIAL_UNITS } from '../prefs/units.js';
import type { SimRun } from './simReport.js';
import { DEFAULT_RUN_COLUMNS, normalizeRunColumns, RUN_SUMMARY_COLUMNS, summaryCell, summaryUnitSuffix } from './runSummaryColumns.js';

describe('saved-run summary columns (N058)', () => {
  it('N032 separates apogee, deployment and load heights from landing drift', () => {
    const units = { ...INITIAL_UNITS, altitude: 'ft', distance: 'km' };
    const peak = { value: 1, time: 1, altitude: 304.8, mach: 0.1, aoa: 0.01 };
    const run = { maxAltitude: 304.8, altitudeAtDeployment: 304.8, landingDistanceM: 2000,
      loads: { maxQ: peak, maxQAlpha: peak } } as SimRun;
    for (const id of ['maxAltitude', 'altitudeAtDeployment', 'maxQAltitude', 'maxQAlphaAltitude']) {
      const column = RUN_SUMMARY_COLUMNS.find(c => c.id === id)!;
      expect(column.quantity).toBe('altitude');
      expect(summaryCell(column, run, units)).toBe('1000');
    }
    expect(summaryCell(RUN_SUMMARY_COLUMNS.find(c => c.id === 'landingDistanceM')!, run, units)).toBe('2.00');
  });
  it('defaults to today’s four metrics and preserves valid viewer order', () => {
    expect(DEFAULT_RUN_COLUMNS).toEqual(['maxAltitude', 'maxVelocity', 'optimumDelayS', 'rodExitVelocity']);
    expect(normalizeRunColumns(undefined)).toBeUndefined();
    expect(normalizeRunColumns(['maxMach', 'maxAltitude', 'unknown', 'maxMach'])).toEqual(['maxMach', 'maxAltitude']);
    expect(normalizeRunColumns([])).toEqual([]);
    expect(normalizeRunColumns(['maxMach', null])).toBeUndefined();
  });
  it('reads recorded summaries, converts preferred units, and leaves missing legacy values blank', () => {
    const drift = RUN_SUMMARY_COLUMNS.find(c => c.id === 'landingDistanceM')!;
    const mach = RUN_SUMMARY_COLUMNS.find(c => c.id === 'maxMach')!;
    expect(summaryCell(drift, { landingDistanceM: 10 } as SimRun, IMPERIAL_UNITS)).toBe('32.8');
    expect(summaryCell(mach, { maxMach: 1.2 } as SimRun, INITIAL_UNITS)).toBe('1.2');
    for (const value of [undefined, null, NaN, Infinity, '10']) {
      expect(summaryCell(drift, { landingDistanceM: value } as SimRun, INITIAL_UNITS)).toBe('');
    }
    for (const column of RUN_SUMMARY_COLUMNS) expect(summaryCell(column, {} as SimRun, INITIAL_UNITS)).toBe('');
    const peak = RUN_SUMMARY_COLUMNS.find(c => c.id === 'maxQAlpha')!;
    expect(Number(summaryCell(peak, { loads: { maxQAlpha: { value: 1000 } } } as SimRun, INITIAL_UNITS))).toBeCloseTo(10 * 180 / Math.PI, 0);
  });
  it('shows q·alpha in preferred pressure and angle units', () => {
    const column = RUN_SUMMARY_COLUMNS.find(c => c.id === 'maxQAlpha')!;
    const run = { loads: { maxQAlpha: { value: 200 } } } as SimRun;
    expect.soft(summaryCell(column, run, INITIAL_UNITS)).toBe('115');
    expect.soft(summaryCell(column, run, { ...INITIAL_UNITS, angle: 'rad' })).toBe('2.00');
    expect.soft(summaryUnitSuffix(column, INITIAL_UNITS)).toBe('·°');
    expect.soft(summaryUnitSuffix(column, { ...INITIAL_UNITS, angle: 'rad' })).toBe('·rad');
  });
  it.each([0.05, 5, 50, 12345.678])('uses the adjacent pressure ladder for q·alpha at %s', pressure => {
    const q = RUN_SUMMARY_COLUMNS.find(c => c.id === 'maxQ')!;
    const qa = RUN_SUMMARY_COLUMNS.find(c => c.id === 'maxQAlpha')!;
    for (const angle of ['°', 'rad']) {
      const units = { ...INITIAL_UNITS, angle };
      const run = { loads: { maxQ: { value: pressure }, maxQAlpha: { value: pressure } } } as SimRun;
      expect(summaryCell(qa, run, units)).toBe(summaryCell(q, {
        loads: { maxQ: { value: pressure * (angle === 'rad' ? 1 : 180 / Math.PI) } },
      } as SimRun, units));
    }
  });
});
