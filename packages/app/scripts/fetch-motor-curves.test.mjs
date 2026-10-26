import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { headerMasses as appHeaderMasses, isSampleList } from '../src/services/thrustcurve.ts';
import { BATCH, addDigests, compactFile, curvesDocument, downloadRawFiles, fetchCurves, headerMasses, main, rawDigests } from './fetch-motor-curves.mjs';

/**
 * fetch-motor-curves.mjs against a stand-in for thrustcurve.org — never the
 * network. Until 2026-09-22 its work ran at import, so none of this could be
 * tested, and a failed batch was reported only after the short bundle had been
 * written (audit 2026-09-22, Tests rows 480 and 523).
 */

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

it.each([null, {}, { results: [null] }, { results: [{ motorId: 42 }] }, 429])('raw census refuses %j and pauses before rejecting without another batch', async body => {
  const events = [];
  const operation = downloadRawFiles(Array.from({ length: BATCH + 1 }, (_, i) => `motor-${i}`), {
    fetchImpl: async () => { events.push('request'); return { ok: body !== 429, status: 429, json: async () => body }; },
    sleep: async ms => { events.push(ms); }, log: () => {},
  });
  await expect(operation).rejects.toThrow(body === 429 ? /HTTP 429/ : /download.json.*shape/);
  expect(events).toEqual(['request', 250]);
});

it('raw census retains prototype-named file IDs as own records', async () => {
  const raw = await downloadRawFiles(['motor'], {
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: ['__proto__', 'constructor', 'toString'].map(simfileId =>
      ({ motorId: 'motor', simfileId, format: 'RASP', data: 'cmF3' })) }) }),
    sleep: async () => {}, log: () => {},
  });
  expect(Object.keys(raw)).toEqual(['__proto__', 'constructor', 'toString']);
  for (const id of Object.keys(raw)) expect(raw[id]).toEqual({ motorId: 'motor', format: 'RASP', source: undefined, data: 'cmF3' });
});

describe('headerMasses, the build-time mirror of thrustcurve.ts', () => {
  // The bundle stores the two numbers instead of the file, and the app then
  // trusts them; a bundled curve must yield exactly the masses a live download
  // of the same file would. So each case runs through BOTH copies.
  const cases = [
    ['BOM-prefixed RockSim masses', '\uFEFF<engine initWt="100" propWt="50"/>',
      { totalWeightG: 100, propWeightG: 50 }],
    ['BOM-prefixed RASP comment', '\uFEFF; comment\nE20 29 100 P 0.01 0.02 Home\n',
      { totalWeightG: 20, propWeightG: 10 }],
    ['S1c-5 single-quoted RockSim attributes', "<engine initWt='100' propWt='50'/>",
      { totalWeightG: 100, propWeightG: 50 }],
    ['padded RockSim masses', '<engine initWt=" 100 " propWt=" 50 "/>',
      { totalWeightG: 100, propWeightG: 50 }],
    ['comment attributes do not override the engine',
      '<!-- initWt="120" propWt="60" --><engine initWt="100" propWt="50"/>',
      { totalWeightG: 100, propWeightG: 50 }],
    ...['0x1 0x2', '0b1 0b10', '0o1 0o2'].map(masses =>
      ['non-decimal RASP masses', `E20 29 100 P ${masses} Home\n`, null]),
    ['a RASP header, kilograms', '; comment\n\nC6 18 70 3-5-7 0.0125 0.025 Estes\n0.1 5\n',
      { totalWeightG: 25, propWeightG: 12.5 }],
    ['RockSim attributes, grams', '<engine code="K480W" initWt="2059" propWt="1232" mfg="AeroTech">',
      { totalWeightG: 2059, propWeightG: 1232 }],
    ['attributes outside an engine are not motor masses',
      'X initWt="100" propWt="40"\nC6 18 70 3 0.0125 0.025 Estes\n', null],
    ['propellant heavier than the motor', 'C6 18 70 3 0.0300 0.0231 Estes\n', null],
    ['a short header line', 'C6 18 70 3 0.0108\n', null],
    ['a negative mass', 'C6 18 70 3 -0.01 0.0231 Estes\n', null],
  ];
  for (const [what, text, want] of cases) {
    it(what, () => {
      const file = { data: b64(text) };
      expect(headerMasses(file)).toEqual(want);
      expect(appHeaderMasses(file)).toEqual(want);
    });
  }
  it('has nothing to read without the raw file', () => {
    expect(headerMasses({})).toBeNull();
  });
});

describe('compactFile', () => {
  it.each([
    [{ time: 0, thrust: 0 }, { time: 1, thrust: 10 }, { time: 2, thrust: -0.004 }],
    [{ time: -0.00001, thrust: 0 }, { time: 1, thrust: 10 }, { time: 2, thrust: 0 }],
  ])('keeps curves the runtime accepts after bundle rounding: %j', (...samples) => {
    const rounded = samples.map(p => ({ time: Number(p.time.toFixed(4)), thrust: Number(p.thrust.toFixed(2)) }));
    expect(isSampleList(rounded)).toBe(true);
    expect(compactFile({ samples })?.samples).toEqual(rounded.map(p => [p.time, p.thrust]));
  });
  it.each([
    [[{ time: 0, thrust: 1 }, { time: 0, thrust: 2 }], true],
    [[{ time: 1, thrust: 1 }, { time: 1, thrust: 1 }], true],
    [[{ time: Number.MAX_VALUE, thrust: 1 }, { time: Number.MAX_VALUE, thrust: 2 }], false],
  ])('checks repairable and overflowing coincident times independently: %j', (samples, usable) => {
    const rounded = samples.map(p => ({ time: Number(p.time.toFixed(4)), thrust: Number(p.thrust.toFixed(2)) }));
    expect(compactFile({ samples }) !== null).toBe(isSampleList(rounded));
    expect(compactFile({ samples }) !== null).toBe(usable);
    expect(isSampleList(rounded)).toBe(usable);
  });
  it.each([
    [[{ time: -1, thrust: 10 }, { time: 1, thrust: 0 }]],
    [[{ time: 0, thrust: 10 }, { time: 1, thrust: -0.1 }]],
    [[{ time: 0, thrust: 10 }, { time: 0, thrust: 10 }]],
    [[{ time: 0.00001, thrust: 10 }, { time: 0.00002, thrust: 10 }]],
    [[{ time: 0, thrust: 10_000_001 }, { time: 1, thrust: 0 }]],
  ])('rejects samples the runtime cannot fly after rounding: %j', samples => {
    expect(compactFile({ samples })).toBeNull();
  });
  it('keeps [t, F] pairs at 4 and 2 decimals, and the header masses', () => {
    const c = compactFile({
      simfileId: 's1', source: 'cert', format: 'RASP',
      samples: [{ time: 0.012345, thrust: 10.126 }, { time: 1.5, thrust: 0 }],
      data: b64('C6 18 70 3 0.0125 0.025 Estes\n'),
    });
    expect(c).toEqual({
      simfileId: 's1', source: 'cert', format: 'RASP',
      samples: [[0.0123, 10.13], [1.5, 0]], masses: { totalWeightG: 25, propWeightG: 12.5 },
    });
  });
  it('drops a file with fewer than two samples or a non-finite one', () => {
    expect(compactFile({ samples: [{ time: 0, thrust: 1 }] })).toBeNull();
    expect(compactFile({ samples: [{ time: 0, thrust: 1 }, { time: NaN, thrust: 2 }] })).toBeNull();
  });
});

describe("desktop OpenRocket's digest, stored per file", () => {
  // thrustcurve.org's Estes C11 RASP file, and the digest desktop wrote for it
  // into a real design (motor-digest.test.mjs pins it).
  const C11 = readFileSync(fileURLToPath(new URL('./fixtures/motor-digest/5f4294d20002e900000004e8.eng', import.meta.url)));
  const raw = { simfileId: 'c11', source: 'user', format: 'RASP', data: C11.toString('base64'),
    samples: [{ time: 0.1, thrust: 5 }, { time: 0.8, thrust: 0 }] };

  it('compactFile stores it, read from the raw text', () => {
    expect(rawDigests(raw)).toEqual(['4f0059c416964ba2528c83551e6a6839']);
    expect(compactFile(raw).digests).toEqual(['4f0059c416964ba2528c83551e6a6839']);
    expect(compactFile({ ...raw, data: undefined }).digests).toBeUndefined();
  });

  it('addDigests adds it only where the file downloaded now is the file the bundle holds', () => {
    const { digests: _d, ...held } = compactFile(raw);
    const bundle = { curves: {
      a: [{ ...held }],
      b: [{ ...held, simfileId: 'revised' }],
      c: [{ ...held, simfileId: 'gone', digests: ['stale'] }],
    } };
    const revised = { ...raw, simfileId: 'revised', samples: [{ time: 0.1, thrust: 6 }, { time: 0.8, thrust: 0 }] };
    expect(addDigests(bundle, [raw, revised])).toEqual({ added: 1, changed: 1, missing: 1 });
    expect(bundle.curves.a[0].digests).toEqual(['4f0059c416964ba2528c83551e6a6839']);
    expect(bundle.curves.b[0].digests).toBeUndefined();
    expect(bundle.curves.c[0].digests).toBeUndefined();
    // Nothing else about a file moves.
    const { digests: _a, ...after } = bundle.curves.a[0];
    expect(after).toEqual(held);
  });
});

/** A catalogue of `n` motors, and a download.json that answers for them. */
function world(n, { failBatch = -1 } = {}) {
  const motors = Array.from({ length: n }, (_, i) => ({
    motorId: `m${i}`, manufacturerAbbrev: 'Test', designation: `F${i}`, availability: 'regular',
  }));
  let batch = -1;
  const fetchImpl = async (_url, opts) => {
    batch++;
    if (batch === failBatch) return { ok: false, status: 503, json: async () => ({}) };
    const { motorIds } = JSON.parse(opts.body);
    return {
      ok: true, status: 200,
      json: async () => ({
        results: motorIds.map((motorId) => ({
          motorId, simfileId: `f-${motorId}`, source: 'cert', format: 'RASP',
          samples: [{ time: 0, thrust: 0 }, { time: 1, thrust: 10 }],
        })),
      }),
    };
  };
  return { motors, fetchImpl };
}

describe('main', () => {
  const quiet = () => {};
  const noSleep = async () => {};

  it.each([null, { results: {} }, { results: [null] }, { results: [{ motorId: 42 }] }])('records malformed download responses as paced batch failures: %j', body => {
    const delays = [];
    return fetchCurves([{ motorId: 'm', designation: 'M', manufacturerAbbrev: 'Home' }], {
      fetchImpl: async () => ({ ok: true, json: async () => body }),
      sleep: async ms => { delays.push(ms); }, log: quiet,
    }).then(got => {
      expect(got.failed).toHaveLength(1);
      expect(got.failed[0]).toMatch(/download.*shape/);
      expect(delays).toEqual([250]);
    });
  });

  it.each(['constructor', 'toString', '__proto__'])('accepts an own motor id %s', async motorId => {
    const got = await fetchCurves([{ motorId }], {
      fetchImpl: async () => ({ ok: true, json: async () => ({ results: [{ motorId,
        samples: [{ time: 0, thrust: 0 }, { time: 1, thrust: 1 }] }] }) }),
      sleep: noSleep, log: quiet,
    });
    expect(Object.keys(got.curves)).toEqual([motorId]);
    expect(got.files).toBe(1);
  });

  it('paces failed batches as well as successful batches', async () => {
    const events = [];
    const { motors, fetchImpl } = world(101, { failBatch: 0 });
    await fetchCurves(motors, {
      fetchImpl: (...args) => { events.push('request'); return fetchImpl(...args); },
      sleep: async (ms) => { events.push(ms); }, log: quiet,
    });
    expect(events).toEqual(['request', 250, 'request', 250, 'request', 250]);
  });

  it('stops on HTTP 429 and records all remaining motors as failed', async () => {
    let requests = 0;
    const { motors } = world(101);
    const got = await fetchCurves(motors, {
      fetchImpl: async () => { requests++; return { ok: false, status: 429 }; },
      sleep: noSleep, log: quiet,
    });
    expect(requests).toBe(1);
    expect(got.failed).toHaveLength(motors.length);
  });

  function run(n, opts) {
    const dir = mkdtempSync(join(tmpdir(), 'motor-curves-'));
    const dbPath = join(dir, 'motors.json');
    const outPath = join(dir, 'motorCurves.json');
    const { motors, fetchImpl } = world(n, opts);
    writeFileSync(dbPath, JSON.stringify({ generated: '2026-09-21', motors }));
    return {
      dir, outPath,
      go: (extra = {}) => main({ dbPath, outPath, fetchImpl, sleep: noSleep, log: quiet, allowPartial: false, ...extra }),
    };
  }

  it('writes every motor\'s curves when every batch arrives', async () => {
    const w = run(BATCH * 2 + 3);
    try {
      expect(await w.go()).toBe(0);
      const doc = JSON.parse(readFileSync(w.outPath, 'utf8'));
      expect(doc.motors).toBe(BATCH * 2 + 3);
      expect(doc.files).toBe(BATCH * 2 + 3);
      expect(doc.catalogueGenerated).toBe('2026-09-21');
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it('writes NOTHING and exits 1 when a batch fails', async () => {
    const w = run(BATCH * 2 + 3, { failBatch: 1 });
    try {
      expect(await w.go()).toBe(1);
      expect(existsSync(w.outPath)).toBe(false);
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it('writes the short bundle when --allow-partial asks for it', async () => {
    const w = run(BATCH * 2 + 3, { failBatch: 1 });
    try {
      expect(await w.go({ allowPartial: true })).toBe(0);
      expect(JSON.parse(readFileSync(w.outPath, 'utf8')).motors).toBe(BATCH + 3);
      expect(JSON.parse(readFileSync(w.outPath, 'utf8')).complete).toBeUndefined();
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });
});

describe('curvesDocument', () => {
  it('counts the motors it holds and records the catalogue it was keyed to', () => {
    const doc = curvesDocument({ curves: { a: [{}], b: [{}, {}] }, files: 3 }, '2026-09-21', '2026-09-22');
    expect(doc).toMatchObject({ generated: '2026-09-22', catalogueGenerated: '2026-09-21', complete: true, motors: 2, files: 3 });
  });
});
