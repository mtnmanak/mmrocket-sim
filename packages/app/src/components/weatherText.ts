import { fmtAltitude, fmtFieldValue, fmtSi, siToUi, type UnitSelection } from '../prefs/units.js';
import type { Endpoint } from '../services/openMeteo.js';
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

/**
 * A wind speed (m/s) in the user's unit, with the digits the Wind avg and
 * Wind gusts σ boxes show — NumField's own formatter, not a coarser one. So
 * the σ the gust chip offers is the number the σ box then reads, and the
 * average in its arithmetic is the one the Wind avg box reads (review of
 * 2026-09-23: both printed to 0.1, "0.9" and "1.8" over boxes reading 0.95
 * and 1.75). The gust, which has no box, prints the same way, so the
 * arithmetic adds up in any unit.
 */
export function windNumber(sym: string, ms: number): string {
  return Number.isFinite(ms) ? fmtFieldValue(siToUi('windspeed', sym, ms)) : '—';
}

/** `windNumber` with its unit: "0.95 m/s". */
export const windText = (sym: string, ms: number): string => `${windNumber(sym, ms)} ${sym}`;

/** One weather field's stored value, as the user reads it, with its unit. */
export function fieldText(key: ApplyKey, stored: number, units: UnitSelection): string {
  switch (key) {
    case 'temperatureC':
      return `${fmtSi('temperature', units.temperature, stored + 273.15, 1)} ${units.temperature}`;
    case 'pressureHPa':
      return `${fmtSi('pressure', units.pressure, stored * 100, PRESSURE_DIGITS[units.pressure] ?? 2)} ${units.pressure}`;
    case 'windAverage':
      return windText(units.windspeed, stored);
    case 'launchAltitudeM':
      return altitudeText(units.distance, stored);
    case 'latitudeDeg':
    case 'longitudeDeg':
      return `${Number(stored.toFixed(5))}°`.replace(/^-/, '−');
  }
}

/**
 * WHAT THE FETCHED NUMBERS ARE, as every label names them: a forecast — or,
 * for a date the ERA5 archive answers, a reanalysis, the weather as it was
 * (weather build, step 3; review of 2026-09-23). The first build said
 * "forecast" in the review, the wind note, the strip's stale line and each
 * field's provenance whatever the endpoint, so a re-fly of a 2019 flight read
 * as a forecast for it. One word per endpoint, read by all of them.
 */
export function sourceWord(endpoint: Endpoint): 'forecast' | 'reanalysis' {
  return endpoint === 'archive' ? 'reanalysis' : 'forecast';
}

/**
 * Whether the weather UI's dates carry their year: for an ERA5 answer, which
 * can be any day back to 1940 — the strip is saved with the session and
 * outlives the dialog's Date box, and a re-fly's read "Sat 14 Jun" with no
 * year (review of 2026-09-23). A forecast is never more than 92 days before
 * or 15 after the day it is fetched, and its dates stay short.
 */
export const showsYear = (endpoint: Endpoint): boolean => endpoint === 'archive';

/** "Forecast" / "Reanalysis" — a source word opening a line or a column. */
export const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The review's and the strip's heading, before the place: "Forecast for" or "ERA5 reanalysis for". */
export function sourceHeading(endpoint: Endpoint): string {
  return endpoint === 'archive' ? 'ERA5 reanalysis for' : 'Forecast for';
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
