import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

// A script that went back to the bare global fetch fails here instead of connecting.
beforeAll(() => vi.stubGlobal('fetch', async () => { throw new Error('global fetch called'); }));
afterAll(() => vi.unstubAllGlobals());

const { fetchCatalogue } = await import('./fetch-motor-db.mjs');
const { downloadRawFiles, fetchCurves } = await import('./fetch-motor-curves.mjs');

describe('the refresh scripts default to the paced client', () => {
  it('fetch-motor-db fetchCatalogue', async () => {
    seen.length = 0;
    await expect(fetchCatalogue({ log: () => {} })).rejects.toThrow('paced client called');
    expect(seen).toEqual(['https://www.thrustcurve.org/api/v1/metadata.json?availability=all']);
  });

  it('fetch-motor-curves fetchCurves and downloadRawFiles', async () => {
    seen.length = 0;
    const got = await fetchCurves([{ motorId: 'm1', manufacturerAbbrev: 'X', designation: 'A1' }],
      { sleep: async () => {}, log: () => {} });
    expect(got.failed).toEqual(['X A1: paced client called']);
    await expect(downloadRawFiles(['m1'], { sleep: async () => {}, log: () => {} })).rejects.toThrow('paced client called');
    expect(seen).toEqual(['https://www.thrustcurve.org/api/v1/download.json', 'https://www.thrustcurve.org/api/v1/download.json']);
  });
});
