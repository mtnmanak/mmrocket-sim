import { useCallback, useEffect, useState } from 'react';
import { APP_VERSION } from '../version.js';
import { versionEarlierThan } from './session.js';

/**
 * "Am I on the current version?" — answered definitively, instead of the
 * support conversation it currently costs (a tester's own words: keep
 * refreshing until you see the number change).
 *
 * `version.json` ships at the app root with every release and is deliberately
 * NOT precached — the workbox glob covers js/css/html/png/webmanifest/woff
 * only, and package-dist.mjs copies the file in AFTER the build for exactly
 * this reason. So a fetch of it always reaches the network and always reports
 * what is actually deployed, even to a tab running an old cached build.
 *
 * The service worker is registered with `registerType: 'autoUpdate'`, which
 * means a new build takes over and reloads the page on its own — but only once
 * the browser gets around to re-checking, which it does on registration, i.e.
 * on a page load. That is why the honest action here is "Reload": it is both
 * what fetches the new build and what this check is telling you to do.
 */

export interface LatestVersion {
  version: string;
  released?: string;
  note?: string;
}

export type UpdateState =
  | { kind: 'checking' }
  /** The deployed version matches (or is older than) this build. */
  | { kind: 'current'; version: string }
  | { kind: 'stale'; latest: LatestVersion }
  /** The check could not be made — offline, blocked, or a dev server. */
  | { kind: 'unknown' };

/** A plausible version string for this project's scheme, and for 1.0.0 later. */
const VERSION_RE = /^\d+(\.\d+)+$/;

/**
 * Read the deployed version. Resolves to null for EVERY failure — offline,
 * CORS, DNS, 404, malformed JSON, wrong shape — and never rejects, matching
 * `fetchNav`'s contract.
 *
 * The shape guard is load-bearing rather than defensive. The deploy ships no
 * 404.html and no `_headers`, so a missing `/version.json` can come back as
 * `index.html` at HTTP 200; `npm run dev` always does that, because the file
 * is not in `public/`. Without the guard the app would parse a page of HTML,
 * fail, and — worse, if it ever half-succeeded — tell a developer their
 * up-to-date build was stale.
 */
export async function fetchLatestVersion(signal?: AbortSignal): Promise<LatestVersion | null> {
  try {
    // Both the query bust and no-store: the CDN's caching headers are not in
    // this repo's control, and the service worker is not the only cache in the
    // path (the HTTP cache and any corporate proxy are too).
    const res = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store', signal });
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    if (typeof raw !== 'object' || raw === null) return null;
    const v = raw as Partial<LatestVersion>;
    if (typeof v.version !== 'string' || !VERSION_RE.test(v.version)) return null;
    return {
      version: v.version,
      ...(typeof v.released === 'string' ? { released: v.released } : {}),
      ...(typeof v.note === 'string' ? { note: v.note } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The service-worker registration, published from main.tsx so the header's
 * "check again" can ask the browser to look for a new build rather than only
 * asking the CDN what exists. Null until the SW registers, and on the retired
 * host (which is deliberately PWA-free) it stays null forever.
 */
let swRegistration: ServiceWorkerRegistration | null = null;
export function setSwRegistration(reg: ServiceWorkerRegistration | undefined): void {
  swRegistration = reg ?? null;
}

/** Ask the browser to re-check for a new service worker. Best-effort. */
export async function pokeServiceWorker(): Promise<void> {
  try { await swRegistration?.update(); } catch { /* offline, or no SW */ }
}

export function useVersionCheck(): { state: UpdateState; recheck: () => void; checking: boolean } {
  const [state, setState] = useState<UpdateState>({ kind: 'checking' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    // Per-effect, not a shared ref: a ref would be re-armed by the NEXT run's
    // setup, so a cancelled run could resume afterwards and write a stale
    // answer over a fresh one.
    let cancelled = false;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    setState({ kind: 'checking' });
    void (async () => {
      // Poke the SW first so that, if a new build is already sitting there,
      // autoUpdate's own reload beats us to it and the user never sees a
      // banner for something already handled.
      if (nonce > 0) await pokeServiceWorker();
      const latest = await fetchLatestVersion(ctrl?.signal);
      if (cancelled) return;
      if (!latest) { setState({ kind: 'unknown' }); return; }
      // A build AHEAD of what version.json says is `current`, never `stale` —
      // that is a developer running a local build, or a CDN edge that has not
      // caught up yet. Telling either of them to reload would be wrong.
      setState(versionEarlierThan(APP_VERSION, latest.version)
        ? { kind: 'stale', latest }
        : { kind: 'current', version: latest.version });
    })();
    return () => { cancelled = true; ctrl?.abort(); };
    // Mount-only, plus explicit rechecks. No polling: this is a design tool
    // people leave open for hours, and a background request every few minutes
    // buys nothing a reload would not.
  }, [nonce]);

  const recheck = useCallback(() => setNonce((n) => n + 1), []);
  return { state, recheck, checking: state.kind === 'checking' };
}
