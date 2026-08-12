// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MMR_NAV_FALLBACK,
  fetchNav,
  parseNav,
  readCachedNav,
  writeCachedNav,
  type MmrNav,
} from './useMmrNav.js';

/**
 * The live contract as served on 12 Aug 2026 (menuVersion 480f0531d406),
 * transcribed byte-for-byte. It is the fixture for "a real payload is
 * accepted" — if the site ever ships a shape this validator rejects, the
 * tools silently fall back forever, so the accepting case matters as much as
 * the rejecting ones.
 */
const LIVE: MmrNav = {
  schema: 'mmr.nav.v1',
  menuVersion: '480f0531d406',
  cutover: true,
  site: {
    name: 'Mountain Man Rockets',
    shortName: 'MMR',
    home: 'https://www.mountainmanrockets.com/',
  },
  nav: [
    { label: 'Builds', url: 'https://www.mountainmanrockets.com/builds/' },
    { label: 'Rocketry U', url: 'https://www.mountainmanrockets.com/learn/' },
  ],
  search: { url: 'https://www.mountainmanrockets.com/search/', param: 'q' },
  feedback: {
    tracker: 'https://github.com/mtnmanak/mountainmanrockets-feedback',
    bug: 'https://github.com/mtnmanak/mountainmanrockets-feedback/issues/new?template=bug-report.yml',
    feature: 'https://github.com/mtnmanak/mountainmanrockets-feedback/issues/new?template=feature-request.yml',
    email: 'admin@mountainmanrockets.com',
  },
  footer: {
    line: 'Mountain Man Rockets — Building and launching rockets for over 50 years',
    links: [{ label: 'YouTube', url: 'https://www.youtube.com/@mountainmanrockets5644' }],
  },
};

/** Structured-clone a fixture so a mutation in one test can't leak into another. */
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

afterEach(() => {
  // Unstub FIRST — one test replaces localStorage itself with a thrower.
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('parseNav — the contract validator', () => {
  it('accepts the live payload unchanged', () => {
    const parsed = parseNav(clone(LIVE));
    expect(parsed).not.toBeNull();
    expect(parsed!.menuVersion).toBe('480f0531d406');
    expect(parsed!.nav).toHaveLength(2);
    expect(parsed!.search!.param).toBe('q');
  });

  it('passes additive fields through untouched (spec: render what you know)', () => {
    const withExtra = { ...clone(LIVE), someFutureField: { a: 1 } };
    const parsed = parseNav(withExtra) as (MmrNav & { someFutureField?: unknown }) | null;
    expect(parsed).not.toBeNull();
    expect(parsed!.someFutureField).toEqual({ a: 1 });
    expect(parsed!.cutover).toBe(true);
  });

  it.each([
    ['null', null],
    ['a non-object', 'mmr.nav.v1'],
    ['a v2 schema served by mistake', { ...clone(LIVE), schema: 'mmr.nav.v2' }],
    ['a missing menuVersion', { ...clone(LIVE), menuVersion: '' }],
    ['a missing site home', { ...clone(LIVE), site: { name: 'MMR' } }],
    ['an empty nav array', { ...clone(LIVE), nav: [] }],
    ['a nav array that is not an array', { ...clone(LIVE), nav: 'Builds' }],
    ['a nav entry with no label', { ...clone(LIVE), nav: [{ url: 'https://x.test/' }] }],
    ['a relative nav url', { ...clone(LIVE), nav: [{ label: 'X', url: '/builds/' }] }],
    ['a javascript: nav url', { ...clone(LIVE), nav: [{ label: 'X', url: 'javascript:alert(1)' }] }],
  ])('rejects %s and leaves the caller its fallback', (_label, payload) => {
    expect(parseNav(payload)).toBeNull();
  });
});

/**
 * The reject/degrade line, which is the whole point of this validator.
 *
 * These cases USED to be in the rejection list above, and that was the bug:
 * `footer.links: []` is an entirely legal payload (spec §1 lets a tool ignore
 * the footer block completely), and rejecting the whole contract for it would
 * have pinned this tool to the baked fallback permanently and silently on
 * every single load. The band would then stamp `data-mmr-source="fallback"`,
 * which spec §7 routes to a SITE session to check CORS / `_headers` /
 * `/chrome/demo` — a debugging dead end, because the fault would be ours.
 *
 * So: the optional blocks degrade, and `nav[]` still goes live.
 */
type OptionalBlock = 'search' | 'feedback' | 'footer';

const DEGRADE_CASES: [label: string, payload: unknown, dropped: OptionalBlock][] = [
  ['a footer whose links are malformed',
    { ...clone(LIVE), footer: { line: 'x', links: [{ label: 'X', url: '/relative/' }] } }, 'footer'],
  ['a footer that is not an object at all',
    { ...clone(LIVE), footer: 'Mountain Man Rockets' }, 'footer'],
  ['a search block with no param',
    { ...clone(LIVE), search: { url: 'https://x.test/' } }, 'search'],
  ['a search block with a javascript: url',
    { ...clone(LIVE), search: { url: 'javascript:alert(1)', param: 'q' } }, 'search'],
  ['a feedback block with a bad tracker url',
    { ...clone(LIVE), feedback: { ...clone(LIVE).feedback!, tracker: 'javascript:alert(1)' } }, 'feedback'],
  ['a feedback block with a nonsense email',
    { ...clone(LIVE), feedback: { ...clone(LIVE).feedback!, email: 'not an address' } }, 'feedback'],
];

describe('parseNav — optional blocks DEGRADE, they do not reject', () => {
  it.each(DEGRADE_CASES)('drops %s and takes the rest of the contract live', (_label, payload, dropped) => {
    const parsed = parseNav(payload);
    expect(parsed).not.toBeNull();
    // The menu — the only thing the band cannot render without — survives.
    expect(parsed!.nav.map((n) => n.label)).toEqual(['Builds', 'Rocketry U']);
    expect(parsed!.menuVersion).toBe('480f0531d406');
    // The one bad block is gone, not passed through half-valid.
    expect(parsed![dropped]).toBeUndefined();
    expect(dropped in parsed!).toBe(false);
    // Every OTHER optional block is untouched.
    for (const key of ['search', 'feedback', 'footer'] as const) {
      if (key !== dropped) expect(parsed![key]).toBeDefined();
    }
  });

  it('ACCEPTS an empty footer.links — it is legal, not malformed', () => {
    // The original defect in one line. `footer.links: []` is a shape the site
    // may legitimately publish (spec §1 even lets a tool ignore `footer`
    // outright), and the old validator folded "non-empty" into its link-list
    // test, so this payload rejected the entire contract. Non-empty is a
    // `nav[]` rule and only a `nav[]` rule.
    const parsed = parseNav({ ...clone(LIVE), footer: { line: 'x', links: [] } });
    expect(parsed).not.toBeNull();
    expect(parsed!.nav).toHaveLength(2);
    expect(parsed!.footer).toEqual({ line: 'x', links: [] });
  });

  it('does not mutate the caller\'s object when it drops a block', () => {
    const bad = { line: 'x', links: [{ label: 'X', url: '/relative/' }] };
    const payload = { ...clone(LIVE), footer: bad };
    parseNav(payload);
    // The fetch body / cache entry is somebody else's object — a shallow copy
    // is what lets a drop be local to the value we return.
    expect(payload.footer).toEqual(bad);
  });

  it('takes an empty-footer payload all the way LIVE through fetchNav', async () => {
    // The end-to-end version of the defect: before the fix this response made
    // `fetchNav` resolve null, so `useMmrNav` never left "fallback" — silently,
    // on every load, forever.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ...clone(LIVE), footer: { line: 'x', links: [] } }),
    })));
    const fresh = await fetchNav();
    expect(fresh).not.toBeNull();
    expect(fresh!.nav).toHaveLength(2);
    expect(fresh!.menuVersion).toBe('480f0531d406');
  });
});

/**
 * DEFECT 3's fix, canonicalised at the boundary: App.tsx builds the
 * browse-issues link as `${tracker}/issues?q=…`, so a trailing slash in the
 * site's config would produce `…feedback//issues`, which GitHub 404s.
 */
describe('parseNav — the tracker URL is canonicalised', () => {
  it('strips a trailing slash so `${tracker}/issues` cannot double up', () => {
    const parsed = parseNav({
      ...clone(LIVE),
      feedback: { ...clone(LIVE).feedback!, tracker: 'https://github.com/mtnmanak/mountainmanrockets-feedback/' },
    });
    expect(parsed!.feedback!.tracker)
      .toBe('https://github.com/mtnmanak/mountainmanrockets-feedback');
    expect(`${parsed!.feedback!.tracker}/issues`).not.toContain('//issues');
  });

  it('strips repeated trailing slashes and leaves a clean url alone', () => {
    const many = parseNav({
      ...clone(LIVE),
      feedback: { ...clone(LIVE).feedback!, tracker: 'https://github.com/mtnmanak/x///' },
    });
    expect(many!.feedback!.tracker).toBe('https://github.com/mtnmanak/x');
    expect(parseNav(clone(LIVE))!.feedback!.tracker).toBe(LIVE.feedback!.tracker);
  });
});

describe('the baked fallback', () => {
  it('is itself a valid contract — it renders on every first paint', () => {
    expect(parseNav(MMR_NAV_FALLBACK)).not.toBeNull();
  });

  it('is the post-replatform menu, not the 2024 WordPress one', () => {
    // The whole point of re-baking it: /index.php/... paths 301 since the
    // 12 Aug 2026 replatform, and shipping redirects as the OFFLINE
    // experience is worse than shipping a menu that is one deploy stale.
    for (const item of MMR_NAV_FALLBACK.nav) {
      expect(item.url).toMatch(/^https:\/\//);
      expect(item.url).not.toContain('/index.php/');
    }
    expect(MMR_NAV_FALLBACK.menuVersion).toBe('480f0531d406');
    expect(MMR_NAV_FALLBACK.nav.map((n) => n.label)).toContain('Rocketry U');
    expect(MMR_NAV_FALLBACK.feedback!.bug).toContain('?template=bug-report.yml');
    // The tool dropdown cannot be prefilled — see docs/feedback-tracker.md.
    expect(MMR_NAV_FALLBACK.feedback!.bug).not.toContain('tool=');
  });
});

describe('the last-known-good cache', () => {
  it('round-trips a contract', () => {
    writeCachedNav(MMR_NAV_FALLBACK);
    expect(readCachedNav()).toEqual(MMR_NAV_FALLBACK);
  });

  it('rejects a half-written entry rather than rendering it', () => {
    localStorage.setItem('mmr-chrome:v1', '{"schema":"mmr.nav.v1","nav":[{"lab');
    expect(readCachedNav()).toBeNull();
  });

  it('rejects a well-formed JSON entry that is not a valid contract', () => {
    localStorage.setItem('mmr-chrome:v1', JSON.stringify({ schema: 'mmr.nav.v1', nav: [] }));
    expect(readCachedNav()).toBeNull();
  });

  it('survives storage being unavailable (private mode, blocked site data)', () => {
    const boom = () => { throw new Error('SecurityError'); };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom });
    expect(readCachedNav()).toBeNull();
    expect(() => writeCachedNav(MMR_NAV_FALLBACK)).not.toThrow();
  });
});

/**
 * The contract URL, guarded at the REQUEST rather than at the constant: a test
 * that imported `CONTRACT` and compared strings would pass while a typo'd
 * `fetch(somethingElse)` shipped, and the URL that actually goes on the wire is
 * the thing that matters here.
 *
 * v0.044 shipped `mountainmanrockets.pages.dev` — copied from spec §5 while the
 * spec's literal was still pre-cutover. It worked only because the Pages preview
 * alias still answered 200, and the failure mode when an alias is retired is
 * invisible: `fetchNav` swallows everything (MUST 1), so the band freezes on its
 * baked fallback with nothing logged. Hence a cheap standing guard.
 */
describe('the contract URL', () => {
  it('requests the canonical www host, not the pages.dev preview alias', async () => {
    const spy = vi.fn(async (_url: unknown, _init?: unknown) => ({
      ok: true,
      json: async () => clone(LIVE),
    }));
    vi.stubGlobal('fetch', spy);
    await fetchNav();
    expect(spy).toHaveBeenCalledTimes(1);
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toBe('https://www.mountainmanrockets.com/chrome/nav.v1.json');
    expect(url).not.toContain('pages.dev');
  });
});

describe('fetchNav — never rejects, whatever the network does', () => {
  it('returns the parsed contract on a good response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => clone(LIVE) })));
    const fresh = await fetchNav();
    expect(fresh!.menuVersion).toBe('480f0531d406');
  });

  it('resolves null when the request rejects (offline, CORS, DNS)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(fetchNav()).resolves.toBeNull();
  });

  it('resolves null on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    await expect(fetchNav()).resolves.toBeNull();
  });

  it('resolves null when the body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    })));
    await expect(fetchNav()).resolves.toBeNull();
  });

  it('resolves null when the schema is not the one we render', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ...clone(LIVE), schema: 'mmr.nav.v2' }),
    })));
    await expect(fetchNav()).resolves.toBeNull();
  });
});
