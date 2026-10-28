import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * The refresh scripts reach thrustcurve.org through thrustcurve-client.mjs's
 * paced client unless a caller hands them another fetch. The client is
 * replaced here by one that records the URL and refuses, so nothing waits and
 * nothing connects; check-upstream's routing is pinned in
 * upstream-followup.test.mjs.
 */
const seen = vi.hoisted(() => []);
vi.mock('./thrustcurve-client.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  thrustcurveFetch: async (url) => {
    seen.push(String(url));
    throw new Error('paced client called');
  },
}));

// A script that went back to the bare global fetch fails here instead of
// connecting. Stubbed before the scripts load, so nothing they do at load
// time can reach the network either.
vi.stubGlobal('fetch', async () => { throw new Error('global fetch called'); });
afterAll(() => vi.unstubAllGlobals());

const { fetchCatalogue, main: dbMain } = await import('./fetch-motor-db.mjs');
const { addDigestsMain, downloadRawFiles, fetchCurves } = await import('./fetch-motor-curves.mjs');

const META = 'https://www.thrustcurve.org/api/v1/metadata.json?availability=all';
const DOWNLOAD = 'https://www.thrustcurve.org/api/v1/download.json';
const quiet = () => {};

describe('the refresh scripts default to the paced client', () => {
  it('fetch-motor-db fetchCatalogue and main (the path CI runs)', async () => {
    seen.length = 0;
    await expect(fetchCatalogue({ log: quiet })).rejects.toThrow('paced client called');
    const dir = mkdtempSync(join(tmpdir(), 'tc-wiring-'));
    const error = vi.spyOn(console, 'error').mockImplementation(quiet);
    try {
      expect(await dbMain({ outPath: join(dir, 'motors.json'), log: quiet })).toBe(1);
      expect(error.mock.calls.flat().join('\n')).toMatch('paced client called');
    } finally {
      error.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(seen).toEqual([META, META]);
  });

  it('fetch-motor-curves fetchCurves, downloadRawFiles and addDigestsMain', async () => {
    seen.length = 0;
    const got = await fetchCurves([{ motorId: 'm1', manufacturerAbbrev: 'X', designation: 'A1' }],
      { sleep: async () => {}, log: quiet });
    expect(got.failed).toEqual(['X A1: paced client called']);
    await expect(downloadRawFiles(['m1'], { sleep: async () => {}, log: quiet })).rejects.toThrow('paced client called');
    const dir = mkdtempSync(join(tmpdir(), 'tc-wiring-'));
    const error = vi.spyOn(console, 'error').mockImplementation(quiet);
    try {
      const outPath = join(dir, 'motorCurves.json');
      writeFileSync(outPath, JSON.stringify({ curves: { m1: [{ simfileId: 's1', samples: [[0, 1], [1, 0]] }] } }));
      expect(await addDigestsMain({ outPath, sleep: async () => {}, log: quiet })).toBe(1);
    } finally {
      error.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(seen).toEqual([DOWNLOAD, DOWNLOAD, DOWNLOAD]);
  });
});
