// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TcMotor, TcSample, TcSimFile } from './thrustcurve.js';

/**
 * The download path of thrustcurve.ts: the network fetch, its deadline, and
 * the localStorage cache around it. Kept apart from thrustcurve.test.ts, which
 * covers the pure transforms and runs without a DOM; everything here needs
 * localStorage and a stubbed `fetch`.
 */

/**
 * A real thrustcurve.org catalog entry (Quest C6, probed 2026-07-02) under a
 * SYNTHETIC id. Since 2026-09-05 fetchMotorSpec answers from the shipped curve
 * bundle before it touches the network, and every real motorId is in that
 * bundle — so with the real id these tests never reached the download path
 * they exist to exercise. An id the bundle has never heard of forces the fetch.
 */
const QUEST_C6: TcMotor = {
  motorId: 'test:unbundled:quest-c6',
  manufacturerAbbrev: 'Quest',
  designation: 'C6',
  commonName: 'C6',
  impulseClass: 'C',
  diameter: 18,
  length: 70,
  avgThrustN: 3.45,
  maxThrustN: 15.46,
  totImpulseNs: 8.76,
  burnTimeS: 2.54,
  totalWeightG: 21,
  propWeightG: 12,
  delays: '0,3,5',
  availability: 'regular',
};

const GOOD_SAMPLES: TcSample[] = [
  { time: 0, thrust: 0 },
  { time: 0.1, thrust: 6.5 },
  { time: 0.15, thrust: 11.75 },
  { time: 1.0, thrust: 3.2 },
  { time: 2.5, thrust: 0 },
];

const CACHE_KEY = `tc:samples:v7:${QUEST_C6.motorId}`;

/**
 * A fresh copy of the module for every test. thrustcurve.ts remembers, per
 * page load, that it has already swept the retired cache generations; without
 * this only the first test in the file would ever exercise that sweep.
 */
async function freshModule(): Promise<typeof import('./thrustcurve.js')> {
  vi.resetModules();
  const tc = await import('./thrustcurve.js');
  // fetchMotorSpec consults the shipped curve bundle before the network, and
  // the bundle is a dynamic import of a 980 KB JSON — real I/O that fake
  // timers cannot advance. Load it once here, on real time, so the tests below
  // measure the download path and not the time the bundle took to arrive.
  await tc.bundledSimFiles('warm-the-bundle');
  return tc;
}

const okResponse = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

/** Stubs fetch with one canned download.json body; returns the spy. */
function stubDownload(results: TcSimFile[], motorId = QUEST_C6.motorId): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => okResponse({ results: results.map(f => ({ motorId, ...f })) }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** A fetch that never resolves on its own — it settles only when aborted. */
function stubHangingFetch(): ReturnType<typeof vi.fn> {
  const spy = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_ok, reject) => {
    const abort = (): void => {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    };
    if (init?.signal?.aborted) { abort(); return; }
    init?.signal?.addEventListener('abort', abort, { once: true });
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

/**
 * Yields microtasks until the stubbed fetch has been called. fetchMotorSpec
 * awaits the (pre-warmed) bundle lookup before it reaches the network, so
 * `spy.mock.calls[0]` is no longer populated on the same tick the call is made.
 * Bounded, so a fetch that never happens fails the test instead of hanging it.
 */
async function untilFetched(spy: ReturnType<typeof vi.fn>): Promise<void> {
  for (let i = 0; i < 100 && spy.mock.calls.length === 0; i++) await Promise.resolve();
  expect(spy.mock.calls.length, 'fetch was never reached').toBeGreaterThan(0);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('isSampleList — the numeric guard both sample paths share', () => {
  it('accepts a real curve and rejects every non-numeric shape', async () => {
    const { isSampleList } = await freshModule();
    expect(isSampleList(GOOD_SAMPLES)).toBe(true);

    expect(isSampleList([])).toBe(false);
    expect(isSampleList(null)).toBe(false);
    expect(isSampleList('not an array')).toBe(false);
    // The exact shape a schema change or a partial archive record produces:
    // thrust present, time missing.
    expect(isSampleList([{ thrust: 5 }, { thrust: 7 }])).toBe(false);
    expect(isSampleList([{ time: 0, thrust: 0 }, { time: '0.1', thrust: 5 }])).toBe(false);
    expect(isSampleList([{ time: 0, thrust: 0 }, { time: 0.1, thrust: null }])).toBe(false);
    // JSON has no Infinity literal, but JSON.parse('1e999') produces one.
    expect(isSampleList(JSON.parse('[{"time":0,"thrust":0},{"time":1,"thrust":1e999}]'))).toBe(false);
    expect(isSampleList([{ time: 0, thrust: 0 }, { time: NaN, thrust: 1 }])).toBe(false);
  });
});

describe('isHeaderMasses — the one mass test, shared by file and cache', () => {
  it('accepts the AeroTech K480W file pair and rejects impossible ones', async () => {
    const { isHeaderMasses } = await freshModule();
    expect(isHeaderMasses({ totalWeightG: 2059, propWeightG: 1232 })).toBe(true);

    // More propellant than loaded mass — the Cesaroni 25E75-17A shape. Its
    // burn would end at a negative rocket mass.
    expect(isHeaderMasses({ totalWeightG: 52, propWeightG: 104 })).toBe(false);
    expect(isHeaderMasses({ totalWeightG: 0, propWeightG: 0 })).toBe(false);
    expect(isHeaderMasses({ totalWeightG: -21, propWeightG: -12 })).toBe(false);
    expect(isHeaderMasses(JSON.parse('{"totalWeightG":1e999,"propWeightG":1}'))).toBe(false);
    expect(isHeaderMasses({ totalWeightG: 21 })).toBe(false);
    expect(isHeaderMasses(null)).toBe(false);
    expect(isHeaderMasses('21/12')).toBe(false);
  });
});

describe('download motor identity', () => {
  it.each([undefined, 'another-motor'])('refuses a file for motorId %s without flying or caching it', async motorId => {
    const tc = await freshModule();
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ results: [{ motorId, samples: GOOD_SAMPLES }] })));
    await expect(tc.fetchMotorSpec(QUEST_C6, 5)).rejects.toBeInstanceOf(tc.NoPublishedCurveError);
    expect(localStorage.getItem(CACHE_KEY)).toBeNull();
    expect(tc.lastCurveFiles(QUEST_C6.motorId)).toBeUndefined();
  });

  it('ignores another motor even when its file has the requested digest', async () => {
    const tc = await freshModule();
    const digest = 'a'.repeat(32);
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ results: [
      { motorId: 'another-motor', samples: GOOD_SAMPLES, digests: [digest] },
      { motorId: QUEST_C6.motorId, samples: GOOD_SAMPLES.map(s => ({ ...s, thrust: s.thrust * 2 })) },
    ] })));
    const read = await tc.curveFiles(QUEST_C6, { digest });
    expect(read.digest?.named).toBe('absent');
    expect(read.files).toHaveLength(1);
    expect(Math.max(...read.flown.samples!.map(s => s.thrust))).toBeCloseTo(23.5, 9);
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!).samples).toEqual(read.flown.samples);
  });
});

describe('a damaged curve from thrustcurve.org never reaches the kernel as NaN', () => {
  const BROKEN: TcSimFile = { format: 'RASP', samples: [{ thrust: 5 }, { thrust: 7 }] as TcSample[] };

  it.each([
    { samples: [{ time: 0, thrust: 0 }, { time: 1, thrust: 20_000_000 }], reason: /thrust.*10,000,000 N.*limit/i },
    { samples: [{ time: 0, thrust: 10 }, { time: 0, thrust: 10 }], reason: /two distinct.*points/i },
  ])('F5 diagnostic names the numeric curve rejection: $reason', async ({ samples, reason }) => {
    const tc = await freshModule();
    stubDownload([{ format: 'RASP', samples }]);
    await expect(tc.fetchMotorSpec(QUEST_C6, 5)).rejects.toThrow(reason);
    expect(localStorage.getItem(CACHE_KEY)).toBeNull();
  });

  it('pickSampleFile skips the damaged file and takes the sound sibling', async () => {
    const { pickSampleFile } = await freshModule();
    const good: TcSimFile = { format: 'RockSim', samples: GOOD_SAMPLES };
    expect(pickSampleFile([BROKEN, good])?.samples).toEqual(GOOD_SAMPLES);
    // ...and reports nothing usable when the damaged file is all there is,
    // rather than handing it on with a length >= 2.
    expect(pickSampleFile([BROKEN])).toBeNull();
  });

  it('fetchMotorSpec throws something actionable instead of a NaN MotorSpec', async () => {
    const tc = await freshModule();
    stubDownload([BROKEN]);
    await expect(tc.fetchMotorSpec(QUEST_C6, 5)).rejects.toThrow(/not numbers/);
    // Nothing was cached: a body this broken must not become a sticky entry.
    expect(localStorage.getItem(CACHE_KEY)).toBeNull();
  });

  it('still uses the good file in the same response, and caches it', async () => {
    const tc = await freshModule();
    stubDownload([BROKEN, { format: 'RockSim', samples: GOOD_SAMPLES }]);
    const spec = await tc.fetchMotorSpec(QUEST_C6, 5);
    expect(spec.times.every((t) => Number.isFinite(t))).toBe(true);
    expect(spec.masses.every((m) => Number.isFinite(m))).toBe(true);
    expect(localStorage.getItem(CACHE_KEY)).not.toBeNull();
    // GOOD_SAMPLES integrate to 9.53 N·s against the C6's certified 8.76
    // (+8.8 %), so the v0.116 impulse note rides along in curveRepairs — the
    // channel App already shows for curve repairs.
    expect(spec.curveRepairs?.some((n) => /\+8\.8 % against the 8\.76 N·s/.test(n))).toBe(true);
  });

  it('names the motor when the body itself is the wrong shape', async () => {
    const tc = await freshModule();
    // `results` as anything but an array used to reach .map() as a bare
    // TypeError with no motor in the message.
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ results: 'nope' })));
    await expect(tc.fetchMotorSpec(QUEST_C6, 5)).rejects.toThrow(/No sample data available for C6/);
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(null)));
    await expect(tc.fetchMotorSpec(QUEST_C6, 5)).rejects.toThrow(/No sample data available for C6/);
  });

  it('skips a null or non-object file in `results` instead of throwing a TypeError', async () => {
    // Audit 2026-09-22: `{"results":[null]}` threw "Cannot read properties of
    // null (reading 'samples')" out of pickSampleFile, naming no motor.
    const tc = await freshModule();
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ results: [null, 7, 'x'] })));
    await expect(tc.fetchMotorSpec(QUEST_C6, 5)).rejects.toThrow(/No sample data available for C6/);
    // …and a sound file beside the junk is still found on a fresh attempt.
    localStorage.removeItem('online-openrocket.no-curve.v1');
    const fetcher = vi.fn(async () => okResponse({ results: [null, { motorId: QUEST_C6.motorId, format: 'RASP', samples: GOOD_SAMPLES }] }));
    vi.stubGlobal('fetch', fetcher);
    const spec = await tc.fetchMotorSpec(QUEST_C6, 5);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(spec.masses.every((m) => Number.isFinite(m))).toBe(true);
  });

  it('reads the body capped, and names the motor when it runs past the cap', async () => {
    // Audit 2026-09-22: `res.json()` read any size of body whole. This one
    // is well-formed JSON a little over 4 MB — the old reader flew it.
    const tc = await freshModule();
    const big = JSON.stringify({ results: [{ motorId: QUEST_C6.motorId, format: 'RASP', samples: GOOD_SAMPLES }], pad: 'x'.repeat(4.5e6) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(big, { status: 200 })));
    await expect(tc.fetchMotorSpec(QUEST_C6, 5)).rejects.toThrow(/answer for C6 ran past 4 MB/);
  });

  it('reads an ordinary streamed body exactly as before', async () => {
    const tc = await freshModule();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ motorId: QUEST_C6.motorId, format: 'RASP', samples: GOOD_SAMPLES }] }), { status: 200 })));
    const spec = await tc.fetchMotorSpec(QUEST_C6, 5);
    expect(spec.masses.every((m) => Number.isFinite(m))).toBe(true);
  });

  it('names the motor when the body is not JSON at all', async () => {
    const tc = await freshModule();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 200 })));
    await expect(tc.fetchMotorSpec(QUEST_C6, 5)).rejects.toThrow(/answer for C6 was not readable/);
  });

  it('drops a cached entry whose samples are not numeric and re-fetches', async () => {
    const tc = await freshModule();
    localStorage.setItem(CACHE_KEY, JSON.stringify({ samples: [{ thrust: 5 }, { thrust: 7 }], massParser: 1 }));
    stubDownload([{ format: 'RASP', samples: GOOD_SAMPLES }]);
    const spec = await tc.fetchMotorSpec(QUEST_C6, 5);
    expect(spec.masses.every((m) => Number.isFinite(m))).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ time: 0, thrust: 10 }],
    [{ time: 0, thrust: 0 }, { time: 1, thrust: 0 }],
    [{ time: 0, thrust: 10 }, { time: 0, thrust: 10 }],
    [{ time: 0, thrust: 0 }, { time: 1, thrust: 20000000 }],
  ])('S1c-g3/g5 evicts an unflyable cache entry (%j)', async (...samples) => {
    const tc = await freshModule();
    localStorage.setItem(CACHE_KEY, JSON.stringify({ samples, massParser: 1 }));
    stubDownload([{ format: 'RASP', samples: GOOD_SAMPLES }]);
    const spec = await tc.fetchMotorSpec(QUEST_C6, 5);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(spec.times.length).toBeGreaterThanOrEqual(2);
    expect(spec.thrusts.every(f => f <= 10000000)).toBe(true);
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!).samples).toEqual(GOOD_SAMPLES);
  });
  it('skips a zero-thrust download in favour of its usable sibling', async () => {
    const tc = await freshModule();
    stubDownload([{ format: 'RASP', samples: [{ time: 0, thrust: 0 }, { time: 1, thrust: 0 }] },
      { format: 'RockSim', samples: GOOD_SAMPLES }]);
    const spec = await tc.fetchMotorSpec({ ...QUEST_C6, totImpulseNs: 0 }, 5);
    expect(spec.thrusts.some(f => f > 0)).toBe(true);
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!).samples).toEqual(GOOD_SAMPLES);
  });
});

/**
 * Audit 2026-09-30: the impulse note measured the RAW file, not the curve the
 * motor flies. A file whose first sample is after t = 0 flies with a (0, 0)
 * point in front (the kernel needs one), and that ramp is impulse the note
 * left out.
 */
describe('the impulse note measures the curve flown', () => {
  // Raw, these integrate to 36 N·s. Flown, the ramp from (0, 0) to the first
  // sample adds ½ × 0.3 s × 30 N = 4.5 N·s: 40.5.
  const LATE_START: TcSample[] = [{ time: 0.3, thrust: 30 }, { time: 1, thrust: 30 }, { time: 2, thrust: 0 }];
  const notesFor = async (totImpulseNs: number): Promise<string[]> => {
    const tc = await freshModule();
    stubDownload([{ format: 'RASP', samples: LATE_START }]);
    const spec = await tc.fetchMotorSpec({ ...QUEST_C6, totImpulseNs, burnTimeS: 2 }, 5);
    return spec.curveRepairs?.filter(tc.isImpulseNote) ?? [];
  };

  it('says nothing for a motor whose flown curve is its certified impulse', async () => {
    // Raw, this read "−11.1 % … expect apogee to read low".
    expect(await notesFor(40.5)).toEqual([]);
  });

  it('quotes the flown figure, and warns where only the flown curve is off', async () => {
    // Raw, 36 against 37.8 is −4.8 %: inside 5 %, no note. Flown, 40.5 is +7.1 %.
    expect(await notesFor(37.8)).toEqual([expect.stringMatching(
      /^The thrust curve flown for C6 integrates to 40\.5 N·s, \+7\.1 % against the 37\.8 N·s it is certified for — expect apogee to read high/)]);
  });
});

/**
 * Audit 2026-09-30: every failure on the way to a curve — no network, a
 * timeout, a bundle chunk that would not load — reached the importer as one
 * thrown Error, and its note said thrustcurve.org "publishes none". Offline, a
 * motor the catalogue check added (not in the bundle) read as having no curve
 * at all, and the user went looking for a file they did not need.
 */
describe('"no curve exists" is said only when thrustcurve.org says so', () => {
  const failure = async (p: Promise<unknown>): Promise<Error> => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    return err as Error;
  };

  it('an answer that lists no file is NoPublishedCurveError — the one failure that means none exists', async () => {
    let tc = await freshModule();
    stubDownload([]);
    const err = await failure(tc.fetchMotorSpec(QUEST_C6, 5));
    expect(err).toBeInstanceOf(tc.NoPublishedCurveError);
    expect(err.message).toMatch(/No sample data available for C6/);
    localStorage.clear();
    tc = await freshModule();
    const second = stubDownload([{ format: 'RASP', samples: [{ time: 0.1, thrust: 5 }] }]); // one sample cannot fly
    expect(await failure(tc.fetchMotorSpec(QUEST_C6, 5))).toBeInstanceOf(tc.NoPublishedCurveError);
    expect(second).toHaveBeenCalledOnce();
  });

  it('a connection that never opens is not that, and says to check the connection', async () => {
    const tc = await freshModule();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const err = await failure(tc.fetchMotorSpec(QUEST_C6, 5));
    expect(err).not.toBeInstanceOf(tc.NoPublishedCurveError);
    expect(err.message).toMatch(/^thrustcurve\.org could not be reached for C6\. thrustcurve.org is not answering/);
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  it('the guide says a shipped motor with no curve needs no request, online or offline', async () => {
    const tc = await freshModule();
    const { MOTOR_DB } = await import('./motorDb.js');
    const { default: bundle } = await import('../data/motorCurves.json');
    const curves: Record<string, unknown> = bundle.curves;
    const noCurve = MOTOR_DB.find((m) => !Object.hasOwn(curves, m.motorId))!;
    expect(noCurve).toBeDefined();
    const spy = stubDownload([]);
    const online = (await failure(tc.fetchMotorSpec(noCurve, 5))).message;
    const offlineSpy = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', offlineSpy);
    const offline = (await failure(tc.fetchMotorSpec(noCurve, 5))).message;
    const guide = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'user-guide.md'), 'utf8');
    const paragraph = guide.split('\n').find((l) => l.includes('with no bundled curve are the one gap')) ?? '';
    expect(paragraph).not.toBe('');
    expect(online).toBe(offline);
    expect(online.toLowerCase()).toContain('no sample data');
    expect(paragraph).toContain('the app makes no request when you pick one');
    expect(spy).not.toHaveBeenCalled();
    expect(offlineSpy).not.toHaveBeenCalled();
  });

  it('an HTTP error or an answer with no results list is not that either', async () => {
    let tc = await freshModule();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response));
    expect(await failure(tc.fetchMotorSpec(QUEST_C6, 5))).not.toBeInstanceOf(tc.NoPublishedCurveError);
    localStorage.clear();
    tc = await freshModule();
    const second = vi.fn(async () => okResponse({ results: 'nope' }));
    vi.stubGlobal('fetch', second);
    expect(await failure(tc.fetchMotorSpec(QUEST_C6, 5))).not.toBeInstanceOf(tc.NoPublishedCurveError);
    expect(second).toHaveBeenCalledOnce();
  });

  it('a bundle that fails to load is not "no curve" — the error says the bundle failed', async () => {
    vi.resetModules();
    vi.doMock('../data/motorCurves.json', () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    try {
      const tc = await import('./thrustcurve.js');
      // The real Quest C6, which the bundle carries — when it loads.
      const bundled: TcMotor = { ...QUEST_C6, motorId: '5f4294d20002310000000016' };
      // Its other caller (the motor browser) still reads a failed bundle as "no files".
      expect(await tc.bundledSimFiles(bundled.motorId)).toEqual([]);
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
      const err = await failure(tc.fetchMotorSpec(bundled, 5));
      expect(err).not.toBeInstanceOf(tc.NoPublishedCurveError);
      expect(err.message).toMatch(/^The thrust curves bundled with the app did not load, and thrustcurve\.org could not be reached for C6/);
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(600_000);
      // With a connection the download stands in for the bundle, as before.
      stubDownload([{ format: 'RASP', samples: GOOD_SAMPLES }], bundled.motorId);
      expect((await tc.fetchMotorSpec(bundled, 5)).times.length).toBeGreaterThan(1);
      // And thrustcurve.org's own "none" is still that, bundle or no bundle.
      localStorage.clear();
      stubDownload([]);
      expect(await failure(tc.fetchMotorSpec(bundled, 5))).toBeInstanceOf(tc.NoPublishedCurveError);
    } finally {
      vi.doUnmock('../data/motorCurves.json');
      vi.resetModules();
    }
  });
});

describe('the download has a deadline, and honours a caller cancelling it', () => {
  it('gives up on a stalled socket after 15 s with a message a rocketeer can act on',
    async () => {
      const tc = await freshModule();
      vi.useFakeTimers();
      stubHangingFetch();
      const p = tc.fetchMotorSpec(QUEST_C6, 5);
      const settled = expect(p).rejects.toThrow(/did not answer within 15 s/);
      // The abort the deadline caused rides along as `cause` — the rocketeer
      // reads the message, a bug report gets the original (audit 2026-09-22).
      const cause = p.then(() => undefined, (e: unknown) => (e as Error).cause);
      await vi.advanceTimersByTimeAsync(15_000);
      await settled;
      expect(await cause).toBeDefined();
    });

  it('is still pending just before the deadline — the timer is not a no-op', async () => {
    const tc = await freshModule();
    vi.useFakeTimers();
    stubHangingFetch();
    let done = false;
    const p = tc.fetchMotorSpec(QUEST_C6, 5).catch(() => { done = true; });
    await vi.advanceTimersByTimeAsync(14_900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(done).toBe(true);
  });

  it("passes a caller's signal through, and its abort is not reported as a timeout",
    async () => {
      const tc = await freshModule();
      const spy = stubHangingFetch();
      const ctrl = new AbortController();
      const p = tc.fetchMotorSpec(QUEST_C6, 5, ctrl.signal);
      await untilFetched(spy);
      // The fetch gets a live signal, not the caller's object verbatim: ours
      // merges the caller's abort with the deadline.
      const init = spy.mock.calls[0]![1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal!.aborted).toBe(false);

      ctrl.abort();
      expect(init.signal!.aborted).toBe(true);
      // Stop was pressed; do NOT tell the user the network stalled.
      await expect(p).rejects.toThrow(/aborted/i);
      await expect(p).rejects.not.toThrow(/did not answer within/);
    });

  it('a signal already aborted before the call never opens a connection that lingers',
    async () => {
      const tc = await freshModule();
      const spy = stubHangingFetch();
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(tc.fetchMotorSpec(QUEST_C6, 5, ctrl.signal)).rejects.toThrow();
      expect((spy.mock.calls[0]![1] as RequestInit).signal!.aborted).toBe(true);
    });

  it('clears its timer on success, so a resolved download leaves nothing pending',
    async () => {
      const tc = await freshModule();
      vi.useFakeTimers();
      stubDownload([{ format: 'RASP', samples: GOOD_SAMPLES }]);
      await tc.fetchMotorSpec(QUEST_C6, 5);
      expect(vi.getTimerCount()).toBe(0);
    });
});

describe('the curve cache is bounded and sweeps its retired generations', () => {
  it('frees the v1 to v6 keys a prefix bump left unreachable, and nothing else',
    async () => {
      const tc = await freshModule();
      // The generations: `tc:samples:` (through v0.060),
      // `tc:samples:v2:` (v0.061-v0.064), `tc:samples:v3:` (v0.065-v0.110),
      // `tc:samples:v4:` (v0.111-v0.115, the first pickSampleFile bump — a v3
      // entry holds the file the PRE-v0.107 chooser picked, which is the whole
      // reason v3 is dead rather than merely old), `tc:samples:v5:` (v0.116 to
      // 2026-10-01, the impulse-agreement term — same rule, so v4 is dead too),
      // `tc:samples:v6:` (that term measured on the curve flown, audit
      // 2026-09-30 — so v5 is dead too) and `tc:samples:v7:` (the last word
      // is the file, never its place in the list — so v6 is dead too).
      localStorage.setItem('tc:samples:deadv1', JSON.stringify({ samples: GOOD_SAMPLES }));
      localStorage.setItem('tc:samples:v2:deadv2', JSON.stringify({ samples: GOOD_SAMPLES }));
      localStorage.setItem('tc:samples:v3:deadv3', JSON.stringify({ samples: GOOD_SAMPLES }));
      localStorage.setItem('tc:samples:v4:deadv4', JSON.stringify({ samples: GOOD_SAMPLES }));
      localStorage.setItem('tc:samples:v5:deadv5', JSON.stringify({ samples: GOOD_SAMPLES }));
      localStorage.setItem('tc:samples:v6:deadv6', JSON.stringify({ samples: GOOD_SAMPLES }));
      localStorage.setItem('tc:samples:v7:keepme', JSON.stringify({ samples: GOOD_SAMPLES }));
      // Neighbours in the same ~5 MB pool. The prefix match must not touch them.
      localStorage.setItem('online-openrocket.session', '{"tree":{}}');
      localStorage.setItem('tc:othersfeature:1', 'x');

      stubDownload([{ format: 'RASP', samples: GOOD_SAMPLES }]);
      await tc.fetchMotorSpec(QUEST_C6, 5);

      expect(localStorage.getItem('tc:samples:deadv1')).toBeNull();
      expect(localStorage.getItem('tc:samples:v2:deadv2')).toBeNull();
      expect(localStorage.getItem('tc:samples:v3:deadv3')).toBeNull();
      expect(localStorage.getItem('tc:samples:v4:deadv4')).toBeNull();
      expect(localStorage.getItem('tc:samples:v5:deadv5')).toBeNull();
      expect(localStorage.getItem('tc:samples:v6:deadv6')).toBeNull();
      expect(localStorage.getItem('tc:samples:v7:keepme')).not.toBeNull();
      expect(localStorage.getItem('online-openrocket.session')).toBe('{"tree":{}}');
      expect(localStorage.getItem('tc:othersfeature:1')).toBe('x');
    });

  it('never flies an entry an older picker chose: a v5 or v6 entry is not read', async () => {
    // Either would outrank the network for as long as it lived (the cache is
    // keyed by motor, not by the rule that chose it).
    for (const generation of ['v5', 'v6']) {
      const tc = await freshModule();
      const STALE: TcSample[] = [{ time: 0, thrust: 0 }, { time: 1, thrust: 30 }, { time: 2, thrust: 0 }];
      localStorage.setItem(`tc:samples:${generation}:${QUEST_C6.motorId}`,
        JSON.stringify({ samples: STALE, masses: null }));
      const spy = stubDownload([{ format: 'RASP', samples: GOOD_SAMPLES }]);
      const spec = await tc.fetchMotorSpec(QUEST_C6, 5);
      expect(spy, generation).toHaveBeenCalledOnce();
      expect(spec.thrusts, generation).toEqual(GOOD_SAMPLES.map((s) => s.thrust));
      localStorage.clear();
    }
  });

  const liveCount = (): number => {
    let n = 0;
    for (let i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i)?.startsWith('tc:samples:v7:')) n++;
    }
    return n;
  };

  it('caps the live generation, evicting the oldest entries first', async () => {
    const tc = await freshModule();
    // One over the 300 cap. Stamps ascend with the index, so entry 0 is oldest.
    for (let i = 0; i < 301; i++) {
      localStorage.setItem(`tc:samples:v7:seed${i}`,
        JSON.stringify({ samples: GOOD_SAMPLES, masses: null, t: 1_000 + i }));
    }
    stubDownload([{ format: 'RASP', samples: GOOD_SAMPLES }]);
    await tc.fetchMotorSpec(QUEST_C6, 5);

    // Pruned back to the 240 low-water mark, plus the entry just written.
    expect(liveCount()).toBe(241);
    expect(localStorage.getItem('tc:samples:v7:seed0')).toBeNull();
    expect(localStorage.getItem('tc:samples:v7:seed60')).toBeNull();
    expect(localStorage.getItem('tc:samples:v7:seed61')).not.toBeNull();
    expect(localStorage.getItem('tc:samples:v7:seed300')).not.toBeNull();
    expect(localStorage.getItem(CACHE_KEY)).not.toBeNull();
  });

  it('leaves the cache alone while it is under the cap', async () => {
    const tc = await freshModule();
    for (let i = 0; i < 50; i++) {
      localStorage.setItem(`tc:samples:v7:seed${i}`,
        JSON.stringify({ samples: GOOD_SAMPLES, masses: null, t: 1_000 + i }));
    }
    stubDownload([{ format: 'RASP', samples: GOOD_SAMPLES }]);
    await tc.fetchMotorSpec(QUEST_C6, 5);
    expect(liveCount()).toBe(51);
  });

  it('stamps what it writes, so age ordering works on the next eviction', async () => {
    const tc = await freshModule();
    stubDownload([{ format: 'RASP', samples: GOOD_SAMPLES }]);
    const before = Date.now();
    await tc.fetchMotorSpec(QUEST_C6, 5);
    const entry = JSON.parse(localStorage.getItem(CACHE_KEY)!) as { t?: number };
    expect(typeof entry.t).toBe('number');
    expect(entry.t!).toBeGreaterThanOrEqual(before);
  });

  it('prunes and retries once when the quota is hit, instead of swallowing it', async () => {
    const tc = await freshModule();
    // happy-dom's Storage is proxied, so neither vi.spyOn(Storage.prototype)
    // nor assigning to localStorage.setItem intercepts. Stub the whole global.
    const map = new Map<string, string>();
    let quotaThrown = false;
    vi.stubGlobal('localStorage', {
      get length() { return map.size; },
      key: (i: number): string | null => [...map.keys()][i] ?? null,
      getItem: (k: string): string | null => map.get(k) ?? null,
      setItem: (k: string, v: string): void => {
        if (k === CACHE_KEY && !quotaThrown) {
          quotaThrown = true;
          const err = new Error('The quota has been exceeded.');
          err.name = 'QuotaExceededError';
          throw err; // setItem writes NOTHING on quota — the entry is not there.
        }
        map.set(k, v);
      },
      removeItem: (k: string): void => { map.delete(k); },
      clear: (): void => map.clear(),
    });
    for (let i = 0; i < 200; i++) {
      localStorage.setItem(`tc:samples:v7:seed${i}`,
        JSON.stringify({ samples: GOOD_SAMPLES, masses: null, t: 1_000 + i }));
    }

    stubDownload([{ format: 'RASP', samples: GOOD_SAMPLES }]);
    const spec = await tc.fetchMotorSpec(QUEST_C6, 5);
    // The motor still flies — the cache is best-effort.
    expect(spec.masses.every((m) => Number.isFinite(m))).toBe(true);
    // ...and the retry, after a hard prune to half the low-water mark (120),
    // wrote it: 120 survivors plus the new entry.
    expect(quotaThrown).toBe(true);
    expect(localStorage.getItem(CACHE_KEY)).not.toBeNull();
    expect(liveCount()).toBe(121);
  });
});

describe('cached masses are validated before they override the catalog', () => {
  it.each([
    { totalWeightG: 120, propWeightG: 60 },
    { totalWeightG: 2000, propWeightG: 1000 },
    null,
  ])('flies legacy cached masses offline without any request: %j', async masses => {
    const tc = await freshModule();
    const entry = JSON.stringify({ samples: GOOD_SAMPLES, masses, t: 1 });
    localStorage.setItem(CACHE_KEY, entry);
    const spy = vi.fn(async () => { throw new Error('offline'); });
    vi.stubGlobal('fetch', spy);
    const spec = await tc.fetchMotorSpec(QUEST_C6, 5);
    expect(spy).not.toHaveBeenCalled();
    expect(spec.masses[0]).toBeCloseTo((masses?.totalWeightG ?? QUEST_C6.totalWeightG!) / 1000, 12);
    expect(localStorage.getItem(CACHE_KEY)).toBe(entry);
    await tc.fetchMotorSpec(QUEST_C6, 5);
    expect(spy).not.toHaveBeenCalled();
  });

  // B (audit S5-3): the entry is kept, but a loaded bundle with a flyable
  // file for the motor flies; until the fix the entry outranked it.
  it('keeps a legacy cache entry when a bundle is available, and flies the bundle', async () => {
    const tc = await freshModule();
    const { MOTOR_DB } = await import('./motorDb.js');
    let motor: TcMotor | undefined;
    for (const candidate of MOTOR_DB) {
      if ((await tc.bundledSimFiles(candidate.motorId)).length) { motor = candidate; break; }
    }
    expect(motor).toBeDefined();
    const shipped = await tc.fetchMotorSpec(motor!, 5, undefined, { bundleOnly: true });
    const entry = JSON.stringify({ samples: GOOD_SAMPLES, masses: { totalWeightG: 2000, propWeightG: 1000 } });
    localStorage.setItem(`tc:samples:v7:${motor!.motorId}`, entry);
    const spy = stubDownload([]);
    expect(await tc.fetchMotorSpec(motor!, 5)).toStrictEqual(shipped);
    expect(spy).not.toHaveBeenCalled();
    expect(localStorage.getItem(`tc:samples:v7:${motor!.motorId}`)).toBe(entry);
  });

  it('the cache still stands in for a bundle chunk that will not load, in requireCurveBundle too', async () => {
    vi.resetModules();
    vi.doMock('../data/motorCurves.json', () => { throw new Error('Failed to fetch dynamically imported module'); });
    try {
      const tc = await import('./thrustcurve.js');
      const bundledC6: TcMotor = { ...QUEST_C6, motorId: '5f4294d20002310000000016' };
      localStorage.setItem(`tc:samples:v7:${bundledC6.motorId}`, JSON.stringify({ samples: GOOD_SAMPLES, masses: null }));
      const spy = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
      vi.stubGlobal('fetch', spy);
      expect(Math.max(...(await tc.fetchMotorSpec(bundledC6, 5)).thrusts)).toBe(11.75);
      expect(spy).not.toHaveBeenCalled();
      await expect(tc.requireCurveBundle([bundledC6])).resolves.toBeUndefined();
      await expect(tc.requireCurveBundle([QUEST_C6])).rejects.toThrow(/did not load/);
    } finally {
      vi.doUnmock('../data/motorCurves.json');
      vi.resetModules();
    }
  });
  const cacheWith = (masses: unknown): void => {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ samples: GOOD_SAMPLES, masses, massParser: 1, t: Date.now() }));
  };

  it('a valid cached file pair still wins over the catalog', async () => {
    const tc = await freshModule();
    cacheWith({ totalWeightG: 2059, propWeightG: 1232 });
    const catalog: TcMotor = { ...QUEST_C6, totalWeightG: 2078, propWeightG: 1292 };
    const spec = await tc.fetchMotorSpec(catalog, 5);
    expect(spec.masses[0]).toBeCloseTo(2.059, 12);
    expect(spec.masses[spec.masses.length - 1]!).toBeCloseTo(2.059 - 1.232, 12);
  });

  it('falls back to the checked catalog when the cached pair is impossible', async () => {
    const tc = await freshModule();
    // More propellant than loaded mass. samplesToMotorSpec refuses this shape
    // for CATALOG masses, but never sees the file masses that override them —
    // so unchecked it produced a rocket whose mass crosses zero mid-burn.
    cacheWith({ totalWeightG: 52, propWeightG: 104 });
    const spec = await tc.fetchMotorSpec(QUEST_C6, 5);
    expect(spec.masses[0]).toBeCloseTo(0.021, 12); // the catalog's 21 g
    expect(spec.masses.every((m) => m > 0)).toBe(true);
    expect(spec.masses.every((m) => Number.isFinite(m))).toBe(true);
  });

  it('falls back when the cached pair parses to Infinity', async () => {
    const tc = await freshModule();
    localStorage.setItem(CACHE_KEY,
      `{"samples":${JSON.stringify(GOOD_SAMPLES)},"massParser":1,"masses":{"totalWeightG":1e999,"propWeightG":1}}`);
    const spec = await tc.fetchMotorSpec(QUEST_C6, 5);
    expect(spec.masses[0]).toBeCloseTo(0.021, 12);
    expect(spec.masses.every((m) => Number.isFinite(m))).toBe(true);
  });

  it('reads a cached curve without touching the network at all', async () => {
    const tc = await freshModule();
    cacheWith(null);
    const spy = stubDownload([{ format: 'RASP', samples: GOOD_SAMPLES }]);
    await tc.fetchMotorSpec(QUEST_C6, 5);
    expect(spy).not.toHaveBeenCalled();
  });
});

/**
 * THE SHIPPED BUNDLE AND NOTHING ELSE (2026-10-01): what a headless Launch
 * flies a motor on (simulateFile's default, `network: 'forbid'`). The app's
 * own path reads this browser's curve cache BEFORE the bundle and downloads
 * what the bundle lacks, so its answer depends on that browser's history; a
 * bundle-only read must not — no cache read, no sweep of the cache's retired
 * generations (it changes nothing it reads), no EX library, no network.
 */
describe('fetchMotorSpec, bundle only', () => {
  /** A motor of the shipped catalogue, which the shipped bundle answers. */
  async function bundled(): Promise<TcMotor> {
    const { findDbMotor } = await import('./motorDb.js');
    return findDbMotor('C6', 18, undefined, 'Estes')!;
  }

  it('refuses a motor the bundle lacks with a named error, and never calls fetch', async () => {
    const tc = await freshModule();
    const spy = stubDownload([{ format: 'RASP', samples: GOOD_SAMPLES }]);
    const err = await tc.fetchMotorSpec(QUEST_C6, 5, undefined, { bundleOnly: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(tc.OfflineCurveError);
    expect((err as Error).message).toBe('The thrust curve for C6 is not among the curves bundled with the app,'
      + ' and this run does not use the network.');
    expect(spy).not.toHaveBeenCalled();
    expect(await tc.bundledOnlyFetchSpec(QUEST_C6, 5).catch((e: unknown) => e)).toBeInstanceOf(tc.OfflineCurveError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('flies the bundle’s curve over a cached one, and leaves the cache as it found it', async () => {
    const tc = await freshModule();
    const motor = await bundled();
    const plain = await tc.fetchMotorSpec(motor, 5, undefined, { bundleOnly: true });
    // A valid cached entry for the same motor, 10 % hotter: the app's path flies it.
    const hot = plain.times.map((time, i) => ({ time, thrust: plain.thrusts[i]! * 1.1 }));
    const key = `tc:samples:v7:${motor.motorId}`;
    localStorage.setItem(key, JSON.stringify({ samples: hot, masses: null, massParser: 1, t: 1 }));
    localStorage.setItem('tc:samples:v6:retired', '{}');
    // Since audit S5-3 the app's path flies the bundle over that entry too.
    const viaApp = await tc.fetchMotorSpec(motor, 5);
    expect(viaApp).toStrictEqual(plain);

    const tc2 = await freshModule(); // a page load that has not swept yet
    localStorage.setItem('tc:samples:v6:retired', '{}');
    const bundleOnly = await tc2.fetchMotorSpec(motor, 5, undefined, { bundleOnly: true });
    expect(bundleOnly).toStrictEqual(plain);
    expect(localStorage.getItem(key)).not.toBeNull();
    expect(localStorage.getItem('tc:samples:v6:retired')).toBe('{}');
  });

  it('never reads this browser\'s cache: a motor the bundle lacks is refused even with an entry the app\'s path would fly', async () => {
    const tc = await freshModule();
    localStorage.setItem(CACHE_KEY, JSON.stringify({ samples: GOOD_SAMPLES, masses: null, massParser: 1, t: 1 }));
    const spy = stubDownload([]);
    expect(await tc.fetchMotorSpec(QUEST_C6, 5, undefined, { bundleOnly: true }).catch((e: unknown) => e)).toBeInstanceOf(tc.OfflineCurveError);
    // Positive control: the app's path flies the entry.
    expect(Math.max(...(await tc.fetchMotorSpec(QUEST_C6, 5)).thrusts)).toBe(11.75);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses an EX-library motor: it lives in one browser, not in the app', async () => {
    const tc = await freshModule();
    const ex = { ...QUEST_C6, motorId: 'ex:abc' };
    const err = await tc.fetchMotorSpec(ex, 5, undefined, { bundleOnly: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(tc.OfflineCurveError);
    expect((err as Error).message).toContain('EX');
  });
});

describe('a desktop design\'s <digest> picks among a downloaded motor\'s files', () => {
  // Two files of one motor, as download.json returns them with data "both":
  // the cert file the app picks, and another whose digest a desktop .ork
  // names. The digest is computed from each file's raw text.
  const rasp = (peak: number) => [
    '; synthetic', 'C6 18 70 0-3-5 0.012 0.021 Quest',
    '0.1 6.5', `0.15 ${peak}`, '1.0 3.2', '2.5 0', '',
  ].join('\n');
  const samples = (peak: number): TcSample[] => [
    { time: 0.1, thrust: 6.5 }, { time: 0.15, thrust: peak }, { time: 1.0, thrust: 3.2 }, { time: 2.5, thrust: 0 },
  ];
  const usual: TcSimFile = { simfileId: 'f-cert', source: 'cert', format: 'RASP', samples: samples(11.75), data: btoa(rasp(11.75)) };
  const other: TcSimFile = { simfileId: 'f-user', source: 'user', format: 'RASP', samples: samples(14), data: btoa(rasp(14)) };

  it('flies the file the digest names, and leaves the cache to the usual pick', async () => {
    const tc = await freshModule();
    const digest = tc.fileDigests(other)[0]!;
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
    expect(tc.fileDigests(usual)[0]).not.toBe(digest);
    expect(tc.pickSampleFile([usual, other], QUEST_C6)).toBe(usual);

    stubDownload([usual, other]);
    const named = await tc.fetchMotorSpec(QUEST_C6, 5, undefined, { digest });
    expect(Math.max(...named.thrusts)).toBe(14);
    expect(localStorage.getItem(CACHE_KEY)).toBeNull();

    const plain = await tc.fetchMotorSpec(QUEST_C6, 5);
    expect(Math.max(...plain.thrusts)).toBe(11.75);
    expect(localStorage.getItem(CACHE_KEY)).not.toBeNull();
  });

  it('a digest that names none of the files changes nothing', async () => {
    const tc = await freshModule();
    stubDownload([usual, other]);
    const spec = await tc.fetchMotorSpec(QUEST_C6, 5, undefined, { digest: '0'.repeat(32) });
    expect(Math.max(...spec.thrusts)).toBe(11.75);
  });

  // A (113-16e): the cache holds the usual pick only; a warm cache flew it
  // for a design whose digest names the other file, and said nothing.
  it('plain first, then the digest: the named file flies, not the warm cache', async () => {
    const tc = await freshModule();
    const digest = tc.fileDigests(other)[0]!;
    const spy = stubDownload([usual, other]);
    expect(Math.max(...(await tc.fetchMotorSpec(QUEST_C6, 5)).thrusts)).toBe(11.75);
    expect(localStorage.getItem(CACHE_KEY)).not.toBeNull();
    expect(Math.max(...(await tc.fetchMotorSpec(QUEST_C6, 5, undefined, { digest })).thrusts)).toBe(14);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(tc.lastCurveFiles(QUEST_C6.motorId)).toMatchObject({ origin: 'download', digest: { value: digest, named: 'flown' } });
    // With no digest, the warm cache answers as before.
    expect(Math.max(...(await tc.fetchMotorSpec(QUEST_C6, 5)).thrusts)).toBe(11.75);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('offline (navigator.onLine false): the cached curve flies at once, with no request, and the fallback is recorded', async () => {
    const tc = await freshModule();
    const digest = tc.fileDigests(other)[0]!;
    stubDownload([usual, other]);
    await tc.fetchMotorSpec(QUEST_C6, 5);
    const spy = stubDownload([usual, other]);
    const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      expect(Math.max(...(await tc.fetchMotorSpec(QUEST_C6, 5, undefined, { digest })).thrusts)).toBe(11.75);
    } finally {
      offline.mockRestore();
    }
    expect(spy).not.toHaveBeenCalled();
    expect(tc.lastCurveFiles(QUEST_C6.motorId)).toMatchObject({ origin: 'cache', cachedFrom: 'download', cacheFallback: 'offline',
      digest: { value: digest, named: 'unknown' } });
  });

  it('a download that cannot be reached (TypeError): the cached curve flies, and the fallback is recorded', async () => {
    const tc = await freshModule();
    const digest = tc.fileDigests(other)[0]!;
    stubDownload([usual, other]);
    await tc.fetchMotorSpec(QUEST_C6, 5);
    const spy = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', spy);
    expect(Math.max(...(await tc.fetchMotorSpec(QUEST_C6, 5, undefined, { digest })).thrusts)).toBe(11.75);
    expect(spy).toHaveBeenCalledOnce();
    expect(tc.lastCurveFiles(QUEST_C6.motorId)).toMatchObject({ origin: 'cache', cacheFallback: 'failed', digest: { named: 'unknown' } });
  });

  it('a digest the cached file carries, or one the motor never published, flies from the cache with no request', async () => {
    const tc = await freshModule();
    stubDownload([usual, other]);
    await tc.fetchMotorSpec(QUEST_C6, 5);
    const spy = stubDownload([usual, other]);
    expect(Math.max(...(await tc.fetchMotorSpec(QUEST_C6, 5, undefined, { digest: tc.fileDigests(usual)[0]! })).thrusts)).toBe(11.75);
    expect(tc.lastCurveFiles(QUEST_C6.motorId)).toMatchObject({ origin: 'cache', digest: { named: 'flown' } });
    expect(Math.max(...(await tc.fetchMotorSpec(QUEST_C6, 5, undefined, { digest: '0'.repeat(32) })).thrusts)).toBe(11.75);
    expect(tc.lastCurveFiles(QUEST_C6.motorId)).toMatchObject({ origin: 'cache', digest: { named: 'absent' } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('an untagged (v0.196) entry with a digest reads as "digest unknown": the download is asked, and its fall-back is the entry', async () => {
    const tc = await freshModule();
    const digest = tc.fileDigests(usual)[0]!;
    localStorage.setItem(CACHE_KEY, JSON.stringify({ samples: usual.samples, masses: null, massParser: 1, t: 1 }));
    const spy = stubDownload([usual, other]);
    expect(Math.max(...(await tc.fetchMotorSpec(QUEST_C6, 5, undefined, { digest })).thrusts)).toBe(11.75);
    expect(spy).toHaveBeenCalledOnce();
    // The download rewrote the entry with its tags, so the next open needs no request.
    await tc.fetchMotorSpec(QUEST_C6, 5, undefined, { digest });
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('the cache and a digest that is not desktop\'s', () => {
  it('a label in no desktop form (not 32 lowercase hex) names no published file: the entry flies, with no request', async () => {
    const tc = await freshModule();
    localStorage.setItem(CACHE_KEY, JSON.stringify({ samples: GOOD_SAMPLES, masses: null, massParser: 1, t: 1 }));
    const spy = stubDownload([{ format: 'RASP', samples: GOOD_SAMPLES }]);
    await tc.fetchMotorSpec(QUEST_C6, 5, undefined, { digest: 'file-digest' });
    expect(spy).not.toHaveBeenCalled();
    expect(tc.lastCurveFiles(QUEST_C6.motorId)).toMatchObject({ origin: 'cache', digest: { value: 'file-digest', named: 'absent' } });
    // Positive control: a desktop-form digest the untagged entry cannot vouch for asks.
    await tc.fetchMotorSpec(QUEST_C6, 5, undefined, { digest: 'f'.repeat(32) });
    expect(spy).toHaveBeenCalledOnce();
  });
});

/**
 * H2: one source for "the files this motor flies from" (curveFiles), which
 * fetchMotorSpec flies and lastCurveFiles keeps for the page session, so a
 * caller that reports on the curve (digestCurveNote, lane 22) needs no
 * second read.
 */
describe('curveFiles and lastCurveFiles', () => {
  it('fetchMotorSpec flies the file curveFiles names, and lastCurveFiles holds that answer', async () => {
    const tc = await freshModule();
    const { findDbMotor } = await import('./motorDb.js');
    const motor = findDbMotor('C6', 18, undefined, 'Estes')!;
    expect(tc.lastCurveFiles(motor.motorId)).toBeUndefined();
    const spec = await tc.fetchMotorSpec(motor, 5);
    const read = tc.lastCurveFiles(motor.motorId)!;
    expect(read.origin).toBe('bundle');
    expect(read.files).toEqual(await tc.bundledFiles(motor.motorId));
    expect(read.flown).toBe(read.usual);
    expect(tc.samplesToMotorSpec(motor, read.flown.samples!, 5, tc.headerMasses(read.flown)).thrusts).toEqual(spec.thrusts);
    // The same answer, asked directly.
    expect((await tc.curveFiles(motor)).flown).toEqual(read.flown);
  });

  it('digestCurveNote reads the same files from it as from the bundle, with no second read', async () => {
    const tc = await freshModule();
    const { digestCurveNote } = await import('./digestCurveNote.js');
    const { MOTOR_DB } = await import('./motorDb.js');
    // A bundled motor whose files fly differently, named by a digest that is not the usual pick's.
    let found: { motor: TcMotor; digest: string } | undefined;
    for (const m of MOTOR_DB) {
      const files = await tc.bundledFiles(m.motorId);
      const usual = tc.pickSampleFile(files, m);
      const other = files.find(f => f !== usual && f.samples && usual && !tc.fliesTheSame(f, usual) && tc.fileDigests(f).length);
      if (other) { found = { motor: m, digest: tc.fileDigests(other)[0]! }; break; }
    }
    expect(found).toBeDefined();
    const { motor, digest } = found!;
    await tc.fetchMotorSpec(motor, 5, undefined, { digest });
    const ref = { designation: motor.designation, manufacturer: motor.manufacturerAbbrev, diameter: motor.diameter / 1000,
      length: motor.length / 1000, delay: 5, digest };
    const memo = vi.fn(async () => tc.lastCurveFiles(motor.motorId)!.files);
    const note = await digestCurveNote(ref, motor, memo);
    expect(note).toBeDefined();
    expect(note).toBe(await digestCurveNote(ref, motor));
    expect(tc.lastCurveFiles(motor.motorId)).toMatchObject({ origin: 'bundle', digest: { value: digest, named: 'flown' } });
  });

  it('keeps the newest 64 motors, dropping the oldest first', async () => {
    const tc = await freshModule();
    const { MOTOR_DB } = await import('./motorDb.js');
    const bundled: TcMotor[] = [];
    for (const m of MOTOR_DB) {
      if (bundled.length === 66) break;
      if ((await tc.bundledFiles(m.motorId)).length) bundled.push(m);
    }
    for (const m of bundled.slice(0, 65)) await tc.curveFiles(m);
    expect(tc.lastCurveFiles(bundled[0]!.motorId)).toBeUndefined();
    expect(tc.lastCurveFiles(bundled[1]!.motorId)).toBeDefined();
    expect(tc.lastCurveFiles(bundled[64]!.motorId)).toBeDefined();
    // A read moves a motor to the newest end: the next new motor drops
    // bundled[2], not bundled[1].
    await tc.curveFiles(bundled[1]!);
    await tc.curveFiles(bundled[65]!);
    expect(tc.lastCurveFiles(bundled[1]!.motorId)).toBeDefined();
    expect(tc.lastCurveFiles(bundled[2]!.motorId)).toBeUndefined();
  });

  it('refuses an EX-library motor, whose curve is not a catalogue file', async () => {
    const tc = await freshModule();
    await expect(tc.curveFiles({ ...QUEST_C6, motorId: 'ex:abc' })).rejects.toThrow(TypeError);
  });
});

describe('lane C sample and bundle guards', () => {
  it.each([{ time: -0.1, thrust: 2 }, { time: 3.1, thrust: -0.4 }])('S1c-5 rejects a negative sample %j in the picker and cache', async bad => {
    const tc = await freshModule();
    expect(tc.isSampleList([bad])).toBe(false);
    const good: TcSimFile = { format: 'RASP', samples: GOOD_SAMPLES };
    const broken: TcSimFile = { format: 'RASP', samples: [...GOOD_SAMPLES, bad] };
    expect(tc.pickSampleFile([broken, good])).toBe(good);
    localStorage.setItem(CACHE_KEY, JSON.stringify({ samples: broken.samples, massParser: 1, cachedAt: Date.now() }));
    const fetch = stubDownload([good]);
    await tc.fetchMotorSpec(QUEST_C6, 5);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!).samples).toEqual(GOOD_SAMPLES);
  });
  it.each(['constructor', 'toString', '__proto__'])('S1c-g4 treats prototype key %s as absent from the bundle', async id => {
    const tc = await freshModule();
    expect(await tc.bundleHasCurve(id)).toBe(false);
  });
});
