import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setReloadHold, settleReloadHold, swUpdate } from './swUpdate.js';
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
beforeEach(() => {
  // Dispose the previous document's pending repair before installing this one.
  swUpdate.start(new EventTarget() as ServiceWorkerRegistration, {
    container: Object.assign(new EventTarget(), { controller: null }) as ServiceWorkerContainer,
    initialController: null, reload: vi.fn(), now: () => 0,
    isUntouched: () => false, otherTabsOpen: async () => false,
  })();
  setReloadHold(() => false);
});

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
        removeItem: (k: string) => { if (k === PRECACHE_GUARD_KEY) seen.flag = null; },
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
  it('J6 refuses an offline resumed repair even when a new installing worker has partial entries', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let held = true;
    setReloadHold(() => held);
    const { e, seen } = env();
    const { reg } = registration();
    reg.unregister = vi.fn(async () => { held = true; return true; });
    expect(await guardPrecache(reg, e)).toBe('held');
    held = false;
    await swUpdate.recheckHeldReload();
    expect(reg.unregister).toHaveBeenCalledOnce();
    e.caches = env({ entries: 1 }).e.caches;
    e.online = () => false;
    await swUpdate.applyUpdate();
    expect(seen.reloads).toBe(0);
    expect(swUpdate.getSnapshot().reloadRequired).toBe(true);
  });
  it('r2 reloads a retired repair after a cancelled reload and a refilled cache without an update', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setReloadHold(() => true);
    const { e, seen } = env();
    const { reg, unregister } = registration();
    const reload = vi.fn();
    const stop = swUpdate.start(Object.assign(new EventTarget(), reg, { waiting: null, update: vi.fn(async () => {}) }), {
      container: Object.assign(new EventTarget(), { controller: reg.active }) as unknown as ServiceWorkerContainer,
      initialController: reg.active, reload, now: () => 0, isUntouched: () => false, otherTabsOpen: async () => false,
    });
    try {
      expect(await guardPrecache(reg, e)).toBe('held');
      await swUpdate.applyUpdate();
      expect(seen.reloads).toBe(1);
      e.caches = env({ entries: 1 }).e.caches;
      await swUpdate.applyUpdate();
      expect(reload).toHaveBeenCalledOnce();
      expect(unregister).toHaveBeenCalledOnce();
      expect(swUpdate.getSnapshot().kind).not.toBe('failed');
    } finally { stop(); }
  });
  it('r2 rechecks cache health after the server query before unregistering', async () => {
    setReloadHold(() => true);
    const { e, seen } = env();
    const { reg, unregister } = registration();
    expect(await guardPrecache(reg, e)).toBe('held');
    e.serverAnswers = async () => {
      e.caches = env({ entries: 1 }).e.caches;
      return true;
    };
    await swUpdate.applyUpdate();
    expect(unregister).not.toHaveBeenCalled();
    expect(seen.flag).toBeNull();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('149 B keeps a held design without unregistering or consuming the retry', async () => {
    let held = true;
    setReloadHold(() => held);
    const { e, seen } = env();
    const { reg, unregister } = registration();
    expect(await guardPrecache(reg, e)).toBe('held');
    expect(unregister).not.toHaveBeenCalled();
    expect(seen.reloads).toBe(0);
    expect(seen.flag).toBeNull();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    held = false;
    await settleReloadHold();
    expect(unregister).toHaveBeenCalledOnce();
    expect(seen.reloads).toBe(1);
  });

  it('149 B rechecks the hold after asynchronous unregistering', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { e, seen } = env();
    const { reg, unregister } = registration();
    unregister.mockImplementation(async () => { setReloadHold(() => true); return true; });
    expect(await guardPrecache(reg, e)).toBe('held');
    expect(seen.reloads).toBe(0);
    expect(swUpdate.getSnapshot()).toMatchObject({ kind: 'ready', reloadRequired: true });
    await swUpdate.applyUpdate();
    expect(seen.reloads).toBe(1);
    expect(unregister).toHaveBeenCalledOnce();
  });

  it.each(['click', 'startup settle'])('round 2 keeps held precache repair pending until %s', async mode => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let held = true;
    setReloadHold(() => held);
    const { e, seen } = env();
    const { reg, unregister } = registration();
    expect(await guardPrecache(reg, e)).toBe('held');
    expect(swUpdate.getSnapshot()).toMatchObject({ kind: 'ready', applying: false, reloadRequired: true });
    if (mode === 'click') await swUpdate.applyUpdate();
    else {
      held = false;
      await settleReloadHold();
    }
    expect(unregister).toHaveBeenCalledOnce();
    expect(seen.reloads).toBe(1);
    expect(seen.flag).toBe('1');
  });

  it('unregisters a stranded worker and reloads, marking the session first', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { e, seen } = env();
    const { reg, unregister } = registration();
    expect(await guardPrecache(reg, e)).toBe('reloaded');
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(seen.reloads).toBe(1);
    expect(seen.flag).not.toBeNull();
    expect(seen.server).toBe(1);
    // Logged, for the bug report a second sighting would need.
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('V211-2 checks connectivity on every retry after a cancelled reload', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setReloadHold(() => true);
    const { e, seen } = env();
    const { reg, unregister } = registration();
    expect(await guardPrecache(reg, e)).toBe('held');
    await swUpdate.applyUpdate();
    expect(seen.reloads).toBe(1);
    e.online = () => false;
    await swUpdate.applyUpdate();
    expect(seen.reloads).toBe(1);
    const server = vi.fn(async () => false);
    e.online = () => true;
    e.serverAnswers = server;
    await swUpdate.applyUpdate();
    expect(server).toHaveBeenCalledOnce();
    expect(seen.reloads).toBe(1);
    e.serverAnswers = async () => true;
    await swUpdate.applyUpdate();
    expect(seen.reloads).toBe(2);
    expect(unregister).toHaveBeenCalledOnce();
  });

  it('V211-6 a rejected unregister does not consume this session retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { e, seen } = env();
    const { reg, unregister } = registration();
    unregister.mockRejectedValueOnce(new Error('worker storage'));
    expect(await guardPrecache(reg, e)).toBe('unknown');
    expect(seen.flag).toBeNull();
    expect(await guardPrecache(reg, e)).toBe('reloaded');
    expect(unregister).toHaveBeenCalledTimes(2);
    expect(seen.reloads).toBe(1);
  });

  it.each([true, false])('V211-8 retires a repair refilled by another tab, online=%s', async online => {
    setReloadHold(() => true);
    const { e, seen } = env();
    const { reg, unregister } = registration();
    const old = reg.active;
    const container = Object.assign(new EventTarget(), { controller: old });
    const reload = vi.fn();
    const stop = swUpdate.start(Object.assign(new EventTarget(), reg), {
      container: container as unknown as ServiceWorkerContainer, initialController: old,
      reload, now: () => 0, isUntouched: () => false, otherTabsOpen: async () => false,
    });
    try {
      expect(await guardPrecache(reg, e)).toBe('held');
      e.caches = env({ entries: 1 }).e.caches;
      e.online = () => online;
      container.controller = {} as ServiceWorker;
      container.dispatchEvent(new Event('controllerchange'));
      await swUpdate.applyUpdate();
      expect(unregister).not.toHaveBeenCalled();
      expect(reload).toHaveBeenCalledOnce();
      expect(seen.server).toBe(1);
      expect(seen.flag).toBeNull();
    } finally { stop(); }
  });

  it('V211-9 retires a repair when the retry flag cannot be written', async () => {
    setReloadHold(() => true);
    const { e, seen } = env({ storage: 'throws-on-write' });
    const { reg, unregister } = registration();
    const old = reg.active;
    const container = Object.assign(new EventTarget(), { controller: old });
    const reload = vi.fn();
    const stop = swUpdate.start(Object.assign(new EventTarget(), reg), {
      container: container as unknown as ServiceWorkerContainer, initialController: old,
      reload, now: () => 0, isUntouched: () => false, otherTabsOpen: async () => false,
    });
    try {
      expect(await guardPrecache(reg, e)).toBe('held');
      container.controller = {} as ServiceWorker;
      container.dispatchEvent(new Event('controllerchange'));
      await swUpdate.applyUpdate();
      expect(reload).toHaveBeenCalledOnce();
      expect(unregister).not.toHaveBeenCalled();
      expect(seen.server).toBe(2);
      await swUpdate.applyUpdate();
      expect(seen.server).toBe(2);
    } finally { stop(); }
  });

  it('V211-8 hands a healthy repaired cache to the waiting-worker update path', async () => {
    setReloadHold(() => true);
    const { e } = env();
    const { reg, unregister } = registration();
    const worker = Object.assign(new EventTarget(), { state: 'installed', postMessage: vi.fn() });
    const live = Object.assign(new EventTarget(), reg, { waiting: null as ServiceWorker | null });
    const stop = swUpdate.start(live as unknown as ServiceWorkerRegistration, {
      container: Object.assign(new EventTarget(), { controller: reg.active }) as unknown as ServiceWorkerContainer,
      initialController: reg.active, reload: vi.fn(), now: () => 0,
      isUntouched: () => false, otherTabsOpen: async () => false,
    });
    try {
      expect(await guardPrecache(reg, e)).toBe('held');
      e.caches = env({ entries: 1 }).e.caches;
      live.waiting = worker as unknown as ServiceWorker;
      await swUpdate.applyUpdate();
      expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'SKIP_WAITING' });
      expect(unregister).not.toHaveBeenCalled();
    } finally { stop(); }
  });

  it('V211-14 keeps a slow repair busy and resumes it only once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setReloadHold(() => true);
    const { e, seen } = env();
    const { reg, unregister } = registration();
    expect(await guardPrecache(reg, e)).toBe('held');
    let answer!: (value: boolean) => void;
    const gate = new Promise<boolean>(resolve => { answer = resolve; });
    const server = vi.fn(() => gate);
    e.serverAnswers = server;
    const first = swUpdate.applyUpdate();
    expect(swUpdate.getSnapshot()).toMatchObject({ applying: true });
    await vi.waitFor(() => expect(server).toHaveBeenCalled());
    expect(server).toHaveBeenCalledOnce();
    expect(unregister).not.toHaveBeenCalled();
    const second = swUpdate.applyUpdate();
    answer(true);
    await Promise.all([first, second]);
    expect(server).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
    expect(seen.reloads).toBe(1);
    expect(swUpdate.getSnapshot()).toMatchObject({ applying: false });
  });

  it.each(['offline', 'server-silent', 'cancelled reload'])('round 3 retries deferred repair after %s', async failure => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setReloadHold(() => true);
    const { e, seen } = env();
    const { reg, unregister } = registration();
    expect(await guardPrecache(reg, e)).toBe('held');
    const online = e.online;
    const server = e.serverAnswers;
    if (failure === 'offline') e.online = () => false;
    if (failure === 'server-silent') e.serverAnswers = async () => false;
    await swUpdate.applyUpdate();
    expect(seen.reloads).toBe(failure === 'cancelled reload' ? 1 : 0);
    expect(swUpdate.getSnapshot()).toMatchObject({ kind: 'ready', applying: false, reloadRequired: true });
    e.online = online;
    e.serverAnswers = server;
    await swUpdate.applyUpdate();
    expect(seen.reloads).toBe(failure === 'cancelled reload' ? 2 : 1);
    expect(unregister).toHaveBeenCalledOnce();
    expect(seen.flag).toBe('1');
  });

  it('round 3 rechecks the hold after a resumed server query', async () => {
    setReloadHold(() => true);
    const { e, seen } = env();
    const { reg, unregister } = registration();
    expect(await guardPrecache(reg, e)).toBe('held');
    let held = false;
    e.serverAnswers = async () => { held = true; return true; };
    setReloadHold(() => held);
    await settleReloadHold();
    expect(unregister).not.toHaveBeenCalled();
    expect(seen.flag).toBeNull();
    expect(seen.reloads).toBe(0);
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
    // main.tsx registers the worker and mounts the app. Since board row 19
    // (2026-10-06) the registration goes through offlineStatus.start, whose
    // second argument becomes onRegisteredSW (main.offlineStatus.test.tsx drives it).
    const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
    expect(main).toMatch(/offlineStatus\.start\(registerSW,[\s\S]*?guardPrecache\(reg\)/);
  });
});
