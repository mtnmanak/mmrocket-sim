import { NETWORK_HOSTS, getJsonCapped, NetError, type NetErrorKind } from './net.js';

/**
 * OPEN-METEO — one hour's weather for one place (weather build, step 3).
 *
 * Pure functions (URLs, parsers, the date window, the hour list, coordinate
 * parsing) plus thin fetchers that take a `fetchImpl`, so no test ever touches
 * the network: every parser here is exercised against captured answers in
 * `__fixtures__/open-meteo/`. Nothing in this module knows the launch panel;
 * `weatherProposal.ts` turns an answer into rows to review, and nothing is
 * written anywhere until the user presses Apply.
 *
 * THE FREE TIER, ON PURPOSE. The owner ruled it usable (2026-09-21):
 * mountainmanrockets.com sells nothing and is non-profit. No API key, no proxy,
 * no paid endpoint. Their data is CC BY 4.0 and the credit line ships
 * wherever their numbers are shown (the weather dialog, the Launch panel's
 * strip, the Fly screen).
 *
 * What is asked for, and what never is:
 *  - `surface_pressure` — STATION pressure at the elevation asked about. NEVER
 *    `pressure_msl`: the sea-level-reduced figure is exactly the number the
 *    Station pressure field's help warns against (15 % dense at 3,900 ft).
 *  - An ELEVATION is always sent. Without it Open-Meteo answers for its own
 *    terrain model's height of the grid cell, and with the Site altitude at
 *    its default 0 the app would fly sea-level air at a high pad (1005.6
 *    against 878.1 hPa at Black Rock, 14.5 % too dense). See
 *    `requestElevations`.
 *  - `timeformat=unixtime` with `timezone=auto`, and the local labels made
 *    here with `Intl`. The answer's `utc_offset_seconds` is TODAY's offset
 *    stamped onto every hour, even across a DST change, so it is never read.
 *  - `wind_speed_unit=ms`, and the units every answer states are CHECKED
 *    (`HOURLY_UNITS`): a km/h answer read as m/s is 3.6x the wind, and nothing
 *    downstream could tell.
 *  - Never `current=`, `forecast_days` or `past_days`: one explicit date window.
 */

export const FORECAST_API = 'https://api.open-meteo.com/v1/forecast';
export const ARCHIVE_API = 'https://archive-api.open-meteo.com/v1/archive';
export const ELEVATION_API = 'https://api.open-meteo.com/v1/elevation';
export const GEOCODE_API = 'https://geocoding-api.open-meteo.com/v1/search';

for (const u of [FORECAST_API, ARCHIVE_API, ELEVATION_API, GEOCODE_API]) {
  // A structural guard, not decoration: net.ts's host list is what any future
  // CSP and the guide's network paragraph are held to.
  if (!NETWORK_HOSTS.some((h) => u.startsWith(`${h}/`))) throw new Error(`${u} is not in NETWORK_HOSTS`);
}

/** Each request's own deadline. Open-Meteo answers in well under a second. */
export const REQUEST_TIMEOUT_MS = 12_000;

/** The five hourly variables, and the only five. */
export const HOURLY_VARS = [
  'temperature_2m', 'surface_pressure', 'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m',
] as const;

/** The unit each hourly series must arrive in — asserted, never assumed. */
export const HOURLY_UNITS: Readonly<Record<'time' | (typeof HOURLY_VARS)[number], string>> = {
  time: 'unixtime',
  temperature_2m: '°C',
  surface_pressure: 'hPa',
  wind_speed_10m: 'm/s',
  wind_gusts_10m: 'm/s',
  wind_direction_10m: '°',
};

/**
 * The forecast endpoint's window, in days either side of today at the SITE:
 * its archive of past forecasts reaches back 92 days, and it forecasts 16 days
 * including today. Before that, the ERA5 reanalysis — the weather as it was,
 * not a forecast — back to its first year.
 */
export const FORECAST_DAYS_BACK = 92;
export const FORECAST_DAYS_AHEAD = 15;
export const ARCHIVE_FIRST_DATE = '1940-01-01';

/**
 * The difference between the site altitude and the terrain model's ground
 * height below which the two are called the same (m). Open-Meteo's terrain is
 * a 90 m model; 30 m of disagreement is the model, not a different pad.
 */
export const ELEVATION_AGREE_M = 30;

/** How long an answer is reused for the same place, elevations and date. */
export const CACHE_TTL_MS = 10 * 60 * 1000;

// ------------------------------------------------------------------- dates

/** "YYYY-MM-DD" of an instant as the calendar reads in `timeZone` (the browser's own when absent or unknown). */
export function ymdInZone(ms: number, timeZone: string | undefined): string {
  // formatToParts, never a locale's whole-date string: 'en-CA' happens to
  // print ISO order today, and nothing promises it will tomorrow.
  const fmt = (tz: string | undefined) => new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms));
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = fmt(timeZone);
  } catch {
    parts = fmt(undefined); // an unknown zone name: the browser's own
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A valid calendar date as "YYYY-MM-DD", else null. */
function parseYmd(ymd: string): { y: number; m: number; d: number } | null {
  const m = YMD.exec(ymd);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? { y, m: mo, d } : null;
}

/** `ymd` moved by `days` calendar days (pure calendar arithmetic, no zone). */
export function addDaysYmd(ymd: string, days: number): string {
  const p = parseYmd(ymd);
  if (!p) return ymd;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export type Endpoint = 'forecast' | 'archive';

export type DateWindow =
  | { ok: true; endpoint: Endpoint; startDate: string; endDate: string }
  | { ok: false; reason: 'too-far-ahead' | 'too-early' | 'bad-date' };

/**
 * Which endpoint answers for `date`, and the dates to ask it for — D−1 to D+1,
 * clamped into that endpoint's window, so every hour of the SITE's calendar
 * day is in the answer whatever the zone. Both dates are the site's calendar
 * (`timezone=auto` reads them that way), as is `today`.
 *
 * Refused before any request: more than 15 days ahead (Open-Meteo forecasts no
 * further) or before 1940.
 */
export function planDateWindow(date: string, today: string): DateWindow {
  if (!parseYmd(date) || !parseYmd(today)) return { ok: false, reason: 'bad-date' };
  const last = addDaysYmd(today, FORECAST_DAYS_AHEAD);
  const firstForecast = addDaysYmd(today, -FORECAST_DAYS_BACK);
  if (date > last) return { ok: false, reason: 'too-far-ahead' };
  const lo = (a: string, b: string) => (a > b ? a : b);
  const hi = (a: string, b: string) => (a < b ? a : b);
  if (date >= firstForecast) {
    return {
      ok: true, endpoint: 'forecast',
      startDate: lo(addDaysYmd(date, -1), firstForecast), endDate: hi(addDaysYmd(date, 1), last),
    };
  }
  if (date < ARCHIVE_FIRST_DATE) return { ok: false, reason: 'too-early' };
  const lastArchive = addDaysYmd(firstForecast, -1);
  return {
    ok: true, endpoint: 'archive',
    startDate: lo(addDaysYmd(date, -1), ARCHIVE_FIRST_DATE), endDate: hi(addDaysYmd(date, 1), lastArchive),
  };
}

/** What the dialog says for a date no endpoint answers. */
export const DATE_REFUSAL: Readonly<Record<'too-far-ahead' | 'too-early' | 'bad-date', string>> = {
  'too-far-ahead': 'Open-Meteo forecasts 16 days ahead at most.',
  'too-early': 'Open-Meteo’s records go back to 1 January 1940.',
  'bad-date': 'Pick a date.',
};

// -------------------------------------------------------------------- URLs

/** Coordinates to 3 decimals (~100 m), which is finer than any grid answering. */
const dp3 = (x: number) => x.toFixed(3);
/** An elevation to 0.1 m — the answer echoes it, and is checked against it. */
const elev = (m: number) => String(Math.round(m * 10) / 10);

/**
 * The forecast (or archive) request: one place, one or two elevations, five
 * hourly variables, a three-day window. Two elevations ask for the SAME point
 * twice, which Open-Meteo answers as an array in request order.
 */
export function forecastUrl(q: {
  endpoint: Endpoint; latitudeDeg: number; longitudeDeg: number; elevationsM: readonly number[];
  startDate: string; endDate: string;
}): string {
  const n = q.elevationsM.length;
  const rep = (s: string) => Array.from({ length: n }, () => s).join(',');
  return `${q.endpoint === 'archive' ? ARCHIVE_API : FORECAST_API}`
    + `?latitude=${rep(dp3(q.latitudeDeg))}&longitude=${rep(dp3(q.longitudeDeg))}`
    + `&elevation=${q.elevationsM.map(elev).join(',')}`
    + `&hourly=${HOURLY_VARS.join(',')}`
    + '&wind_speed_unit=ms&temperature_unit=celsius&timeformat=unixtime&timezone=auto'
    + `&start_date=${q.startDate}&end_date=${q.endDate}`;
}

/** The terrain model's ground height at a point. */
export function elevationUrl(latitudeDeg: number, longitudeDeg: number): string {
  return `${ELEVATION_API}?latitude=${dp3(latitudeDeg)}&longitude=${dp3(longitudeDeg)}`;
}

/** A place search (GeoNames data, through Open-Meteo). */
export function geocodeUrl(name: string, countryCode?: string): string {
  return `${GEOCODE_API}?name=${encodeURIComponent(name.trim())}`
    + `${countryCode ? `&countryCode=${encodeURIComponent(countryCode)}` : ''}`
    + '&count=10&language=en&format=json';
}

// ------------------------------------------------------------------ errors

/** Every way a weather lookup fails, the network's included. */
export type WeatherErrorKind = NetErrorKind | 'refused' | 'http' | 'shape' | 'units' | 'no-data';

export class WeatherError extends Error {
  readonly kind: WeatherErrorKind;
  constructor(kind: WeatherErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WeatherError';
    this.kind = kind;
  }
}

/** Where every failure message ends: the dialog writes only on Apply, so nothing did change. */
export const UNCHANGED_TAIL = ' Your launch conditions are unchanged.';

/** What the user reads for a failure. */
export function weatherErrorText(err: unknown): string {
  if (err instanceof WeatherError) return `${err.message}${UNCHANGED_TAIL}`;
  if (err instanceof NetError) {
    switch (err.kind) {
      case 'timeout': return `Open-Meteo did not answer within ${REQUEST_TIMEOUT_MS / 1000} s.${UNCHANGED_TAIL}`;
      case 'not-json': return 'Open-Meteo sent a web page instead of weather — a Wi-Fi sign-in page? '
        + `Open any site to sign in, then try again.${UNCHANGED_TAIL}`;
      case 'too-large': return `Open-Meteo sent far more than one hour’s weather, so it was not read.${UNCHANGED_TAIL}`;
      case 'aborted': return `Cancelled.${UNCHANGED_TAIL}`;
      default: return `Could not reach Open-Meteo.${UNCHANGED_TAIL}`;
    }
  }
  return `Could not reach Open-Meteo.${UNCHANGED_TAIL}`;
}

/** Was this failure the user's own cancel (which the dialog does not report)? */
export const isCancel = (err: unknown): boolean => err instanceof NetError && err.kind === 'aborted';

// ------------------------------------------------------------------ parsing

/** One hour of one elevation's answer. Null is MISSING — never zero. */
export interface HourSample {
  unix: number;
  temperatureC: number | null;
  pressureHPa: number | null;
  windSpeedMs: number | null;
  /** The strongest gust in the HOUR BEFORE `unix` (Open-Meteo's hourly gust). */
  windGustMs: number | null;
  /**
   * Where the wind blows FROM, compass degrees. Display only: the app's wind
   * always blows from the east, and Rod aim — the rail's angle to it — is the
   * user's to set; a bearing cannot say how a rail leans.
   */
  windFromDeg: number | null;
}

/** One elevation's answer. */
export interface ForecastVariant {
  /** The elevation asked for, as the answer echoed it (m). */
  elevationM: number;
  /** The grid cell that answered — shown for its distance, never applied. */
  gridLatitudeDeg: number | null;
  gridLongitudeDeg: number | null;
  /** The site's IANA zone, from `timezone=auto`. */
  timezone: string | null;
  samples: HourSample[];
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const finiteOrNull = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** An Open-Meteo 400 answer — `{"error": true, "reason": "…"}` — or null. */
export function refusalReason(body: unknown): string | null {
  const one = Array.isArray(body) ? body[0] : body;
  return isObj(one) && one['error'] === true ? (typeof one['reason'] === 'string' ? one['reason'] : 'no reason given') : null;
}

/**
 * A forecast/archive answer, checked. An array (one element per requested
 * elevation, in request order — the first carries no `location_id`) or a
 * single object for one elevation.
 *
 * Throws `WeatherError`:
 *  - `refused` for Open-Meteo's own `{"error": true}` body;
 *  - `units` when any series is not in the unit asked for (`HOURLY_UNITS`);
 *  - `shape` for a wrong element count, a missing or ragged series, or an
 *    elevation that does not echo the one asked for within 0.5 m (the
 *    variants would be read against the wrong altitude);
 *  - `no-data` when every temperature, pressure and wind in every series is
 *    null (HTTP 200 can carry exactly that for a date the model lacks).
 */
export function parseForecast(body: unknown, elevationsM: readonly number[]): ForecastVariant[] {
  const reason = refusalReason(body);
  if (reason !== null) throw new WeatherError('refused', `Open-Meteo refused the request: ${reason}.`);
  const items = Array.isArray(body) ? body : [body];
  if (items.length !== elevationsM.length) {
    throw new WeatherError('shape', `Open-Meteo answered for ${items.length} places, not ${elevationsM.length}.`);
  }
  let anyValue = false;
  const variants = items.map((item, i): ForecastVariant => {
    if (!isObj(item) || !isObj(item['hourly_units']) || !isObj(item['hourly'])) {
      throw new WeatherError('shape', 'Open-Meteo’s answer was not in the shape the app reads.');
    }
    const units = item['hourly_units'];
    for (const [k, want] of Object.entries(HOURLY_UNITS)) {
      if (units[k] !== want) {
        throw new WeatherError('units', `Open-Meteo sent ${k} in ${String(units[k] ?? 'no unit')}, not ${want}.`);
      }
    }
    const e = finiteOrNull(item['elevation']);
    if (e === null || Math.abs(e - elevationsM[i]!) > 0.5) {
      throw new WeatherError('shape', `Open-Meteo answered for ${e ?? 'no'} m, not the ${elevationsM[i]} m asked for.`);
    }
    const h = item['hourly'];
    const time = h['time'];
    if (!Array.isArray(time) || time.some((t) => finiteOrNull(t) === null)) {
      throw new WeatherError('shape', 'Open-Meteo’s answer had no usable hours.');
    }
    const series = HOURLY_VARS.map((v) => {
      const a = h[v];
      if (!Array.isArray(a) || a.length !== time.length) {
        throw new WeatherError('shape', `Open-Meteo’s ${v} series did not match its hours.`);
      }
      return a.map(finiteOrNull);
    });
    const [tC, pH, ws, wg, wd] = series as [(number | null)[], (number | null)[], (number | null)[], (number | null)[], (number | null)[]];
    const samples = (time as number[]).map((unix, j): HourSample => {
      const s = {
        unix, temperatureC: tC[j]!, pressureHPa: pH[j]!, windSpeedMs: ws[j]!, windGustMs: wg[j]!, windFromDeg: wd[j]!,
      };
      if (s.temperatureC !== null || s.pressureHPa !== null || s.windSpeedMs !== null) anyValue = true;
      return s;
    });
    return {
      elevationM: e,
      gridLatitudeDeg: finiteOrNull(item['latitude']),
      gridLongitudeDeg: finiteOrNull(item['longitude']),
      timezone: typeof item['timezone'] === 'string' ? item['timezone'] : null,
      samples,
    };
  });
  if (!anyValue) throw new WeatherError('no-data', 'Open-Meteo has no data for that date here.');
  return variants;
}

/** The terrain model's ground height from an elevation answer, rounded to 1 m, or null. */
export function parseElevation(body: unknown): number | null {
  if (!isObj(body) || !Array.isArray(body['elevation'])) return null;
  const e = finiteOrNull(body['elevation'][0]);
  return e === null ? null : Math.round(e);
}

/** One place-search result. */
export interface GeoPlace {
  name: string;
  /** State / province. */
  admin1: string | null;
  country: string | null;
  countryCode: string | null;
  latitudeDeg: number;
  longitudeDeg: number;
  /** GeoNames' own height of the place (m) — shown in the list, never applied. */
  elevationM: number | null;
  timezone: string | null;
  /** GeoNames feature code: PPL* is a populated place (a town centre). */
  featureCode: string | null;
}

/**
 * A place-search answer. A missing `results` is no match (Open-Meteo sends no
 * key at all then), and a row with no usable coordinates is dropped rather
 * than offered.
 */
export function parseGeocode(body: unknown): GeoPlace[] {
  if (!isObj(body) || !Array.isArray(body['results'])) return [];
  const str = (x: unknown) => (typeof x === 'string' && x.trim() !== '' ? x : null);
  const out: GeoPlace[] = [];
  for (const r of body['results']) {
    if (!isObj(r)) continue;
    const lat = finiteOrNull(r['latitude']);
    const lon = finiteOrNull(r['longitude']);
    const name = str(r['name']);
    if (lat === null || lon === null || name === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    out.push({
      name, admin1: str(r['admin1']), country: str(r['country']), countryCode: str(r['country_code']),
      latitudeDeg: lat, longitudeDeg: lon, elevationM: finiteOrNull(r['elevation']),
      timezone: str(r['timezone']), featureCode: str(r['feature_code']),
    });
  }
  return out;
}

/** A town centre, as GeoNames codes one (PPL, PPLA, PPLC, …). */
export const isTownCentre = (p: Pick<GeoPlace, 'featureCode'>): boolean => /^PPL/.test(p.featureCode ?? '');

/**
 * A query that is only a postal code. Open-Meteo matches postcodes mainly in
 * the US (a few other countries' too); with no country it silently picks one —
 * `10115`, Berlin's, comes back as New York.
 */
export const isDigitsOnly = (q: string): boolean => /^[\d\s-]+$/.test(q.trim()) && /\d/.test(q);

/**
 * "Town ST" with no comma finds nothing; "Town, ST" does. For a US search that
 * ends in a bare two-letter token, the one retry worth making. Null when the
 * query does not have that shape.
 */
export function usCommaRetry(q: string): string | null {
  const m = /^(.*\S)\s+([A-Za-z]{2})$/.exec(q.trim());
  return m && !m[1]!.includes(',') ? `${m[1]}, ${m[2]}` : null;
}

// -------------------------------------------------------------- coordinates

export type ParsedCoordinates =
  | { ok: true; latitudeDeg: number; longitudeDeg: number }
  | { ok: false; error: string };

/** A signed number for a message, with a real minus sign. */
const signed = (x: number) => (x < 0 ? `−${Math.abs(x)}` : String(x));

/** What the place box says about a map link that carries no coordinates. */
export const MAP_LINK_WITHOUT_COORDINATES = 'That link has no coordinates in it (a short share link only points at '
  + 'a page). Open it, then paste the link from the address bar — or right-click the spot in Google Maps and copy '
  + 'the coordinates at the top of the menu.';

/**
 * Text that is a web address rather than a place: a scheme, or a bare
 * host-and-path such as `maps.app.goo.gl/abc`.
 */
const isLink = (t: string): boolean => /^https?:\/\//i.test(t) || /^(?:[\w-]+\.)+[a-z]{2,}\/\S*$/i.test(t);

/**
 * Typed or pasted coordinates, in any of the common forms — or null when the
 * text is not coordinates at all and should be searched as a place:
 *
 *   40.87, -119.06 · 40.87 -119.06 · 40.87N 119.06W · N40.87 W119.06
 *   40°52'12"N 119°03'36"W · 40° 52.2' N, 119° 3.6' W
 *   …/maps/@40.87,-119.06,15z (a Google Maps link) · 40,87; -119,06
 *   …/maps?q=40.87,-119.06 · …?api=1&query=40.87%2C-119.06 · …?ll=40.87,-119.06
 *
 * It needs a decimal point, a degree or minute mark, a hemisphere letter or a
 * comma before it will read two numbers as coordinates, so a ZIP (`89412`),
 * a postcode (`10115`) or `12 34` is a search, not a place in the ocean. The
 * errors it reports are ones a human can act on: a latitude past ±90, which
 * almost always means the pair was pasted the other way round, and a link
 * with no coordinates in it.
 */
export function parseCoordinates(text: string): ParsedCoordinates | null {
  let t = text.trim()
    .replace(/[′’‘`]/g, "'").replace(/[″”“]/g, '"').replace(/''/g, '"')
    .replace(/[º˚]/g, '°').replace(/−/g, '-');
  if (t === '') return null;
  // A Google Maps link: the pair right after the '@'.
  const at = /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/.exec(t);
  if (at) return checked(Number(at[1]), Number(at[2]));
  // A map link that states the point as a query instead — Google's ?q=, the
  // Maps URLs API's ?query=, Apple's ?ll= — its comma often percent-encoded
  // and its space a '+'. Any OTHER link has no coordinates to read: a
  // maps.app.goo.gl share link is a redirect, and a place link carries a name.
  // It says so, because returning null sent the whole URL to the geocoder as
  // a town name, which answered "Nothing found. Put a comma between town and
  // state" (review of 2026-09-23).
  if (isLink(t)) {
    let u = t.replace(/\+/g, ' ');
    try {
      u = decodeURIComponent(u);
    } catch {
      /* a stray '%': read the text as it stands */
    }
    const q = /[?&](?:q|query|ll|center|daddr|destination)=\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i.exec(u);
    return q ? checked(Number(q[1]), Number(q[2])) : { ok: false, error: MAP_LINK_WITHOUT_COORDINATES };
  }
  // Decimal commas, the pair split by ';'.
  if (t.includes(';')) {
    const halves = t.split(';');
    if (halves.length !== 2) return null;
    const a = oneCoordinate(halves[0]!.replace(',', '.'));
    const b = oneCoordinate(halves[1]!.replace(',', '.'));
    return a && b ? assign(a, b) : null;
  }
  if (!/[.°'",NSEWnsew]/.test(t)) return null;
  t = t.toUpperCase();
  const coords = coordinateList(t);
  return coords && coords.length === 2 ? assign(coords[0]!, coords[1]!) : null;
}

interface Coord { value: number; hemi: 'NS' | 'EW' | null }

/** Exactly one coordinate in `s`, or null. */
function oneCoordinate(s: string): Coord | null {
  const list = coordinateList(s.trim().toUpperCase());
  return list && list.length === 1 ? list[0]! : null;
}

/**
 * Reads a run of coordinates: numbers with optional °, ' and " marks and an
 * N/S/E/W letter before or after. Anything else in the text — another letter,
 * a stray symbol — and it is not coordinates (null).
 */
function coordinateList(s: string): Coord[] | null {
  const tokens = s.match(/-?\d+(?:\.\d+)?|[°'"]|[NSEW]|,|\s+|./g) ?? [];
  const out: Coord[] = [];
  let cur: { deg: number | null; min: number | null; sec: number | null; hemi: string | null } =
    { deg: null, min: null, sec: null, hemi: null };
  const flush = (): boolean => {
    if (cur.deg === null) return cur.hemi === null;
    if ((cur.min !== null && (cur.min < 0 || cur.min >= 60)) || (cur.sec !== null && (cur.sec < 0 || cur.sec >= 60))) return false;
    const mag = Math.abs(cur.deg) + (cur.min ?? 0) / 60 + (cur.sec ?? 0) / 3600;
    const negative = cur.deg < 0 || Object.is(cur.deg, -0) || cur.hemi === 'S' || cur.hemi === 'W';
    out.push({ value: negative ? -mag : mag, hemi: cur.hemi === null ? null : /[NS]/.test(cur.hemi) ? 'NS' : 'EW' });
    cur = { deg: null, min: null, sec: null, hemi: null };
    return true;
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (/^\s+$/.test(tok)) continue;
    if (tok === ',') {
      if (!flush()) return null;
      continue;
    }
    if (/^[NSEW]$/.test(tok)) {
      if (cur.deg === null) {
        if (cur.hemi !== null) return null;
        cur.hemi = tok; // a prefix: N40.87
      } else if (cur.hemi !== null) {
        // The coordinate in hand already had its letter in FRONT (N40.87), so
        // this one prefixes the next: "N40.87 W119.06".
        if (!flush()) return null;
        cur.hemi = tok;
      } else {
        cur.hemi = tok; // a suffix: 40.87N — it closes the coordinate
        if (!flush()) return null;
      }
      continue;
    }
    if (/^-?\d/.test(tok)) {
      let j = i + 1;
      while (j < tokens.length && /^\s+$/.test(tokens[j]!)) j++;
      const mark = tokens[j];
      const v = Number(tok);
      if (mark === "'" || mark === '"') {
        if (cur.deg === null) return null;
        if (mark === "'") { if (cur.min !== null) return null; cur.min = v; } else { if (cur.sec !== null) return null; cur.sec = v; }
        i = j;
      } else {
        // A degree figure, marked or not; a second one starts the next coordinate.
        if (cur.deg !== null && !flush()) return null;
        cur.deg = v;
        if (mark === '°') i = j;
      }
      continue;
    }
    return null; // any other character: not coordinates
  }
  if (!flush()) return null;
  return out;
}

/** Two read coordinates as (latitude, longitude), by their letters or their order. */
function assign(a: Coord, b: Coord): ParsedCoordinates | null {
  if (a.hemi !== null && a.hemi === b.hemi) return null; // both N/S, or both E/W
  const aIsLon = a.hemi === 'EW' || b.hemi === 'NS';
  return aIsLon ? checked(b.value, a.value) : checked(a.value, b.value);
}

function checked(lat: number, lon: number): ParsedCoordinates {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false, error: 'Those are not coordinates.' };
  if (Math.abs(lat) > 90) {
    return { ok: false, error: `Latitude ${signed(lat)} is outside ±90 — are these the other way round?` };
  }
  if (Math.abs(lon) > 180) return { ok: false, error: `Longitude ${signed(lon)} is outside ±180.` };
  return { ok: true, latitudeDeg: lat, longitudeDeg: lon };
}

// ------------------------------------------------------------------ places

/** How the place was chosen — kept, because a town centre and a pasted pad are not the same claim. */
export type PlaceMethod = 'search' | 'coordinates' | 'device';

/**
 * The place a forecast is for. Its latitude and longitude are what Apply
 * offers for the Latitude and Longitude fields — NEVER the answering grid
 * point, which is up to a few km away and is not where anyone launches.
 */
export interface WeatherPlace {
  label: string;
  latitudeDeg: number;
  longitudeDeg: number;
  method: PlaceMethod;
  countryCode?: string;
  /** A device fix's accuracy (m), after rounding. */
  accuracyM?: number;
  /** A search result that is a town centre, not a field. */
  townCentre?: boolean;
  /** The place's zone when the search knew it; the forecast's own answer wins once there is one. */
  timezone?: string;
}

/** "40.870, −119.060" — a typed or located place's label. */
export function coordinatesLabel(latitudeDeg: number, longitudeDeg: number): string {
  const f = (x: number) => (x < 0 ? `−${Math.abs(x).toFixed(3)}` : x.toFixed(3));
  return `${f(latitudeDeg)}, ${f(longitudeDeg)}`;
}

/** A search result as the place a forecast is fetched for. */
export function placeFromGeo(g: GeoPlace): WeatherPlace {
  return {
    label: [g.name, g.admin1, g.countryCode].filter((s) => s !== null && s !== '').join(', '),
    latitudeDeg: g.latitudeDeg,
    longitudeDeg: g.longitudeDeg,
    method: 'search',
    ...(g.countryCode ? { countryCode: g.countryCode } : {}),
    ...(isTownCentre(g) ? { townCentre: true } : {}),
    ...(g.timezone ? { timezone: g.timezone } : {}),
  };
}

/**
 * A device position, rounded to 2 decimals (about 1.1 km) BEFORE anything is
 * sent or kept: latitude and longitude travel with every .ork and share link
 * made from the design, and a home's exact position has no business in one.
 * The stated accuracy is widened to the rounding it now carries.
 */
export function placeFromDevice(latitudeDeg: number, longitudeDeg: number, accuracyM: number): WeatherPlace {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const lat = r2(latitudeDeg);
  const lon = r2(longitudeDeg);
  // Half a 0.01° step on each axis, at most ~785 m on the diagonal.
  const roundingM = 0.005 * 111_320 * Math.SQRT2;
  const acc = Number.isFinite(accuracyM) && accuracyM > 0 ? accuracyM + roundingM : roundingM;
  return { label: coordinatesLabel(lat, lon), latitudeDeg: lat, longitudeDeg: lon, method: 'device', accuracyM: acc };
}

/** What a place search came to. */
export type SearchOutcome =
  | { kind: 'place'; place: WeatherPlace }
  | { kind: 'places'; places: GeoPlace[] }
  | { kind: 'none'; message: string };

export const SEARCH_COPY = {
  pickCountry: 'Pick a country first — a postal code alone matches places in several countries.',
  nothing: 'Nothing found. Put a comma between town and state ("Gerlach, NV").',
  postcodes: 'Postal-code search covers the US and a few other countries — try the town name.',
} as const;

/**
 * Resolves what was typed in the place box: coordinates are read here with no
 * request at all; anything else is a place search. At most two requests (the
 * US comma retry is the second). A postal code with no country is refused
 * BEFORE any request — Open-Meteo would silently pick one country's match.
 */
export async function searchPlace(text: string, countryCode: string | undefined, o: FetchOpts = {}): Promise<SearchOutcome> {
  const q = text.trim();
  if (q === '') return { kind: 'none', message: SEARCH_COPY.nothing };
  const c = parseCoordinates(q);
  if (c) {
    return c.ok
      ? { kind: 'place', place: { label: coordinatesLabel(c.latitudeDeg, c.longitudeDeg), latitudeDeg: c.latitudeDeg, longitudeDeg: c.longitudeDeg, method: 'coordinates' } }
      : { kind: 'none', message: c.error };
  }
  const digits = isDigitsOnly(q);
  if (digits && !countryCode) return { kind: 'none', message: SEARCH_COPY.pickCountry };
  let found = await fetchGeocode(q, countryCode, o);
  const retry = countryCode === 'US' && found.length === 0 ? usCommaRetry(q) : null;
  if (retry !== null) found = await fetchGeocode(retry, countryCode, o);
  if (found.length === 0) {
    return { kind: 'none', message: digits ? `${SEARCH_COPY.nothing} ${SEARCH_COPY.postcodes}` : SEARCH_COPY.nothing };
  }
  return { kind: 'places', places: found };
}

// ----------------------------------------------------------------- the hour

/**
 * Intl's own spaces, made plain. Newer ICU puts a NARROW no-break space before
 * "PM" and older ICU a plain one, so the same hour read differently on two
 * browsers — and in a test, on two machines.
 */
const plainSpaces = (s: string): string => s.replace(/[\u202f\u00a0]/g, ' ');

/** One selectable hour on the site's calendar date. */
export interface LocalHour {
  unix: number;
  /** "2:00 PM PDT" — the zone abbreviation tells the two 1 AMs of a DST fall-back apart. */
  label: string;
  /** 0-23 on the site's clock — what the dialog remembers between visits. */
  hour: number;
}

/**
 * The hours of `samples` that fall on `ymd` in `timeZone`, labelled there by
 * `Intl` — 23, 24 or 25 of them around a DST change. Never from the answer's
 * `utc_offset_seconds`, which is today's offset stamped on every hour: a
 * 15 December hour fetched in September would read PDT. An unknown zone name
 * falls back to UTC rather than throwing.
 */
export function hoursOnLocalDate(samples: readonly HourSample[], timeZone: string, ymd: string): LocalHour[] {
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'UTC';
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  const hourOf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' });
  return samples
    .filter((s) => ymdInZone(s.unix * 1000, tz) === ymd)
    .map((s) => {
      const d = new Date(s.unix * 1000);
      return { unix: s.unix, label: plainSpaces(fmt.format(d)), hour: Number(hourOf.formatToParts(d).find((p) => p.type === 'hour')?.value ?? 0) };
    });
}

/**
 * "2:00 PM PDT, Sat 26 Sep" — the valid time of a forecast, in the site's
 * zone; "—" for a time no Date can hold. The strip renders this from a session
 * record, where a finite but enormous `validUnix` made both Intl calls throw
 * (the UTC retry included) and took the Launch panel down on every load of
 * that session. `validWeatherSnapshot` refuses such a record now; this refuses
 * to be the thing that throws whatever reaches it.
 */
export function formatValidTime(unix: number, timeZone: string): string {
  const d = new Date(unix * 1000);
  if (!Number.isFinite(d.getTime())) return '—';
  const safe = (opts: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat('en-US', { ...opts, timeZone }).formatToParts(d);
    } catch {
      return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).formatToParts(d);
    }
  };
  const time = safe({ hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
    .map((p) => p.value).join('');
  const parts = safe({ weekday: 'short', day: 'numeric', month: 'short' });
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return plainSpaces(`${time}, ${get('weekday')} ${get('day')} ${get('month')}`);
}

/** Great-circle distance (m) — how far the answering grid point is from the place. */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** "NNW" for 331° — a compass point for the wind-from context line. */
export function compassPoint(deg: number): string {
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return points[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]!;
}

// --------------------------------------------------------- the elevations

/**
 * The elevation(s) to ask the forecast for. The app flies the pad at its SITE
 * altitude, so that is always one of them; the terrain model's ground height
 * is the other when the two disagree by more than the model's own noise —
 * one request either way, and the review offers the choice. Asking at the
 * ground height alone would hand back air for a pad the app is not flying;
 * asking at the site alone, when the site is the default 0, is sea-level air
 * at a high pad (the trap this module's header describes).
 */
export function requestElevations(siteM: number, demM: number | null): number[] {
  if (demM === null || Math.abs(siteM - demM) <= ELEVATION_AGREE_M) return [siteM];
  return [siteM, demM];
}

// ---------------------------------------------------------------- fetchers

/** How the thin fetchers below are called — every one cancellable and injectable. */
export interface FetchOpts {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * The request options every Open-Meteo call uses: never cached by the browser
 * (a forecast served stale as fresh is the worst failure this feature has — the
 * short in-memory reuse below is keyed and timed), no cookies, no referrer —
 * the place is the only thing that should travel.
 */
const REQUEST = { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' } as const;

/**
 * The status line of a non-2xx answer, in the user's words. A body that was
 * not JSON (`json` undefined — a server's error page, see `getJsonCapped`)
 * has no reason to quote, so it reads as the bare status whatever it is.
 */
function httpError(status: number, json: unknown): WeatherError {
  if (json === undefined) return new WeatherError('http', `Open-Meteo answered HTTP ${status}.`);
  const reason = refusalReason(json) ?? (isObj(json) && typeof json['reason'] === 'string' ? json['reason'] : null);
  if (status === 400) return new WeatherError('refused', `Open-Meteo refused the request: ${reason ?? 'no reason given'}.`);
  return new WeatherError('http', reason !== null ? `${reason}.` : `Open-Meteo answered HTTP ${status}.`);
}

/**
 * Answers reused for ten minutes, keyed on the whole request URL — so on the
 * place (3 dp), the elevations, the dates and the endpoint. Changing the hour
 * asks for nothing; pressing Fetch twice in a minute asks once. Only
 * successful answers are kept.
 */
const answers = new Map<string, { at: number; value: unknown }>();

/** Forget every reused answer (tests; nothing in the app needs it). */
export function clearWeatherCache(): void {
  answers.clear();
}

async function cached<T>(url: string, load: () => Promise<T>): Promise<T> {
  const hit = answers.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  const value = await load();
  answers.set(url, { at: Date.now(), value });
  return value;
}

/** A place search. Throws NetError / WeatherError. */
export async function fetchGeocode(name: string, countryCode: string | undefined, o: FetchOpts = {}): Promise<GeoPlace[]> {
  const a = await getJsonCapped(geocodeUrl(name, countryCode), { ...REQUEST, ...o, timeoutMs: REQUEST_TIMEOUT_MS });
  if (a.status < 200 || a.status >= 300) throw httpError(a.status, a.json);
  return parseGeocode(a.json);
}

/** The terrain model's ground height, or null on ANY failure but a cancel — it is advice, not data. */
export async function fetchElevation(latitudeDeg: number, longitudeDeg: number, o: FetchOpts = {}): Promise<number | null> {
  const url = elevationUrl(latitudeDeg, longitudeDeg);
  try {
    return await cached(url, async () => {
      const a = await getJsonCapped(url, { ...REQUEST, ...o, timeoutMs: REQUEST_TIMEOUT_MS });
      const e = a.status >= 200 && a.status < 300 ? parseElevation(a.json) : null;
      if (e === null) throw new WeatherError('shape', 'no elevation'); // not cached
      return e;
    });
  } catch (err) {
    if (isCancel(err)) throw err;
    return null;
  }
}

/** The forecast (or archive) for one place at one or two elevations. Throws NetError / WeatherError. */
export async function fetchForecast(q: Parameters<typeof forecastUrl>[0], o: FetchOpts = {}): Promise<ForecastVariant[]> {
  const url = forecastUrl(q);
  return cached(url, async () => {
    const a = await getJsonCapped(url, { ...REQUEST, ...o, timeoutMs: REQUEST_TIMEOUT_MS });
    if (a.status < 200 || a.status >= 300) throw httpError(a.status, a.json);
    return parseForecast(a.json, q.elevationsM);
  });
}

/** Everything one Fetch press brings back. */
export interface WeatherAnswer {
  endpoint: Endpoint;
  /** The site's calendar date asked about. */
  date: string;
  /** The terrain model's ground height at the place, or null when it could not be had. */
  demM: number | null;
  /** The elevations asked for, in request order — `variants` matches it index for index. */
  elevationsM: number[];
  variants: ForecastVariant[];
  /** The site's zone: the answer's own, else the place's, else the browser's. */
  timezone: string;
}

/** A date no endpoint answers — refused before any request. */
export class DateRefusal extends Error {
  readonly reason: 'too-far-ahead' | 'too-early' | 'bad-date';
  constructor(reason: 'too-far-ahead' | 'too-early' | 'bad-date') {
    super(DATE_REFUSAL[reason]);
    this.name = 'DateRefusal';
    this.reason = reason;
  }
}

/**
 * One Fetch press: the date checked first (a refused date costs no request),
 * then the terrain height, then one forecast request at the elevation(s)
 * `requestElevations` picks against the SITE altitude the flight flies. At most
 * two requests, three with the place search, four with its US comma retry.
 */
export async function fetchWeather(q: {
  place: Pick<WeatherPlace, 'latitudeDeg' | 'longitudeDeg' | 'timezone'>;
  /** The site altitude the flight flies (padAir's, clamped). */
  siteM: number;
  date: string;
  /** Today on the SITE's calendar. */
  today: string;
}, o: FetchOpts = {}): Promise<WeatherAnswer> {
  const w = planDateWindow(q.date, q.today);
  if (!w.ok) throw new DateRefusal(w.reason);
  const demM = await fetchElevation(q.place.latitudeDeg, q.place.longitudeDeg, o);
  const elevationsM = requestElevations(q.siteM, demM);
  const variants = await fetchForecast({
    endpoint: w.endpoint, latitudeDeg: q.place.latitudeDeg, longitudeDeg: q.place.longitudeDeg,
    elevationsM, startDate: w.startDate, endDate: w.endDate,
  }, o);
  const timezone = variants[0]?.timezone ?? q.place.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { endpoint: w.endpoint, date: q.date, demM, elevationsM, variants, timezone };
}
