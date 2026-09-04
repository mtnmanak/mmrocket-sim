// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TcMotor, TcSample, TcSimFile } from './thrustcurve.js';

/**
 * The download path of thrustcurve.ts: the network fetch, its deadline, and
 * the localStorage cache around it. Kept apart from thrustcurve.test.ts, which
 * covers the pure transforms and runs without a DOM; everything here needs
 * localStorage and a stubbed `fetch`.
 */

/** Real thrustcurve.org catalog entry (Quest C6, probed 2026-07-02). */
const QUEST_C6: TcMotor = {
  motorId: '5f4294d20002310000000016',
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

const CACHE_KEY = `tc:samples:v3:${QUEST_C6.motorId}`;

/**
 * A fresh copy of the module for every test. thrustcurve.ts remembers, per
 * page load, that it has already swept the retired cache generations; without
 * this only the first test in the file would ever exercise that sweep.
 */
async function freshModule(): Promise<typeof import('./thrustcurve.js')> {
  vi.resetModules();
  return import('./thrustcurve.js');
}

const okResponse = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

/** Stubs fetch with one canned download.json body; returns the spy. */
function stubDownload(results: TcSimFile[]): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => okResponse({ results }));
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
    expect(isSampleList([{ time: '0.1', thrust: 5 }])).toBe(false);
    expect(isSampleList([{ time: 0.1, thrust: null }])).toBe(false);
    // JSON has no Infinity literal, but JSON.parse('1e999') produces one.
    expect(isSampleList(JSON.parse('[{"time":0,"thrust":1e999}]'))).toBe(false);
    expect(isSampleList([{ time: NaN, thrust: 1 }])).toBe(false);
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

describe('a damaged curve from thrustcurve.org never reaches the kernel as NaN', () => {
  const BROKEN: TcSimFile = { format: 'RASP', samples: [{ thrust: 5 }, { thrust: 7 }] as TcSample[] };

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

  it('drops a cached entry whose samples are not numeric and re-fetches', async () => {
    const tc = await freshModule();
    localStorage.setItem(CACHE_KEY, JSON.stringify({ samples: [{ thrust: 5 }, { thrust: 7 }] }));
    stubDownload([{ format: 'RASP', samples: GOOD_SAMPLES }]);
    const spec = await tc.fetchMotorSpec(QUEST_C6, 5);
    expect(spec.masses.every((m) => Number.isFinite(m))).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
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
      await vi.advanceTimersByTimeAsync(15_000);
      await settled;
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
  it('frees the v1 and v2 keys a prefix bump left unreachable, and nothing else',
    async () => {
      const tc = await freshModule();
      // The three generations that shipped: `tc:samples:` (through v0.060),
      // `tc:samples:v2:` (v0.061-v0.064), `tc:samples:v3:` (from v0.065).
      localStorage.setItem('tc:samples:deadv1', JSON.stringify({ samples: GOOD_SAMPLES }));
      localStorage.setItem('tc:samples:v2:deadv2', JSON.stringify({ samples: GOOD_SAMPLES }));
      localStorage.setItem('tc:samples:v3:keepme', JSON.stringify({ samples: GOOD_SAMPLES }));
      // Neighbours in the same ~5 MB pool. The prefix match must not touch them.
      localStorage.setItem('online-openrocket.session', '{"tree":{}}');
      localStorage.setItem('tc:othersfeature:1', 'x');

      stubDownload([{ format: 'RASP', samples: GOOD_SAMPLES }]);
      await tc.fetchMotorSpec(QUEST_C6, 5);

      expect(localStorage.getItem('tc:samples:deadv1')).toBeNull();
      expect(localStorage.getItem('tc:samples:v2:deadv2')).toBeNull();
      expect(localStorage.getItem('tc:samples:v3:keepme')).not.toBeNull();
      expect(localStorage.getItem('online-openrocket.session')).toBe('{"tree":{}}');
      expect(localStorage.getItem('tc:othersfeature:1')).toBe('x');
    });

  const liveCount = (): number => {
    let n = 0;
    for (let i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i)?.startsWith('tc:samples:v3:')) n++;
    }
    return n;
  };

  it('caps the live generation, evicting the oldest entries first', async () => {
    const tc = await freshModule();
    // One over the 300 cap. Stamps ascend with the index, so entry 0 is oldest.
    for (let i = 0; i < 301; i++) {
      localStorage.setItem(`tc:samples:v3:seed${i}`,
        JSON.stringify({ samples: GOOD_SAMPLES, masses: null, t: 1_000 + i }));
    }
    stubDownload([{ format: 'RASP', samples: GOOD_SAMPLES }]);
    await tc.fetchMotorSpec(QUEST_C6, 5);

    // Pruned back to the 240 low-water mark, plus the entry just written.
    expect(liveCount()).toBe(241);
    expect(localStorage.getItem('tc:samples:v3:seed0')).toBeNull();
    expect(localStorage.getItem('tc:samples:v3:seed60')).toBeNull();
    expect(localStorage.getItem('tc:samples:v3:seed61')).not.toBeNull();
    expect(localStorage.getItem('tc:samples:v3:seed300')).not.toBeNull();
    expect(localStorage.getItem(CACHE_KEY)).not.toBeNull();
  });

  it('leaves the cache alone while it is under the cap', async () => {
    const tc = await freshModule();
    for (let i = 0; i < 50; i++) {
      localStorage.setItem(`tc:samples:v3:seed${i}`,
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
      localStorage.setItem(`tc:samples:v3:seed${i}`,
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
  const cacheWith = (masses: unknown): void => {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ samples: GOOD_SAMPLES, masses, t: Date.now() }));
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
      `{"samples":${JSON.stringify(GOOD_SAMPLES)},"masses":{"totalWeightG":1e999,"propWeightG":1}}`);
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
