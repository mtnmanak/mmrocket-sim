import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheNames } from 'workbox-core/_private/cacheNames.js';
import {
  PRECACHE_GUARD_KEY, guardPrecache, precacheCacheName, precacheVerdict, type PrecacheGuardEnv,
} from './precacheGuard.js';

/**
 * "REGISTRATION PRESENT, PRECACHE EMPTY" (board Tier 1 row 16): a safeguard
 * for a state seen once and not reproduced, in which the service worker was
 * registered and controlling while its precache was empty. No real service
 * worker runs here: the decision is a pure function, and the steps around it
 * take their browser through an injected environment.
 */

const SCOPE = 'https://mmrsim.example/';

describe('precacheVerdict — the decision, every branch', () => {
  const stranded = {
    dev: false, alreadyTried: false, activeWorker: true, precacheEntries: 0, online: true,
  };

  it('acts on an active worker whose precache is empty, or missing altogether', () => {
    expect(precacheVerdict(stranded)).toBe('stranded');
    expect(precacheVerdict({ ...stranded, precacheEntries: null })).toBe('stranded');
  });

  it('leaves a precache that holds anything', () => {
    expect(precacheVerdict({ ...stranded, precacheEntries: 1 })).toBe('precache-ok');
    expect(precacheVerdict({ ...stranded, precacheEntries: 24 })).toBe('precache-ok');
  });

  it('leaves a worker still installing: a first visit fills its cache as it goes', () => {
    expect(precacheVerdict({ ...stranded, activeWorker: false })).toBe('no-worker');
    expect(precacheVerdict({ ...stranded, activeWorker: false, precacheEntries: null })).toBe('no-worker');
  });

  it('never acts offline, where there is nothing to fetch the app again from', () => {
    expect(precacheVerdict({ ...stranded, online: false })).toBe('offline');
  });

  it('acts at most once a session', () => {
    expect(precacheVerdict({ ...stranded, alreadyTried: true })).toBe('already-tried');
  });

  it('never acts in dev', () => {
    expect(precacheVerdict({ ...stranded, dev: true })).toBe('dev');
    expect(precacheVerdict({ ...stranded, dev: true, alreadyTried: true, online: false })).toBe('dev');
  });
});

describe('precacheCacheName — the cache workbox really fills', () => {
  it('is workbox-core’s own precache name for the registration’s scope', () => {
    // Held to the installed workbox, not to a string typed here: a workbox
    // that renamed its precache would otherwise leave the guard reading a cache
    // that never exists — and calling every working install stranded.
    cacheNames.updateDetails({ suffix: SCOPE });
    try {
      expect(precacheCacheName(SCOPE)).toBe(cacheNames.getPrecacheName());
    } finally {
      cacheNames.updateDetails({ suffix: '' });
    }
  });

  it('holds while vite.config.ts leaves workbox its own prefix', () => {
    // workbox's `cacheId` option replaces the "workbox" prefix of every cache name.
    const config = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
    expect(config).not.toMatch(/\bcacheId\b/);
  });
});

/** A browser for the steps around the decision, every part of it recorded. */
function env(over: {
  dev?: boolean;
  online?: boolean;
  /** Entries in the scope's precache cache; null: the cache does not exist. */
  entries?: number | null;
  server?: boolean;
  storage?: 'ok' | 'throws' | 'throws-on-read' | 'throws-on-write';
  flagged?: boolean;
} = {}) {
  const seen = { server: 0, reloads: 0, opened: [] as string[], flag: over.flagged ? '1' : null as string | null };
  const entries = over.entries === undefined ? 0 : over.entries;
  const e: PrecacheGuardEnv = {
    dev: over.dev ?? false,
    online: () => over.online ?? true,
    session: () => {
      if (over.storage === 'throws') throw new DOMException('The operation is insecure.', 'SecurityError');
      return {
        getItem: (k: string) => {
          if (over.storage === 'throws-on-read') throw new DOMException('The operation is insecure.', 'SecurityError');
          return k === PRECACHE_GUARD_KEY ? seen.flag : null;
        },
        setItem: (k: string, v: string) => {
          if (over.storage === 'throws-on-write') throw new DOMException('Quota', 'QuotaExceededError');
          if (k === PRECACHE_GUARD_KEY) seen.flag = v;
        },
      };
    },
    caches: () => ({
      keys: async () => (entries === null ? ['some-other-cache'] : ['some-other-cache', precacheCacheName(SCOPE)]),
      open: async (name: string) => {
        seen.opened.push(name);
        return { keys: async () => Array.from({ length: entries ?? 0 }, () => new Request('https://x/')) } as unknown as Cache;
      },
    }),
    serverAnswers: async () => { seen.server++; return over.server ?? true; },
    reload: () => { seen.reloads++; },
  };
  return { e, seen };
}

/** A registration, with an active worker unless told otherwise. */
function registration(active = true) {
  const unregister = vi.fn(async () => true);
  const reg = { scope: SCOPE, active: active ? ({} as ServiceWorker) : null, unregister } as unknown as ServiceWorkerRegistration;
  return { reg, unregister };
}

describe('guardPrecache — unregister and reload, once, only where that heals', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('unregisters a stranded worker and reloads, marking the session first', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { e, seen } = env();
    const { reg, unregister } = registration();
    expect(await guardPrecache(reg, e)).toBe('reloaded');
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(seen.reloads).toBe(1);
    expect(seen.flag).not.toBeNull();
    // Logged, for the bug report a second sighting would need.
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('does it once a session: the reloaded page leaves the worker alone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { e, seen } = env();
    await guardPrecache(registration().reg, e);
    const again = registration();
    expect(await guardPrecache(again.reg, e)).toBe('already-tried');
    expect(again.unregister).not.toHaveBeenCalled();
    expect(seen.reloads).toBe(1);
  });

  it('acts on a precache that is missing while the worker is active, without creating it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { e, seen } = env({ entries: null });
    expect(await guardPrecache(registration().reg, e)).toBe('reloaded');
    // caches.open() creates the cache it is asked for; the probe must not.
    expect(seen.opened).toEqual([]);
  });

  it('leaves a full precache alone, and never asks the server', async () => {
    const { e, seen } = env({ entries: 24 });
    const { reg, unregister } = registration();
    expect(await guardPrecache(reg, e)).toBe('precache-ok');
    expect(unregister).not.toHaveBeenCalled();
    expect(seen.server).toBe(0);
    expect(seen.flag).toBeNull();
  });

  it('does nothing offline, and does not ask the server', async () => {
    const { e, seen } = env({ online: false });
    const { reg, unregister } = registration();
    expect(await guardPrecache(reg, e)).toBe('offline');
    expect(unregister).not.toHaveBeenCalled();
    expect(seen.server).toBe(0);
  });

  it('does nothing when the server does not answer — and a later load may still try', async () => {
    const { e, seen } = env({ server: false });
    const { reg, unregister } = registration();
    expect(await guardPrecache(reg, e)).toBe('server-silent');
    expect(seen.server).toBe(1);
    expect(unregister).not.toHaveBeenCalled();
    expect(seen.reloads).toBe(0);
    expect(seen.flag).toBeNull();
  });

  it('does nothing where the session flag cannot be kept: "once" could not be promised', async () => {
    for (const storage of ['throws', 'throws-on-read', 'throws-on-write'] as const) {
      const { e, seen } = env({ storage });
      const { reg, unregister } = registration();
      expect(await guardPrecache(reg, e), storage).toBe('already-tried');
      expect(unregister, storage).not.toHaveBeenCalled();
      expect(seen.reloads, storage).toBe(0);
    }
  });

  it('never asks the server when the flag cannot even be read — that would reload on every load', async () => {
    // A storage that refuses reads but takes writes would otherwise say "not
    // tried" on every load, and every load would unregister and reload again.
    for (const storage of ['throws', 'throws-on-read'] as const) {
      const { e, seen } = env({ storage });
      await guardPrecache(registration().reg, e);
      expect(seen.server, storage).toBe(0);
      expect(seen.flag, storage).toBeNull();
    }
  });

  it('leaves a first visit alone while its worker installs', async () => {
    const { e, seen } = env({ entries: 0 });
    const { reg, unregister } = registration(false);
    expect(await guardPrecache(reg, e)).toBe('no-worker');
    expect(unregister).not.toHaveBeenCalled();
    expect(seen.server).toBe(0);
  });

  it('does nothing in dev, or with no registration', async () => {
    const dev = env({ dev: true });
    const one = registration();
    expect(await guardPrecache(one.reg, dev.e)).toBe('dev');
    expect(one.unregister).not.toHaveBeenCalled();
    expect(await guardPrecache(undefined, env().e)).toBe('no-registration');
  });
});

describe('the wiring', () => {
  it('runs on every registration main.tsx makes', () => {
    // main.tsx registers the worker and mounts the app, so no test runs it.
    const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
    expect(main).toMatch(/onRegisteredSW:[^\n]*guardPrecache\(reg\)/);
  });
});
