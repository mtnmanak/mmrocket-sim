import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Icon } from './Icon.js';
import type { MmrNav, MmrNavSource } from '../services/useMmrNav.js';

/**
 * The Mountain Man Rockets site band (spec §2, `docs/chrome-spec.md` in the
 * mountainmanrockets repo) — a slim strip above this app's own header carrying
 * the brand link, the site menu and a search affordance. It replaces the eight
 * hardcoded WordPress links this tool shipped through v0.043; the data now
 * comes from the published Nav Contract (see `services/useMmrNav.ts`).
 *
 * `target="_top"` on every link is load-bearing, not decoration: this app is
 * embeddable (vite `base: './'`), so a click has to navigate the WHOLE tab out
 * to the site rather than load mountainmanrockets.com inside a nested frame.
 *
 * The visual voice is deliberately the one the old `.site-nav` had — tracked
 * 11.5px caps on `--surface-2` with an orange hover — because that was tuned
 * to sit under this app's header without competing with it. Only the class
 * names changed, to the `.mmr-band-*` namespace the spec requires (MUST 5).
 */

/**
 * MUST 1, "fail open": the calculator always outranks the chrome. Contract
 * data is remote and the band is the only thing rendering it, so a shape we
 * failed to anticipate must cost the user a menu — never the app. React
 * unmounts the whole tree on an uncaught render error, and this boundary is
 * what stops that tree from being the rocket designer.
 *
 * A boundary only catches errors thrown BELOW it, which is why every exported
 * component here is a two-line wrapper around a `*Body` that does the actual
 * reading of `nav`: put the `nav.nav.map` in the same component that renders
 * the boundary and the throw happens while building the boundary's own
 * element, one level too high to be caught.
 */
class BandBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(_err: Error, _info: ErrorInfo) {
    /* Swallowed on purpose: React already logs it to the console in dev, and
       there is no user-facing recovery — the band simply is not there. */
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The search affordance (spec §3). A plain GET form to `{url}?{param}=<term>`
 * — no JavaScript, no fetch, no results UI; the site's own search page does
 * all of it. Native form submission also means the band adds exactly zero
 * keyboard handling, which is MUST 4 ("the tools own their keyboards"): Enter
 * submits because the browser does implicit submission, and every other
 * keystroke stays inside the input. This app's global Ctrl+Z already exempts
 * input elements, so typing here cannot reach the undo stack.
 *
 * Both forms render always and CSS picks one by width — the full input at
 * >= 768px, the compact magnifier link below it. Doing it in CSS rather than
 * JS keeps the first paint correct with no measurement pass and no resize
 * listener.
 */
function BandSearch({ search }: { search: NonNullable<MmrNav['search']> }) {
  return (
    <>
      <form className="mmr-band-search" action={search.url} method="get" target="_top" role="search">
        <input
          type="search"
          name={search.param}
          placeholder="Search"
          aria-label="Search mountainmanrockets.com"
        />
        <button type="submit" title="Search mountainmanrockets.com" aria-label="Search">
          <Icon name="search" size={13} />
        </button>
      </form>
      <a
        className="mmr-band-search-link"
        href={search.url}
        target="_top"
        title="Search mountainmanrockets.com"
        aria-label="Search mountainmanrockets.com"
      >
        <Icon name="search" size={14} />
      </a>
    </>
  );
}

/**
 * The band. `data-mmr-menu-version` and `data-mmr-source` (MUST 3) are the
 * whole debugging protocol from spec §7: open DevTools, read the two stamps,
 * and they say whether a wrong-looking menu is this repo's problem (stamp
 * matches the live contract) or the site's (stale hash, or source !== 'live').
 */
export function SiteBand(props: { nav: MmrNav; source: MmrNavSource }) {
  return <BandBoundary><BandBody {...props} /></BandBoundary>;
}

function BandBody({ nav, source }: { nav: MmrNav; source: MmrNavSource }) {
  return (
    <div
      className="mmr-band"
      data-mmr-menu-version={nav.menuVersion}
      data-mmr-source={source}
    >
      <a className="mmr-band-brand" href={nav.site.home} target="_top" title={nav.site.name}>
        {nav.site.shortName ?? nav.site.name}
      </a>
      <nav className="mmr-band-nav" aria-label="Mountain Man Rockets site menu">
        {/* Keyed by INDEX, not by url. Nothing in the contract or the site's
            generator promises distinct URLs, and spec §1 obliges us to render
            every entry unfiltered — so a duplicate is something we must show,
            not something we may collapse. Duplicate React keys warn and can
            reconcile a label against the wrong href during the
            fallback → live swap. The list never reorders client-side (it is
            replaced wholesale, once), so index keys cost nothing here. */}
        {nav.nav.map((item, i) => (
          <a key={i} href={item.url} target="_top">{item.label}</a>
        ))}
      </nav>
      {nav.search && <BandSearch search={nav.search} />}
    </div>
  );
}

/**
 * Two rulings collide on the footer strip, and this is the adjudication.
 *
 * chrome-spec MUST 6 says band links navigate `target="_top"`. This repo's
 * A standing project ruling says GitHub links
 * open in a new tab — his words, "so the user is not completely taken away
 * from the site" — and every other GitHub affordance in this app honours it
 * (`App.tsx` uses `window.open(url, '_blank', 'noopener')`). The live
 * contract's `footer.links` contains "Bugs & requests" →
 * github.com/mtnmanak/mountainmanrockets-feedback/issues, so `_top` there
 * navigates the WHOLE tab off a half-finished rocket design.
 *
 * The local ruling wins, for github.com only. MUST 6's PURPOSE is escaping an
 * embedding frame, and `_blank` escapes one exactly as completely as `_top`
 * does — so the spec's intent is satisfied while its letter bends. Every
 * non-GitHub site link keeps `_top`, unchanged.
 */
function footerLinkTarget(url: string): { target: string; rel?: string } {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'github.com' || host.endsWith('.github.com')) {
      return { target: '_blank', rel: 'noopener' };
    }
  } catch {
    /* `new URL` throws on anything it cannot parse, and a throw inside render
       takes the band down (MUST 1). `parseNav` screens contract URLs, but the
       baked fallback and a hand-edited cache entry also reach here — anything
       unparseable is treated as a site link and keeps the spec's default. */
  }
  return { target: '_top' };
}

/**
 * The footer strip (spec §4) — opt-in per tool, and the spec recommends opting
 * in here because this app has had no footer at all. One line of site identity
 * plus the site's own links, from data we already fetched for the band.
 */
export function SiteBandFooter(props: { nav: MmrNav }) {
  return <BandBoundary><BandFooterBody {...props} /></BandBoundary>;
}

function BandFooterBody({ nav }: { nav: MmrNav }) {
  if (!nav.footer) return null;
  return (
    <div className="mmr-band-footer">
      <span className="mmr-band-footer-line">{nav.footer.line}</span>
      <span className="mmr-band-footer-links">
        {/* Index keys, for the same reason as the menu above: the contract
            does not promise distinct URLs and we may not filter duplicates. */}
        {nav.footer.links.map((l, i) => (
          <a key={i} href={l.url} {...footerLinkTarget(l.url)}>{l.label}</a>
        ))}
      </span>
    </div>
  );
}
