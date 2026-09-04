import { describe, expect, it } from 'vitest';
import {
  IMPERIAL_UNITS, INITIAL_UNITS, METRIC_UNITS, UNITS,
  fmtSi, niceStep, siToUi, uiToSi, type Quantity,
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

/**
 * `fmtSi` is the ONE function that turns an internal SI value into the string a
 * user reads, and until 2026-09-04 nothing exercised it. It is consumed by ten
 * modules — schematicExport's L3/Tripoli cert-packet header, SimResults'
 * deployment/descent/landing readouts, StatTiles, FlyScreen, PropertyPanel,
 * RecoverySizingPanel — so a regression in its precision ladder changes printed
 * dimensions and flight numbers across the whole app at once. `npm test` does
 * not typecheck, so nothing else would have caught it either.
 */
describe('fmtSi — the app’s single SI display formatter', () => {
  it('walks the magnitude ladder: 3 dp below 1, then 2, then 1, then 0 at 100', () => {
    expect(fmtSi('length', 'm', 0.5)).toBe('0.500');
    expect(fmtSi('length', 'm', 0.999)).toBe('0.999');
    expect(fmtSi('length', 'm', 1)).toBe('1.00');
    expect(fmtSi('length', 'm', 9.99)).toBe('9.99');
    expect(fmtSi('length', 'm', 10)).toBe('10.0');
    expect(fmtSi('length', 'm', 99.9)).toBe('99.9');
    expect(fmtSi('length', 'm', 100)).toBe('100');
    expect(fmtSi('length', 'm', 1234.5)).toBe('1235');
  });

  it('chooses the band on the ABSOLUTE value, so a negative reads like its twin', () => {
    // Math.abs, not the signed value: a CG measured backwards from a reference
    // must not lose two decimals for being negative.
    expect(fmtSi('length', 'm', -0.5)).toBe('-0.500');
    expect(fmtSi('length', 'm', -10)).toBe('-10.0');
    expect(fmtSi('length', 'm', -100)).toBe('-100');
    expect(fmtSi('length', 'm', 0)).toBe('0.000');
  });

  it('formats in the SELECTED unit, not the internal one', () => {
    expect(fmtSi('length', 'mm', 0.0254)).toBe('25.4');
    expect(fmtSi('length', 'in', 0.0254)).toBe('1.00');
    expect(fmtSi('mass', 'g', 0.5)).toBe('500');
    expect(fmtSi('velocity', 'ft/s', 6.096)).toBe('20.0');
  });

  it('applies the temperature offset the same way siToUi does', () => {
    expect(fmtSi('temperature', '°F', 288.15)).toBe('59.0');
    expect(fmtSi('temperature', '°C', 288.15)).toBe('15.0');
    expect(fmtSi('temperature', 'K', 288.15)).toBe('288');
  });

  it('falls back to the quantity’s FIRST unit for a symbol it does not know', () => {
    // unitDef's `?? UNITS[quantity][0]` — a stale stored preference must print
    // a number in a known unit rather than NaN.
    expect(fmtSi('length', 'furlong', 0.001)).toBe(fmtSi('length', 'mm', 0.001));
  });

  it('the `digits` path shows UP TO that many decimals, stripping trailing zeros', () => {
    // Used by the CP/CG/length readouts, which the owner wants to 3 decimals
    // whatever the magnitude — the ladder above caps >= 10 at 1 dp, which lost
    // real precision on inch readouts.
    expect(fmtSi('length', 'in', 0.0254, 3)).toBe('1');
    expect(fmtSi('length', 'in', 0.0254 * 12.5, 3)).toBe('12.5');
    expect(fmtSi('length', 'm', 1.2345, 3)).toBe('1.234');   // toFixed, so it ROUNDS
    expect(fmtSi('length', 'm', 1.2346, 3)).toBe('1.235');
    expect(fmtSi('distance', 'ft', 45.72, 0)).toBe('150');
  });

  it('collapses a value below the requested precision to a bare 0', () => {
    // `String(Number('0.000'))` is '0', not '0.000'. That is deliberate for the
    // dimension readouts, and it is the branch most likely to be broken by a
    // well-meant "keep the decimals" change — so it is pinned.
    expect(fmtSi('length', 'm', 0.0001, 3)).toBe('0');
    expect(fmtSi('length', 'm', 0.0005, 3)).toBe('0.001');
  });
});

