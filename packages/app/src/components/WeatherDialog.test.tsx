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
import { fieldText, gustNote } from './weatherText.js';
import { INITIAL_UNITS } from '../prefs/units.js';
import { ALOFT_VARS, HOURLY_VARS, clearWeatherCache, ymdInZone, type WeatherPlace } from '../services/openMeteo.js';
import { applyProposal, undoApply, validWeatherSnapshot, type WeatherPatch, type WeatherSnapshot } from '../services/weatherSnapshot.js';

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
  vi.restoreAllMocks();
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

function render(opts: { launch?: LaunchConditions; route?: Route; geolocation?: Pick<Geolocation, 'getCurrentPosition'> | null;
    initialPlace?: WeatherPlace; initialHour?: { validUnix: number; timezone: string }; now?: () => number } = {}) {
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
        <WeatherDialog launch={opts.launch ?? DEFAULT_CONDITIONS} fetchImpl={fetchImpl} now={opts.now ?? (() => NOW)}
          geolocation={opts.geolocation === undefined ? null : opts.geolocation}
          initialPlace={opts.initialPlace} initialHour={opts.initialHour}
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
const GERLACH_PLACE: WeatherPlace = { label: 'Gerlach, Nevada, US', latitudeDeg: 40.65157, longitudeDeg: -119.35519, method: 'search' };
const RENO: WeatherPlace = { label: 'Reno, Nevada, US', latitudeDeg: 39.52963, longitudeDeg: -119.8138,
  method: 'search', timezone: 'America/Los_Angeles' };

const LEM_SITE = { ...DEFAULT_CONDITIONS, latitudeDeg: 26.380273, longitudeDeg: 80.126879, launchAltitudeM: 3.048 };
// Synthetic terrain/zone evidence from the research, not measured Open-Meteo heights.
const LEM_WEATHER: Route = (u) => {
  const params = new URL(u).searchParams;
  const west = Number(params.get('longitude')!.split(',')[0]) < 0;
  if (u.includes('/v1/elevation')) return { body: { elevation: [west ? 4 : 125] } };
  const captured = fixture('forecast-gerlach-0-1202m.json') as Record<string, unknown>[];
  const variants = params.get('elevation')!.split(',').map((elevation, i): Record<string, unknown> => ({
    ...captured[i], latitude: 26.38, longitude: west ? -80.13 : 80.13,
    elevation: Number(elevation), timezone: west ? 'America/New_York' : 'Asia/Kolkata',
  }));
  for (const variant of variants) {
    const hourly = variant['hourly'] as Record<string, number[]>;
    const units = variant['hourly_units'] as Record<string, string>;
    hourly['wind_speed_80m'] = hourly['time']!.map(() => west ? 24 : 12);
    hourly['wind_direction_80m'] = hourly['time']!.map(() => west ? 180 : 90);
    units['wind_speed_80m'] = 'm/s';
    units['wind_direction_80m'] = '°';
  }
  return { body: variants.length === 1 ? variants[0] : variants };
};

async function reviewLem(opts: { launch?: LaunchConditions; route?: Route } = {}) {
  vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(240);
  render({ launch: LEM_SITE, route: LEM_WEATHER, ...opts });
  await click(button(/^This design’s site/));
  typeInto(q('input[type="date"]'), '2026-09-26');
  await click(button('Fetch'));
}

describe('the design-site longitude check', () => {
  it('uses only the chosen site’s existing fetch and shows hemispheres in the review', async () => {
    await reviewLem();
    expect(host.textContent).toContain('Check the longitude’s sign.');
    expect(host.textContent).toContain('Asia/Kolkata');
    expect(host.textContent).toContain('125 m');
    expect(row('latitudeDeg')!.textContent).toContain('26.38027° N');
    expect(row('longitudeDeg')!.textContent).toContain('80.12688° E');
    expect(button('Fetch for 80.127° W instead')).toBeTruthy();
    expect(button('Keep 80.127° E')).toBeTruthy();
    expect(urls).toHaveLength(2);
    expect(urls.every((u) => new URL(u).searchParams.get('longitude')!.startsWith('80.127'))).toBe(true);
    expect(applied).toEqual([]);
    await click(button('Cancel'));
    expect(applied).toEqual([]);
  });

  it('fetches the opposite longitude on click and applies its FULL precision only on Apply', async () => {
    await reviewLem();
    expect(q<HTMLInputElement>('input[aria-label="Apply Winds aloft"]')!.checked).toBe(true);
    expect(q('.wind-profile-table')!.textContent).toContain('90.0° E');
    await click(button('Fetch for 80.127° W instead'));
    expect(applied).toEqual([]);
    expect(LEM_SITE.longitudeDeg).toBe(80.126879);
    expect(urls).toHaveLength(4);
    expect(urls[2]).toContain('latitude=26.380&longitude=-80.127');
    expect(q('.weather-chosen')!.textContent).toContain('26.380° N, 80.127° W');
    expect(host.textContent).not.toContain('Check the longitude’s sign.');
    expect(host.textContent).toContain('ground here 4 m');
    expect(q('.wind-profile-table')!.textContent).toContain('180.0° S');
    expect(q('.wind-profile-table')!.textContent).not.toContain('90.0° E');
    for (const url of urls.filter((u) => u.includes('/v1/forecast'))) {
      expect(new URL(url).searchParams.get('hourly')!.split(',')).toEqual([...HOURLY_VARS, ...ALOFT_VARS]);
    }
    await click(button('Apply'));
    expect(applied).toHaveLength(1);
    expect(applied[0]!.patch).toMatchObject({ latitudeDeg: 26.380273, longitudeDeg: -80.126879 });
    expect(applied[0]!.snapshot.place).toMatchObject({ latitudeDeg: 26.380273, longitudeDeg: -80.126879 });
    expect(applied[0]!.patch.windLevels).toHaveLength(2);
    expect(applied[0]!.patch.windLevels![1]).toMatchObject({ altitude: 80, speed: 24 });
    expect(applied[0]!.patch.windProfileSource).toMatchObject({
      kind: 'open-meteo', place: applied[0]!.snapshot.place.label, validUnix: applied[0]!.snapshot.validUnix,
    });
    expect(closed).toBe(1);
  });

  it('clears a preceding profile when the corrected site has only surface weather, and Undo restores it', async () => {
    const launch = { ...LEM_SITE, windAverage: 3, windStdDev: 0.2,
      windLevels: [{ altitude: 10, speed: 3, direction: 0, standardDeviation: 0.2 },
        { altitude: 80, speed: 30, direction: 0, standardDeviation: 2 }],
      windProfileSource: { kind: 'ork' as const } };
    await reviewLem({ launch, route: async (url) => {
      const answer = await LEM_WEATHER(url);
      if (url.includes('/v1/forecast') && new URL(url).searchParams.get('longitude')!.startsWith('-')) {
        const variant = answer.body as { hourly: Record<string, number[]> };
        delete variant.hourly['wind_speed_80m'];
        delete variant.hourly['wind_direction_80m'];
      }
      return answer;
    } });
    expect(q('input[aria-label="Apply Winds aloft"]')).toBeTruthy();
    await click(button('Fetch for 80.127° W instead'));
    expect(q('input[aria-label="Apply Winds aloft"]')).toBeNull();
    expect(host.textContent).toContain('Winds aloft are unavailable');
    await click(button('Apply'));
    const { patch, snapshot } = applied[0]!;
    expect(patch.longitudeDeg).toBe(-80.126879);
    expect(patch.windLevels).toEqual([]);
    const next = applyProposal(launch, patch);
    expect(next).not.toHaveProperty('windProfileSource');
    expect(undoApply(next, snapshot)).toEqual(launch);
  });

  it('preserves the untouched default date when correcting longitude across midnight', async () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(240);
    let now = new Date(2026, 8, 26, 23, 59).getTime();
    render({ launch: LEM_SITE, route: LEM_WEATHER, now: () => now });
    await click(button(/^This design’s site/));
    expect(q<HTMLInputElement>('input[type="date"]')!.value).toBe('2026-09-26');
    await click(button('Fetch'));
    expect(q('.weather-review')).toBeTruthy();

    now = new Date(2026, 8, 27, 0, 1).getTime();
    await click(button('Fetch for 80.127° W instead'));
    expect(q<HTMLInputElement>('input[type="date"]')!.value).toBe('2026-09-26');
    const requests = urls.filter((u) => u.includes('/v1/forecast')).map((u) => new URL(u).searchParams);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.get('longitude')).toBe('-80.127');
    // The service asks for D-1 through D+1, then reviews only the chosen day.
    expect(requests[1]!.get('start_date')).toBe('2026-09-25');
    expect(requests[1]!.get('end_date')).toBe('2026-09-27');
    expect(q('.weather-review h3')!.textContent).toMatch(/26 Sep/);
    expect(button('Apply')!.disabled).toBe(false);
    await click(button('Apply'));
    expect(applied).toHaveLength(1);
    const { patch, snapshot } = applied[0]!;
    expect(patch.longitudeDeg).toBe(-80.126879);
    expect(snapshot.timezone).toBe('America/New_York');
    expect(ymdInZone(snapshot.validUnix * 1000, snapshot.timezone)).toBe('2026-09-26');
    expect(patch.windLevels![1]).toMatchObject({ altitude: 80, speed: 24 });
    expect(patch.windProfileSource).toMatchObject({ validUnix: snapshot.validUnix });
  });

  it('does not offer old east-site weather if the chosen west fetch fails', async () => {
    await reviewLem({ route: (u) => new URL(u).searchParams.get('longitude')!.startsWith('-')
      ? { status: 503, body: {} } : LEM_WEATHER(u) });
    await click(button('Fetch for 80.127° W instead'));
    expect(q('[role="alert"]')!.textContent).toContain('503');
    expect(q('.weather-review')).toBeNull();
    expect(q('.wind-profile')).toBeNull();
    expect(button('Apply')!.disabled).toBe(true);
    expect(applied).toEqual([]);
  });

  it('leaves Longitude out of Apply when its corrected row is unticked', async () => {
    await reviewLem();
    await click(button('Fetch for 80.127° W instead'));
    await click(q('input[aria-label="Apply Longitude"]'));
    await click(button('Apply'));
    expect(applied[0]!.patch).not.toHaveProperty('longitudeDeg');
    expect(applied[0]!.snapshot.place.longitudeDeg).toBe(-80.126879);
  });

  it('disables both sign choices during another request', async () => {
    await reviewLem({ route: (u) => u.includes('geocoding-api')
      ? new Promise(() => {}) : LEM_WEATHER(u) });
    typeInto(q('input[aria-label="Place"]'), 'Another town');
    await click(button('Search'));
    expect(button('Fetch for 80.127° W instead')!.disabled).toBe(true);
    expect(button('Keep 80.127° E')!.disabled).toBe(true);
    await click(q('form button'));
    expect(button('Fetch for 80.127° W instead')!.disabled).toBe(false);
    expect(button('Keep 80.127° E')!.disabled).toBe(false);
  });

  it('lets the user cancel a mirrored fetch and ignores its late answer', async () => {
    let finish: (() => void) | undefined;
    await reviewLem({ route: async (u) => {
      if (new URL(u).searchParams.get('longitude')!.startsWith('-')) {
        await new Promise<void>((resolve) => { finish = resolve; });
      }
      return LEM_WEATHER(u);
    } });
    await click(button('Fetch for 80.127° W instead'));
    expect(host.textContent).toContain('Asking Open-Meteo');
    expect(button('Apply')!.disabled).toBe(true);
    await click(q('.weather-when button'));
    finish!();
    await settle();
    expect(q('.weather-review')).toBeNull();
    expect(applied).toEqual([]);
  });

  it.each(['coordinates', 'device'] as const)('never checks a %s selection, even at the design coordinates', async (method) => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(240);
    const launch = { ...LEM_SITE, latitudeDeg: 26.38, longitudeDeg: 80.13 };
    render({ launch, route: LEM_WEATHER, geolocation: {
      getCurrentPosition: (ok) => ok({ coords: { latitude: 26.38, longitude: 80.13, accuracy: 30 } } as GeolocationPosition),
    } });
    await click(button(/^This design’s site/));
    if (method === 'coordinates') {
      typeInto(q('input[aria-label="Place"]'), '26.38, 80.13');
      await click(button('Search'));
    } else await click(button(WEATHER_DIALOG_COPY.locate));
    typeInto(q('input[type="date"]'), '2026-09-26');
    await click(button('Fetch'));
    expect(q('.weather-review')).toBeTruthy();
    expect(host.textContent).not.toContain('Check the longitude’s sign.');
  });

  it('does not flag Kanpur with a matching browser offset, even with an altitude mismatch', async () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-330);
    render({ launch: LEM_SITE, route: LEM_WEATHER });
    await click(button(/^This design’s site/));
    typeInto(q('input[type="date"]'), '2026-09-26');
    await click(button('Fetch'));
    expect(q('.weather-review')).toBeTruthy();
    expect(host.textContent).not.toContain('Check the longitude’s sign.');
  });

  it('drops the suggestion if the design coordinates changed while the dialog was open', async () => {
    await reviewLem();
    render({ launch: { ...LEM_SITE, longitudeDeg: 81 }, route: LEM_WEATHER });
    expect(host.textContent).not.toContain('Check the longitude’s sign.');
    render({ launch: { ...LEM_SITE, latitudeDeg: 27 }, route: LEM_WEATHER });
    expect(host.textContent).not.toContain('Check the longitude’s sign.');
  });

  it('Keep preserves the value and suppresses repeat prompts for that site, including reopening', async () => {
    const launch = { ...LEM_SITE, longitudeDeg: 80.126881 };
    await reviewLem({ launch });
    const before = [...urls];
    await click(button('Keep 80.127° E'));
    expect(urls).toEqual(before);
    expect(applied).toEqual([]);
    await click(button(/^This design’s site/));
    await click(button('Fetch'));
    expect(host.textContent).not.toContain('Check the longitude’s sign.');
    await click(button('Apply'));
    expect(applied[0]!.patch.longitudeDeg).toBe(launch.longitudeDeg);
    act(() => root.unmount());
    root = createRoot(host);
    await reviewLem({ launch });
    expect(host.textContent).not.toContain('Check the longitude’s sign.');
    render({ launch: LEM_SITE, route: LEM_WEATHER });
    await click(button(/^This design’s site/));
    await click(button('Fetch'));
    expect(host.textContent).toContain('Check the longitude’s sign.');
  });
});

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
    expect(row('longitudeDeg')!.textContent).toContain('blank (80.6° W flown)');
    expect(row('latitudeDeg')!.textContent).toContain('(Gerlach, Nevada, US — town centre)');
    const context = q('.weather-context')!.textContent!;
    // The app's wind DOES have a direction — always from the east, the frame
    // Rod aim is measured in — so the line says that, not "no direction"
    // (review of 2026-09-23: the guide said both).
    expect(context).toMatch(new RegExp(`Wind from 294° \\(WNW\\) — ${WEATHER_DIALOG_COPY.windNotApplied}`));
    expect(WEATHER_DIALOG_COPY.windNotApplied).toMatch(/always blows from the east/);
    expect(context).not.toMatch(/no direction/);
    expect(context).toMatch(/Gust 4\.6 m\/s \(strongest in the hour before\) — see Wind gusts σ\./);
    // Step 4's preview: offered in the panel after Apply, never set by it.
    // The σ the chip will write, with the digits the σ box will show.
    expect(context).toMatch(/σ from this gust ≈ 0\.95 m\/s — offered beside Wind gusts σ\s+once this wind is applied; Apply never sets σ\./);
    expect(context).toMatch(/Forecast grid point 1\.4 km from your site\./);
    expect(context).toMatch(/Density altitude 0 m → /);
  });

  // A gust no stronger than the wind is common — 30 of the 72 captured hours —
  // and it offers no σ. The review used to point at "Wind gusts σ" anyway, a
  // row that never appears (review of 2026-09-23); it says why there is none.
  it('says there is no σ estimate when the gust is no stronger than the wind', async () => {
    await reviewGerlach();
    choose(q('.weather-when select'), String(Date.UTC(2026, 8, 26, 18) / 1000)); // 11 AM: wind 2.12, gust 1.8
    await settle();
    const context = q('.weather-context')!.textContent!;
    expect(context).toMatch(/Gust 1\.8 m\/s \(strongest in the hour before\) — no stronger than this hour’s wind, so there is no σ estimate\./);
    expect(context).not.toMatch(/σ from this gust|see Wind gusts σ/);
  });

  // A date more than 92 days back is answered by the ERA5 archive: the weather
  // as it was, which no heading, column or note may call a forecast (spec
  // §3.1; review of 2026-09-23). The real archive capture for Black Rock.
  it('calls an ERA5 answer a reanalysis, never a forecast', async () => {
    render({
      launch: { ...DEFAULT_CONDITIONS, launchAltitudeM: 1190 },
      route: (u) => (u.includes('/v1/elevation') ? { body: fixture('elevation-blackrock.json') }
        : u.startsWith('https://archive-api.open-meteo.com/v1/archive?') ? { body: fixture('archive-blackrock-2025-06-14.json') }
          : { status: 404, body: { reason: `unexpected ${u}` } }),
    });
    typeInto(q('input[aria-label="Place"]'), '40.87, -119.06');
    await click(button('Search'));
    typeInto(q('input[type="date"]'), '2025-06-14');
    await click(button('Fetch'));
    choose(q('.weather-when select'), String(Date.UTC(2025, 5, 14, 21) / 1000));
    await settle();
    expect(q('.weather-review h3')!.textContent).toBe('ERA5 reanalysis for 40.870° N, 119.060° W · 2:00 PM PDT, Sat 14 Jun 2025');
    expect([...host.querySelectorAll('.weather-review thead th')].at(-1)!.textContent).toBe('Reanalysis');
    expect(row('windAverage')!.textContent).toContain('(reanalysis at 10 m / 33 ft)');
    expect(q('.weather-context')!.textContent).toMatch(/Reanalysis grid point [\d.]+ km from your site\./);
    // The archive tag is the one place the word may appear: "…not a forecast".
    expect(q('.weather-review')!.textContent!.replace(WEATHER_DIALOG_COPY.archive, '')).not.toMatch(/forecast/i);
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

  // THE PRIVACY COPY, held to its two sources (review of 2026-09-23). What the
  // app sends is what these requests carry, so every parameter of every one
  // is named here: a searched name (and country), coordinates, the dates and
  // the elevations, plus fixed settings — nothing else, and nothing from the
  // design. What Open-Meteo does with a request is only ever attributed to
  // its terms, which scripts/check-upstream.mjs §6 re-reads before a release.
  it('sends what the intro says and nothing else, and says what Open-Meteo does only as its terms do', async () => {
    await reviewGerlach({ ...DEFAULT_CONDITIONS, windStdDev: 0.7, launchRodAngleDeg: 5 });
    const DATA = new Set(['name', 'countryCode', 'latitude', 'longitude', 'elevation', 'start_date', 'end_date']);
    const FIXED: Record<string, string> = {
      count: '10', language: 'en', format: 'json', wind_speed_unit: 'ms', temperature_unit: 'celsius',
      timeformat: 'unixtime', timezone: 'auto',
      hourly: [...HOURLY_VARS, ...ALOFT_VARS].join(','),
    };
    for (const u of urls) {
      for (const [k, v] of new URL(u).searchParams) {
        if (!DATA.has(k)) expect(FIXED[k], `${k}=${v} in ${u}`).toBe(v);
      }
    }
    const { intro } = WEATHER_DIALOG_COPY;
    expect(intro).toMatch(/one hour’s weather/);
    expect(intro).not.toMatch(/forecast/); // an older date is a reanalysis
    expect(intro).toMatch(/a place name you search for, the chosen place’s coordinates, the date and your site altitude — nothing about your rocket/);
    const guide = readFileSync(join(here, '..', '..', 'user-guide.md'), 'utf8');
    const leaves = guide.split('\n').find((l) => l.startsWith('**What leaves your browser.**')) ?? '';
    expect(leaves).toContain('[terms](https://open-meteo.com/en/terms)');
    // Every sentence about Open-Meteo's own handling names the terms as its source.
    const ABOUT_OPEN_METEO = /\blogs?\b|third part|90 days|collect|retain|keeps?\b/i;
    for (const text of [intro, leaves]) {
      const about = text.split(/(?<=\.) (?=[A-Z])/).filter((s) => ABOUT_OPEN_METEO.test(s));
      expect(about.length, text).toBeGreaterThan(0);
      for (const s of about) expect(s, s).toMatch(/terms/);
    }
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

  it('never shows, or applies, a day the Date box no longer says — a date change cancels a fetch still out', async () => {
    // The forecast request is held; the search and the terrain answer at once.
    const held: Array<(v: { body: unknown }) => void> = [];
    render({ route: (u) => (u.includes('/v1/forecast')
      ? new Promise((resolve) => { held.push(resolve); })
      : GERLACH(u)) });
    typeInto(q('input[aria-label="Place"]'), 'Gerlach, NV');
    choose(q('.weather-country select'), 'US');
    await click(button('Search'));
    await click(button(/^Gerlach, Nevada, US/));
    typeInto(q('input[type="date"]'), '2026-09-26');
    await click(button('Fetch'));
    expect(held).toHaveLength(1);
    expect(urls.at(-1)).toContain('start_date=2026-09-25&end_date=2026-09-27');
    // A slow connection: the user moves the date on before Saturday's answer lands.
    typeInto(q('input[type="date"]'), '2026-09-28');
    await settle();
    held[0]!({ body: fixture('forecast-gerlach-0-1202m.json') });
    await settle();
    expect(q<HTMLInputElement>('input[type="date"]')!.value).toBe('2026-09-28');
    expect(q('.weather-review')).toBeNull();
    expect(button('Apply')!.hasAttribute('disabled')).toBe(true);
    // ...and nothing is left running: Fetch is back, for the new date.
    expect(button('Fetch')).toBeTruthy();
    expect(applied).toHaveLength(0);
  });

  // A PICK FROM THE LIST ENDS A FETCH STILL OUT (audit 2026-09-30). The list
  // was the one place control left live while a fetch ran, and a pick
  // cancelled nothing: the earlier place's answer then passed the sequencer,
  // and Reno's air sat under "Forecast for Gerlach" with Gerlach's
  // coordinates, one Apply away from the launch conditions.
  it('never shows, or applies, one place’s weather under a place picked while it was out', async () => {
    // Reno's air, unmistakable: 31.7 °C every hour.
    const renoAir = (fixture('forecast-gerlach-0-1202m.json') as { hourly: { temperature_2m: number[] } }[])
      .map((v) => ({ ...v, hourly: { ...v.hourly, temperature_2m: v.hourly.temperature_2m.map(() => 31.7) } }));
    const held: Array<(v: { body: unknown }) => void> = [];
    render({ initialPlace: RENO, route: (u) => (u.includes('/v1/forecast')
      ? new Promise((resolve) => { held.push(resolve); })
      : GERLACH(u)) });
    typeInto(q('input[type="date"]'), '2026-09-26');
    typeInto(q('input[aria-label="Place"]'), 'Gerlach, NV');
    choose(q('.weather-country select'), 'US');
    await click(button('Search'));
    // Reno is still the place; Gerlach's results wait in the list.
    expect(q('.weather-chosen')!.textContent).toContain('Reno, Nevada, US');
    await click(button('Fetch'));
    expect(held).toHaveLength(1);
    expect(urls.at(-1)).toContain('latitude=39.530,39.530');
    // A slow connection: the user picks Gerlach before Reno's answer lands.
    await click(button(/^Gerlach, Nevada, US/));
    expect(q('.weather-chosen')!.textContent).toContain('Gerlach, Nevada, US');
    expect(button('Fetch'), 'Fetch is back: nothing is left running').toBeTruthy();
    held[0]!({ body: renoAir });
    await settle();
    expect(q('.weather-review')).toBeNull();
    expect(button('Apply')!.hasAttribute('disabled')).toBe(true);
    // Gerlach's own fetch shows Gerlach's own air, and applies it.
    await click(button('Fetch'));
    expect(urls.at(-1)).toContain('latitude=40.652,40.652');
    held[1]!({ body: fixture('forecast-gerlach-0-1202m.json') });
    await settle();
    expect(q('.weather-review h3')!.textContent).toMatch(/^Forecast for Gerlach, Nevada, US · /);
    expect(row('temperatureC')!.textContent).not.toContain(fieldText('temperatureC', 31.7, INITIAL_UNITS));
    await click(button('Apply'));
    expect(applied).toHaveLength(1);
    expect(applied[0]!.patch.temperatureC).not.toBe(31.7);
    expect(applied[0]!.patch.latitudeDeg).toBe(40.65157);
  });

  it('keeps a place picked while the browser was still locating, whatever the browser answers later', async () => {
    let answer: PositionCallback | undefined;
    render({ geolocation: { getCurrentPosition: (ok) => { answer = ok; } } });
    typeInto(q('input[aria-label="Place"]'), 'Gerlach, NV');
    choose(q('.weather-country select'), 'US');
    await click(button('Search'));
    await click(button(WEATHER_DIALOG_COPY.locate));
    // The permission prompt is still up when the user picks from the list instead.
    await click(button(/^Gerlach, Nevada, US/));
    expect(button(WEATHER_DIALOG_COPY.locate), 'the location request is over').toBeTruthy();
    expect(button(WEATHER_DIALOG_COPY.locate)!.hasAttribute('disabled')).toBe(false);
    await act(async () => { answer!({ coords: { latitude: 39.52963, longitude: -119.8138, accuracy: 30 } } as GeolocationPosition); });
    await settle();
    expect(q('.weather-chosen')!.textContent).toContain('Gerlach, Nevada, US');
    expect(host.textContent).not.toContain('Located to within');
  });

  // A DATE TYPED WHILE A PLACE IS STILL COMING STAYS (review of the audit
  // fixes, 2026-10-01). The place a location fix or a search's one answer
  // brings lands through the render that STARTED the request, whose date had
  // not been touched yet, so it put the Date box back on today — and Fetch
  // then asked for today's weather, not the launch day typed into the box.
  it('keeps a date typed while the browser was still locating', async () => {
    let answer: PositionCallback | undefined;
    render({ initialPlace: RENO, geolocation: { getCurrentPosition: (ok) => { answer = ok; } } });
    expect(q<HTMLInputElement>('input[type="date"]')!.value).toBe('2026-09-22');
    await click(button(WEATHER_DIALOG_COPY.locate));
    // The permission prompt is still up when the user types Saturday.
    typeInto(q('input[type="date"]'), '2026-09-26');
    await act(async () => { answer!({ coords: { latitude: 40.869712, longitude: -119.061288, accuracy: 30 } } as GeolocationPosition); });
    await settle();
    expect(q('.weather-chosen')!.textContent).toContain('40.870° N, 119.060° W');
    expect(q<HTMLInputElement>('input[type="date"]')!.value).toBe('2026-09-26');
    await click(button('Fetch'));
    expect(urls.at(-1)).toContain('start_date=2026-09-25&end_date=2026-09-27');
  });

  it('keeps a date typed while a search was still out', async () => {
    const held: Array<(v: { body: unknown }) => void> = [];
    const gerlachOnly = fixture('geocode-gerlach.json') as { results: unknown[] };
    render({ initialPlace: RENO, route: (u) => (u.includes('geocoding-api')
      ? new Promise((resolve) => { held.push(resolve); })
      : GERLACH(u)) });
    typeInto(q('input[aria-label="Place"]'), 'Gerlach, NV');
    choose(q('.weather-country select'), 'US');
    await click(button('Search'));
    expect(held).toHaveLength(1);
    typeInto(q('input[type="date"]'), '2026-09-26');
    // One place found, so it is chosen without a list.
    held[0]!({ body: { ...gerlachOnly, results: gerlachOnly.results.slice(0, 1) } });
    await settle();
    expect(q('.weather-chosen')!.textContent).toContain('Gerlach, Nevada, US');
    expect(q<HTMLInputElement>('input[type="date"]')!.value).toBe('2026-09-26');
    await click(button('Fetch'));
    expect(urls.at(-1)).toContain('start_date=2026-09-25&end_date=2026-09-27');
  });

  it('can cancel a location request the browser never answers', async () => {
    // A permission prompt left unanswered: neither callback ever runs.
    const silent = { getCurrentPosition: vi.fn() };
    render({ geolocation: silent, initialPlace: { label: 'Gerlach, Nevada, US', latitudeDeg: 40.65157, longitudeDeg: -119.35519, method: 'search' } });
    await click(button(WEATHER_DIALOG_COPY.locate));
    expect(silent.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(button('Fetch')!.hasAttribute('disabled')).toBe(true);
    await click(button('Cancel'));
    expect(button(WEATHER_DIALOG_COPY.locate)!.hasAttribute('disabled')).toBe(false);
    expect(button('Fetch')!.hasAttribute('disabled')).toBe(false);
    expect(host.textContent).not.toContain('Waiting for your browser’s location');
    expect(closed).toBe(0);
  });

  it('rounds a device position to about 1 km before it is used, and says how close it is', async () => {
    const geo = { getCurrentPosition: vi.fn((ok: PositionCallback) => ok({
      coords: { latitude: 40.869712, longitude: -119.061288, accuracy: 30 },
    } as GeolocationPosition)) };
    render({ geolocation: geo });
    await click(button(WEATHER_DIALOG_COPY.locate));
    expect(q('.weather-chosen')!.textContent).toContain('40.870° N, 119.060° W');
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

  // FETCH AGAIN (review of 2026-09-23): it opened on TODAY, so a user who
  // applied Saturday 2 PM, moved Site altitude and fetched again got today's
  // 2 PM air for Saturday's launch — and an ERA5 re-fly lost its date
  // altogether. It opens on the applied hour's own date now, and picks that
  // hour, ahead of the hour the dialog last remembered.
  it('opens Fetch again on the applied weather’s date, and picks its hour', async () => {
    localStorage.setItem('online-openrocket.weather.v1', JSON.stringify({ lastHour: 9 }));
    render({
      launch: { ...DEFAULT_CONDITIONS, latitudeDeg: 40.87, longitudeDeg: -119.06 },
      initialPlace: { ...GERLACH_PLACE, timezone: 'America/Los_Angeles' },
      initialHour: { validUnix: SAT_2PM, timezone: 'America/Los_Angeles' },
    });
    expect(q<HTMLInputElement>('input[type="date"]')!.value).toBe('2026-09-26');
    await click(button('Fetch'));
    expect(urls.at(-1)).toContain('start_date=2026-09-25&end_date=2026-09-27');
    expect(q<HTMLSelectElement>('.weather-when select')!.value).toBe(String(SAT_2PM));
    expect(q('.weather-review h3')!.textContent).toBe('Forecast for Gerlach, Nevada, US · 2:00 PM PDT, Sat 26 Sep');
    // Another place keeps the date: it is the launch's, not today's.
    await click(button(/^This design’s site/));
    expect(q<HTMLInputElement>('input[type="date"]')!.value).toBe('2026-09-26');
  });

  it('opens an ERA5 re-fly’s Fetch again on its own date, and asks the archive again', async () => {
    const JUNE_2PM = Date.UTC(2025, 5, 14, 21) / 1000;
    render({
      launch: { ...DEFAULT_CONDITIONS, launchAltitudeM: 1190 },
      route: (u) => (u.includes('/v1/elevation') ? { body: fixture('elevation-blackrock.json') }
        : u.startsWith('https://archive-api.open-meteo.com/v1/archive?') ? { body: fixture('archive-blackrock-2025-06-14.json') }
          : { status: 404, body: { reason: `unexpected ${u}` } }),
      initialPlace: { label: '40.870, −119.060', latitudeDeg: 40.87, longitudeDeg: -119.06, method: 'coordinates', timezone: 'America/Los_Angeles' },
      initialHour: { validUnix: JUNE_2PM, timezone: 'America/Los_Angeles' },
    });
    expect(q<HTMLInputElement>('input[type="date"]')!.value).toBe('2025-06-14');
    await click(button('Fetch'));
    expect(urls.at(-1)).toMatch(/^https:\/\/archive-api\.open-meteo\.com\/v1\/archive\?/);
    expect(q<HTMLSelectElement>('.weather-when select')!.value).toBe(String(JUNE_2PM));
    expect(q('.weather-review h3')!.textContent).toBe('ERA5 reanalysis for 40.870° N, 119.060° W · 2:00 PM PDT, Sat 14 Jun 2025');
  });

  // ☁ Get weather opens on today — the SITE's today, once the last place's
  // zone is known: 18:00 UTC on the 22nd is already the 23rd at UTC+14.
  it('opens ☁ Get weather on today at the last place', () => {
    render({ initialPlace: { ...GERLACH_PLACE, timezone: 'Pacific/Kiritimati' } });
    expect(q<HTMLInputElement>('input[type="date"]')!.value).toBe('2026-09-23');
  });

  it('offers this design’s own site when it has one, and starts from the last place on Fetch again', async () => {
    render({ launch: { ...DEFAULT_CONDITIONS, latitudeDeg: 40.87, longitudeDeg: -119.06 } });
    expect(button(/^This design’s site \(40\.870° N, 119\.060° W\)$/)).toBeTruthy();
    act(() => root.unmount());
    root = createRoot(host);
    render({ initialPlace: { label: 'Gerlach, Nevada, US', latitudeDeg: 40.65157, longitudeDeg: -119.35519, method: 'search' } });
    expect(q('.weather-chosen')!.textContent).toContain('Gerlach, Nevada, US');
    expect(button('Fetch')).toBeTruthy();
  });
});

describe('gustNote', () => {
  it('points at the σ row only when there is one, and otherwise says why not', () => {
    expect(gustNote(1.75, 4.6)).toBe('see Wind gusts σ.');
    expect(gustNote(3.4, 3.2)).toBe('no stronger than this hour’s wind, so there is no σ estimate.');
    expect(gustNote(3.4, 3.4)).toBe('no stronger than this hour’s wind, so there is no σ estimate.');
    expect(gustNote(2.4, 2.5)).toBe('within Open-Meteo’s 0.1 m/s resolution of this hour’s wind, so there is no σ estimate.');
    expect(gustNote(0, 2)).toBe('the wind is calm this hour, so there is no σ estimate.');
    expect(gustNote(null, 2)).toBe('Open-Meteo has no wind for this hour, so there is no σ estimate.');
  });
});

// Review of 2026-09-23: in inHg the review's Now read "29.92 inHg" beside
// "25.9 inHg" — the promised two decimals, with the trailing zero stripped.
describe('fieldText, for a pressure', () => {
  const inHg = { ...INITIAL_UNITS, pressure: 'inHg' };
  it('keeps each unit’s decimals, trailing zero included, so the columns line up', () => {
    expect(fieldText('pressureHPa', 1013.25, inHg)).toBe('29.92 inHg');
    expect(fieldText('pressureHPa', 877.2, inHg)).toBe('25.90 inHg');
    expect(fieldText('pressureHPa', 877.2, { ...INITIAL_UNITS, pressure: 'bar' })).toBe('0.8772 bar');
  });
  it('prints a whole number whole, as a field’s bounds are', () => {
    expect(fieldText('pressureHPa', 300, { ...INITIAL_UNITS, pressure: 'mbar' })).toBe('300 mbar');
    expect(fieldText('pressureHPa', 1100, { ...INITIAL_UNITS, pressure: 'mbar' })).toBe('1100 mbar');
  });
});


describe('winds aloft review', () => {
  const route: Route = async (url) => {
    const answer = await GERLACH(url);
    if (!url.includes('/v1/forecast')) return answer;
    const variants = answer.body as { hourly: Record<string, number[]>; hourly_units: Record<string, string> }[];
    for (const v of variants) {
      v.hourly['wind_speed_80m'] = v.hourly['time']!.map(() => 12);
      v.hourly['wind_direction_80m'] = v.hourly['time']!.map(() => 10);
      v.hourly_units['wind_speed_80m'] = 'm/s'; v.hourly_units['wind_direction_80m'] = '°';
    }
    return answer;
  };
  const review = async (launch?: LaunchConditions, weatherRoute = route, archive = false) => {
    render({ launch, route: weatherRoute, initialPlace: GERLACH_PLACE });
    if (archive) {
      typeInto(q('input[type="date"]'), '2025-06-14');
      await click(button('Fetch'));
      return;
    }
    typeInto(q('input[type="date"]'), '2026-09-26');
    await click(button('Fetch'));
    choose(q('.weather-when select'), String(SAT_2PM));
  };
  const existingProfile = (source: 'ork' | 'open-meteo'): LaunchConditions => ({
    ...DEFAULT_CONDITIONS, windAverage: 3, windStdDev: 0.2,
    windLevels: [
      { altitude: 10, speed: 3, direction: 0, standardDeviation: 0.2 },
      { altitude: 800, speed: 20, direction: 0.7, standardDeviation: 0.2 },
    ],
    windProfileSource: source === 'ork' ? { kind: 'ork' }
      : { kind: 'open-meteo', place: 'Previous site', validUnix: SAT_2PM - 3600, surfaceFromDeg: 270 },
  });
  const archiveRoute: Route = (url) => url.includes('/v1/elevation')
    ? { body: { elevation: [1190] } }
    : { body: fixture('archive-blackrock-2025-06-14.json') };
  const selections = [
    ['temperatureC'], ['pressureHPa'], ['latitudeDeg', 'longitudeDeg'],
    ['temperatureC', 'pressureHPa', 'latitudeDeg', 'longitudeDeg'], [],
  ];
  const preservationCases = (['ork', 'open-meteo'] as const).flatMap((source) =>
    (['aloft', 'surface', 'archive'] as const).flatMap((weather) =>
      selections.map((keys) => ({ source, weather, keys }))));

  it.each(preservationCases)('preserves $source winds for $weather weather when only $keys are selected', async ({ source, weather, keys }) => {
    const launch = { ...existingProfile(source), launchAltitudeM: weather === 'archive' ? 1190 : 0 };
    await review(launch, weather === 'aloft' ? route : weather === 'surface' ? GERLACH : archiveRoute, weather === 'archive');
    if (weather !== 'archive') await click(q('.weather-altitude input[type="radio"]'));
    for (const input of host.querySelectorAll<HTMLInputElement>('.weather-review tr input[type="checkbox"]')) {
      const key = input.closest('tr')!.getAttribute('data-row')!;
      if (input.checked !== keys.includes(key)) await click(input);
    }
    // Keep the site altitude too, so an empty row selection is truly empty.
    expect(button('Apply')!.disabled).toBe(keys.length === 0);
    await click(button('Apply'));
    if (!keys.length) {
      expect(applied).toEqual([]);
      expect(closed).toBe(0);
      return;
    }
    const { patch, snapshot } = applied[0]!;
    expect(Object.keys(patch).sort()).toEqual([...keys].sort());
    for (const receipt of [snapshot.before, snapshot.applied]) {
      expect(receipt).not.toHaveProperty('windLevels');
      expect(receipt).not.toHaveProperty('windProfileSource');
    }
    const next = applyProposal(launch, patch);
    expect(next.windLevels).toBe(launch.windLevels);
    expect(next.windProfileSource).toBe(launch.windProfileSource);
    expect(next.windAverage).toBe(launch.windAverage);
    expect(next.windStdDev).toBe(launch.windStdDev);
    expect(undoApply(next, snapshot)).toEqual(launch);
  });

  it.each([null, -1])('preserves existing winds when the selected hour refuses surface wind %s', async (speed) => {
    const launch = existingProfile('ork');
    await review(launch, async (url) => {
      const answer = await route(url);
      if (url.includes('/v1/forecast')) {
        for (const variant of answer.body as { hourly: Record<string, (number | null)[]> }[]) {
          variant.hourly['wind_speed_10m'] = variant.hourly['time']!.map(() => speed);
        }
      }
      return answer;
    });
    expect(q<HTMLInputElement>('input[aria-label="Apply Wind avg"]')!.disabled).toBe(true);
    await click(button('Apply'));
    const { patch, snapshot } = applied[0]!;
    expect(patch).not.toHaveProperty('windAverage');
    expect(patch).not.toHaveProperty('windLevels');
    expect(patch).not.toHaveProperty('windProfileSource');
    const next = applyProposal(launch, patch);
    expect(next.windLevels).toBe(launch.windLevels);
    expect(next.windProfileSource).toBe(launch.windProfileSource);
    expect(undoApply(next, snapshot)).toEqual(launch);
  });

  it.each(['surface', 'archive', 'calm'] as const)('clears an old profile when applying %s surface wind, with Undo', async (weather) => {
    const launch = { ...existingProfile('open-meteo'), launchAltitudeM: weather === 'archive' ? 1190 : 0 };
    const calmRoute: Route = async (url) => {
      const answer = await GERLACH(url);
      if (url.includes('/v1/forecast')) {
        for (const variant of answer.body as { hourly: Record<string, number[]> }[]) {
          variant.hourly['wind_speed_10m'] = variant.hourly['time']!.map(() => 0);
        }
      }
      return answer;
    };
    await review(launch, weather === 'archive' ? archiveRoute : weather === 'calm' ? calmRoute : GERLACH, weather === 'archive');
    await click(button('Apply'));
    const { patch, snapshot } = applied[0]!;
    expect(patch.windAverage).toBeDefined();
    if (weather === 'calm') expect(patch.windAverage).toBe(0);
    expect(patch.windLevels).toEqual([]);
    const next = applyProposal(launch, patch);
    expect(next.windLevels).toEqual([]);
    expect(next).not.toHaveProperty('windProfileSource');
    expect(undoApply(next, snapshot)).toEqual(launch);
  });

  it('preserves winds through an altitude-only Apply when every weather row is unchecked', async () => {
    const launch = { ...existingProfile('ork'), launchAltitudeM: 0 };
    await review(launch);
    for (const input of host.querySelectorAll<HTMLInputElement>('.weather-review tr input:checked')) await click(input);
    expect(button('Apply')!.disabled).toBe(false);
    await click(button('Apply'));
    const { patch, snapshot } = applied[0]!;
    expect(patch).toEqual({ launchAltitudeM: 1202 });
    const next = applyProposal(launch, patch);
    expect(next.windLevels).toBe(launch.windLevels);
    expect(next.windProfileSource).toBe(launch.windProfileSource);
    expect(undoApply(next, snapshot)).toEqual(launch);
  });

  it.each([false, true])('retains the aloft choice %s while Wind avg is unchecked and rechecked', async (aloft) => {
    const launch = existingProfile('ork');
    await review(launch);
    if (!aloft) await click(q('input[aria-label="Apply Winds aloft"]'));
    await click(q('input[aria-label="Apply Wind avg"]'));
    expect(q<HTMLInputElement>('input[aria-label="Apply Winds aloft"]')!.disabled).toBe(true);
    await click(button('Apply'));
    expect(applied[0]!.patch).not.toHaveProperty('windLevels');
    expect(applyProposal(launch, applied[0]!.patch).windLevels).toBe(launch.windLevels);
    // The harness keeps the dialog mounted after Apply so we can recheck it.
    await click(q('input[aria-label="Apply Wind avg"]'));
    expect(q<HTMLInputElement>('input[aria-label="Apply Winds aloft"]')!.checked).toBe(aloft);
    await click(button('Apply'));
    const { patch, snapshot } = applied[1]!;
    expect(patch.windLevels).toHaveLength(aloft ? 2 : 0);
    const next = applyProposal(launch, patch);
    if (aloft) expect(next.windProfileSource).toMatchObject({ kind: 'open-meteo', place: GERLACH_PLACE.label });
    else expect(next).not.toHaveProperty('windProfileSource');
    expect(undoApply(next, snapshot)).toEqual(launch);
  });
  it('defaults to ticked, shows levels, strongest wind and compass bearings, and applies and undoes the profile', async () => {
    await review();
    expect(q<HTMLInputElement>('input[aria-label="Apply Winds aloft"]')!.checked).toBe(true);
    expect(q('.wind-profile')!.textContent).toContain('2 levels to 262 ft (80 m) above ground, strongest');
    expect(q('.wind-profile-table')!.textContent).toContain('10.0° N');
    expect(urls).toHaveLength(2);
    await click(button('Apply'));
    const { patch, snapshot } = applied[0]!;
    expect(patch.windLevels).toHaveLength(2);
    expect(patch.windLevels![0]!.speed).toBe(patch.windAverage);
    expect(patch.windProfileSource).toMatchObject({ kind: 'open-meteo', validUnix: SAT_2PM });
    expect(validWeatherSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect(undoApply(applyProposal(DEFAULT_CONDITIONS, patch), snapshot)).toEqual(DEFAULT_CONDITIONS);
  });
  it('unticking winds aloft applies surface weather and clears a preceding profile, with Undo', async () => {
    const launch = { ...DEFAULT_CONDITIONS, windAverage: 3, windLevels: [{ altitude: 0, speed: 3, direction: 0 }], windProfileSource: { kind: 'ork' as const } };
    await review(launch);
    await click(q('input[aria-label="Apply Winds aloft"]'));
    await click(button('Apply'));
    expect(applied[0]!.patch.windLevels).toEqual([]);
    expect(undoApply(applyProposal(launch, applied[0]!.patch), applied[0]!.snapshot)).toEqual(launch);
  });
  it('requires the surface wind with the profile and says when levels are unavailable', async () => {
    await review();
    await click(q('input[aria-label="Apply Wind avg"]'));
    expect(q<HTMLInputElement>('input[aria-label="Apply Winds aloft"]')!.disabled).toBe(true);
    await click(button('Apply'));
    expect(applied[0]!.patch.windLevels).toBeUndefined();
    expect(applied[0]!.patch.windAverage).toBeUndefined();
    render({ initialPlace: GERLACH_PLACE });
    clearWeatherCache();
    await click(button('Fetch'));
    expect(host.textContent).toContain('Winds aloft are unavailable');
  });
});
