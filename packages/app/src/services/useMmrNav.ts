import { useEffect, useState } from 'react';

/**
 * The Mountain Man Rockets "Nav Contract" — the site publishes its menu as
 * DATA at a stable URL and every tool renders the band itself. Adopted
 * 12 Aug 2026; the spec is `docs/chrome-spec.md` in the mountainmanrockets
 * repo, and it is adjudicated — do not re-derive the design here.
 *
 * Why data and not a shared script: nothing executable ever crosses an
 * origin, and a menu change becomes one commit in one repo instead of four
 * tool sessions. The whole fetch is progressive enhancement — see the fail-open
 * contract on `useMmrNav` below.
 *
 * This file is an ADAPTATION of the spec's reference hook (spec §5), not an
 * import: each tool owns its copy so the site can never break a tool by
 * shipping. The adaptations are the shared validator (`parseNav`) and the
 * split of cache/fetch into testable functions; the fallback-first state
 * machine is the spec's, unchanged. `CONTRACT` is NOT: it points at
 * `www.mountainmanrockets.com`, the canonical post-cutover host, which is a
 * correction to the literal printed in §5 — see the note on the constant
 * itself before touching it.
 */

/**
 * Spec constant AS CORRECTED — §5's own literal is pre-cutover. The canonical
 * host is `www.mountainmanrockets.com`, the site's own origin. All
 * four tools must agree on one URL so a caching or CORS fault is diagnosed
 * once, in one place (spec §7); changing this is a spec revision, not a tool
 * decision.
 *
 * DO NOT "restore" the `mountainmanrockets.pages.dev` literal that older docs
 * — and this file, through v0.044 — still carry. It was copied from §5 while
 * the spec's own literal was still pre-cutover, and it works today only
 * because the Pages preview alias happens to still answer 200. Rename or
 * retire that alias and the fetch fails, which by design is SILENT: `fetchNav`
 * swallows every failure so the menu can never cost the user the app (MUST 1),
 * so the band would simply freeze on its baked snapshot with nothing logged
 * and nothing reported. The only visible symptom is `data-mmr-source` stuck at
 * "fallback" in DevTools — on a machine where somebody happens to look.
 */
const CONTRACT = 'https://www.mountainmanrockets.com/chrome/nav.v1.json';
const CACHE_KEY = 'mmr-chrome:v1';

export interface MmrNavLink {
  label: string;
  url: string;
}

export interface MmrNav {
  schema: 'mmr.nav.v1';
  /** 12-hex content hash of the whole menu; stamped on the band for debugging. */
  menuVersion: string;
  /** Informational: true once the site's DNS cutover happened. */
  cutover?: boolean;
  site: { name: string; shortName?: string; home: string };
  nav: MmrNavLink[];
  search?: { url: string; param: string };
  feedback?: { tracker: string; bug: string; feature: string; email: string };
  footer?: { line: string; links: MmrNavLink[] };
}

export type MmrNavSource = 'fallback' | 'cache' | 'live';

export interface MmrNavState {
  nav: MmrNav;
  source: MmrNavSource;
}

/**
 * FALLBACK — a BUILD-TIME SNAPSHOT of the live contract (fetched 12 Aug 2026,
 * menuVersion 480f0531d406). It is what renders offline, on a fetch failure,
 * and on the very first paint of every load; the live fetch supersedes it a
 * few hundred milliseconds later.
 *
 * It deliberately is NOT the eight WordPress links this app shipped through
 * v0.043. Those predate the 12 Aug 2026 replatform and now 301
 * (`/index.php/builds/` → `/builds/`) or name sections the site no longer uses
 * ("HPR Primer" is "Rocketry U"). The fallback IS the offline experience, so
 * shipping today's menu — even a snapshot of it — beats shipping redirects and
 * stale labels. `menuVersion` is carried verbatim so the `data-mmr-menu-version`
 * stamp stays honest: a band showing this hash with source="fallback" is a tool
 * that could not reach the contract, which is exactly what spec §7 wants to see.
 */
export const MMR_NAV_FALLBACK: MmrNav = {
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
    { label: 'Tools & Techniques', url: 'https://www.mountainmanrockets.com/techniques/' },
    { label: 'Checklists & Info', url: 'https://www.mountainmanrockets.com/lists/' },
    { label: 'Media', url: 'https://www.mountainmanrockets.com/media/' },
    { label: 'Links', url: 'https://www.mountainmanrockets.com/links/' },
    { label: 'Online Tools', url: 'https://www.mountainmanrockets.com/online_tools/' },
    { label: 'Contact', url: 'https://www.mountainmanrockets.com/contact/' },
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
    links: [
      { label: 'YouTube', url: 'https://www.youtube.com/@mountainmanrockets5644' },
      { label: 'Bugs & requests', url: 'https://github.com/mtnmanak/mountainmanrockets-feedback/issues' },
      { label: 'Contact', url: 'https://www.mountainmanrockets.com/contact/' },
    ],
  },
};

/** Only http(s) may reach an `href`/`window.open` — see `parseNav`. */
const isHttpUrl = (v: unknown): v is string =>
  typeof v === 'string' && /^https?:\/\/[^\s]+$/i.test(v);

/**
 * Every ENTRY in a link list must be renderable. Emptiness is deliberately
 * NOT checked here: `nav[]` is the only array the spec requires to be
 * populated (§1 "render all of them"; the reference hook in §5 tests exactly
 * `!fresh.nav?.length`), while `footer.links: []` is a perfectly legal
 * payload for a site with no footer links to publish. Folding the non-empty
 * test in here is what made an empty footer reject the whole contract.
 */
const isLinkList = (v: unknown): v is MmrNavLink[] =>
  Array.isArray(v)
  && v.every((l): boolean => {
    const link = l as Partial<MmrNavLink> | null;
    return !!link && typeof link.label === 'string' && !!link.label && isHttpUrl(link.url);
  });

const isSearchBlock = (v: unknown): boolean => {
  const s = v as Partial<NonNullable<MmrNav['search']>> | null;
  return !!s && isHttpUrl(s.url) && typeof s.param === 'string' && !!s.param;
};

const isFeedbackBlock = (v: unknown): boolean => {
  const f = v as Partial<NonNullable<MmrNav['feedback']>> | null;
  return !!f && isHttpUrl(f.tracker) && isHttpUrl(f.bug) && isHttpUrl(f.feature)
    && typeof f.email === 'string' && /^[^\s@]+@[^\s@]+$/.test(f.email);
};

const isFooterBlock = (v: unknown): boolean => {
  const f = v as Partial<NonNullable<MmrNav['footer']>> | null;
  return !!f && typeof f.line === 'string' && isLinkList(f.links);
};

/**
 * Validate a candidate contract, from the network OR from localStorage.
 *
 * Why this is stricter than the spec's `schema === 'mmr.nav.v1' && nav.length`
 * one-liner: the same object is parsed on both paths, so a half-written cache
 * entry from a killed tab has to be rejected exactly like a bad response, and
 * every string in it is about to become an `href`. React escapes text, but it
 * will happily render `href="javascript:…"` — hence the http(s) test on every
 * URL. A schema we don't recognise (a v2 payload served by mistake) must leave
 * the baked fallback standing: spec §1, "Reject anything else and keep your
 * fallback."
 *
 * REJECT vs DEGRADE — the line, and why it moved. Whole-payload rejection is
 * reserved for what the band cannot render without: `schema`, `menuVersion`,
 * `site`, and a NON-EMPTY `nav[]`. The optional blocks (`search`, `feedback`,
 * `footer`) degrade instead — a bad one is dropped and the rest of the
 * contract goes live, because the band already renders correctly with any of
 * them absent (spec §1 says a tool may ignore `footer` outright).
 *
 * The earlier "reject everything, uniformly" rule looked safer and was not:
 * one legal-but-empty `footer.links` would have pinned this tool to the baked
 * fallback permanently and silently on every load, and the band would then
 * stamp `data-mmr-source="fallback"` — which spec §7 routes to a SITE session
 * to check CORS, `_headers` and `/chrome/demo`, all of which would be fine.
 * A validator that misdirects debugging is worse than one that renders eight
 * good links and skips a broken search box.
 *
 * `nav[]` itself is still all-or-nothing: §1 forbids filtering it ("render
 * all of them"), so one bad entry there means we do not trust the menu at
 * all. Additive fields we don't know about pass straight through (spec §1's
 * versioning rule: render what you know, ignore what you don't).
 */
export function parseNav(raw: unknown): MmrNav | null {
  try {
    const c = raw as Partial<MmrNav> | null;
    if (!c || typeof c !== 'object') return null;
    if (c.schema !== 'mmr.nav.v1') return null;
    if (typeof c.menuVersion !== 'string' || !c.menuVersion) return null;
    if (!c.site || typeof c.site.name !== 'string' || !c.site.name || !isHttpUrl(c.site.home)) return null;
    if (!isLinkList(c.nav) || c.nav.length === 0) return null;

    // Shallow copy so unknown additive fields ride along untouched while the
    // caller's object — a live fetch body, or a cache entry another call may
    // still be holding — is never mutated by a drop or a normalisation.
    const out = { ...c } as MmrNav;
    if (out.search !== undefined && !isSearchBlock(out.search)) delete out.search;
    if (out.footer !== undefined && !isFooterBlock(out.footer)) delete out.footer;
    if (out.feedback !== undefined && !isFeedbackBlock(out.feedback)) {
      delete out.feedback;
    } else if (out.feedback) {
      // Canonicalise the tracker ONCE, here, so no consumer has to think about
      // it. App.tsx builds the browse-issues link as `${tracker}/issues?q=…`;
      // a trailing slash in the site's config would make that `…feedback//issues`,
      // which GitHub 404s — dead-ending the user's only in-app route to the
      // existing-issue list. Cheaper to normalise at the boundary than to
      // audit every future concatenation site.
      out.feedback = { ...out.feedback, tracker: out.feedback.tracker.replace(/\/+$/, '') };
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Last-known-good menu (spec MUST 7), so a returning offline user sees the
 * newest menu they ever saw rather than the vendored snapshot. Every access is
 * guarded: localStorage throws outright in Safari private mode and when a
 * user has blocked site data, and the band must never be the thing that
 * breaks the app.
 */
export function readCachedNav(): MmrNav | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? parseNav(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeCachedNav(nav: MmrNav): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(nav));
  } catch {
    /* Quota, private mode, blocked storage — the band works, it just re-fetches. */
  }
}

/**
 * Fetch the live contract. Resolves to `null` for every failure mode there is
 * — offline, CORS, DNS, 404, malformed JSON, wrong schema — and NEVER rejects,
 * so the caller has nothing to handle. `cache: 'no-cache'` revalidates rather
 * than reusing a stale HTTP cache entry; the menu is small and the localStorage
 * copy is what actually serves offline.
 */
export async function fetchNav(signal?: AbortSignal): Promise<MmrNav | null> {
  try {
    const res = await fetch(CONTRACT, { cache: 'no-cache', signal });
    if (!res.ok) return null;
    return parseNav(await res.json());
  } catch {
    return null;
  }
}

/**
 * The band's data source, fail-open by construction (spec MUST 1 and 2):
 *
 *  1. First render is SYNCHRONOUS — cached contract if there is a valid one,
 *     otherwise the baked fallback. There is deliberately no loading state:
 *     a spinner or a reserved-then-filled gap in the top strip is a layout
 *     shift on every single page load, which is worse than a menu that is
 *     occasionally one deploy stale.
 *  2. The live fetch then supersedes it and rewrites the cache. Nothing here
 *     can throw into the app: `fetchNav` swallows everything, the `.catch` is
 *     belt-and-braces, and `alive` guards the unmounted case.
 *
 * The refetch is intentionally mount-only (empty deps). The menu changes on
 * site deploys, not on user actions, and this app is a long-lived single-page
 * session — polling would cost more than it could ever gain.
 */
export function useMmrNav(fallback: MmrNav = MMR_NAV_FALLBACK): MmrNavState {
  const [state, setState] = useState<MmrNavState>(() => {
    const cached = readCachedNav();
    return cached
      ? { nav: cached, source: 'cache' }
      : { nav: fallback, source: 'fallback' };
  });

  useEffect(() => {
    let alive = true;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    fetchNav(ctrl?.signal)
      .then((fresh) => {
        if (!alive || !fresh) return;
        writeCachedNav(fresh);
        // Set unconditionally even when menuVersion matches what we already
        // had: `data-mmr-source` must reach "live" for the spec §7 debugging
        // protocol to mean anything. When the version is unchanged the render
        // output is identical, so React's diff makes it a no-op in the DOM.
        setState({ nav: fresh, source: 'live' });
      })
      .catch(() => { /* unreachable — fetchNav never rejects. MUST 1. */ });
    return () => {
      alive = false;
      ctrl?.abort();
    };
  }, []);

  return state;
}
