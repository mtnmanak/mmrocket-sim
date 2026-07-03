import { describe, expect, it } from 'vitest';
import {
  IMPERIAL_UNITS, INITIAL_UNITS, METRIC_UNITS, UNITS,
  niceStep, siToUi, uiToSi, type Quantity,
} from './units.js';

describe('unit conversions (factors from desktop UnitGroup 24.12)', () => {
  it('round-trips every unit of every quantity', () => {
    for (const q of Object.keys(UNITS) as Quantity[]) {
      for (const u of UNITS[q]) {
        const si = 123.456;
        expect(uiToSi(q, u.symbol, siToUi(q, u.symbol, si))).toBeCloseTo(si, 9);
      }
    }
  });

  it('converts known values', () => {
    expect(siToUi('length', 'in', 0.0254)).toBeCloseTo(1);
    expect(siToUi('length', 'mm', 0.001)).toBeCloseTo(1);
    expect(siToUi('mass', 'oz', 0.0283495231)).toBeCloseTo(1);
    expect(siToUi('mass', 'lb', 0.45359237)).toBeCloseTo(1);
    expect(siToUi('velocity', 'mph', 0.44704)).toBeCloseTo(1);
    expect(siToUi('acceleration', 'G', 9.80665)).toBeCloseTo(1);
    expect(siToUi('distance', 'ft', 0.3048)).toBeCloseTo(1);
    expect(siToUi('density', 'g/cm³', 1000)).toBeCloseTo(1);
    expect(siToUi('pressure', 'mbar', 101325)).toBeCloseTo(1013.25);
  });

  it('handles temperature offsets like the desktop (si = (ui + offset) * factor)', () => {
    expect(siToUi('temperature', '°C', 273.15)).toBeCloseTo(0);
    expect(siToUi('temperature', '°F', 273.15)).toBeCloseTo(32);
    expect(uiToSi('temperature', '°F', 212)).toBeCloseTo(373.15);
    expect(siToUi('temperature', 'K', 288.15)).toBeCloseTo(288.15);
  });

  it('every default set only references units that exist', () => {
    for (const sel of [INITIAL_UNITS, METRIC_UNITS, IMPERIAL_UNITS]) {
      for (const q of Object.keys(UNITS) as Quantity[]) {
        expect(UNITS[q].some((u) => u.symbol === sel[q]), `${q}: ${sel[q]}`).toBe(true);
      }
    }
  });

  it('niceStep snaps to 1-2-5', () => {
    expect(niceStep(0.03937)).toBeCloseTo(0.05);
    expect(niceStep(1)).toBe(1);
    expect(niceStep(1.8)).toBe(2);
    expect(niceStep(0.393)).toBeCloseTo(0.5);
    expect(niceStep(39.37)).toBeCloseTo(50);
    expect(niceStep(0)).toBe(1);
  });
});
