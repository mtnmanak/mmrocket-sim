import { fmtAltitude, fmtSi, type UnitSelection } from '../prefs/units.js';
import type { ApplyKey } from '../services/weatherSnapshot.js';

/**
 * How the weather UI words its numbers (weather build, step 3) — the review,
 * the Launch panel's strip and the gust chip read the same fields, so they
 * format them in one place, in the user's own units.
 */

/** "3,944 ft" — an altitude to read, grouped, with its unit. */
export function altitudeText(sym: string, m: number): string {
  const s = fmtAltitude(sym, m);
  const n = Number(s);
  return Number.isFinite(n) ? `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${sym}` : s;
}

/** Decimals a pressure reads to, by unit: 877.2 mbar, 25.90 inHg, 0.8772 bar. */
const PRESSURE_DIGITS: Readonly<Record<string, number>> = {
  mbar: 1, Pa: 0, bar: 4, atm: 4, mmHg: 1, inHg: 2, psi: 2,
};

/** A distance to read in the user's unit family: km for metric, mi for imperial. */
export function farText(sym: string, m: number): string {
  const imperial = sym === 'ft' || sym === 'yd' || sym === 'mi';
  const v = imperial ? m / 1609.344 : m / 1000;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${imperial ? 'mi' : 'km'}`;
}

/** One weather field's stored value, as the user reads it, with its unit. */
export function fieldText(key: ApplyKey, stored: number, units: UnitSelection): string {
  switch (key) {
    case 'temperatureC':
      return `${fmtSi('temperature', units.temperature, stored + 273.15, 1)} ${units.temperature}`;
    case 'pressureHPa':
      return `${fmtSi('pressure', units.pressure, stored * 100, PRESSURE_DIGITS[units.pressure] ?? 2)} ${units.pressure}`;
    case 'windAverage':
      return `${fmtSi('windspeed', units.windspeed, stored, 1)} ${units.windspeed}`;
    case 'launchAltitudeM':
      return altitudeText(units.distance, stored);
    case 'latitudeDeg':
    case 'longitudeDeg':
      return `${Number(stored.toFixed(5))}°`.replace(/^-/, '−');
  }
}

/** The panel's own label for each field the weather can write. */
export const FIELD_LABEL: Readonly<Record<ApplyKey, string>> = {
  temperatureC: 'Temperature',
  pressureHPa: 'Station pressure',
  windAverage: 'Wind avg',
  launchAltitudeM: 'Site altitude',
  latitudeDeg: 'Latitude',
  longitudeDeg: 'Longitude',
};
