// @vitest-environment happy-dom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteBand, SiteBandFooter } from './SiteBand.js';
import { MMR_NAV_FALLBACK, useMmrNav, type MmrNav } from '../services/useMmrNav.js';

/**
 * There is no @testing-library in this workspace and adding a dependency was
 * out of scope, so these render through react-dom's own root API with React's
 * `act`. That is enough for what has to be proven here — the band's stamps and
 * the hook's fallback → cache → live progression are all observable in the
 * DOM, which is exactly where the spec's debugging protocol reads them
 * (chrome-spec §7).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LIVE_NAV: MmrNav = {
  schema: 'mmr.nav.v1',
  menuVersion: 'aaaaaaaaaaaa',
  site: { name: 'Mountain Man Rockets', shortName: 'MMR', home: 'https://www.mountainmanrockets.com/' },
  nav: [{ label: 'Builds', url: 'https://www.mountainmanrockets.com/builds/' }],
  search: { url: 'https://www.mountainmanrockets.com/search/', param: 'q' },
  footer: {
    line: 'Mountain Man Rockets — 50 years',
    links: [{ label: 'YouTube', url: 'https://www.youtube.com/@mountainmanrockets5644' }],
  },
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

/** A fetch that never settles — proves what the FIRST paint contains. */
const stubPendingFetch = () => vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})));

const band = () => host.querySelector('.mmr-band');

function Harness() {
  const { nav, source } = useMmrNav(MMR_NAV_FALLBACK);
  return (
    <>
      <SiteBand nav={nav} source={source} />
      <SiteBandFooter nav={nav} />
    </>
  );
}

describe('SiteBand — the rendered band', () => {
  it('stamps the menu version and the source on the band element (MUST 3)', () => {
    act(() => root.render(<SiteBand nav={LIVE_NAV} source="live" />));
    expect(band()!.getAttribute('data-mmr-menu-version')).toBe('aaaaaaaaaaaa');
    expect(band()!.getAttribute('data-mmr-source')).toBe('live');
  });

  it('sends every link to _top and renders the whole menu unfiltered', () => {
    act(() => root.render(<SiteBand nav={MMR_NAV_FALLBACK} source="fallback" />));
    const links = [...host.querySelectorAll('.mmr-band a')] as HTMLAnchorElement[];
    // Brand + the eight menu items + the compact search link.
    expect(links).toHaveLength(MMR_NAV_FALLBACK.nav.length + 2);
    expect(links.every((a) => a.getAttribute('target') === '_top')).toBe(true);
    expect([...host.querySelectorAll('.mmr-band-nav a')].map((a) => a.textContent))
      .toEqual(MMR_NAV_FALLBACK.nav.map((n) => n.label));
  });

  it('renders a duplicate menu url twice — §1 forbids filtering, keys are by index', () => {
    const nav: MmrNav = {
      ...LIVE_NAV,
      nav: [
        { label: 'Builds', url: 'https://www.mountainmanrockets.com/builds/' },
        { label: 'Latest build', url: 'https://www.mountainmanrockets.com/builds/' },
      ],
    };
    act(() => root.render(<SiteBand nav={nav} source="live" />));
    expect([...host.querySelectorAll('.mmr-band-nav a')].map((a) => a.textContent))
      .toEqual(['Builds', 'Latest build']);
  });

  it('renders search as a plain GET form with no keyboard handling of its own (MUST 4)', () => {
    act(() => root.render(<SiteBand nav={LIVE_NAV} source="live" />));
    const form = host.querySelector('.mmr-band-search') as HTMLFormElement;
    expect(form.getAttribute('action')).toBe('https://www.mountainmanrockets.com/search/');
    expect(form.getAttribute('method')).toBe('get');
    expect(form.getAttribute('target')).toBe('_top');
    expect(host.querySelector('.mmr-band-search input')!.getAttribute('name')).toBe('q');
    // The compact magnifier link is present at every width; CSS picks one.
    expect(host.querySelector('.mmr-band-search-link')!.getAttribute('href'))
      .toBe('https://www.mountainmanrockets.com/search/');
  });

  it('renders the opted-in footer strip, and nothing at all without footer data', () => {
    act(() => root.render(<SiteBandFooter nav={LIVE_NAV} />));
    expect(host.querySelector('.mmr-band-footer-line')!.textContent)
      .toBe('Mountain Man Rockets — 50 years');
    expect(host.querySelector('.mmr-band-footer-links a')!.getAttribute('target')).toBe('_top');

    const { footer: _dropped, ...noFooter } = LIVE_NAV;
    act(() => root.render(<SiteBandFooter nav={noFooter as MmrNav} />));
    expect(host.querySelector('.mmr-band-footer')).toBeNull();
  });

  it('sends footer GitHub links to a new tab and site links to _top', () => {
    // chrome-spec MUST 6 says `_top`; docs/feedback-tracker.md records the owner's
    // standing ruling that GitHub links open in a new tab, "so the user is not
    // completely taken away from the site". The live contract's footer really
    // does carry the tracker's /issues link, so a `_top` there would navigate
    // the whole tab off a half-finished design. Local ruling wins for
    // github.com only — and `_blank` escapes an embedding frame just as `_top`
    // does, which is all MUST 6 was ever for.
    const nav: MmrNav = {
      ...LIVE_NAV,
      footer: {
        line: 'x',
        links: [
          { label: 'Bugs & requests', url: 'https://github.com/mtnmanak/mountainmanrockets-feedback/issues' },
          { label: 'Contact', url: 'https://www.mountainmanrockets.com/contact/' },
          { label: 'Docs', url: 'https://docs.github.com/en' },
        ],
      },
    };
    act(() => root.render(<SiteBandFooter nav={nav} />));
    const [gh, site, sub] = [...host.querySelectorAll('.mmr-band-footer-links a')] as HTMLAnchorElement[];
    expect(gh!.getAttribute('target')).toBe('_blank');
    expect(gh!.getAttribute('rel')).toBe('noopener');
    expect(site!.getAttribute('target')).toBe('_top');
    expect(site!.getAttribute('rel')).toBeNull();
    // A subdomain of github.com is still GitHub.
    expect(sub!.getAttribute('target')).toBe('_blank');
  });

  it('renders a duplicate footer entry rather than collapsing it on a shared key', () => {
    // Nothing in the contract promises distinct URLs and spec §1 forbids
    // filtering, so a duplicate must appear twice. Keying by url deduplicated
    // it in React's eyes and warned; index keys do not.
    const dup = { label: 'YouTube', url: 'https://www.youtube.com/@mountainmanrockets5644' };
    const nav: MmrNav = { ...LIVE_NAV, footer: { line: 'x', links: [dup, { ...dup, label: 'Videos' }, dup] } };
    act(() => root.render(<SiteBandFooter nav={nav} />));
    expect([...host.querySelectorAll('.mmr-band-footer-links a')].map((a) => a.textContent))
      .toEqual(['YouTube', 'Videos', 'YouTube']);
  });

  it('does not throw on a footer url that URL() cannot parse (MUST 1)', () => {
    // The target decision runs `new URL(...)` per link; a throw there would
    // take the whole band down. Unparseable falls back to the spec default.
    const nav = {
      ...LIVE_NAV,
      footer: { line: 'x', links: [{ label: 'Broken', url: 'not a url at all' }] },
    } as MmrNav;
    act(() => root.render(<SiteBandFooter nav={nav} />));
    const a = host.querySelector('.mmr-band-footer-links a') as HTMLAnchorElement;
    expect(a).not.toBeNull();
    expect(a.getAttribute('target')).toBe('_top');
  });

  it('fails open: a band render error takes the band down, never the app (MUST 1)', () => {
    // `.map` on a non-array throws during render. Without the boundary React
    // unmounts the whole tree — which in the real app is the rocket designer.
    // React's dev build re-dispatches the render error as a global `error`
    // event so DevTools can break on it; swallow that so the runner does not
    // read a deliberately-thrown, deliberately-caught error as a failure.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const swallow = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
    window.addEventListener('error', swallow, true);
    try {
      const broken = { ...LIVE_NAV, nav: 'Builds' } as unknown as MmrNav;
      act(() => root.render(
        <>
          <SiteBand nav={broken} source="live" />
          <div className="the-tool">still here</div>
        </>,
      ));
      expect(band()).toBeNull();
      expect(host.querySelector('.the-tool')!.textContent).toBe('still here');
    } finally {
      window.removeEventListener('error', swallow, true);
      quiet.mockRestore();
    }
  });
});

describe('useMmrNav — fallback, then cache, then live', () => {
  it('paints the baked fallback synchronously when there is no cache (MUST 2)', () => {
    stubPendingFetch();
    act(() => root.render(<Harness />));
    // No await anywhere above: this is the first paint.
    expect(band()!.getAttribute('data-mmr-source')).toBe('fallback');
    expect(band()!.getAttribute('data-mmr-menu-version')).toBe(MMR_NAV_FALLBACK.menuVersion);
    expect(host.querySelectorAll('.mmr-band-nav a')).toHaveLength(MMR_NAV_FALLBACK.nav.length);
  });

  it('paints a cached contract synchronously on first render (MUST 7)', () => {
    stubPendingFetch();
    const cached: MmrNav = { ...LIVE_NAV, menuVersion: 'cccccccccccc' };
    localStorage.setItem('mmr-chrome:v1', JSON.stringify(cached));
    act(() => root.render(<Harness />));
    expect(band()!.getAttribute('data-mmr-source')).toBe('cache');
    expect(band()!.getAttribute('data-mmr-menu-version')).toBe('cccccccccccc');
  });

  it('ignores a corrupt cache and paints the fallback instead', () => {
    stubPendingFetch();
    localStorage.setItem('mmr-chrome:v1', '{"schema":"mmr.nav.v1","nav":');
    act(() => root.render(<Harness />));
    expect(band()!.getAttribute('data-mmr-source')).toBe('fallback');
  });

  it('lets a live contract supersede the fallback and writes it to the cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => LIVE_NAV })));
    await act(async () => { root.render(<Harness />); });
    expect(band()!.getAttribute('data-mmr-source')).toBe('live');
    expect(band()!.getAttribute('data-mmr-menu-version')).toBe('aaaaaaaaaaaa');
    expect([...host.querySelectorAll('.mmr-band-nav a')].map((a) => a.textContent)).toEqual(['Builds']);
    expect(JSON.parse(localStorage.getItem('mmr-chrome:v1')!)).toEqual(LIVE_NAV);
    // Footer data comes off the same fetch — one request feeds band + footer.
    expect(host.querySelector('.mmr-band-footer-line')!.textContent).toBe('Mountain Man Rockets — 50 years');
  });

  it('swallows a fetch rejection: the fallback stands and the cache is untouched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await act(async () => { root.render(<Harness />); });
    expect(band()!.getAttribute('data-mmr-source')).toBe('fallback');
    expect(band()!.getAttribute('data-mmr-menu-version')).toBe(MMR_NAV_FALLBACK.menuVersion);
    expect(localStorage.getItem('mmr-chrome:v1')).toBeNull();
  });

  it('refuses a live payload with the wrong schema and keeps the cached menu', async () => {
    const cached: MmrNav = { ...LIVE_NAV, menuVersion: 'cccccccccccc' };
    localStorage.setItem('mmr-chrome:v1', JSON.stringify(cached));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ ...LIVE_NAV, schema: 'mmr.nav.v2', menuVersion: 'dddddddddddd' }),
    })));
    await act(async () => { root.render(<Harness />); });
    expect(band()!.getAttribute('data-mmr-source')).toBe('cache');
    expect(band()!.getAttribute('data-mmr-menu-version')).toBe('cccccccccccc');
  });

  it('survives StrictMode\'s double-mount without a duplicate band or a stray fetch error', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => LIVE_NAV }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(<StrictMode><Harness /></StrictMode>); });
    expect(host.querySelectorAll('.mmr-band')).toHaveLength(1);
    expect(band()!.getAttribute('data-mmr-source')).toBe('live');
  });
});
