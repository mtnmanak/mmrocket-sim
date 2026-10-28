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

it.each(['timeout', '503'] as const)('S7d-g6 retains a governing 429 refusal after %s', async failure => {
  vi.useFakeTimers();
  let finish!: (response: Response) => void;
  const overlapping = traffic.thrustcurveFetch(() => new Promise(resolve => { finish = resolve; }))('https://www.thrustcurve.org/api/v1/search.json');
  await traffic.thrustcurveFetch(async () => response({}, 429, { 'Retry-After': '1800' }))('https://www.thrustcurve.org/api/v1/search.json');
  if (failure === 'timeout') traffic.recordThrustcurveFailure(true, false, false);
  else { finish(response({}, 503)); await overlapping; }
  expect(traffic.thrustcurveBackoffMessage()).toContain('refusing requests');
  expect(traffic.thrustcurveBackoffMessage()).toContain('30 minutes');
  if (failure === 'timeout') { finish(response({}, 511)); await overlapping; }
  await vi.advanceTimersByTimeAsync(1800_000);
  traffic.recordThrustcurveFailure(true, false, false);
  expect(traffic.thrustcurveBackoffMessage()).toContain('not answering');
});

// Audit S5-4: batchSweep fetches in parallel, so a 200 sent BEFORE another
// request's 429 can land after it. Only a request sent after a window opened
// says anything about that window.
it('a 200 to a request sent before a 429 window opened leaves the window standing', async () => {
  vi.useFakeTimers();
  let finishA!: (response: Response) => void;
  const a = traffic.thrustcurveFetch(() => new Promise(resolve => { finishA = resolve; }))('https://www.thrustcurve.org/api/v1/download.json');
  await vi.advanceTimersByTimeAsync(1);
  await traffic.thrustcurveFetch(async () => response({}, 429, { 'Retry-After': '1800' }))('https://www.thrustcurve.org/api/v1/download.json');
  finishA(response({ results: [] }));
  await a;
  expect(traffic.thrustcurveBackoffMessage()).toContain('refusing requests');
  expect(traffic.thrustcurveBackoffMessage()).toContain('30 minutes');
  expect(() => traffic.assertThrustcurveAvailable()).toThrow(traffic.ThrustcurveBackoffError);
  const blocked = vi.fn(async () => response({ results: [] }));
  await expect(traffic.thrustcurveFetch(blocked)('https://www.thrustcurve.org/api/v1/download.json')).rejects.toThrow(/refusing requests/);
  expect(blocked).not.toHaveBeenCalled();
});

// No request passes assertThrustcurveAvailable while a window is open, so the
// only request "sent after" a window is one sent once it has passed.
it('positive control: a request sent after the window opened, once it allows one, goes through and clears it', async () => {
  vi.useFakeTimers();
  await traffic.thrustcurveFetch(async () => response({}, 429, { 'Retry-After': '60' }))('https://www.thrustcurve.org/api/v1/download.json');
  expect(traffic.thrustcurveBackoffMessage()).toContain('refusing requests');
  await vi.advanceTimersByTimeAsync(60_000);
  const sent = vi.fn(async () => response({ results: [] }));
  await traffic.thrustcurveFetch(sent)('https://www.thrustcurve.org/api/v1/download.json');
  expect(sent).toHaveBeenCalledOnce();
  expect(traffic.thrustcurveBackoffMessage()).toBe('');
  expect(() => traffic.assertThrustcurveAvailable()).not.toThrow();
});

it.each([undefined, '60', '600'])('retains the active 429 reason with Retry-After %s when a later failure extends the pause', async retryAfter => {
  vi.useFakeTimers();
  let finish!: (response: Response) => void;
  const overlapping = traffic.thrustcurveFetch(() => new Promise(resolve => { finish = resolve; }))('https://www.thrustcurve.org/api/v1/search.json');
  await traffic.thrustcurveFetch(async () => response({}, 429, retryAfter ? { 'Retry-After': retryAfter } : undefined))('https://www.thrustcurve.org/api/v1/search.json');
  await vi.advanceTimersByTimeAsync(1);
  traffic.recordThrustcurveFailure(true, false, false);
  expect(traffic.thrustcurveBackoffMessage()).toContain('refusing requests');
  finish(response({}, 503)); await overlapping;
  expect(traffic.thrustcurveBackoffMessage()).toContain('refusing requests');
  await vi.advanceTimersByTimeAsync((retryAfter ? Number(retryAfter) * 1000 : 600_000) - 1);
  expect(traffic.thrustcurveBackoffMessage()).toContain('not answering');
});

it.each(['garbage', '2026-02-31'])('a corrupt persisted overlay date (%s) preserves the shipped-date negative cache', async fetchedAt => {
  localStorage.setItem(catalogue.OVERLAY_KEY, JSON.stringify({ baseGenerated: db.MOTOR_DB_DATE, fetchedAt,
    liveCount: 0, added: [], changed: [], removed: [], rejected: [] }));
  localStorage.setItem(KEY, JSON.stringify({ retained: db.MOTOR_DB_DATE }));
  catalogue.restoreCatalogueOverlay();
  const fetcher = vi.fn(async () => response({ results: [] }));
  vi.stubGlobal('fetch', fetcher);
  await miss(tc.fetchMotorSpec(motor, 5));
  await miss(tc.fetchMotorSpec(motor, 5));
  expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ retained: db.MOTOR_DB_DATE, [motor.motorId]: db.MOTOR_DB_DATE });
});

// Under a legacy (pre-row-110) overlay; a curated snapshot keys on its own date (thrustcurve.snapshotCurves.test.ts, D.7).
it('remembers empty answers across module reloads, and retries once a legacy overlay\'s check date changes', async () => {
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

// A legacy overlay only: under a curated snapshot the snapshot's curves file answers instead, with no
// thrustcurve.org request (thrustcurve.snapshotCurves.test.ts, D.7).
it('a newer legacy check retries a shipped absent curve once per catalogue check', async () => {
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
  expect(fetcher).toHaveBeenCalledOnce();
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

// Until audit S5-4 this success closed the breaker: it was sent before the
// 503 opened it, so it says nothing about the window.
it('a success already in flight does not close a breaker another request opened after it was sent', async () => {
  let resolve!: (value: Response) => void;
  const wrapped = traffic.thrustcurveFetch(vi.fn(() => new Promise<Response>((r) => { resolve = r; })));
  const inFlight = wrapped('https://www.thrustcurve.org/api/v1/metadata.json');
  vi.stubGlobal('fetch', vi.fn(async () => response({}, 503)));
  await miss(tc.fetchMotorSpec(motor, 5));
  expect(() => traffic.assertThrustcurveAvailable()).toThrow(/about 10 minutes/);
  resolve(response({}));
  await inFlight;
  expect(() => traffic.assertThrustcurveAvailable()).toThrow(/about 10 minutes/);
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
] as const)('holds a %s back-off on downloads, never on the catalogue check, then permits one request', async (_label, status, retryAfter, duration) => {
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
  expect(fetcher).toHaveBeenCalledOnce();
  // The catalogue is not thrustcurve.org: its check still asks (A.3).
  const curated = vi.fn(async () => response({}, 503));
  await expect(catalogue.checkForCatalogueUpdates({ force: true, fetchImpl: curated })).rejects.toThrow(/catalogue\.mountainmanrockets\.com answered HTTP 503/);
  expect(curated).toHaveBeenCalledOnce();
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

it('a download timeout opens the breaker without another request', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(hanging);
  vi.stubGlobal('fetch', fetcher);
  const p = miss(tc.fetchMotorSpec(motor, 5));
  await vi.advanceTimersByTimeAsync(15_000);
  expect((await p).message).toMatch(/did not answer within/);
  expect((await p).message).toMatch(/\. thrustcurve.org is not answering/);
  expect((await p).message).toContain('app will not ask it again for about 10 minutes');
  expect(() => traffic.assertThrustcurveAvailable()).toThrow(/about 10 minutes/);
  await expect(tc.fetchMotorSpec(motor, 5)).rejects.toThrow(/about 10 minutes/);
  expect(fetcher).toHaveBeenCalledOnce();
});

it('a catalogue timeout leaves thrustcurve.org\'s breaker closed (replaces the shared-breaker case)', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(hanging);
  const p = miss(catalogue.checkForCatalogueUpdates({ force: true, fetchImpl: fetcher }));
  await vi.advanceTimersByTimeAsync(30_000);
  expect((await p).message).toBe('catalogue.mountainmanrockets.com did not answer within 30 s.');
  expect(traffic.thrustcurveBackoffMessage()).toBe('');
  expect(() => traffic.assertThrustcurveAvailable()).not.toThrow();
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

it('a catalogue 503 leaves thrustcurve.org\'s back-off empty and its downloads open (replaces "a catalogue HTTP failure blocks subsequent downloads and checks")', async () => {
  const curated = vi.fn(async () => response({}, 503));
  const first = await miss(catalogue.checkForCatalogueUpdates({ force: true, fetchImpl: curated }));
  expect(first.message).toBe('catalogue.mountainmanrockets.com answered HTTP 503.');
  expect(traffic.thrustcurveBackoffMessage()).toBe('');
  const download = vi.fn(async () => response({ results: [{ samples }] }));
  vi.stubGlobal('fetch', download);
  await tc.fetchMotorSpec(motor, 5);
  expect(download).toHaveBeenCalledOnce();
  // And a second check asks again: there is no catalogue breaker either.
  await miss(catalogue.checkForCatalogueUpdates({ force: true, fetchImpl: curated }));
  expect(curated).toHaveBeenCalledTimes(2);
});

it('an open thrustcurve.org back-off does not block a catalogue check (replaces "a recent cached catalogue check remains available while the breaker is open")', async () => {
  localStorage.setItem(catalogue.OVERLAY_KEY, JSON.stringify({ baseGenerated: db.MOTOR_DB_DATE,
    fetchedAt: new Date().toISOString(), liveCount: 0, added: [], changed: [], removed: [], rejected: [] }));
  vi.stubGlobal('fetch', vi.fn(async () => response({}, 503)));
  await miss(tc.fetchMotorSpec(motor, 5));
  expect(() => traffic.assertThrustcurveAvailable()).toThrow(/about 10 minutes/);
  const curated = vi.fn(async () => response({}, 500));
  expect((await catalogue.checkForCatalogueUpdates({ fetchImpl: curated })).skipped).toBe('recent');
  expect(curated).not.toHaveBeenCalled();
  // Forced, it asks the catalogue — the breaker is thrustcurve.org's alone.
  await expect(catalogue.checkForCatalogueUpdates({ force: true, fetchImpl: curated })).rejects.toThrow(/HTTP 500/);
  expect(curated).toHaveBeenCalledOnce();
});

it('bundled and cached curves load byte for byte while the breaker is open', async () => {
  const fetcher = vi.fn(async () => response({}, 503));
  vi.stubGlobal('fetch', fetcher);
  const bundled = db.MOTOR_DB.find((m) => m.designation === 'C6' && m.manufacturerAbbrev === 'Estes')!;
  const baseline = JSON.stringify(await tc.fetchMotorSpec(bundled, 5));
  // Readable fixture captured from the pre-traffic client; no kernel floats.
  expect(JSON.parse(baseline)).toEqual(C6_SPEC);
  localStorage.setItem('tc:samples:v7:cached', JSON.stringify({ samples, masses: null, massParser: 1 }));
  const cached = JSON.stringify(await tc.fetchMotorSpec({ ...motor, motorId: 'cached' }, 5));
  expect(fetcher).not.toHaveBeenCalled();
  await miss(tc.fetchMotorSpec(motor, 5));
  expect(JSON.stringify(await tc.fetchMotorSpec(bundled, 5))).toBe(baseline);
  expect(JSON.stringify(await tc.fetchMotorSpec({ ...motor, motorId: 'cached' }, 5))).toBe(cached);
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each([null, { totalWeightG: 2000, propWeightG: 1000 }])('flies legacy cached masses %j through an open breaker without requests', async masses => {
  const fetcher = vi.fn(async () => response({}, 503));
  vi.stubGlobal('fetch', fetcher);
  await miss(tc.fetchMotorSpec(motor, 5));
  localStorage.setItem('tc:samples:v7:legacy', JSON.stringify({ samples, masses }));
  const spec = await tc.fetchMotorSpec({ ...motor, motorId: 'legacy' }, 5);
  expect(spec.times.length).toBeGreaterThan(1);
  expect(localStorage.getItem('tc:samples:v7:legacy')).not.toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
});

// Until audit S5-3 the entry flew ahead of the bundle; it is kept, and the
// loaded bundle flies, with the breaker open or not.
it('keeps legacy cached masses while the breaker is open, and flies the bundle over them', async () => {
  const bundled = db.MOTOR_DB.find(m => m.designation === 'C6' && m.manufacturerAbbrev === 'Estes')!;
  const shipped = await tc.fetchMotorSpec(bundled, 5, undefined, { bundleOnly: true });
  const fetcher = vi.fn(async () => response({}, 503));
  vi.stubGlobal('fetch', fetcher);
  await miss(tc.fetchMotorSpec(motor, 5));
  const key = 'tc:samples:v7:' + bundled.motorId;
  localStorage.setItem(key, JSON.stringify({ samples, masses: { totalWeightG: 2000, propWeightG: 1000 } }));
  expect(await tc.fetchMotorSpec(bundled, 5)).toStrictEqual(shipped);
  expect(localStorage.getItem(key)).not.toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
});

it('documents no thrustcurve.org requests for known missing curves and the reload/back-off paths', () => {
  const guide = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../user-guide.md'), 'utf8');
  // Row 110 / D.7: a missing curve is answered by the curated catalogue, never thrustcurve.org.
  expect(guide).toContain('the app makes no request when you pick one before the catalogue has been checked');
  expect(guide).toContain('the motor stays without one and thrustcurve.org is not asked');
  expect(guide).toContain('When it loads online, at most every six hours');
  expect(guide).toContain('loading a motor or opening a design can download its curve');
  expect(guide.indexOf('The app ships every thrust curve')).toBeLessThan(guide.indexOf('Three filter rows'));
  expect(guide).toContain('the app stops asking for a while and says so');
  expect(guide).toContain('loaded, opened in a design or flown in **Batch simulate**');
  expect(guide.match(/a newer catalogue can supply a curve the app did not ship, from the curated catalogue rather than thrustcurve\.org/gi)).toHaveLength(2);
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
