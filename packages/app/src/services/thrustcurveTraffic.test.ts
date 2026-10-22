// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TcMotor } from './thrustcurve.js';

type Client = typeof import('./thrustcurve.js');
let tc: Client;
let catalogue: typeof import('./catalogueOverlay.js');
let db: typeof import('./motorDb.js');
let traffic: typeof import('./thrustcurveTraffic.js');
let motor: TcMotor;
let noCurveMotor: TcMotor;
const KEY = 'online-openrocket.no-curve.v1';
const samples = [{ time: 0, thrust: 0 }, { time: 0.1, thrust: 12 }, { time: 1, thrust: 0 }];
// Catalogue refreshes must preserve the ordering these retry cases exercise.
const daysAfter = (date: string, days: number): string => new Date(Date.parse(date) + days * 86_400_000).toISOString();
const response = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });
const miss = (p: Promise<unknown>): Promise<Error> => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => {
  expect(e).toBeInstanceOf(Error);
  return e as Error;
});

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  tc = await import('./thrustcurve.js');
  catalogue = await import('./catalogueOverlay.js');
  db = await import('./motorDb.js');
  traffic = await import('./thrustcurveTraffic.js');
  motor = { ...db.MOTOR_DB.find((m) => m.designation === 'C6' && m.manufacturerAbbrev === 'Estes')!, motorId: 'new-motor' };
  const { default: bundle } = await import('../data/motorCurves.json');
  const curves: Record<string, unknown> = bundle.curves;
  noCurveMotor = db.MOTOR_DB.find(m => !Object.hasOwn(curves, m.motorId))!;
  expect(noCurveMotor).toBeDefined();
  await tc.bundledSimFiles('warm');
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.doUnmock('../data/motorCurves.json'); localStorage.clear();
});

it('remembers empty answers across module reloads, and retries once the catalogue date changes', async () => {
  const fetcher = vi.fn(async () => response({ results: [] }));
  vi.stubGlobal('fetch', fetcher);
  expect(await miss(tc.fetchMotorSpec(motor, 5))).toBeInstanceOf(tc.NoPublishedCurveError);
  expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ [motor.motorId]: db.MOTOR_DB_DATE });
  vi.resetModules();
  tc = await import('./thrustcurve.js');
  expect(await miss(tc.fetchMotorSpec(motor, 5))).toBeInstanceOf(tc.NoPublishedCurveError);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const currentDb = await import('./motorDb.js');
  currentDb.setCatalogueOverlay({ baseGenerated: currentDb.MOTOR_DB_DATE, fetchedAt: daysAfter(currentDb.MOTOR_DB_DATE, 1),
    liveCount: 1, added: [], changed: [], removed: [], rejected: [] });
  await miss(tc.fetchMotorSpec(motor, 5));
  await miss(tc.fetchMotorSpec(motor, 5));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each(['', 'garbage', '2026-02-31'])('an invalid overlay date (%s) still remembers an empty answer', async (fetchedAt) => {
  db.setCatalogueOverlay({ baseGenerated: db.MOTOR_DB_DATE, fetchedAt,
    liveCount: 0, added: [], changed: [], removed: [], rejected: [] });
  const fetcher = vi.fn(async () => response({ results: [] }));
  vi.stubGlobal('fetch', fetcher);
  await miss(tc.fetchMotorSpec(motor, 5));
  await miss(tc.fetchMotorSpec(motor, 5));
  expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ [motor.motorId]: db.MOTOR_DB_DATE });
});

it('a newer check retries a shipped absent curve once per catalogue check', async () => {
  const fetcher = vi.fn(async () => response({ results: [] }));
  vi.stubGlobal('fetch', fetcher);
  await miss(tc.fetchMotorSpec(noCurveMotor, 5));
  expect(fetcher).not.toHaveBeenCalled();
  for (const fetchedAt of [daysAfter(db.MOTOR_DB_DATE, 1), daysAfter(db.MOTOR_DB_DATE, 2)]) {
    db.setCatalogueOverlay({ baseGenerated: db.MOTOR_DB_DATE, fetchedAt,
      liveCount: 0, added: [], changed: [], removed: [], rejected: [] });
    await miss(tc.fetchMotorSpec(noCurveMotor, 5));
    await miss(tc.fetchMotorSpec(noCurveMotor, 5));
  }
  expect(fetcher).toHaveBeenCalledTimes(2);
  // A later check can discover a curve published since the shipped build.
  db.setCatalogueOverlay({ baseGenerated: db.MOTOR_DB_DATE, fetchedAt: daysAfter(db.MOTOR_DB_DATE, 3),
    liveCount: 0, added: [], changed: [], removed: [], rejected: [] });
  fetcher.mockImplementation(async () => response({ results: [{ samples }] }));
  expect((await tc.fetchMotorSpec(noCurveMotor, 5)).thrusts).toEqual([0, 12, 0]);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('remembers an answer whose only file has one sample', async () => {
  const fetcher = vi.fn(async () => response({ results: [{ samples: [{ time: 0.1, thrust: 5 }] }] }));
  vi.stubGlobal('fetch', fetcher);
  expect(await miss(tc.fetchMotorSpec(motor, 5))).toBeInstanceOf(tc.NoPublishedCurveError);
  expect(await miss(tc.fetchMotorSpec(motor, 5))).toBeInstanceOf(tc.NoPublishedCurveError);
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each([
  '', '{', '[]', '{"new-motor":5}', '{"new-motor":"garbage"}', '{"new-motor":"2026-02-31"}', '{"new-motor":"2026-10-09","bad":false}',
])('drops a corrupt negative cache (%s) and still downloads', async (raw) => {
  localStorage.setItem(KEY, raw);
  const fetcher = vi.fn(async () => response({ results: [{ samples }] }));
  vi.stubGlobal('fetch', fetcher);
  await tc.fetchMotorSpec(motor, 5);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(localStorage.getItem(KEY)).toBeNull();
});

it('caps the negative cache at 2,000 entries, evicting the oldest learned entry', async () => {
  localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`old-${i}`, db.MOTOR_DB_DATE]))));
  vi.stubGlobal('fetch', vi.fn(async () => response({ results: [] })));
  await miss(tc.fetchMotorSpec(motor, 5));
  const stored = JSON.parse(localStorage.getItem(KEY)!) as Record<string, string>;
  expect(Object.keys(stored)).toHaveLength(2000);
  expect(stored['old-0']).toBeUndefined();
  expect(stored[motor.motorId]).toBe(db.MOTOR_DB_DATE);
});

it('drops an over-limit negative store and tolerates unavailable storage', async () => {
  localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`old-${i}`, db.MOTOR_DB_DATE]))));
  const fetcher = vi.fn(async () => response({ results: [] }));
  vi.stubGlobal('fetch', fetcher);
  await miss(tc.fetchMotorSpec(motor, 5));
  expect(Object.keys(JSON.parse(localStorage.getItem(KEY)!) as object)).toEqual([motor.motorId]);
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('disabled'); }, removeItem: () => { throw new Error('disabled'); } });
  expect(await miss(tc.fetchMotorSpec(motor, 5))).toBeInstanceOf(tc.NoPublishedCurveError);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('only a matching bundle catalogue date can establish a shipped no-curve motor', async () => {
  const original = await import('../data/motorCurves.json');
  vi.resetModules();
  vi.doMock('../data/motorCurves.json', () => ({ default: { ...original.default,
    catalogueGenerated: daysAfter(db.MOTOR_DB_DATE, -1).slice(0, 10),
  } }));
  const client = await import('./thrustcurve.js');
  const fetcher = vi.fn(async () => response({ results: [] }));
  vi.stubGlobal('fetch', fetcher);
  await expect(client.fetchMotorSpec(noCurveMotor, 5))
    .rejects.toBeInstanceOf(client.NoPublishedCurveError);
  expect(fetcher).toHaveBeenCalledOnce();
});

it('a bundled file that cannot be picked is not mistaken for an absent file', async () => {
  const original = await import('../data/motorCurves.json');
  const shipped = noCurveMotor;
  vi.resetModules();
  vi.doMock('../data/motorCurves.json', () => ({ default: { ...original.default,
    curves: { [shipped.motorId]: [{ samples: [[0, 0]] }] },
  } }));
  const client = await import('./thrustcurve.js');
  const fetcher = vi.fn(async () => response({ results: [{ samples }] }));
  vi.stubGlobal('fetch', fetcher);
  expect((await client.fetchMotorSpec({ ...motor, motorId: shipped.motorId }, 5)).thrusts).toEqual([0, 12, 0]);
  expect(fetcher).toHaveBeenCalledOnce();
});

it('an imported EX motor bypasses the negative cache and breaker', async () => {
  const { addExMotors, parseEng, exToDbEntry, exToMotorSpec } = await import('./exMotors.js');
  const imported = parseEng('C6 18 70 3-5 0.012 0.021 Home\n0 0\n0.1 12\n1 0\n')[0]!;
  addExMotors([imported]);
  localStorage.setItem(KEY, JSON.stringify({ [imported.motorId]: db.MOTOR_DB_DATE }));
  const fetcher = vi.fn(async () => response({}, 503));
  vi.stubGlobal('fetch', fetcher);
  await miss(tc.fetchMotorSpec(motor, 5));
  expect(await tc.fetchMotorSpec(exToDbEntry(imported), 5)).toEqual(exToMotorSpec(imported, 5));
  expect(fetcher).toHaveBeenCalledOnce();
});

it('a partial bundle cannot establish that a shipped motor has no published curve', async () => {
  const original = await import('../data/motorCurves.json');
  vi.resetModules();
  vi.doMock('../data/motorCurves.json', () => ({ default: { ...original.default, complete: undefined } }));
  const client = await import('./thrustcurve.js');
  const fetcher = vi.fn(async () => response({ results: [{ samples }] }));
  vi.stubGlobal('fetch', fetcher);
  expect((await client.fetchMotorSpec(noCurveMotor, 5)).thrusts).toEqual([0, 12, 0]);
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each(['partial', 'mismatched', 'newer overlay'] as const)('design-open notes do not claim no published curve with a %s catalogue', async (kind) => {
  const original = await import('../data/motorCurves.json');
  vi.resetModules();
  vi.doMock('../data/motorCurves.json', () => ({ default: { ...original.default,
    ...(kind === 'partial' ? { complete: false } : {}),
    ...(kind === 'mismatched' ? { catalogueGenerated: daysAfter(db.MOTOR_DB_DATE, -1).slice(0, 10) } : {}),
  } }));
  const currentDb = await import('./motorDb.js');
  if (kind === 'newer overlay') currentDb.setCatalogueOverlay({ baseGenerated: currentDb.MOTOR_DB_DATE,
    fetchedAt: daysAfter(currentDb.MOTOR_DB_DATE, 1), liveCount: 0, added: [], changed: [], removed: [], rejected: [] });
  const { matchImportedMotor } = await import('./motorMatch.js');
  const shipped = currentDb.MOTOR_DB.find(m => m.motorId === noCurveMotor.motorId)!;
  const fetchSpec = vi.fn(async () => { throw new Error('download unavailable'); });
  const result = await matchImportedMotor({ designation: shipped.designation, manufacturer: shipped.manufacturerAbbrev,
    diameter: shipped.diameter / 1000, length: shipped.length / 1000, delay: 5 }, { findDb: () => shipped, fetchSpec });
  expect(fetchSpec).toHaveBeenCalledOnce();
  expect(result.note).toContain('download unavailable');
  expect(result.note).not.toContain('publishes none');
});

it('a backwards device clock never extends the pause beyond one hour', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
  vi.stubGlobal('fetch', vi.fn(async () => response({}, 503)));
  await miss(tc.fetchMotorSpec(motor, 5));
  vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
  expect(traffic.thrustcurveBackoffMessage()).toMatch(/about 60 minutes/);
  expect(() => traffic.assertThrustcurveAvailable()).toThrow(/about 60 minutes/);
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(() => traffic.assertThrustcurveAvailable()).not.toThrow();
});

it('offline connection advice retains its original import wording without back-off', async () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  expect((await miss(tc.fetchMotorSpec(motor, 5))).message)
    .toContain("Check the connection and try again, or import the motor's .rse/.eng file.");
});

it('back-off joins advice after existing punctuation without doubling it', () => {
  traffic.recordThrustcurveFailure(true, false, false);
  for (const message of ['HTTP 503', 'HTTP 503.', 'Offline?', 'Unavailable!']) {
    expect(traffic.withThrustcurveBackoff(message)).toBe(`${/[.!?]$/.test(message) ? message : message + '.'} ${traffic.thrustcurveBackoffMessage()}`);
  }
});

it('offline TypeError leaves requests available after reconnecting', async () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const fetcher = vi.fn(async () => { throw new TypeError('offline'); });
  vi.stubGlobal('fetch', fetcher);
  expect((await miss(tc.fetchMotorSpec(motor, 5))).message).not.toContain('app will not ask');
  expect(() => traffic.assertThrustcurveAvailable()).not.toThrow();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  window.dispatchEvent(new Event('online'));
  const good = vi.fn(async () => response({ results: [{ samples }] }));
  vi.stubGlobal('fetch', good);
  await tc.fetchMotorSpec(motor, 5);
  expect(good).toHaveBeenCalledOnce();
});

it('reconnecting closes an already open breaker', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({}, 503)));
  await miss(tc.fetchMotorSpec(motor, 5));
  expect(() => traffic.assertThrustcurveAvailable()).toThrow();
  window.dispatchEvent(new Event('online'));
  const good = vi.fn(async () => response({ results: [{ samples }] }));
  vi.stubGlobal('fetch', good);
  await tc.fetchMotorSpec(motor, 5);
  expect(good).toHaveBeenCalledOnce();
});

it('HTTP 511 captive portal does not open the breaker', async () => {
  const fetcher = vi.fn(async () => response({}, 511));
  vi.stubGlobal('fetch', fetcher);
  await expect(tc.fetchMotorSpec(motor, 5)).rejects.toThrow(/HTTP 511/);
  expect(() => traffic.assertThrustcurveAvailable()).not.toThrow();
  await expect(catalogue.checkForCatalogueUpdates({ force: true, fetchImpl: fetcher })).rejects.toThrow(/HTTP 511/);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(() => traffic.assertThrustcurveAvailable()).not.toThrow();
});

it('a Stop reported as TypeError or timeout does not open the breaker', async () => {
  const ctrl = new AbortController();
  const fetcher = vi.fn(async () => { ctrl.abort(); throw new TypeError('cancelled'); });
  await expect(traffic.thrustcurveFetch(fetcher)('https://www.thrustcurve.org/api/v1/download.json', { signal: ctrl.signal }))
    .rejects.toThrow('cancelled');
  expect(() => traffic.assertThrustcurveAvailable()).not.toThrow();
  traffic.recordThrustcurveFailure(true, true, false);
  expect(() => traffic.assertThrustcurveAvailable()).not.toThrow();
});

it('a failed bundle and open breaker retain the reload advice without claiming bundled motors load', async () => {
  vi.resetModules();
  vi.doMock('../data/motorCurves.json', () => { throw new Error('chunk gone'); });
  const client = await import('./thrustcurve.js');
  const fetcher = vi.fn(async () => response({}, 503));
  vi.stubGlobal('fetch', fetcher);
  const first = await miss(client.fetchMotorSpec(motor, 5));
  expect(first.message).toMatch(/bundled with the app did not load, and thrustcurve.org is not answering/);
  expect(first.message).toContain('Reload the app with a connection');
  const error = await miss(client.fetchMotorSpec(motor, 5));
  expect(error.message).toMatch(/bundled with the app did not load, and thrustcurve.org is not answering/);
  expect(error.message).toMatch(/about 10 minutes\. Reload the app with a connection/);
  expect(error.message).toContain("import the motor's .rse/.eng file");
  expect(error.message).not.toContain('still load');
  expect(fetcher).toHaveBeenCalledOnce();
});

it('the test-only reset isolates a previous request failure', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({}, 503)));
  await miss(tc.fetchMotorSpec(motor, 5));
  expect(() => traffic.assertThrustcurveAvailable()).toThrow();
  traffic.resetThrustcurveBackoffForTests();
  expect(() => traffic.assertThrustcurveAvailable()).not.toThrow();
});

it('a success already in flight closes a breaker opened by another request', async () => {
  let resolve!: (value: Response) => void;
  const wrapped = traffic.thrustcurveFetch(vi.fn(() => new Promise<Response>((r) => { resolve = r; })));
  const inFlight = wrapped('https://www.thrustcurve.org/api/v1/metadata.json');
  vi.stubGlobal('fetch', vi.fn(async () => response({}, 503)));
  await miss(tc.fetchMotorSpec(motor, 5));
  expect(() => traffic.assertThrustcurveAvailable()).toThrow(/about 10 minutes/);
  resolve(response({}));
  await inFlight;
  expect(() => traffic.assertThrustcurveAvailable()).not.toThrow();
});

it('does not remember malformed answers or open the breaker for HTTP 404', async () => {
  const fetcher = vi.fn(async () => response({ results: 'bad shape' }));
  vi.stubGlobal('fetch', fetcher);
  expect(await miss(tc.fetchMotorSpec(motor, 5))).not.toBeInstanceOf(tc.NoPublishedCurveError);
  expect(localStorage.getItem(KEY)).toBeNull();
  fetcher.mockImplementation(async () => response({}, 404));
  await expect(tc.fetchMotorSpec(motor, 5)).rejects.toThrow(/HTTP 404/);
  expect(() => traffic.assertThrustcurveAvailable()).not.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([
  ['503', 503, undefined, 600_000], ['429 seconds', 429, '120', 120_000],
  ['429 date', 429, 'Sat, 17 Oct 2026 12:03:00 GMT', 180_000],
  ['minimum', 503, '0', 60_000], ['maximum', 503, '99999', 3_600_000],
  ['invalid', 503, 'nonsense', 600_000], ['network', 0, undefined, 600_000],
] as const)('shares %s back-off between download and catalogue, then permits one request', async (_label, status, retryAfter, duration) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
  const fetcher = vi.fn(async () => {
    if (!status) throw new TypeError('Failed to fetch');
    return response({}, status, retryAfter === undefined ? undefined : { 'Retry-After': retryAfter });
  });
  vi.stubGlobal('fetch', fetcher);
  const first = await miss(tc.fetchMotorSpec(motor, 5));
  const expected = new RegExp(`about ${duration / 60_000} minute${duration === 60_000 ? '' : 's'}\\.`);
  expect(first.message).toMatch(expected);
  if (status) expect(first.message).toMatch(new RegExp(`HTTP ${status}\\. thrustcurve\\.org`));
  if (status === 429) expect(first.message).toContain('is refusing requests right now');
  if (!status) expect(first.message).not.toContain('are you offline?');
  expect(first.message).not.toContain('Check the connection and try again');
  await expect(tc.fetchMotorSpec({ ...motor, motorId: 'another' }, 5)).rejects.toThrow(expected);
  await expect(catalogue.checkForCatalogueUpdates({ force: true, fetchImpl: fetcher })).rejects.toThrow(expected);
  expect(fetcher).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(duration - 1);
  await expect(tc.fetchMotorSpec(motor, 5)).rejects.toThrow(/about 1 minute\./);
  expect(fetcher).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  fetcher.mockImplementation(async () => response({ results: [{ samples }] }));
  await tc.fetchMotorSpec(motor, 5);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(() => traffic.assertThrustcurveAvailable()).not.toThrow();
});

const hanging: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
  const abort = () => reject(new DOMException('aborted', 'AbortError'));
  if (init?.signal?.aborted) abort();
  else init?.signal?.addEventListener('abort', abort, { once: true });
});

it.each(['download', 'catalogue'] as const)('%s timeout opens the shared breaker without another request', async (source) => {
  vi.useFakeTimers();
  const fetcher = vi.fn(hanging);
  vi.stubGlobal('fetch', fetcher);
  const p = miss(source === 'download' ? tc.fetchMotorSpec(motor, 5)
    : catalogue.checkForCatalogueUpdates({ force: true, fetchImpl: fetcher }));
  await vi.advanceTimersByTimeAsync(source === 'download' ? 15_000 : 30_000);
  expect((await p).message).toMatch(/did not answer within/);
  expect((await p).message).toMatch(/\. thrustcurve.org is not answering/);
  expect((await p).message).toContain('app will not ask it again for about 10 minutes');
  expect(() => traffic.assertThrustcurveAvailable()).toThrow(/about 10 minutes/);
  await expect(tc.fetchMotorSpec(motor, 5)).rejects.toThrow(/about 10 minutes/);
  await expect(catalogue.checkForCatalogueUpdates({ force: true, fetchImpl: fetcher })).rejects.toThrow(/about 10 minutes/);
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each(['download', 'catalogue'] as const)('%s Stop leaves the breaker closed', async (source) => {
  const ctrl = new AbortController();
  const fetcher = vi.fn(hanging);
  vi.stubGlobal('fetch', fetcher);
  const p = miss(source === 'download' ? tc.fetchMotorSpec(motor, 5, ctrl.signal)
    : catalogue.checkForCatalogueUpdates({ force: true, signal: ctrl.signal, fetchImpl: fetcher }));
  for (let i = 0; i < 100 && !fetcher.mock.calls.length; i++) await Promise.resolve();
  expect(fetcher).toHaveBeenCalledOnce();
  ctrl.abort();
  expect((await p).name).toBe('AbortError');
  fetcher.mockImplementation(async () => response({ results: [{ samples }] }));
  await tc.fetchMotorSpec(motor, 5);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('a catalogue HTTP failure blocks subsequent downloads and checks, even when forced', async () => {
  const fetcher = vi.fn(async () => response({}, 503));
  const first = await miss(catalogue.checkForCatalogueUpdates({ force: true, fetchImpl: fetcher }));
  expect(first.message).toMatch(/HTTP 503 for \/metadata.json\?availability=all\. thrustcurve.org is not answering.*app will not ask it again for about 10 minutes/);
  vi.stubGlobal('fetch', fetcher);
  await expect(tc.fetchMotorSpec(motor, 5)).rejects.toThrow(/about 10 minutes/);
  await expect(catalogue.checkForCatalogueUpdates({ force: true, fetchImpl: fetcher })).rejects.toThrow(/about 10 minutes/);
  expect(fetcher).toHaveBeenCalledOnce();
});

it('a catalogue 429 says requests are refused, with a separate back-off sentence', async () => {
  const fetcher = vi.fn(async () => response({}, 429, { 'Retry-After': '120' }));
  const first = await miss(catalogue.checkForCatalogueUpdates({ force: true, fetchImpl: fetcher }));
  expect(first.message).toMatch(/HTTP 429 for \/metadata.json\?availability=all\. thrustcurve.org is refusing requests right now/);
  expect(first.message).toContain('about 2 minutes.');
  expect(fetcher).toHaveBeenCalledOnce();
});

it('a recent cached catalogue check remains available while the breaker is open', async () => {
  localStorage.setItem(catalogue.OVERLAY_KEY, JSON.stringify({ baseGenerated: db.MOTOR_DB_DATE,
    fetchedAt: new Date().toISOString(), liveCount: 0, added: [], changed: [], removed: [], rejected: [] }));
  const fetcher = vi.fn(async () => response({}, 503));
  vi.stubGlobal('fetch', fetcher);
  await miss(tc.fetchMotorSpec(motor, 5));
  expect((await catalogue.checkForCatalogueUpdates({ fetchImpl: fetcher })).skipped).toBe('recent');
  await expect(catalogue.checkForCatalogueUpdates({ force: true, fetchImpl: fetcher })).rejects.toThrow(/about 10 minutes/);
  expect(fetcher).toHaveBeenCalledOnce();
});

it('bundled and cached curves load byte for byte while the breaker is open', async () => {
  const bundled = db.MOTOR_DB.find((m) => m.designation === 'C6' && m.manufacturerAbbrev === 'Estes')!;
  const baseline = JSON.stringify(await tc.fetchMotorSpec(bundled, 5));
  // Readable fixture captured from the pre-traffic client; no kernel floats.
  expect(JSON.parse(baseline)).toEqual(C6_SPEC);
  localStorage.setItem('tc:samples:v7:cached', JSON.stringify({ samples, masses: null }));
  const cached = JSON.stringify(await tc.fetchMotorSpec({ ...motor, motorId: 'cached' }, 5));
  const fetcher = vi.fn(async () => response({}, 503));
  vi.stubGlobal('fetch', fetcher);
  await miss(tc.fetchMotorSpec(motor, 5));
  expect(JSON.stringify(await tc.fetchMotorSpec(bundled, 5))).toBe(baseline);
  expect(JSON.stringify(await tc.fetchMotorSpec({ ...motor, motorId: 'cached' }, 5))).toBe(cached);
  expect(fetcher).toHaveBeenCalledOnce();
});

it('documents no requests for known missing curves and the reload/back-off paths', () => {
  const guide = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../user-guide.md'), 'utf8');
  expect(guide).toContain('the app makes no request when you pick one');
  expect(guide).toContain('at most every six hours unless you ask again');
  expect(guide).toContain('loading a motor or opening a design can download its curve');
  expect(guide.indexOf('The app ships every thrust curve')).toBeLessThan(guide.indexOf('Three filter rows'));
  expect(guide).toContain('the app stops asking for a while and says so');
  expect(guide).toContain('loaded, opened in a design or flown in **Batch simulate**');
  expect(guide).toContain('a newer check allows one download attempt per motor again');
  expect(guide).toContain('unless every candidate already has a cached curve');
});

// Estes C6 at 5 s; JavaScript transform, no kernel results.
const C6_SPEC = {
  "designation": "C6",
  "diameter": 0.018,
  "length": 0.07,
  "times": [
    0,
    0.031,
    0.092,
    0.139,
    0.192,
    0.209,
    0.231,
    0.248,
    0.292,
    0.37,
    0.475,
    0.671,
    0.702,
    0.723,
    0.85,
    1.063,
    1.211,
    1.242,
    1.303,
    1.468,
    1.656,
    1.821,
    1.834,
    1.847,
    1.86
  ],
  "thrusts": [
    0,
    0.95,
    4.83,
    9.94,
    14.09,
    11.45,
    7.38,
    6.15,
    5.49,
    4.92,
    4.45,
    4.26,
    4.54,
    4.16,
    4.45,
    4.35,
    4.35,
    4.07,
    4.26,
    4.35,
    4.45,
    4.45,
    2.93,
    1.32,
    0
  ],
  "masses": [
    0.0231,
    0.02308196471534859,
    0.022866043470445574,
    0.022440919047621747,
    0.02166096800588361,
    0.021395074631012683,
    0.021141380334928038,
    0.02100052139358099,
    0.020686872789605924,
    0.020189613352211994,
    0.019587100116073154,
    0.018541629265631743,
    0.018374565576229216,
    0.01826267944699959,
    0.017593034533322977,
    0.016445145312589487,
    0.015656614497066415,
    0.015496764921524454,
    0.015185584303870108,
    0.014315573195550095,
    0.013302412756592837,
    0.012403098138236493,
    0.012344344141310986,
    0.012310508844978545,
    0.012299999999999998
  ],
  "cgX": 0.035,
  "ejectionDelay": 5
};
