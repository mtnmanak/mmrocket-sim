import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { headerMasses as appHeaderMasses } from '../src/services/thrustcurve.ts';
import { BATCH, compactFile, curvesDocument, headerMasses, main } from './fetch-motor-curves.mjs';

/**
 * fetch-motor-curves.mjs against a stand-in for thrustcurve.org — never the
 * network. Until 2026-09-22 its work ran at import, so none of this could be
 * tested, and a failed batch was reported only after the short bundle had been
 * written (audit 2026-09-22, Tests rows 480 and 523).
 */

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

describe('headerMasses, the build-time mirror of thrustcurve.ts', () => {
  // The bundle stores the two numbers instead of the file, and the app then
  // trusts them; a bundled curve must yield exactly the masses a live download
  // of the same file would. So each case runs through BOTH copies.
  const cases = [
    ['a RASP header, kilograms', '; comment\n\nC6 18 70 3-5-7 0.0125 0.025 Estes\n0.1 5\n',
      { totalWeightG: 25, propWeightG: 12.5 }],
    ['RockSim attributes, grams', '<engine code="K480W" initWt="2059" propWt="1232" mfg="AeroTech">',
      { totalWeightG: 2059, propWeightG: 1232 }],
    ['RockSim tried first even in a RASP-looking file',
      'X initWt="100" propWt="40"\nC6 18 70 3 0.0125 0.025 Estes\n', { totalWeightG: 100, propWeightG: 40 }],
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
    } finally {
      rmSync(w.dir, { recursive: true, force: true });
    }
  });
});

describe('curvesDocument', () => {
  it('counts the motors it holds and records the catalogue it was keyed to', () => {
    const doc = curvesDocument({ curves: { a: [{}], b: [{}, {}] }, files: 3 }, '2026-09-21', '2026-09-22');
    expect(doc).toMatchObject({ generated: '2026-09-22', catalogueGenerated: '2026-09-21', motors: 2, files: 3 });
  });
});
