// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLatestVersion } from './versionCheck.js';
import { versionEarlierThan } from './session.js';

/**
 * The version check has to be right in the two directions that cost something:
 * it must never tell an up-to-date user to reload, and it must never treat a
 * page of HTML as a version.
 *
 * That second one is not defensive coding. The deploy ships no 404.html and no
 * `_headers`, so Cloudflare Pages can answer a missing `/version.json` with
 * `index.html` at HTTP 200 — and `npm run dev` always does, because the file
 * is not in `public/`. A `res.ok` check alone would sail straight past both.
 */

const jsonRes = (body: unknown, ok = true) => ({
  ok,
  json: () => Promise.resolve(body),
}) as Response;

afterEach(() => { vi.restoreAllMocks(); });

describe('fetchLatestVersion', () => {
  it('reads a well-formed version.json', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonRes({ version: '0.074', released: '2026-08-27', note: 'hello' }));
    await expect(fetchLatestVersion()).resolves.toEqual({
      version: '0.074', released: '2026-08-27', note: 'hello',
    });
  });

  it('busts every cache in the path', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ version: '0.074' }));
    await fetchLatestVersion();
    const [url, init] = f.mock.calls[0]!;
    // The service worker does not precache it, but the HTTP cache, the CDN and
    // any corporate proxy still would.
    expect(String(url)).toMatch(/^\.\/version\.json\?t=\d+$/);
    expect((init as RequestInit).cache).toBe('no-store');
  });

  it('refuses an SPA-fallback HTML page answered at HTTP 200', async () => {
    // What Vite's dev server and a 404-less Pages deploy actually return.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    } as unknown as Response);
    await expect(fetchLatestVersion()).resolves.toBeNull();
  });

  it('refuses valid JSON that is not a version', async () => {
    for (const body of [null, 'nope', {}, { version: 42 }, { version: 'latest' }, { version: '' }]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(body));
      await expect(fetchLatestVersion()).resolves.toBeNull();
    }
  });

  it('never rejects — offline, blocked and 404 all resolve to null', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(fetchLatestVersion()).resolves.toBeNull();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ version: '0.074' }, false));
    await expect(fetchLatestVersion()).resolves.toBeNull();
  });

  it('drops fields that are present but the wrong type, keeping the version', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonRes({ version: '0.074', released: 7, note: null }));
    await expect(fetchLatestVersion()).resolves.toEqual({ version: '0.074' });
  });
});

describe('the staleness decision', () => {
  it('a newer deployed version is stale', () => {
    expect(versionEarlierThan('0.073', '0.074')).toBe(true);
  });

  it('the same version is NOT stale', () => {
    expect(versionEarlierThan('0.073', '0.073')).toBe(false);
  });

  it('a build AHEAD of the CDN is current, not stale', () => {
    // A developer on a local build, or an edge that has not caught up. Telling
    // either of them to reload would be wrong, and reloading would not help.
    expect(versionEarlierThan('0.074', '0.073')).toBe(false);
  });

  it('compares numerically, so 0.100 is newer than 0.71', () => {
    // The reason this comparator exists rather than a string compare: today's
    // zero padding is what makes lexical order accidentally right.
    expect(versionEarlierThan('0.71', '0.100')).toBe(true);
    expect(versionEarlierThan('0.100', '0.71')).toBe(false);
    expect(versionEarlierThan('0.999', '1.0.0')).toBe(true);
  });
});
