import { describe, expect, it } from 'vitest';
import {
  IMPERIAL_UNITS, INITIAL_UNITS, METRIC_UNITS, UNITS,
  fmtSi, fmtSig, niceStep, readDecimal, siToUi, uiToSi, type Quantity,
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

describe('fmtSig — a display-unit value that does not collapse in a big unit', () => {
  /**
   * Audit 2026-09-22: decimal counts chosen for millimetres were inherited by
   * metres and feet — a 98 mm airframe read "0.1 m", 215 catalogue tube sizes
   * printed as 22 labels in metres, and a 0.4 mm wall showed "0".
   */
  it('keeps `places` decimals where they carry the figure, as the mm sites did', () => {
    expect(fmtSig(98, 3, 1)).toBe('98');        // trailing zero stripped
    expect(fmtSig(52.37, 3, 1)).toBe('52.4');
    expect(fmtSig(1219.2, 3, 0)).toBe('1219');  // the integer part is never rounded
    expect(fmtSig(304.8, 3, 1)).toBe('304.8');
    expect(fmtSig(100, 3, 0)).toBe('100');      // no point, so no zero is lost
    expect(fmtSig(12.3456789, 3, 3)).toBe('12.346');
  });

  it('switches to significant figures where `places` would flatten a small value', () => {
    expect(fmtSig(0.098, 3, 1)).toBe('0.098');
    expect(fmtSig(0.0004, 3, 3)).toBe('0.0004');
    expect(fmtSig(0.0254, 4, 2)).toBe('0.0254');
    expect(fmtSig(0.02413, 4, 2)).toBe('0.02413');
    expect(fmtSig(-0.0123456, 3, 1)).toBe('-0.0123');
  });

  it('prints zero as "0" and a non-finite value as a dash', () => {
    expect(fmtSig(0, 3, 3)).toBe('0');
    expect(fmtSig(Number.NaN, 3)).toBe('—');
    expect(fmtSig(Number.POSITIVE_INFINITY, 3)).toBe('—');
  });

  it('keeps two close tube sizes apart in metres and feet, where two decimals did not', () => {
    // Four figures, as the Scale dialog's size list uses. 23.00 and 24.13 mm
    // were one "0.02 m" label at two decimals.
    const m = (mm: number) => fmtSig(siToUi('length', 'm', mm / 1000), 4, 2);
    expect([m(23), m(24.13)]).toEqual(['0.023', '0.02413']);
    const ft = (mm: number) => fmtSig(siToUi('length', 'ft', mm / 1000), 4, 2);
    expect(ft(98)).toBe('0.3215');
  });
});


describe('readDecimal — the one parser behind every typed number', () => {
  it('reads what Number() reads, and refuses what is not one finite number', () => {
    expect(readDecimal('2.5')).toBe(2.5);
    expect(readDecimal(' -3 ')).toBe(-3);
    expect(readDecimal('.5')).toBe(0.5);
    for (const t of ['', '  ', '-', '.', 'abc', '1e400', 'Infinity', 'NaN']) {
      expect(readDecimal(t), t).toBeNull();
    }
  });

  /**
   * Audit 2026-09-22: in a comma-decimal locale an iPhone's decimal pad has no
   * "." key, and Number('1,5') is NaN, so no fraction could be typed at all.
   */
  it('accepts a single comma as the decimal separator', () => {
    for (const comma of [false, true]) {
      expect(readDecimal('1,5', comma)).toBe(1.5);
      expect(readDecimal('0,25', comma)).toBe(0.25);
      expect(readDecimal('-12,3456', comma)).toBe(-12.3456);
      expect(readDecimal('1,50', comma)).toBe(1.5);
      expect(readDecimal(',5', comma)).toBe(0.5);
    }
  });

  it('refuses "10,000" in a decimal-point locale rather than reading it as 10', () => {
    // A thousands group. Read as a decimal comma it would silently turn ten
    // thousand feet into ten; refused, the input shows its error border.
    expect(readDecimal('10,000', false)).toBeNull();
    expect(readDecimal('1,500', false)).toBeNull();
    // Where the locale itself writes a decimal comma, that is what it means.
    expect(readDecimal('1,500', true)).toBe(1.5);
  });

  it('refuses grouping it cannot read with certainty in any locale', () => {
    for (const comma of [false, true]) {
      expect(readDecimal('1,000,000', comma)).toBeNull();
      expect(readDecimal('1,000.5', comma)).toBeNull();
      expect(readDecimal('1.000,5', comma)).toBeNull();
    }
  });
});
