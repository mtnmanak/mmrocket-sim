// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { DEFAULT_CONDITIONS, type LaunchConditions } from './LaunchPanel.js';
import { WeatherDialog, WEATHER_DIALOG_COPY } from './WeatherDialog.js';
import { clearWeatherCache } from '../services/openMeteo.js';
import type { WeatherPatch, WeatherSnapshot } from '../services/weatherSnapshot.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The ☁ Get weather dialog end to end, on answers captured from Open-Meteo on
 * 2026-09-22 — no request leaves the test: every one goes to a fake fetch that
 * serves a fixture and records the URL. The clock is 18:00 UTC on 22 Sep 2026.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(here, '..', 'services', '__fixtures__', 'open-meteo', name), 'utf8'));
const NOW = Date.UTC(2026, 8, 22, 18);
const SAT_2PM = Date.UTC(2026, 8, 26, 21) / 1000;

type Route = (url: string) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;
const GERLACH: Route = (u) => (u.includes('geocoding-api') ? { body: fixture('geocode-gerlach.json') }
  : u.includes('/v1/elevation') ? { body: { elevation: [1202.0] } }
    : { body: fixture('forecast-gerlach-0-1202m.json') });

let host: HTMLDivElement;
let root: Root;
let urls: string[];
let applied: { patch: WeatherPatch; snapshot: WeatherSnapshot }[];
let closed: number;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  urls = [];
  applied = [];
  closed = 0;
  clearWeatherCache();
  localStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

function render(opts: { launch?: LaunchConditions; route?: Route; geolocation?: Pick<Geolocation, 'getCurrentPosition'> | null;
    initialPlace?: WeatherSnapshot['place'] } = {}) {
  const route = opts.route ?? GERLACH;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    const { status = 200, body } = await route(url);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  act(() => {
    root.render(
      <PrefsProvider>
        <WeatherDialog launch={opts.launch ?? DEFAULT_CONDITIONS} fetchImpl={fetchImpl} now={() => NOW}
          geolocation={opts.geolocation === undefined ? null : opts.geolocation}
          initialPlace={opts.initialPlace}
          onApply={(patch, snapshot) => { applied.push({ patch, snapshot }); }}
          onClose={() => { closed++; }} />
      </PrefsProvider>,
    );
  });
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const q = <T extends Element>(sel: string) => host.querySelector<T>(sel);
const button = (text: string | RegExp) => [...host.querySelectorAll('button')]
  .find((b) => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? '')));
const click = async (el: Element | undefined | null) => {
  expect(el, 'element to click').toBeTruthy();
  await act(async () => { (el as HTMLElement).click(); });
  await settle();
};
function typeInto(el: HTMLInputElement | null, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function choose(el: HTMLSelectElement | null, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el!.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const row = (key: string) => q(`tr[data-row="${key}"]`);

/** Search Gerlach, pick the town, fetch Saturday, and show 2 PM. */
async function reviewGerlach(launch?: LaunchConditions) {
  render({ launch });
  typeInto(q('input[aria-label="Place"]'), 'Gerlach, NV');
  choose(q('.weather-country select'), 'US');
  await click(button('Search'));
  await click(button(/^Gerlach, Nevada, US/));
  typeInto(q('input[type="date"]'), '2026-09-26');
  await click(button('Fetch'));
  choose(q('.weather-when select'), String(SAT_2PM));
}

describe('the weather dialog', () => {
  it('writes NOTHING until Apply — a search, a fetch and a Cancel call onApply zero times', async () => {
    await reviewGerlach();
    expect(q('.weather-review')).toBeTruthy();
    await click(button('Cancel'));
    expect(applied).toHaveLength(0);
    expect(closed).toBe(1);
  });

  it('shows Now beside the forecast, and marks the site’s standard fill as such', async () => {
    await reviewGerlach();
    expect(q('.weather-review h3')!.textContent).toBe('Forecast for Gerlach, Nevada, US · 2:00 PM PDT, Sat 26 Sep');
    const t = row('temperatureC')!.textContent!;
    expect(t).toContain('15 °C');
    expect(t).toContain('(standard for 0 m)');
    // The terrain was fetched too, and at the default Site altitude of 0 the
    // review starts on the ground height — so the air offered is 1,202 m's.
    expect(t).toContain('23.3 °C');
    expect(row('pressureHPa')!.textContent).toContain('877.2 mbar');
    expect(q<HTMLInputElement>('.weather-altitude input[type="radio"]:checked')!.parentElement!.textContent)
      .toMatch(/Use the ground height, 1,202 m \(terrain model\)/);
    expect(row('windAverage')!.textContent).toContain('(forecast at 10 m / 33 ft)');
    expect(row('longitudeDeg')!.textContent).toContain('blank (−80.6 flown)');
    expect(row('latitudeDeg')!.textContent).toContain('(Gerlach, Nevada, US — town centre)');
    const context = q('.weather-context')!.textContent!;
    expect(context).toMatch(/Wind from 294° \(WNW\) — the\s+app’s wind has no direction\./);
    expect(context).toMatch(/Gust 4\.6 m\/s \(strongest in the hour before\)/);
    expect(context).toMatch(/Forecast grid point 1\.4 km from your site\./);
    expect(context).toMatch(/Density altitude 0 m → /);
  });

  it('applies only the ticked rows, in one write, and never σ', async () => {
    await reviewGerlach({ ...DEFAULT_CONDITIONS, windStdDev: 0.7 });
    await click(q('input[aria-label="Apply Wind avg"]'));
    await click(button('Apply'));
    expect(applied).toHaveLength(1);
    const { patch, snapshot } = applied[0]!;
    expect(patch).toEqual({
      temperatureC: 23.3, pressureHPa: 877.2, latitudeDeg: 40.65157, longitudeDeg: -119.35519, launchAltitudeM: 1202,
    });
    expect(snapshot.applied).toEqual(patch);
    expect(snapshot.fetched).toMatchObject({ windSpeedMs: 1.75, windGustMs: 4.6 });
    expect(snapshot).toMatchObject({ forAltitudeM: 1202, validUnix: SAT_2PM, retrievedAt: new Date(NOW).toISOString() });
    expect(closed).toBe(1);
    // What the dialog remembers for next time: the country, the query, the hour.
    expect(JSON.parse(localStorage.getItem('online-openrocket.weather.v1')!))
      .toEqual({ country: 'US', lastQuery: 'Gerlach, NV', lastHour: 14 });
  });

  it('keeping your own Site altitude applies the air fetched for it', async () => {
    await reviewGerlach();
    await click(q('.weather-altitude input[type="radio"]'));
    expect(row('pressureHPa')!.textContent).toContain('1005.7 mbar');
    await click(button('Apply'));
    expect(applied[0]!.patch).not.toHaveProperty('launchAltitudeM');
    expect(applied[0]!.snapshot.forAltitudeM).toBe(0);
  });

  it('asks three things and no more: the search, the terrain, one forecast at two elevations', async () => {
    await reviewGerlach();
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('geocoding-api.open-meteo.com/v1/search?name=Gerlach%2C%20NV&countryCode=US');
    expect(urls[1]).toContain('/v1/elevation?latitude=40.652&longitude=-119.355');
    expect(urls[2]).toContain('elevation=0,1202');
    expect(urls[2]).toContain('start_date=2026-09-25&end_date=2026-09-27');
    // Changing the hour asks for nothing.
    choose(q('.weather-when select'), String(SAT_2PM + 3600));
    await settle();
    expect(urls).toHaveLength(3);
  });

  it('credits Open-Meteo under CC BY 4.0, and GeoNames once a search was used', async () => {
    render();
    const links = () => [...host.querySelectorAll('.weather-credit a')].map((a) => a.getAttribute('href'));
    expect(links()).toEqual(['https://open-meteo.com/', 'https://creativecommons.org/licenses/by/4.0/']);
    typeInto(q('input[aria-label="Place"]'), 'Gerlach, NV');
    choose(q('.weather-country select'), 'US');
    await click(button('Search'));
    expect(links()).toContain('https://www.geonames.org/');
  });

  it('refuses a postal code with no country before asking anyone', async () => {
    render();
    typeInto(q('input[aria-label="Place"]'), '10115');
    choose(q('.weather-country select'), '');
    await click(button('Search'));
    expect(q('.weather-note')!.textContent).toMatch(/^Pick a country first/);
    expect(urls).toEqual([]);
  });

  it('refuses a date more than 15 days ahead before any request', async () => {
    render();
    typeInto(q('input[aria-label="Place"]'), '40.87, -119.06');
    await click(button('Search'));
    typeInto(q('input[type="date"]'), '2026-10-08');
    await click(button('Fetch'));
    expect(q('.weather-note')!.textContent).toBe('Open-Meteo forecasts 16 days ahead at most.');
    expect(urls).toEqual([]);
  });

  it('says a failure left everything unchanged, and applies nothing', async () => {
    await (async () => {
      render({ route: (u) => (u.includes('/v1/forecast') ? { status: 500, body: {} } : GERLACH(u)) });
      typeInto(q('input[aria-label="Place"]'), '40.87, -119.06');
      await click(button('Search'));
      await click(button('Fetch'));
    })();
    expect(q('.weather-error')!.textContent).toBe('Open-Meteo answered HTTP 500. Your launch conditions are unchanged.');
    expect(button('Apply')!.hasAttribute('disabled')).toBe(true);
    expect(applied).toHaveLength(0);
  });

  it('shows only the LATEST search’s answer, however the network orders them', async () => {
    const pending: Array<(v: { body: unknown }) => void> = [];
    render({ route: () => new Promise((resolve) => { pending.push(resolve); }) });
    typeInto(q('input[aria-label="Place"]'), 'Gerlach, NV');
    choose(q('.weather-country select'), 'US');
    await click(button('Search'));
    // The first search is still out when the second goes; Cancel/Search again.
    await click(button('Cancel'));
    typeInto(q('input[aria-label="Place"]'), 'Nowhere');
    await click(button('Search'));
    expect(pending).toHaveLength(2);
    pending[1]!({ body: fixture('geocode-none.json') });
    await settle();
    pending[0]!({ body: fixture('geocode-gerlach.json') });
    await settle();
    expect(q('.weather-note')!.textContent).toMatch(/^Nothing found/);
    expect(q('.weather-places')).toBeNull();
  });

  it('rounds a device position to about 1 km before it is used, and says how close it is', async () => {
    const geo = { getCurrentPosition: vi.fn((ok: PositionCallback) => ok({
      coords: { latitude: 40.869712, longitude: -119.061288, accuracy: 30 },
    } as GeolocationPosition)) };
    render({ geolocation: geo });
    await click(button(WEATHER_DIALOG_COPY.locate));
    expect(q('.weather-chosen')!.textContent).toContain('40.870, −119.060');
    expect(host.textContent).toContain('Located to within 1.0 km.');
    expect(urls).toEqual([]);
  });

  it('says so when the browser refuses a location, or has none to give', async () => {
    const refused = { getCurrentPosition: (_ok: PositionCallback, bad?: PositionErrorCallback | null) =>
      bad?.({ code: 1, message: 'denied' } as GeolocationPositionError) };
    render({ geolocation: refused });
    await click(button(WEATHER_DIALOG_COPY.locate));
    expect(host.textContent).toContain(WEATHER_DIALOG_COPY.refused);
    act(() => root.unmount());
    root = createRoot(host);
    render({ geolocation: null });
    await click(button(WEATHER_DIALOG_COPY.locate));
    expect(host.textContent).toContain(WEATHER_DIALOG_COPY.unavailable);
  });

  it('offers this design’s own site when it has one, and starts from the last place on Fetch again', async () => {
    render({ launch: { ...DEFAULT_CONDITIONS, latitudeDeg: 40.87, longitudeDeg: -119.06 } });
    expect(button(/^This design’s site \(40\.870, −119\.060\)$/)).toBeTruthy();
    act(() => root.unmount());
    root = createRoot(host);
    render({ initialPlace: { label: 'Gerlach, Nevada, US', latitudeDeg: 40.65157, longitudeDeg: -119.35519, method: 'search' } });
    expect(q('.weather-chosen')!.textContent).toContain('Gerlach, Nevada, US');
    expect(button('Fetch')).toBeTruthy();
  });
});
