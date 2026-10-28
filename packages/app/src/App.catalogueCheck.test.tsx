// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { MOTOR_DB, MOTOR_DB_DATE, getCatalogueOverlay, setCatalogueOverlay } from './services/motorDb.js';
import { checkForCatalogueUpdates, discardCatalogueOverlay } from './services/catalogueOverlay.js';
import { resetCatalogueAutoCheckForTests, startCatalogueAutoCheck } from './services/catalogueAutoCheck.js';
import { CATALOGUE_BASE } from './services/catalogueClient.js';
import { catalogueFetch, daysAfter, manifestOf, publication } from './services/catalogueFixture.testSupport.js';
import type { SessionState } from './services/session.js';

/**
 * The automatic catalogue check beside the running App (row 110, part C):
 * App's tests never start it (main.tsx does), it never holds up the first
 * render or a flight, and a result that changes a motor loaded in the design
 * says so once in the message strip.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom has no canvas, and a Launch lands on the Results tab's uPlot charts.
const ctx2d = new Proxy({}, { get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 0 }) : () => undefined) });
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;

const SESSION_KEY = 'online-openrocket.session.v1';
const RUNS_KEY = 'online-openrocket.sim-runs.v1';
const C6 = MOTOR_DB.find(m => m.manufacturerAbbrev === 'Estes' && m.designation === 'C6')!;
let mounted: { root: Root; host: HTMLElement }[] = [];
const settle = async (ms = 0) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };
async function waitFor(pred: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
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
const session = () => JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as SessionState | null;
const starterStored = () => Object.keys(session()?.mountMotors ?? {}).length > 0;
const runs = () => (JSON.parse(localStorage.getItem(RUNS_KEY) ?? '[]') as unknown[]).length;
const notice = () => document.querySelector('.notice-bar')?.textContent ?? '';

/** Every request App made, by URL; a fetch that fails as offline for anything but the catalogue. */
let seen: string[] = [];
const stubFetch = (catalogue: typeof fetch | null) => vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  seen.push(String(input));
  if (catalogue && String(input).startsWith(CATALOGUE_BASE)) return catalogue(input, init);
  throw new TypeError('offline (test)');
}));
const catalogueRequests = () => seen.filter(u => u.startsWith(CATALOGUE_BASE));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('online-openrocket.workspace.v1', 'design');
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  setCatalogueOverlay(null);
  resetCatalogueAutoCheckForTests();
  seen = [];
});
afterEach(async () => {
  window.dispatchEvent(new Event('pagehide'));
  for (const { root, host } of mounted) { await act(async () => { root.unmount(); }); host.remove(); }
  mounted = [];
  discardCatalogueOverlay();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('App makes no catalogue request under the default test setup; the started check makes exactly one manifest request', async () => {
  const pub = await publication(`${daysAfter(MOTOR_DB_DATE, 2)}.2`, MOTOR_DB);
  stubFetch(catalogueFetch(manifestOf(pub), [pub]));
  await mountApp();
  await waitFor(starterStored, 'the starter motor');
  await settle(100);
  expect(catalogueRequests()).toEqual([]);
  // Positive control: the same App, with the check started as main.tsx starts it.
  expect(await startCatalogueAutoCheck()).toBe('checked');
  expect(catalogueRequests().filter(u => u.endsWith('manifest.json'))).toHaveLength(1);
}, 30_000);

it('never blocks startup: with the manifest held, the first render commits and a flight completes', async () => {
  let answered = false;
  stubFetch(() => new Promise<Response>(() => { /* the manifest never answers */ }));
  const outcome = startCatalogueAutoCheck().then((o) => { answered = true; return o; });
  const host = await mountApp();
  expect(host.querySelector('.workspace-tabs')).not.toBeNull();
  await waitFor(starterStored, 'the starter motor');
  await act(async () => {
    [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Launch')!.click();
  });
  await waitFor(() => runs() === 1, 'the flight to be saved');
  expect(catalogueRequests()).toEqual([`${CATALOGUE_BASE}manifest.json`]);
  expect(answered).toBe(false);
  void outcome;
}, 30_000);

it('an automatic result that changes a loaded motor says so once in the message strip, and leaves the loaded flight data as it was', async () => {
  const changed = { ...C6, totImpulseNs: C6.totImpulseNs + 0.5 };
  const pub = await publication(`${daysAfter(MOTOR_DB_DATE, 2)}.2`, MOTOR_DB.map(m => m.motorId === C6.motorId ? changed : m));
  stubFetch(catalogueFetch(manifestOf(pub), [pub]));
  await mountApp();
  await waitFor(starterStored, 'the starter motor');
  const before = Object.values(session()!.mountMotors!)[0]!;
  expect(before.meta.motorId).toBe(C6.motorId);
  expect(notice()).not.toMatch(/In this design/);
  expect(await startCatalogueAutoCheck()).toBe('checked');
  await waitFor(() => /In this design/.test(notice()), 'the notice');
  expect(document.querySelectorAll('.notice-bar').length).toBe(1);
  expect(notice()).toContain('In this design: Estes C6 (totImpulseNs) — re-run the flight.');
  expect(getCatalogueOverlay()?.changed.map(c => c.motorId)).toEqual([C6.motorId]);
  // The installed change does not alter the loaded motor's flight data: the
  // spec a Launch flies is the one loaded before the check.
  await settle(500);
  const after = Object.values(session()!.mountMotors!)[0]!;
  expect(after.spec).toEqual(before.spec);
}, 30_000);

it('an automatic result that changes no loaded motor shows nothing; the button\'s result never reaches the strip', async () => {
  const other = MOTOR_DB.find(m => m.motorId !== C6.motorId && m.manufacturerAbbrev === 'AeroTech')!;
  const pub = await publication(`${daysAfter(MOTOR_DB_DATE, 2)}.2`, MOTOR_DB.map(m => m.motorId === other.motorId ? { ...m, totImpulseNs: m.totImpulseNs + 1 } : m));
  stubFetch(catalogueFetch(manifestOf(pub), [pub]));
  await mountApp();
  await waitFor(starterStored, 'the starter motor');
  expect(await startCatalogueAutoCheck()).toBe('checked');
  await settle(200);
  expect(getCatalogueOverlay()?.changed).toHaveLength(1);
  expect(notice()).not.toMatch(/In this design/);
  // A button check that does change the loaded C6: still nothing in the strip.
  const pub2 = await publication(`${daysAfter(MOTOR_DB_DATE, 2)}.3`, MOTOR_DB.map(m => m.motorId === C6.motorId ? { ...m, totImpulseNs: m.totImpulseNs + 1 } : m));
  await act(async () => { await checkForCatalogueUpdates({ force: true, fetchImpl: catalogueFetch(manifestOf(pub2), [pub2]) }); });
  await settle(200);
  expect(getCatalogueOverlay()?.changed.map(c => c.motorId)).toEqual([C6.motorId]);
  expect(notice()).not.toMatch(/In this design/);
}, 30_000);
