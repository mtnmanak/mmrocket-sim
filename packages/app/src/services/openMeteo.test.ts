import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NETWORK_HOSTS, NetError } from './net.js';
import {
  addDaysYmd, clearWeatherCache, compassPoint, DateRefusal, distanceM, fetchElevation, fetchForecast, fetchWeather,
  forecastUrl, formatValidTime, geocodeUrl, hoursOnLocalDate, isDigitsOnly, parseCoordinates, parseForecast,
  parseGeocode, placeFromDevice, placeFromGeo, planDateWindow, requestElevations, searchPlace, SEARCH_COPY,
  usCommaRetry, WeatherError, weatherErrorText, ymdInZone, type HourSample,
} from './openMeteo.js';

/**
 * services/openMeteo.ts against answers captured from Open-Meteo on
 * 2026-09-22 (`__fixtures__/open-meteo/`). No test here reaches the network:
 * every request goes to a fake `fetchImpl` that serves a fixture, and counts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(here, '__fixtures__', 'open-meteo', name), 'utf8'));

/** 14:00 PDT on Sat 26 Sep 2026, the hour the review tests read. */
const SAT_2PM = Date.UTC(2026, 8, 26, 21) / 1000;

/** A fake fetch that answers each request from `route(url)` and records the URLs asked for. */
function fakeFetch(route: (url: string) => { status?: number; body: unknown }) {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    const { status = 200, body } = route(url);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { fetchImpl, urls };
}

beforeEach(() => { clearWeatherCache(); });
afterEach(() => { vi.useRealTimers(); });

describe('the forecast request', () => {
  const url = forecastUrl({
    endpoint: 'forecast', latitudeDeg: 40.65157, longitudeDeg: -119.35519, elevationsM: [0, 1202],
    startDate: '2026-09-25', endDate: '2026-09-27',
  });

  it('asks for STATION pressure in m/s, unix time and the site’s own zone — and nothing that would mislead', () => {
    expect(url).toContain('surface_pressure');
    expect(url).toContain('wind_speed_unit=ms');
    expect(url).toContain('timeformat=unixtime');
    expect(url).toContain('timezone=auto');
    expect(url).not.toMatch(/pressure_msl|forecast_days|past_days|current=/);
  });

  it('sends the place to 3 decimals, once per elevation', () => {
    expect(url).toContain('latitude=40.652,40.652&longitude=-119.355,-119.355&elevation=0,1202');
    expect(url).toContain('&start_date=2026-09-25&end_date=2026-09-27');
  });

  it('uses only hosts the network surface lists', () => {
    for (const u of [url, geocodeUrl('Gerlach, NV', 'US')]) {
      expect(NETWORK_HOSTS).toContain(new URL(u).origin);
    }
    expect(forecastUrl({ endpoint: 'archive', latitudeDeg: 0, longitudeDeg: 0, elevationsM: [0], startDate: '2000-01-01', endDate: '2000-01-02' }))
      .toMatch(/^https:\/\/archive-api\.open-meteo\.com\//);
  });
});

describe('the date window', () => {
  const today = '2026-09-22';

  it('is the forecast endpoint back to today−92, and the ERA5 archive before that', () => {
    const back92 = addDaysYmd(today, -92);
    expect(planDateWindow(back92, today)).toMatchObject({ ok: true, endpoint: 'forecast', startDate: back92 });
    expect(planDateWindow(addDaysYmd(today, -93), today)).toMatchObject({
      ok: true, endpoint: 'archive', startDate: addDaysYmd(today, -94), endDate: addDaysYmd(today, -93),
    });
  });

  it('asks for D−1 to D+1, clamped to what the endpoint forecasts', () => {
    expect(planDateWindow('2026-09-26', today)).toEqual({ ok: true, endpoint: 'forecast', startDate: '2026-09-25', endDate: '2026-09-27' });
    expect(planDateWindow(addDaysYmd(today, 15), today)).toEqual({
      ok: true, endpoint: 'forecast', startDate: addDaysYmd(today, 14), endDate: addDaysYmd(today, 15),
    });
  });

  it('refuses more than 15 days ahead, and 1939, before any request', async () => {
    expect(planDateWindow(addDaysYmd(today, 16), today)).toEqual({ ok: false, reason: 'too-far-ahead' });
    expect(planDateWindow('1939-12-31', today)).toEqual({ ok: false, reason: 'too-early' });
    expect(planDateWindow('2026-02-30', today)).toEqual({ ok: false, reason: 'bad-date' });
    const f = fakeFetch(() => ({ body: {} }));
    await expect(fetchWeather({
      place: { latitudeDeg: 40.87, longitudeDeg: -119.06 }, siteM: 1190, date: addDaysYmd(today, 16), today,
    }, { fetchImpl: f.fetchImpl })).rejects.toBeInstanceOf(DateRefusal);
    expect(f.urls).toEqual([]);
  });

  it('reads today on the SITE’s calendar, not the browser’s', () => {
    // 03:30 UTC on 23 Sep is still the 22nd in Nevada.
    const ms = Date.UTC(2026, 8, 23, 3, 30);
    expect(ymdInZone(ms, 'America/Los_Angeles')).toBe('2026-09-22');
    expect(ymdInZone(ms, 'Europe/Berlin')).toBe('2026-09-23');
  });
});

describe('parseForecast', () => {
  it('reads a two-elevation answer in request order', () => {
    const [low, high] = parseForecast(fixture('forecast-gerlach-0-1202m.json'), [0, 1202]);
    expect(low!.elevationM).toBe(0);
    expect(high!.elevationM).toBe(1202);
    expect(high!.timezone).toBe('America/Los_Angeles');
    const at = (v: typeof low) => v!.samples.find((s) => s.unix === SAT_2PM)!;
    // The same hour, the same grid cell, two elevations: the high pad's
    // station pressure is not the sea-level one.
    expect(at(low)).toMatchObject({ temperatureC: 31.1, pressureHPa: 1005.7, windSpeedMs: 1.75, windGustMs: 4.6, windFromDeg: 294 });
    expect(at(high)).toMatchObject({ temperatureC: 23.3, pressureHPa: 877.2, windSpeedMs: 1.75, windGustMs: 4.6 });
  });

  it('reads a single-object answer for one elevation', () => {
    const [v] = parseForecast(fixture('forecast-blackrock-1190m.json'), [1190]);
    expect(v!.samples).toHaveLength(72);
    expect(v!.samples.find((s) => s.unix === SAT_2PM)).toMatchObject({ temperatureC: 19.5, pressureHPa: 879.6 });
  });

  it('refuses a 400 body with Open-Meteo’s own reason', () => {
    expect(() => parseForecast(fixture('forecast-400.json'), [1190])).toThrow(/refused the request: Invalid value/);
  });

  it('refuses a wrong unit — km/h read as m/s would be 3.6x the wind', () => {
    const body = fixture('forecast-blackrock-1190m.json') as { hourly_units: Record<string, string> };
    body.hourly_units.wind_speed_10m = 'km/h';
    expect(() => parseForecast(body, [1190])).toThrow(WeatherError);
    expect(() => parseForecast(body, [1190])).toThrow(/wind_speed_10m in km\/h, not m\/s/);
    const f = fixture('forecast-blackrock-1190m.json') as { hourly_units: Record<string, string> };
    f.hourly_units.temperature_2m = '°F';
    try {
      parseForecast(f, [1190]);
      expect.unreachable();
    } catch (err) {
      expect((err as WeatherError).kind).toBe('units');
    }
  });

  it('refuses ragged series, a wrong element count and an elevation that does not echo', () => {
    const ragged = fixture('forecast-blackrock-1190m.json') as { hourly: { surface_pressure: number[] } };
    ragged.hourly.surface_pressure.pop();
    const kind = (body: unknown, elevations: number[]) => {
      try {
        parseForecast(body, elevations);
        return 'parsed';
      } catch (err) {
        return (err as WeatherError).kind;
      }
    };
    expect(kind(ragged, [1190])).toBe('shape');
    expect(kind(fixture('forecast-gerlach-0-1202m.json'), [0])).toBe('shape');
    expect(kind(fixture('forecast-blackrock-1190m.json'), [1219.2])).toBe('shape');
  });

  it('calls an all-null answer no data, never zeros', () => {
    expect(() => parseForecast(fixture('historical-2016-all-null.json'), [1190]))
      .toThrow(/no data for that date here/);
  });

  it('keeps a null hour null and a calm 0.0 m/s as 0', () => {
    const body = fixture('forecast-blackrock-1190m.json') as { hourly: Record<string, (number | null)[]> };
    body.hourly.temperature_2m![0] = null;
    body.hourly.wind_speed_10m![1] = 0;
    const [v] = parseForecast(body, [1190]);
    expect(v!.samples[0]!.temperatureC).toBeNull();
    expect(v!.samples[1]!.windSpeedMs).toBe(0);
  });
});

describe('the hours of the site’s day', () => {
  const hourly = (fromUtc: number, n: number): HourSample[] => Array.from({ length: n }, (_, i) => ({
    unix: fromUtc / 1000 + i * 3600,
    temperatureC: 10, pressureHPa: 900, windSpeedMs: 1, windGustMs: 2, windFromDeg: 0,
  }));

  it('has 25 hours on the fall-back day, two 1 AMs told apart by their zone', () => {
    const hours = hoursOnLocalDate(hourly(Date.UTC(2025, 10, 1), 96), 'America/Los_Angeles', '2025-11-02');
    expect(hours).toHaveLength(25);
    const oneAm = hours.filter((h) => h.label.startsWith('1:00 AM'));
    expect(oneAm.map((h) => h.label)).toEqual(['1:00 AM PDT', '1:00 AM PST']);
  });

  it('has 23 hours on the spring-forward day, and no 2 AM', () => {
    const hours = hoursOnLocalDate(hourly(Date.UTC(2026, 2, 7), 96), 'America/Los_Angeles', '2026-03-08');
    expect(hours).toHaveLength(23);
    expect(hours.some((h) => h.label.startsWith('2:00 AM'))).toBe(false);
  });

  it('labels a December hour PST even though the answer’s offset says PDT', () => {
    const hours = hoursOnLocalDate(hourly(Date.UTC(2026, 11, 15), 48), 'America/Los_Angeles', '2026-12-15');
    expect(hours).toHaveLength(24);
    expect(hours.every((h) => h.label.endsWith('PST'))).toBe(true);
    expect(hours[14]).toMatchObject({ label: '2:00 PM PST', hour: 14 });
  });

  it('reads the captured answer’s Saturday, and names the review’s hour', () => {
    const [, v] = parseForecast(fixture('forecast-gerlach-0-1202m.json'), [0, 1202]);
    const hours = hoursOnLocalDate(v!.samples, v!.timezone!, '2026-09-26');
    expect(hours).toHaveLength(24);
    expect(hours.find((h) => h.unix === SAT_2PM)).toMatchObject({ label: '2:00 PM PDT', hour: 14 });
    expect(formatValidTime(SAT_2PM, 'America/Los_Angeles')).toBe('2:00 PM PDT, Sat 26 Sep');
  });

  it('falls back to UTC for a zone name it does not know, rather than throwing', () => {
    expect(hoursOnLocalDate(hourly(Date.UTC(2026, 8, 26), 24), 'Not/AZone', '2026-09-26')).toHaveLength(24);
  });
});

describe('parseCoordinates', () => {
  const at = (t: string) => {
    const c = parseCoordinates(t);
    if (!c || !c.ok) throw new Error(`${t}: ${JSON.stringify(c)}`);
    return [c.latitudeDeg, c.longitudeDeg] as const;
  };

  it('reads every common form to the same place', () => {
    const want = [40.87, -119.06];
    for (const t of [
      '40.87, -119.06', '40.87 -119.06', '40.87N 119.06W', 'N40.87 W119.06', '40.87N119.06W',
      '40° 52.2\' N, 119° 3.6\' W', '40.87°, −119.06°', '119.06W 40.87N',
      'https://www.google.com/maps/@40.87,-119.06,15z', '40,87; -119,06',
    ]) {
      const [lat, lon] = at(t);
      expect(lat, t).toBeCloseTo(want[0]!, 9);
      expect(lon, t).toBeCloseTo(want[1]!, 9);
    }
  });

  it('reads degrees, minutes and seconds', () => {
    const [lat, lon] = at('40°52\'12"N 119°03\'36"W');
    const [lat2, lon2] = at('40.87, -119.06');
    expect(Math.abs(lat - lat2)).toBeLessThan(1e-4);
    expect(Math.abs(lon - lon2)).toBeLessThan(1e-4);
  });

  it('says so when the pair is the other way round', () => {
    expect(parseCoordinates('-119.06, 40.87')).toEqual({
      ok: false, error: 'Latitude −119.06 is outside ±90 — are these the other way round?',
    });
  });

  it('leaves a ZIP, a postcode, two bare numbers and a town name for the place search', () => {
    for (const t of ['89412', '10115', '12 34', 'Gerlach, NV', 'New York', 'Salt Lake City', '']) {
      expect(parseCoordinates(t), t).toBeNull();
    }
  });
});

describe('place search', () => {
  it('reads the Gerlach answer', () => {
    const [g] = parseGeocode(fixture('geocode-gerlach.json'));
    expect(g).toMatchObject({
      name: 'Gerlach', admin1: 'Nevada', countryCode: 'US', latitudeDeg: 40.65157, longitudeDeg: -119.35519,
      elevationM: 1202, timezone: 'America/Los_Angeles', featureCode: 'PPL',
    });
    expect(placeFromGeo(g!)).toMatchObject({ label: 'Gerlach, Nevada, US', method: 'search', townCentre: true });
  });

  it('reads no results, and a row without coordinates, as nothing', () => {
    expect(parseGeocode(fixture('geocode-none.json'))).toEqual([]);
    expect(parseGeocode({ results: [{ name: 'X', latitude: null, longitude: 3 }] })).toEqual([]);
  });

  it('refuses a postal code with no country, with no request — Open-Meteo would pick New York for Berlin’s', async () => {
    const f = fakeFetch(() => ({ body: fixture('geocode-10115-any-country.json') }));
    expect(await searchPlace('10115', undefined, { fetchImpl: f.fetchImpl }))
      .toEqual({ kind: 'none', message: SEARCH_COPY.pickCountry });
    expect(f.urls).toEqual([]);
    expect(isDigitsOnly('89412')).toBe(true);
    expect(isDigitsOnly('Gerlach 89412')).toBe(false);
  });

  it('reads coordinates with no request at all', async () => {
    const f = fakeFetch(() => ({ body: {} }));
    const r = await searchPlace('40.87, -119.06', undefined, { fetchImpl: f.fetchImpl });
    expect(r).toMatchObject({ kind: 'place', place: { latitudeDeg: 40.87, longitudeDeg: -119.06, method: 'coordinates' } });
    expect(f.urls).toEqual([]);
  });

  it('retries a US "Town ST" once with the comma it needs', async () => {
    expect(usCommaRetry('Gerlach NV')).toBe('Gerlach, NV');
    expect(usCommaRetry('Gerlach, NV')).toBeNull();
    const f = fakeFetch((u) => ({ body: u.includes('%2C') ? fixture('geocode-gerlach.json') : fixture('geocode-none.json') }));
    const r = await searchPlace('Gerlach NV', 'US', { fetchImpl: f.fetchImpl });
    expect(r.kind).toBe('places');
    expect(f.urls).toHaveLength(2);
    expect(f.urls[1]).toContain('name=Gerlach%2C%20NV&countryCode=US');
  });

  it('says what to try when nothing matches — and never promises worldwide postcodes', async () => {
    const f = fakeFetch(() => ({ body: fixture('geocode-none.json') }));
    expect(await searchPlace('Nowhere Special', 'US', { fetchImpl: f.fetchImpl }))
      .toEqual({ kind: 'none', message: SEARCH_COPY.nothing });
    expect(await searchPlace('01234', 'DE', { fetchImpl: f.fetchImpl }))
      .toEqual({ kind: 'none', message: `${SEARCH_COPY.nothing} ${SEARCH_COPY.postcodes}` });
  });
});

describe('a device position', () => {
  it('is rounded to about 1 km before it is sent or kept', () => {
    const p = placeFromDevice(40.869712, -119.061288, 30);
    expect(p).toMatchObject({ latitudeDeg: 40.87, longitudeDeg: -119.06, method: 'device', label: '40.870, −119.060' });
    // The accuracy stated is widened by the rounding it now carries.
    expect(p.accuracyM!).toBeGreaterThan(30 + 700);
  });
});

describe('the elevations asked for', () => {
  it('is the site alone when the terrain agrees within 30 m, or is unknown', () => {
    expect(requestElevations(1190, 1202)).toEqual([1190]);
    expect(requestElevations(1190, null)).toEqual([1190]);
  });

  it('is the site AND the ground when they disagree — one request, the review picks', () => {
    expect(requestElevations(0, 1202)).toEqual([0, 1202]);
    expect(requestElevations(0, -86)).toEqual([0, -86]);
  });
});

describe('fetchWeather', () => {
  const place = { latitudeDeg: 40.65157, longitudeDeg: -119.35519, timezone: 'America/Los_Angeles' };
  const route = (u: string) => (u.includes('/v1/elevation')
    ? { body: { elevation: [1202.0] } }
    : { body: fixture('forecast-gerlach-0-1202m.json') });

  it('asks the terrain first, then one forecast at the site and the ground', async () => {
    const f = fakeFetch(route);
    const a = await fetchWeather({ place, siteM: 0, date: '2026-09-26', today: '2026-09-22' }, { fetchImpl: f.fetchImpl });
    expect(f.urls).toHaveLength(2);
    expect(f.urls[0]).toMatch(/\/v1\/elevation\?latitude=40\.652&longitude=-119\.355$/);
    expect(f.urls[1]).toContain('elevation=0,1202');
    expect(a).toMatchObject({ endpoint: 'forecast', demM: 1202, elevationsM: [0, 1202], timezone: 'America/Los_Angeles' });
    expect(a.variants).toHaveLength(2);
  });

  it('reuses the same answer for ten minutes, and asks again after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 8, 22, 20));
    const f = fakeFetch(route);
    const q = { place, siteM: 0, date: '2026-09-26', today: '2026-09-22' };
    await fetchWeather(q, { fetchImpl: f.fetchImpl });
    await fetchWeather(q, { fetchImpl: f.fetchImpl });
    expect(f.urls).toHaveLength(2);
    vi.setSystemTime(Date.UTC(2026, 8, 22, 20, 10, 1));
    await fetchWeather(q, { fetchImpl: f.fetchImpl });
    expect(f.urls).toHaveLength(4);
  });

  it('flies on without the terrain height when that request fails', async () => {
    const f = fakeFetch((u) => (u.includes('/v1/elevation') ? { status: 500, body: 'oops' } : { body: fixture('forecast-blackrock-1190m.json') }));
    const a = await fetchWeather({ place, siteM: 1190, date: '2026-09-26', today: '2026-09-22' }, { fetchImpl: f.fetchImpl });
    expect(a.demM).toBeNull();
    expect(a.elevationsM).toEqual([1190]);
    expect(await fetchElevation(1, 2, { fetchImpl: fakeFetch(() => ({ body: { elevation: [] } })).fetchImpl })).toBeNull();
  });

  it('passes a cancel through rather than reading it as "no terrain"', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fetchImpl: typeof fetch = async (_u, init) => {
      if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return new Response('{}');
    };
    await expect(fetchElevation(1, 2, { fetchImpl, signal: ctrl.signal })).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('words every failure for a rocketeer, and says nothing changed', async () => {
    const f400 = fakeFetch(() => ({ status: 400, body: fixture('forecast-400.json') }));
    const q = { endpoint: 'forecast' as const, latitudeDeg: 1, longitudeDeg: 2, elevationsM: [0], startDate: '2026-09-25', endDate: '2026-09-27' };
    const err400 = await fetchForecast(q, { fetchImpl: f400.fetchImpl }).catch((e: unknown) => e);
    expect(weatherErrorText(err400)).toMatch(/^Open-Meteo refused the request: Invalid value.*Your launch conditions are unchanged\.$/);
    // A server's own error page while it is down: not JSON, but an ERROR
    // status, so it reads as the status — never as a Wi-Fi sign-in page.
    const f503 = fakeFetch(() => ({ status: 503, body: '<html><h1>503 Service Unavailable</h1></html>' }));
    const err503 = await fetchForecast(q, { fetchImpl: f503.fetchImpl }).catch((e: unknown) => e);
    expect(weatherErrorText(err503)).toBe('Open-Meteo answered HTTP 503. Your launch conditions are unchanged.');
    const f400html = fakeFetch(() => ({ status: 400, body: '<html>Bad Request</html>' }));
    expect(weatherErrorText(await fetchForecast(q, { fetchImpl: f400html.fetchImpl }).catch((e: unknown) => e)))
      .toBe('Open-Meteo answered HTTP 400. Your launch conditions are unchanged.');
    // A sign-in page at 200 — or at 511, the captive-portal status — is the captive-portal wording.
    for (const status of [200, 511]) {
      const portal = fakeFetch(() => ({ status, body: '<!doctype html><title>Sign in to Wi-Fi</title>' }));
      expect(weatherErrorText(await fetchForecast(q, { fetchImpl: portal.fetchImpl }).catch((e: unknown) => e)))
        .toMatch(/^Open-Meteo sent a web page instead of weather — a Wi-Fi sign-in page\?/);
    }
    const f502 = fakeFetch(() => ({ status: 502, body: { reason: 'Upstream busy' } }));
    expect(weatherErrorText(await fetchForecast(q, { fetchImpl: f502.fetchImpl }).catch((e: unknown) => e)))
      .toBe('Upstream busy. Your launch conditions are unchanged.');
    const f500 = fakeFetch(() => ({ status: 500, body: {} }));
    expect(weatherErrorText(await fetchForecast(q, { fetchImpl: f500.fetchImpl }).catch((e: unknown) => e)))
      .toBe('Open-Meteo answered HTTP 500. Your launch conditions are unchanged.');
    expect(weatherErrorText(new NetError('network', 'x'))).toBe('Could not reach Open-Meteo. Your launch conditions are unchanged.');
    expect(weatherErrorText(new NetError('timeout', 'x'))).toBe('Open-Meteo did not answer within 12 s. Your launch conditions are unchanged.');
  });
});

describe('context helpers', () => {
  it('names a compass point and a grid distance', () => {
    expect(compassPoint(331)).toBe('NNW');
    expect(compassPoint(-10)).toBe('N');
    expect(compassPoint(294)).toBe('WNW');
    // The captured answer's grid cell is 1.4 km from Gerlach's town centre.
    expect(distanceM(40.65157, -119.35519, 40.66386, -119.35593) / 1000).toBeCloseTo(1.37, 2);
  });
});
