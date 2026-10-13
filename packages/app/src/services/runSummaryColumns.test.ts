import { describe, expect, it } from 'vitest';
import { INITIAL_UNITS, IMPERIAL_UNITS } from '../prefs/units.js';
import type { SimRun } from './simReport.js';
import { DEFAULT_RUN_COLUMNS, normalizeRunColumns, RUN_SUMMARY_COLUMNS, summaryCell } from './runSummaryColumns.js';

describe('saved-run summary columns (N058)', () => {
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
    expect(Number(summaryCell(peak, { loads: { maxQAlpha: { value: 1000 } } } as SimRun, INITIAL_UNITS))).toBe(10);
  });
});
