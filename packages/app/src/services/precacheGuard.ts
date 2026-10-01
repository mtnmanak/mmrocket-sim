import { fetchLatestVersion } from './versionCheck.js';

/**
 * "REGISTRATION PRESENT, PRECACHE EMPTY" — A SAFEGUARD (board Tier 1 row 16).
 *
 * Seen ONCE on the live site (2026-09-15) and not reproduced: Cache Storage
 * was empty while the service worker was still registered and controlling.
 * That strands the app offline, and it does not heal. workbox answers a
 * precached file missing from its cache from the network, and puts it back
 * only for an entry with an SRI hash, which this build's manifest does not
 * carry; the cache is filled when a worker INSTALLS, and an unchanged worker
 * never installs again. So two online reloads and an explicit
 * `registration.update()` left it empty, and only unregistering restored it:
 * the next load installs a fresh worker, which fills the cache.
 *
 * With no cause known this is a guard, not a fix. On a load where an active
 * worker's precache is empty or missing, it unregisters the worker and reloads
 * — online only, with the server answering (nothing could be fetched again
 * otherwise, and unregistering would make an offline page worse), at most once
 * a tab session, and never in dev, which has no worker. Main.tsx runs it on
 * every registration.
 */

/** sessionStorage: set before the one unregister-and-reload a tab gets. */
export const PRECACHE_GUARD_KEY = 'online-openrocket.precache-guard.v1';

/**
 * The cache workbox precaches into for a worker at `scope`: workbox-core's
 * `cacheNames.getPrecacheName()` — its prefix, `precache-v2`, and the
 * registration's scope. vite.config.ts sets no `cacheId`, which would replace
 * the prefix (precacheGuard.test.ts holds both to the installed workbox).
 */
export function precacheCacheName(scope: string): string {
  return `workbox-precache-v2-${scope}`;
}

/** Why the worker is left alone, or `stranded`: act, once the server answers. */
export type PrecacheVerdict = 'dev' | 'already-tried' | 'no-worker' | 'precache-ok' | 'offline' | 'stranded';

/** The decision. Pure; the checks run in order, so the first reason found is the one given. */
export function precacheVerdict(f: {
  dev: boolean;
  /** This tab acted already — or cannot keep the flag that says so. */
  alreadyTried: boolean;
  /** The registration has an installed, activated worker. */
  activeWorker: boolean;
  /** Entries in the scope's precache cache; null when that cache does not exist. */
  precacheEntries: number | null;
  online: boolean;
}): PrecacheVerdict {
  if (f.dev) return 'dev';
  if (f.alreadyTried) return 'already-tried';
  // A worker still installing fills its cache as it goes: empty or missing is
  // then the install, not a fault. Only an ACTIVE worker serves offline loads.
  if (!f.activeWorker) return 'no-worker';
  if (f.precacheEntries !== null && f.precacheEntries > 0) return 'precache-ok';
  if (!f.online) return 'offline';
  return 'stranded';
}

/** The browser the guard acts in, injectable so the steps can be tested without a worker. */
export interface PrecacheGuardEnv {
  dev: boolean;
  online: () => boolean;
  /** sessionStorage. Reading the property itself throws where storage is blocked. */
  session: () => Pick<Storage, 'getItem' | 'setItem'>;
  caches: () => Pick<CacheStorage, 'keys' | 'open'> | undefined;
  /** version.json reached the real server (it is never precached). */
  serverAnswers: () => Promise<boolean>;
  reload: () => void;
}

const browser: PrecacheGuardEnv = {
  dev: import.meta.env.DEV,
  online: () => navigator.onLine !== false,
  session: () => window.sessionStorage,
  caches: () => globalThis.caches,
  serverAnswers: async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      return (await fetchLatestVersion(ctrl.signal)) !== null;
    } finally {
      clearTimeout(timer);
    }
  },
  reload: () => location.reload(),
};

export type PrecacheGuardOutcome = PrecacheVerdict | 'no-registration' | 'unknown' | 'server-silent' | 'reloaded';

/** Look, decide, and — when the precache is stranded — unregister and reload. Never throws. */
export async function guardPrecache(
  reg: ServiceWorkerRegistration | undefined,
  env: PrecacheGuardEnv = browser,
): Promise<PrecacheGuardOutcome> {
  if (!reg) return 'no-registration';
  let alreadyTried: boolean;
  try {
    alreadyTried = env.session().getItem(PRECACHE_GUARD_KEY) !== null;
  } catch {
    alreadyTried = true; // no flag, so "once" could not be promised
  }
  let precacheEntries: number | null = null;
  try {
    const store = env.caches();
    if (!store) return 'unknown';
    const name = precacheCacheName(reg.scope);
    // keys() first: open() CREATES the cache it is asked for.
    if ((await store.keys()).includes(name)) precacheEntries = (await (await store.open(name)).keys()).length;
  } catch {
    return 'unknown';
  }
  const verdict = precacheVerdict({
    dev: env.dev, alreadyTried, activeWorker: reg.active !== null, precacheEntries, online: env.online(),
  });
  if (verdict !== 'stranded') return verdict;
  if (!(await env.serverAnswers())) return 'server-silent';
  try {
    env.session().setItem(PRECACHE_GUARD_KEY, '1');
  } catch {
    return 'already-tried';
  }
  console.warn('MMRocket Sim: the offline copy was empty while its service worker was active; '
    + 'unregistering the worker and reloading once, so a fresh one installs.');
  try {
    await reg.unregister();
  } catch {
    return 'unknown';
  }
  env.reload();
  return 'reloaded';
}
