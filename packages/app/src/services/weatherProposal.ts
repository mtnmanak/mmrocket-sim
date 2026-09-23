import {
  LATITUDE_DEG_RANGE, LONGITUDE_DEG_RANGE, WIND_MS_RANGE, type LaunchConditions,
} from '../components/LaunchPanel.js';
import {
  densityAltitudeM, PAD_PRESSURE_HPA_RANGE, PAD_TEMP_C_RANGE, padAir, padPressureIssue, SITE_ALTITUDE_M_RANGE,
} from './atmosphere.js';
import { distanceM, type HourSample, type WeatherAnswer, type WeatherPlace } from './openMeteo.js';
import { applyProposal, beforeOf, type ApplyKey, type WeatherPatch, type WeatherSnapshot } from './weatherSnapshot.js';

/**
 * THE REVIEW (weather build, step 3): one fetched hour, set beside the launch
 * conditions as they stand, one row per field Apply could write — each
 * checked against the field's OWN bounds before it may be ticked. Nothing
 * here writes anything; `patchOf` is what Apply hands App.
 *
 * Kept out of openMeteo.ts (which the spec had it in) because it reads the
 * Launch panel's bounds, and LaunchPanel reaches openMeteo.ts through its
 * strip (WeatherStrip.tsx, for the valid-time label): with this in there, the
 * two modules would import each other.
 */

/** A row that cannot be applied, and why. */
export type RowRefusal =
  | { why: 'missing' }
  | { why: 'range'; range: readonly [number, number] }
  /** A pressure that reads as sea level for the pad it would fly — the backstop below. */
  | { why: 'sea-level'; altitudeM: number };

export interface ProposalRow {
  key: Exclude<ApplyKey, 'launchAltitudeM'>;
  /** The field as the flight flies it now, in stored units; null = blank (longitude). */
  now: number | null;
  /** The "now" temperature or pressure is the site's standard fill, not a typed number. */
  nowFromSite: boolean;
  /** What the forecast offers, in stored units; null = Open-Meteo had none. */
  value: number | null;
  refusal: RowRefusal | null;
}

export type AltitudeChoice = 'site' | 'ground';

export interface AltitudeReview {
  /** The site altitude flown now (padAir's, clamped). */
  siteM: number;
  /** The terrain model's ground height, when it could be had. */
  demM: number | null;
  /** Site and ground within ELEVATION_AGREE_M — shown, nothing to choose. */
  agree: boolean;
  /** Both were fetched, so the radio is offered. */
  canChoose: boolean;
  /** The choice in force (always 'site' when there is none to make). */
  choice: AltitudeChoice;
  /** What Site altitude becomes on Apply with 'ground' — the ground height, clamped into the field's range. */
  groundAltitudeM: number | null;
  /** The ground height is outside what the Site altitude field accepts (other than below sea level). */
  groundRefused: boolean;
  /** The ground is below sea level: the pad goes to 0 with the air measured at the ground. */
  belowSeaLevel: boolean;
  /** No ground height and the site at its default 0: "check Site altitude first". */
  unchecked: boolean;
}

export interface Proposal {
  rows: ProposalRow[];
  altitude: AltitudeReview;
  /** The fetched hour of the variant the temperature and pressure come from. */
  sample: HourSample;
  /** The site altitude the flight will fly after Apply — what applied T/p belong to. */
  forAltitudeM: number;
  /** How far the answering grid point is from the place (m). */
  gridDistanceM: number | null;
  grid: { latitudeDeg: number | null; longitudeDeg: number | null };
}

/** The radio's starting position: the ground when the site is still at its default 0, else what the user set. */
export function defaultAltitudeChoice(launch: LaunchConditions, answer: WeatherAnswer): AltitudeChoice {
  return answer.variants.length > 1 && padAir(launch).altitudeM === 0 ? 'ground' : 'site';
}

const inRange = (v: number, [lo, hi]: readonly [number, number]) => v >= lo && v <= hi;

/**
 * The review of one hour. `choice` picks which fetched elevation the pad will
 * fly: the temperature and pressure ALWAYS come from the variant fetched at
 * the altitude that will be flown, never from the other one — pairing the
 * ground's air with the site's pad is exactly the sea-level-air trap this
 * build exists to avoid.
 */
export function buildProposal(q: {
  launch: LaunchConditions;
  answer: WeatherAnswer;
  place: Pick<WeatherPlace, 'latitudeDeg' | 'longitudeDeg'>;
  unix: number;
  choice: AltitudeChoice;
}): Proposal {
  const { launch, answer, place } = q;
  const now = padAir(launch);
  const siteM = now.altitudeM;
  const dem = answer.demM;
  const [altLo, altHi] = SITE_ALTITUDE_M_RANGE;
  const belowSeaLevel = dem !== null && dem < altLo;
  const groundRefused = dem !== null && dem > altHi;
  const groundAltitudeM = dem === null || groundRefused ? null : Math.max(altLo, dem);
  const canChoose = answer.variants.length > 1 && groundAltitudeM !== null;
  const choice: AltitudeChoice = canChoose ? q.choice : 'site';
  // requestElevations asks for [site] or [site, ground], in that order, and
  // the air flown must be the air fetched for the pad that will be flown.
  const variant = answer.variants[choice === 'ground' ? 1 : 0] ?? answer.variants[0]!;
  const sample = variant.samples.find((s) => s.unix === q.unix)
    ?? { unix: q.unix, temperatureC: null, pressureHPa: null, windSpeedMs: null, windGustMs: null, windFromDeg: null };
  const forAltitudeM = choice === 'ground' ? groundAltitudeM! : siteM;

  const row = (key: ProposalRow['key'], nowV: number | null, nowFromSite: boolean, value: number | null,
      range: readonly [number, number]): ProposalRow => ({
    key, now: nowV, nowFromSite, value,
    refusal: value === null ? { why: 'missing' } : !inRange(value, range) ? { why: 'range', range } : null,
  });

  const pressure = row('pressureHPa', now.pressurePa / 100, now.pressureFromSite, sample.pressureHPa, PAD_PRESSURE_HPA_RANGE);
  // The BACKSTOP. A pressure fetched for one elevation and flown at another
  // is the one mistake this review must not be able to make; the variant
  // choice above already rules it out, so this fires only on a wiring bug —
  // and then refuses the row rather than trusting the wiring.
  if (pressure.refusal === null && pressure.value !== null
      && padPressureIssue({ launchAltitudeM: forAltitudeM, temperatureC: null, pressureHPa: pressure.value }) !== null) {
    pressure.refusal = { why: 'sea-level', altitudeM: forAltitudeM };
  }

  const rows: ProposalRow[] = [
    row('temperatureC', now.temperatureK - 273.15, now.temperatureFromSite, sample.temperatureC, PAD_TEMP_C_RANGE),
    pressure,
    row('windAverage', launch.windAverage, false, sample.windSpeedMs, WIND_MS_RANGE),
    // The PLACE's coordinates — a search result, typed coordinates or a device
    // fix — never the answering grid point, which is not where anyone launches.
    row('latitudeDeg', launch.latitudeDeg, false, place.latitudeDeg, LATITUDE_DEG_RANGE),
    row('longitudeDeg', typeof launch.longitudeDeg === 'number' && Number.isFinite(launch.longitudeDeg)
      ? launch.longitudeDeg : null, false, place.longitudeDeg, LONGITUDE_DEG_RANGE),
  ];

  return {
    rows,
    altitude: {
      siteM, demM: dem, agree: dem !== null && answer.variants.length === 1, canChoose, choice,
      groundAltitudeM, groundRefused, belowSeaLevel,
      unchecked: dem === null && siteM === 0,
    },
    sample,
    forAltitudeM,
    gridDistanceM: variant.gridLatitudeDeg !== null && variant.gridLongitudeDeg !== null
      ? distanceM(place.latitudeDeg, place.longitudeDeg, variant.gridLatitudeDeg, variant.gridLongitudeDeg)
      : null,
    grid: { latitudeDeg: variant.gridLatitudeDeg, longitudeDeg: variant.gridLongitudeDeg },
  };
}

/** The rows that may be ticked — every row with a value inside its field's bounds. */
export const applicable = (p: Proposal): ProposalRow[] => p.rows.filter((r) => r.refusal === null && r.value !== null);

/**
 * What Apply writes: the ticked rows that may be applied, plus the Site
 * altitude when the ground was chosen. Never σ — it is not a row.
 */
export function patchOf(p: Proposal, ticked: ReadonlySet<ProposalRow['key']>): WeatherPatch {
  const patch: WeatherPatch = {};
  for (const r of applicable(p)) if (ticked.has(r.key)) patch[r.key] = r.value!;
  if (p.altitude.canChoose && p.altitude.choice === 'ground' && p.altitude.groundAltitudeM !== null) {
    patch.launchAltitudeM = p.altitude.groundAltitudeM;
  }
  return patch;
}

/** Density altitude the flight would fly after this patch — the review's "now → after" line. */
export function densityAfter(launch: LaunchConditions, patch: WeatherPatch): number {
  return densityAltitudeM(applyProposal(launch, patch));
}

/** The provenance record for an Apply of `patch` onto `launch`. */
export function snapshotOf(q: {
  launch: LaunchConditions;
  answer: WeatherAnswer;
  place: WeatherPlace;
  proposal: Proposal;
  patch: WeatherPatch;
  retrievedAt: Date;
}): WeatherSnapshot {
  const { place, proposal: p, answer } = q;
  const s = p.sample;
  return {
    v: 1, provider: 'open-meteo', endpoint: answer.endpoint, model: 'best_match',
    place: {
      label: place.label, latitudeDeg: place.latitudeDeg, longitudeDeg: place.longitudeDeg, method: place.method,
      ...(place.countryCode ? { countryCode: place.countryCode } : {}),
      ...(place.accuracyM !== undefined ? { accuracyM: place.accuracyM } : {}),
      ...(place.townCentre ? { townCentre: true } : {}),
    },
    grid: p.grid,
    demElevationM: answer.demM,
    forAltitudeM: p.forAltitudeM,
    timezone: answer.timezone,
    validUnix: s.unix,
    retrievedAt: q.retrievedAt.toISOString(),
    fetched: {
      temperatureC: s.temperatureC, pressureHPa: s.pressureHPa,
      windSpeedMs: s.windSpeedMs, windGustMs: s.windGustMs, windFromDeg: s.windFromDeg,
    },
    applied: { ...q.patch },
    before: beforeOf(q.launch, q.patch),
  };
}
