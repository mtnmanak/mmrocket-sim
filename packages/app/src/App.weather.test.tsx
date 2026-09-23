// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import type { SessionState } from './services/session.js';
import { exportOrk } from './services/orkFile.js';
import { encodeShareFragment } from './services/shareLink.js';
import { DEFAULT_CONDITIONS, type LaunchConditions } from './components/LaunchPanel.js';
import type { WeatherSnapshot } from './services/weatherSnapshot.js';
import { ymdInZone } from './services/openMeteo.js';
import { APP_VERSION } from './version.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no canvas (the same stub App.session.test.tsx uses).
const ctx2d = new Proxy({}, {
  get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 0 }) : () => undefined),
});
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;

/**
 * The weather record's life in App (weather build, step 3): restored from the
 * autosave with the launch conditions it describes, and dropped when an opened
 * design — here a share link — brings launch conditions of its own. The whole
 * App, mounted, with fetch stubbed to fail as it would offline: nothing here
 * asks Open-Meteo anything.
 */

const SESSION_KEY = 'online-openrocket.session.v1';
const SNAP: WeatherSnapshot = {
  v: 1, provider: 'open-meteo', endpoint: 'forecast', model: 'best_match',
  place: { label: 'Gerlach, Nevada, US', latitudeDeg: 40.65157, longitudeDeg: -119.35519, method: 'search' },
  grid: { latitudeDeg: 40.66386, longitudeDeg: -119.35593 },
  demElevationM: 1202, forAltitudeM: 1202, timezone: 'America/Los_Angeles',
  validUnix: Date.UTC(2026, 8, 26, 21) / 1000, retrievedAt: '2026-09-22T18:00:00.000Z',
  fetched: { temperatureC: 23.3, pressureHPa: 877.2, windSpeedMs: 1.75, windGustMs: 4.6, windFromDeg: 294 },
  applied: { temperatureC: 23.3, pressureHPa: 877.2, launchAltitudeM: 1202 },
  before: { temperatureC: null, pressureHPa: null, launchAltitudeM: 0 },
};
const APPLIED: LaunchConditions = { ...DEFAULT_CONDITIONS, temperatureC: 23.3, pressureHPa: 877.2, launchAltitudeM: 1202 };

let mounted: { root: Root; host: HTMLElement }[] = [];
const settle = async (ms = 0) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
async function waitFor(pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await settle(50);
  }
}
async function mountApp(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => { root.render(<PrefsProvider><App /></PrefsProvider>); });
  return host;
}
const stored = (): SessionState | null => {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) as SessionState : null;
};

beforeEach(() => {
  localStorage.clear();
  // The Motors & Launch workspace, where the Launch panel lives; tour off.
  localStorage.setItem('online-openrocket.workspace.v1', 'motors');
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    tree: { name: 'Mine', components: [] }, launch: APPLIED, weather: SNAP, appVersion: APP_VERSION, savedAt: Date.now(),
  }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
});

afterEach(async () => {
  window.dispatchEvent(new Event('pagehide'));
  for (const { root, host } of mounted) {
    await act(async () => { root.unmount(); });
    host.remove();
  }
  mounted = [];
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', window.location.pathname);
});

describe('applied weather across a reload and an open', () => {
  it('comes back with the session, strip and field lines included, and is autosaved again', async () => {
    const host = await mountApp();
    await waitFor(() => host.querySelector('[data-weather="strip"]') !== null, 'the weather strip');
    expect(host.querySelector('[data-weather="strip"]')!.textContent).toContain('Gerlach, Nevada, US');
    expect(host.querySelector('[data-provenance="temperatureC"]')?.textContent).toBe('forecast');
    window.dispatchEvent(new Event('pagehide'));
    expect(stored()!.weather).toEqual(SNAP);
  }, 30000);

  // Provenance, not design: a saved-clean design that gains a weather record
  // across a reload is still saved-clean — App's own dirty check, read through
  // ✕ New, which asks "Start a new design?" only when there is unsaved work.
  it('does not make a saved-clean design dirty', async () => {
    localStorage.removeItem(SESSION_KEY);
    localStorage.setItem('online-openrocket.workspace.v1', 'design');
    await mountApp();
    // A first visit is clean once the starter motor has landed and been autosaved.
    await waitFor(() => Object.keys(stored()?.mountMotors ?? {}).length > 0, 'the starter motor to be autosaved');
    window.dispatchEvent(new Event('pagehide'));
    for (const { root, host } of mounted) {
      await act(async () => { root.unmount(); });
      host.remove();
    }
    mounted = [];
    const s = stored()!;
    expect(s.savedMark, 'the clean first visit left a mark').toBeTruthy();
    expect(s.weather).toBeUndefined();
    localStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, weather: SNAP }));
    const host = await mountApp();
    await settle(600);
    const newButton = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('✕ New'))!;
    await act(async () => { newButton.click(); });
    expect(host.textContent).not.toContain('Start a new design?');
  }, 30000);

  // The stale strip's Fetch again opens on the applied weather's own date —
  // it opened on today, so fetching again for a moved Site altitude brought
  // today's air for Saturday's launch (review of 2026-09-23). ☁ Get weather
  // still opens on today, at the site.
  it('opens Fetch again on the applied hour’s date, and ☁ Get weather on today', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      tree: { name: 'Mine', components: [] }, launch: { ...APPLIED, launchAltitudeM: 1524 }, weather: SNAP,
      appVersion: APP_VERSION, savedAt: Date.now(),
    }));
    const host = await mountApp();
    const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
    const dateBox = () => host.querySelector<HTMLInputElement>('.weather-dialog input[type="date"]');
    await waitFor(() => button('Fetch again') !== undefined, 'the stale line’s Fetch again');
    await act(async () => { button('Fetch again')!.click(); });
    expect(dateBox()!.value).toBe('2026-09-26');
    expect(host.querySelector('.weather-chosen')!.textContent).toContain('Gerlach, Nevada, US');
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Close the weather dialog"]')!.click(); });
    expect(dateBox()).toBeNull();
    const before = ymdInZone(Date.now(), SNAP.timezone);
    await act(async () => { host.querySelector<HTMLButtonElement>('.panel-head .weather-btn')!.click(); });
    expect([before, ymdInZone(Date.now(), SNAP.timezone)]).toContain(dateBox()!.value);
  }, 30000);

  // Review of 2026-09-23: Undo took the gust chip's explanation away and left
  // the σ it had written from the forecast, unlabelled. Undo now puts that σ
  // back too; Dismiss keeps it, as it keeps every value, and only the notes go.
  it('Undo puts back the σ the gust chip wrote; Dismiss keeps it', async () => {
    const WIND_SNAP: WeatherSnapshot = {
      ...SNAP, applied: { ...SNAP.applied, windAverage: 1.75 }, before: { ...SNAP.before, windAverage: 0 },
    };
    const start = { ...APPLIED, windAverage: 1.75, windStdDev: 0.3 };
    const sigmaBox = (host: HTMLElement) => [...host.querySelectorAll('input')]
      .find((i) => (i.getAttribute('aria-label') ?? '').startsWith('Wind gusts σ'))!;
    const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === text)!;
    for (const [end, expected] of [['Undo', 0.3], ['Dismiss', 0.95]] as const) {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        tree: { name: 'Mine', components: [] }, launch: start, weather: WIND_SNAP, appVersion: APP_VERSION, savedAt: Date.now(),
      }));
      const host = await mountApp();
      await waitFor(() => host.querySelector('.gust-estimate button') !== null, 'the gust chip');
      expect(sigmaBox(host).value).toBe('0.3');
      await act(async () => { host.querySelector<HTMLButtonElement>('.gust-estimate button')!.click(); });
      expect(sigmaBox(host).value).toBe('0.95');
      await act(async () => { button(host, end).click(); });
      expect(host.querySelector('[data-weather="strip"]'), end).toBeNull();
      expect(host.querySelector('.gust-estimate'), end).toBeNull();
      expect(sigmaBox(host).value, end).toBe(String(expected));
      window.dispatchEvent(new Event('pagehide'));
      expect(stored()!.launch.windStdDev, end).toBe(expected);
      // Undo puts back every field the weather wrote, Wind avg included.
      if (end === 'Undo') expect(stored()!.launch).toMatchObject({ windAverage: 0, launchAltitudeM: 0, temperatureC: null });
      for (const m of mounted) {
        await act(async () => { m.root.unmount(); });
        m.host.remove();
      }
      mounted = [];
    }
  }, 30000);

  it('is dropped when a share link opens a design with launch conditions of its own', async () => {
    const xml = exportOrk({
      name: 'Linked',
      tree: {
        name: 'Linked',
        components: [{
          type: 'stage', name: 'Sustainer',
          children: [
            { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002 },
            { type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0005 },
          ],
        }],
      } as never,
      launch: { ...DEFAULT_CONDITIONS, windAverage: 3, launchAltitudeM: 300 },
    });
    window.location.hash = (await encodeShareFragment(xml)).replace(/^#/, '');
    const host = await mountApp();
    await waitFor(() => [...host.querySelectorAll('button')].some((b) => /^Open “Linked”/.test(b.textContent ?? '')),
      'the open-from-link offer');
    await act(async () => {
      [...host.querySelectorAll('button')].find((b) => /^Open “Linked”/.test(b.textContent ?? ''))!.click();
    });
    await waitFor(() => host.querySelector('[data-weather="strip"]') === null, 'the strip to go');
    expect(host.querySelector('[data-provenance]')).toBeNull();
    // The link's Longitude was blank, and it opens blank — the greyed −80.6
    // it flies, not a typed one (review of 2026-09-23).
    const lon = [...host.querySelectorAll('input')].find((i) => (i.getAttribute('aria-label') ?? '').startsWith('Longitude'))!;
    expect(lon.value).toBe('');
    expect(lon.placeholder).toBe('-80.6');
    window.dispatchEvent(new Event('pagehide'));
    const s = stored()!;
    expect(s.weather).toBeUndefined();
    expect(s.launch).toMatchObject({ windAverage: 3, launchAltitudeM: 300, longitudeDeg: null });
  }, 30000);
});
