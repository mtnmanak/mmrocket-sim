import type { LaunchConditions } from '../components/LaunchPanel.js';
import { padAir } from './atmosphere.js';
import type { Endpoint, PlaceMethod } from './openMeteo.js';

/**
 * WHERE THE LAUNCH CONDITIONS' WEATHER CAME FROM (weather build, step 3).
 *
 * Applying a forecast writes ordinary launch conditions — they fly, save and
 * share exactly as typed ones do, and fly offline. What this module keeps
 * BESIDE them is the provenance: what was fetched, for where and when, what
 * was applied, and what each applied field held before. That is what lets the
 * panel say "forecast" or "edited — forecast said 22.9 °C" per field, offer
 * Undo, notice that the Site altitude moved out from under an applied
 * temperature and pressure, and (step 4) offer a gust-based σ.
 *
 * It is SESSION state, not design state: it is not in `designFingerprint`,
 * `conditionsKeyOf`, the .ork or a share link — where a number came from is
 * not physics, and a file handed to someone else carries the numbers, not the
 * story. It is cleared when an opened design brings launch conditions of its
 * own (App.applyImported).
 *
 * Everything here is pure; App owns the state.
 */

/** The launch fields Apply may write — and the only ones. Wind gusts σ is NEVER among them. */
export const APPLY_KEYS = [
  'temperatureC', 'pressureHPa', 'windAverage', 'launchAltitudeM', 'latitudeDeg', 'longitudeDeg',
] as const;
export type ApplyKey = (typeof APPLY_KEYS)[number];

/** One Apply's write: only the ticked fields, each a number. */
export type WeatherPatch = Partial<Record<ApplyKey, number>>;

/** The credit Open-Meteo's CC BY 4.0 licence asks for, shown wherever its numbers are. */
export const WEATHER_CREDIT = {
  source: { text: 'Weather data by Open-Meteo.com', href: 'https://open-meteo.com/' },
  licence: { text: 'CC BY 4.0', href: 'https://creativecommons.org/licenses/by/4.0/' },
  places: { text: 'GeoNames', href: 'https://www.geonames.org/' },
} as const;

export interface WeatherSnapshot {
  v: 1;
  provider: 'open-meteo';
  endpoint: Endpoint;
  model: 'best_match';
  place: {
    label: string;
    latitudeDeg: number;
    longitudeDeg: number;
    method: PlaceMethod;
    countryCode?: string;
    accuracyM?: number;
    townCentre?: boolean;
  };
  /** The grid cell that answered — context, never applied. */
  grid: { latitudeDeg: number | null; longitudeDeg: number | null };
  /** The terrain model's ground height at the place (m), when it could be had. */
  demElevationM: number | null;
  /** The CLAMPED site altitude the applied temperature and pressure belong to (m). */
  forAltitudeM: number;
  /** The site's IANA zone — the valid time is shown in it. */
  timezone: string;
  /** The hour the forecast is for (unix s). */
  validUnix: number;
  /** When it was fetched (ISO 8601). */
  retrievedAt: string;
  /** What Open-Meteo said for that hour, whether or not it was applied. */
  fetched: {
    temperatureC: number | null;
    pressureHPa: number | null;
    windSpeedMs: number | null;
    windGustMs: number | null;
    windFromDeg: number | null;
  };
  /** What Apply wrote. Never σ. */
  applied: WeatherPatch;
  /**
   * What those fields held before Apply — a key the launch did not have (a
   * longitude on a design from before the field) is absent here too, so Undo
   * restores the absence, not a null.
   */
  before: Partial<Record<ApplyKey, number | null>>;
  /**
   * Wind gusts σ as the GUST CHIP wrote it from this record, and what σ held
   * just before that click — absent until the chip is clicked. Apply never
   * writes σ; the chip's click is a separate, later write, and this is its
   * receipt, so the strip's Undo can take back a σ that came from this
   * weather along with the fields Apply wrote (review of 2026-09-23: Undo
   * cleared the chip's explanation and left the forecast-derived σ in the box
   * with nothing saying where it came from). Dismiss keeps it, as it keeps
   * every value.
   */
  sigmaEstimate?: { applied: number; before: number };
}

/** Two stored values the same for provenance purposes: equal, or equal to float noise. */
function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a !== 'number' || typeof b !== 'number') return a === b;
  return a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * The launch conditions with an Apply's fields written — only the APPLY_KEYS,
 * only finite numbers, so a stray `windStdDev` or an `undefined` in the patch
 * cannot reach state. Every other field keeps its value (the same object
 * reference where nothing changes). Apply goes through this inside App's
 * functional `setLaunch` updater, so a field edited while the dialog was open
 * is not overwritten from a stale copy.
 */
export function applyProposal(launch: LaunchConditions, patch: WeatherPatch): LaunchConditions {
  const write: Partial<Record<ApplyKey, number>> = {};
  for (const k of APPLY_KEYS) {
    const v = (patch as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v)) write[k] = v;
  }
  return Object.keys(write).length === 0 ? launch : { ...launch, ...write };
}

/** The fields a patch will write, as they stand now — the snapshot's `before`. */
export function beforeOf(launch: LaunchConditions, patch: WeatherPatch): WeatherSnapshot['before'] {
  const out: WeatherSnapshot['before'] = {};
  for (const k of APPLY_KEYS) {
    if (!(k in patch) || !Object.hasOwn(launch, k)) continue;
    const v = launch[k];
    out[k] = typeof v === 'number' ? v : null;
  }
  return out;
}

/**
 * Undo an Apply: each applied field goes back to what it held before — but
 * ONLY where it still holds the applied value. A field edited by hand since is
 * the user's newer decision and is left alone. Wind gusts σ goes back the same
 * way when the gust chip set it from this record (`sigmaEstimate`).
 */
export function undoApply(launch: LaunchConditions,
    snap: Pick<WeatherSnapshot, 'applied' | 'before' | 'sigmaEstimate'>): LaunchConditions {
  let next: LaunchConditions | null = null;
  for (const k of APPLY_KEYS) {
    if (!(k in snap.applied) || !sameValue(launch[k], snap.applied[k])) continue;
    next ??= { ...launch };
    const rec = next as unknown as Record<string, unknown>;
    if (Object.hasOwn(snap.before, k)) rec[k] = snap.before[k];
    else delete rec[k];
  }
  const sigma = snap.sigmaEstimate;
  if (sigma && sameValue(launch.windStdDev, sigma.applied)) {
    next = { ...(next ?? launch), windStdDev: sigma.before };
  }
  return next ?? launch;
}

/** The record after the gust chip writes `sigmaMs` over a σ of `beforeMs`: its receipt, for Undo. */
export function withSigmaEstimate(snap: WeatherSnapshot, sigmaMs: number, beforeMs: number): WeatherSnapshot {
  return { ...snap, sigmaEstimate: { applied: sigmaMs, before: beforeMs } };
}

/**
 * A second Apply replaces the weather record, and the record is where Undo
 * finds what Wind gusts σ held before the gust chip set it. Without this, a
 * Fetch again or any second Apply after taking the estimate left σ at the
 * estimate on Undo, with nothing on screen saying where it came from (claim
 * check of the v0.140 notes, 2026-09-23). So the new record inherits the old
 * one's estimate while σ still holds exactly the estimated value; once the
 * user has changed σ, it is theirs and nothing is carried.
 */
export function carrySigmaEstimate(prev: WeatherSnapshot | null, next: WeatherSnapshot,
    launch: Pick<LaunchConditions, 'windStdDev'>): WeatherSnapshot {
  const est = prev?.sigmaEstimate;
  if (!est || next.sigmaEstimate || !sameValue(launch.windStdDev, est.applied)) return next;
  return { ...next, sigmaEstimate: est };
}

/**
 * The applied temperature and pressure belong to one site altitude; this says
 * when the Site altitude has moved away from it while either still holds its
 * applied value — they are then that altitude's air flown at another pad.
 * Null when there is nothing to say.
 */
export function staleness(launch: LaunchConditions, snap: WeatherSnapshot): { forAltitudeM: number; nowAltitudeM: number } | null {
  const now = padAir(launch).altitudeM;
  if (Math.abs(now - snap.forAltitudeM) < 1e-6) return null;
  const held = (['temperatureC', 'pressureHPa'] as const)
    .some((k) => k in snap.applied && sameValue(launch[k], snap.applied[k]));
  return held ? { forAltitudeM: snap.forAltitudeM, nowAltitudeM: now } : null;
}

/** What one field says about where its number came from, or null for a field the forecast did not set. */
export type FieldProvenance = { kind: 'forecast' } | { kind: 'edited'; said: number };

export function fieldProvenance(launch: LaunchConditions, snap: WeatherSnapshot | null, key: ApplyKey): FieldProvenance | null {
  const said = snap?.applied[key];
  if (typeof said !== 'number') return null;
  return sameValue(launch[key], said) ? { kind: 'forecast' } : { kind: 'edited', said };
}

// -------------------------------------------------------------- validation

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const finiteOrNull = (x: unknown): number | null | undefined => (x === null ? null : finite(x) ? x : undefined);

/**
 * A stored snapshot, checked — or null, and the caller drops it. The session
 * is localStorage, which anything can have written; a malformed provenance
 * record must not be able to put a wrong "forecast said" beside a field, and
 * dropping it loses nothing that flies.
 */
export function validWeatherSnapshot(x: unknown): WeatherSnapshot | null {
  if (!isObj(x) || x['v'] !== 1 || x['provider'] !== 'open-meteo' || x['model'] !== 'best_match') return null;
  if (x['endpoint'] !== 'forecast' && x['endpoint'] !== 'archive') return null;
  const p = x['place'];
  if (!isObj(p) || typeof p['label'] !== 'string' || !finite(p['latitudeDeg']) || !finite(p['longitudeDeg'])) return null;
  if (p['method'] !== 'search' && p['method'] !== 'coordinates' && p['method'] !== 'device') return null;
  const g = x['grid'];
  if (!isObj(g)) return null;
  const gLat = finiteOrNull(g['latitudeDeg']);
  const gLon = finiteOrNull(g['longitudeDeg']);
  const dem = finiteOrNull(x['demElevationM']);
  if (gLat === undefined || gLon === undefined || dem === undefined) return null;
  if (!finite(x['forAltitudeM']) || typeof x['timezone'] !== 'string' || !finite(x['validUnix']) || typeof x['retrievedAt'] !== 'string') return null;
  // Finite is not enough: an hour the strip is to name must be one a Date can
  // hold (±8.64e12 s), or the strip has no time to show for it.
  if (!Number.isFinite(new Date(x['validUnix'] * 1000).getTime())) return null;
  const f = x['fetched'];
  if (!isObj(f)) return null;
  const fetched = {
    temperatureC: finiteOrNull(f['temperatureC']), pressureHPa: finiteOrNull(f['pressureHPa']),
    windSpeedMs: finiteOrNull(f['windSpeedMs']), windGustMs: finiteOrNull(f['windGustMs']), windFromDeg: finiteOrNull(f['windFromDeg']),
  };
  if (Object.values(fetched).some((v) => v === undefined)) return null;
  if (!isObj(x['applied']) || !isObj(x['before'])) return null;
  const applied: WeatherPatch = {};
  for (const [k, v] of Object.entries(x['applied'])) {
    if (!(APPLY_KEYS as readonly string[]).includes(k) || !finite(v)) return null;
    applied[k as ApplyKey] = v;
  }
  const before: WeatherSnapshot['before'] = {};
  for (const [k, v] of Object.entries(x['before'])) {
    const n = finiteOrNull(v);
    if (!(APPLY_KEYS as readonly string[]).includes(k) || n === undefined) return null;
    before[k as ApplyKey] = n;
  }
  // Optional; when present, two non-negative finite speeds, or the record goes
  // — a malformed receipt must not let Undo write a σ nobody had.
  const s = x['sigmaEstimate'];
  if (s !== undefined && (!isObj(s) || !finite(s['applied']) || !finite(s['before'])
    || s['applied'] < 0 || s['before'] < 0)) return null;
  return {
    v: 1, provider: 'open-meteo', endpoint: x['endpoint'], model: 'best_match',
    place: {
      label: p['label'], latitudeDeg: p['latitudeDeg'], longitudeDeg: p['longitudeDeg'], method: p['method'],
      ...(typeof p['countryCode'] === 'string' ? { countryCode: p['countryCode'] } : {}),
      ...(finite(p['accuracyM']) ? { accuracyM: p['accuracyM'] } : {}),
      ...(p['townCentre'] === true ? { townCentre: true } : {}),
    },
    grid: { latitudeDeg: gLat, longitudeDeg: gLon },
    demElevationM: dem,
    forAltitudeM: x['forAltitudeM'],
    timezone: x['timezone'],
    validUnix: x['validUnix'],
    retrievedAt: x['retrievedAt'],
    fetched: fetched as WeatherSnapshot['fetched'],
    applied,
    before,
    ...(isObj(s) ? { sigmaEstimate: { applied: s['applied'] as number, before: s['before'] as number } } : {}),
  };
}
