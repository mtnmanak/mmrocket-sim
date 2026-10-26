import { describe, expect, it } from 'vitest';
import { INITIAL_UNITS, IMPERIAL_UNITS, type UnitSelection } from '../prefs/units.js';
import { baseLabel, massTextFor, padMassTextFor, statedWeightTextFor } from './unitText.js';

/**
 * The words App's notes are written with, in the user's units — moved out of
 * App's body (2026-10-01) so the headless Launch writes the same import and
 * pad-mass notes with no React mounted. They change words only, never a number.
 */
const US: UnitSelection = { ...INITIAL_UNITS, mass: 'oz', length: 'in' };

describe('unitText', () => {
  it.each([
    [INITIAL_UNITS, '100 g (3.53 oz)', '25.4 mm (1 in)'],
    [IMPERIAL_UNITS, '3.53 oz (100 g)', '1 in (25.4 mm)'],
  ] as const)('pairs physical quantities in mass and stated-weight notices (%j)', (units, mass, length) => {
    expect(massTextFor(units)(0.1)).toBe(mass);
    expect(statedWeightTextFor(units).length(0.0254)).toBe(length);
  });
  it('names a mass in the unit asked for, with the unit after it', () => {
    expect(massTextFor(INITIAL_UNITS)(0.1)).toBe('100 g (3.53 oz)');
    expect(massTextFor(US)(0.1)).toMatch(/^3\.\d+ oz \(100 g\)$/);
  });

  it('builds the stated-weight words from the mass and length units', () => {
    const t = statedWeightTextFor(US);
    expect(t.mass(0.1)).toBe(massTextFor(US)(0.1));
    expect(t.length(0.0254)).toBe('1 in (25.4 mm)');
    // Three significant places, the stated-weight sentence's precision (App's own call).
    expect(t.length(0.0123)).toBe('0.484 in (12.3 mm)');
  });

  it('names a motor by its base label for a pad-mass note: no delay grain, no auto tag', () => {
    const t = padMassTextFor(INITIAL_UNITS);
    expect(t.mass(0.1)).toBe('100 g (3.53 oz)');
    expect(t.motorName('H220-14')).toBe('H220');
    expect(t.motorName('H220-P')).toBe('H220');
    expect(t.motorName('H220 (auto delay)')).toBe('H220');
    expect(baseLabel('C6-5')).toBe('C6');
    expect(baseLabel('BB-54-2550 (auto delay)')).toBe('BB-54-2550');
    expect(t.motorName('BB-54-2550-P')).toBe('BB-54-2550');
    for (const suffix of ['', '-9', ' (auto delay)']) {
      expect(baseLabel('N1975W-PS' + suffix)).toBe('N1975W-PS');
      expect(t.motorName('N1975W-PS' + suffix)).toBe('N1975W-PS');
    }
  });
});
