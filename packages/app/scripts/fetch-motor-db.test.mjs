import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAP, FIELDS, catalogueDocument, fetchCatalogue, main } from './fetch-motor-db.mjs';

/**
 * fetch-motor-db.mjs against a stand-in for thrustcurve.org — never the network.
 *
 * Until 2026-09-22 this script did its work at module top level and exported
 * nothing, so none of it could be tested, and it never compared what came back
 * with the `matches` count every search.json answer carries: a short page would
 * have shipped as the whole catalogue (audit 2026-09-22, Tests row 524).
 */

const CLASSES = ['F', 'G', 'H'];

/** A synthetic catalogue: one small maker, and one over the request cap. */
function catalogue() {
  const motors = [];
  for (let i = 0; i < 3; i++) {
    motors.push({ motorId: `s${i}`, manufacturerAbbrev: 'Small', designation: `F${i}0`, impulseClass: 'F', extra: 'x' });
  }
  for (let i = 0; i < CAP + 20; i++) {
    const ic = CLASSES[i % 3];
    motors.push({ motorId: `b${i}`, manufacturerAbbrev: 'Big', designation: `${ic}${100 + i}`, impulseClass: ic });
  }
  return motors;
}

/**
 * thrustcurve.org's two endpoints, as far as this script uses them. `tamper`
 * rewrites one search answer, to model an API that misbehaves.
 */
function fakeApi({ motors = catalogue(), manufacturers = ['Small', 'Big'], classes = CLASSES,
  tamper = (_params, body) => body } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const u = new URL(url);
    let body;
    if (u.pathname.endsWith('/metadata.json')) {
      body = { manufacturers: manufacturers.map((abbrev) => ({ abbrev })), impulseClasses: classes };
    } else if (u.pathname.endsWith('/search.json')) {
      const p = Object.fromEntries(u.searchParams);
      const hits = motors.filter((m) => (!p.manufacturer || m.manufacturerAbbrev === p.manufacturer)
        && (!p.impulseClass || m.impulseClass === p.impulseClass));
      body = tamper(p, { matches: hits.length, results: hits.slice(0, Number(p.maxResults)) });
    } else {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls };
}

const quiet = () => {};

describe('fetchCatalogue', () => {
  it('pages a maker over the cap by impulse class and returns the whole catalogue', async () => {
    const { fetchImpl, calls } = fakeApi();
    const motors = await fetchCatalogue({ fetchImpl, log: quiet });
    expect(motors).toHaveLength(3 + CAP + 20);
    // Projected to exactly the bundled fields, sorted by maker then designation.
    expect(Object.keys(motors[0])).toEqual(FIELDS);
    expect(motors[0].manufacturerAbbrev).toBe('Big');
    expect(motors.at(-1).manufacturerAbbrev).toBe('Small');
    // Every request names itself to the volunteer-run service.
    expect(calls.every((c) => c.opts.headers['user-agent'] === 'mmrocket-sim-upstream-check')).toBe(true);
  });

  it('refuses a short page on a maker under the cap', async () => {
    const { fetchImpl } = fakeApi({
      tamper: (p, b) => (p.manufacturer === 'Small' ? { ...b, results: b.results.slice(0, 2) } : b),
    });
    await expect(fetchCatalogue({ fetchImpl, log: quiet })).rejects.toThrow(/returned 2 of its 3 matches/);
  });

  it('refuses a short page inside a subdivided maker', async () => {
    const { fetchImpl } = fakeApi({
      tamper: (p, b) => (p.impulseClass === 'G' ? { ...b, results: b.results.slice(1) } : b),
    });
    await expect(fetchCatalogue({ fetchImpl, log: quiet })).rejects.toThrow(/impulseClass=G.*a short page/);
  });

  it('refuses a maker whose classes do not add up to its own count', async () => {
    // metadata.json names two of the three classes the maker's motors are in.
    const { fetchImpl } = fakeApi({ classes: ['F', 'G'] });
    await expect(fetchCatalogue({ fetchImpl, log: quiet }))
      .rejects.toThrow(/Big: its impulse classes add up to \d+ motors, thrustcurve\.org lists 520/);
  });

  it('refuses a catalogue short of the API\'s own population', async () => {
    // A maker metadata.json does not name: its motors are in the population
    // and in no per-maker query.
    const motors = [...catalogue(), { motorId: 'x1', manufacturerAbbrev: 'Unlisted', designation: 'K1', impulseClass: 'K' }];
    const { fetchImpl } = fakeApi({ motors });
    await expect(fetchCatalogue({ fetchImpl, log: quiet }))
      .rejects.toThrow(/add up to 523 motors, thrustcurve\.org lists 524/);
  });

  it('refuses an answer with no usable `matches`, since completeness cannot then be shown', async () => {
    const { fetchImpl } = fakeApi({ tamper: (_p, b) => ({ results: b.results }) });
    await expect(fetchCatalogue({ fetchImpl, log: quiet })).rejects.toThrow(/no usable `matches`/);
  });
});

describe('main', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'motor-db-'));

  it('writes motors.json only when the catalogue is complete', async () => {
    const dir = tmp();
    try {
      const outPath = join(dir, 'motors.json');
      expect(await main({ outPath, fetchImpl: fakeApi().fetchImpl, log: quiet })).toBe(0);
      const doc = JSON.parse(readFileSync(outPath, 'utf8'));
      expect(doc.count).toBe(3 + CAP + 20);
      expect(doc.motors).toHaveLength(doc.count);
      expect(doc.generated).toMatch(/^\d{4}-\d\d-\d\d$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves motors.json alone and exits non-zero on a short page', async () => {
    const dir = tmp();
    try {
      const outPath = join(dir, 'motors.json');
      const { fetchImpl } = fakeApi({
        tamper: (p, b) => (p.manufacturer === 'Small' ? { ...b, results: [] } : b),
      });
      expect(await main({ outPath, fetchImpl, log: quiet })).toBe(1);
      expect(existsSync(outPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('catalogueDocument', () => {
  it('is the shape the app and the refresh diff read', () => {
    expect(catalogueDocument([{ motorId: 'a' }], '2026-09-22')).toEqual({
      generated: '2026-09-22', source: 'thrustcurve.org API v1', count: 1, motors: [{ motorId: 'a' }],
    });
  });
});
