import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { registerSW } from 'virtual:pwa-register';
import { createOfflineStatusStore, offlineStatusText } from './offlineStatus.js';
import { precacheCacheName } from './precacheGuard.js';

type Options = NonNullable<Parameters<typeof registerSW>[0]>;
const scope = 'https://mmrsim.example/app/';
const controller = { scriptURL: `${scope}sw.js`, state: 'activated' } as ServiceWorker;
const reg = { scope, active: controller } as ServiceWorkerRegistration;
let sw: EventTarget & { controller: ServiceWorker | null; getRegistration: ReturnType<typeof vi.fn> };
let keys: ReturnType<typeof vi.fn>;
let entries: ReturnType<typeof vi.fn>;
let open: ReturnType<typeof vi.fn>;
let options: Options;
let store: ReturnType<typeof createOfflineStatusStore>;
let register: ReturnType<typeof vi.fn<typeof registerSW>>;
let stop: (() => void) | undefined;
const registered = vi.fn();
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

beforeEach(() => {
  store = createOfflineStatusStore();
  sw = Object.assign(new EventTarget(), { controller: null as ServiceWorker | null, getRegistration: vi.fn().mockResolvedValue(reg) });
  keys = vi.fn().mockResolvedValue([precacheCacheName(scope)]);
  entries = vi.fn().mockResolvedValue([new Request(`${scope}index.html`)]);
  open = vi.fn().mockResolvedValue({ keys: entries });
  vi.stubGlobal('navigator', { serviceWorker: sw });
  vi.stubGlobal('caches', { keys, open });
  register = vi.fn<typeof registerSW>((value) => {
    options = value!;
    return async () => {};
  });
  registered.mockClear();
});
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function start() { stop = store.start(register, registered); }

describe('offline copy status', () => {
  it('starts silent; registration and a cache without control cannot prove readiness', async () => {
    expect(offlineStatusText(store.getSnapshot())).toBe('');
    start();
    options.onRegisteredSW?.('./sw.js', reg);
    await settle();
    expect(store.getSnapshot()).toEqual({ kind: 'unknown' });
    expect(keys).not.toHaveBeenCalled();
    expect(registered).toHaveBeenCalledWith('./sw.js', reg);
    expect(options.immediate).toBe(true);
    expect(options.onNeedReload).toBeUndefined();
  });

  it('publishes the first-install callback, even before control and without storage access', () => {
    start();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    options.onOfflineReady?.();
    expect(offlineStatusText(store.getSnapshot())).toBe('Offline copy ready');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    options.onOfflineReady?.();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(keys).not.toHaveBeenCalled();
  });

  it('recognizes a later load without another offline-ready callback', async () => {
    sw.controller = controller;
    start();
    await settle();
    expect(store.getSnapshot()).toMatchObject({ kind: 'ready', detail: expect.stringContaining('1 precache entries') });
    expect(open).toHaveBeenCalledWith(precacheCacheName(scope));
  });

  it('checks when the worker takes control, and clears readiness when control is lost', async () => {
    start();
    sw.controller = controller;
    sw.dispatchEvent(new Event('controllerchange'));
    await settle();
    expect(store.getSnapshot().kind).toBe('ready');
    sw.controller = null;
    sw.dispatchEvent(new Event('controllerchange'));
    await settle();
    expect(store.getSnapshot().kind).toBe('unknown');
  });

  it.each([{ names: [] }, { names: ['workbox-precache-v2-https://mmrsim.example/other/'] }, { names: ['workbox-runtime'] }])(
    'rejects missing or unrelated precaches ($names), without creating a cache', async ({ names }) => {
      sw.controller = controller;
      keys.mockResolvedValue(names);
      await store.recheck();
      expect(store.getSnapshot()).toMatchObject({ kind: 'unavailable', reason: 'download missing' });
      expect(open).not.toHaveBeenCalled();
    },
  );

  it('rejects an empty precache and notices removal on a subsequent check', async () => {
    sw.controller = controller;
    await store.recheck();
    expect(store.getSnapshot().kind).toBe('ready');
    entries.mockResolvedValue([]);
    await store.recheck();
    expect(offlineStatusText(store.getSnapshot())).toBe('Offline copy not available — download missing');
  });

  it('requires the registration to belong to the controlling worker', async () => {
    sw.controller = { ...controller, scriptURL: `${scope}other.js` } as ServiceWorker;
    await store.recheck();
    expect(store.getSnapshot().kind).toBe('unknown');
    expect(keys).not.toHaveBeenCalled();
  });

  it('reports unsupported browsers without attempting registration', () => {
    vi.stubGlobal('navigator', {});
    expect(start).not.toThrow();
    expect(offlineStatusText(store.getSnapshot())).toBe('Offline copy not available in this browser');
    expect(register).not.toHaveBeenCalled();
  });

  it('reports registration errors with a short label and detail, then recovers on install', async () => {
    start();
    options.onRegisterError?.(new Error('Network failure with a long URL'));
    await settle();
    expect(store.getSnapshot()).toEqual({ kind: 'unavailable', reason: 'registration failed', detail: 'Network failure with a long URL' });
    options.onOfflineReady?.();
    expect(store.getSnapshot().kind).toBe('ready');
  });

  it('a failed update registration still recognizes an existing offline copy', async () => {
    sw.controller = controller;
    start();
    options.onRegisterError?.('offline');
    await settle();
    expect(store.getSnapshot()).toMatchObject({ kind: 'ready', detail: expect.stringContaining('Registration check failed: offline') });
  });

  it.each(['getRegistration', 'keys', 'open', 'entries'])('contains rejected %s promises', async (method) => {
    sw.controller = controller;
    ({ getRegistration: sw.getRegistration, keys, open, entries })[method]!.mockRejectedValue(new Error('Access denied'));
    await expect(store.recheck()).resolves.toBeUndefined();
    expect(store.getSnapshot()).toEqual({ kind: 'unavailable', reason: 'could not verify', detail: 'Access denied' });
  });

  it.each(['serviceWorker', 'caches'])('contains throwing %s getters', async (property) => {
    sw.controller = controller;
    if (property === 'serviceWorker') {
      vi.stubGlobal('navigator', { get serviceWorker() { throw new Error('Blocked'); } });
      expect(start).not.toThrow();
    } else {
      vi.spyOn(globalThis, 'caches', 'get').mockImplementation(() => { throw new Error('Blocked'); });
      await expect(store.recheck()).resolves.toBeUndefined();
    }
    expect(store.getSnapshot()).toMatchObject({ kind: 'unavailable', reason: 'could not verify' });
  });

  it('contains synchronous registration failures without throwing at startup', () => {
    register.mockImplementation(() => { throw new Error('Registration blocked'); });
    expect(start).not.toThrow();
    expect(store.getSnapshot()).toMatchObject({ kind: 'unavailable', detail: 'Registration blocked' });
  });

  it('does not let a pending probe overwrite the offline-ready callback', async () => {
    sw.controller = controller;
    let finish!: (value: string[]) => void;
    keys.mockReturnValue(new Promise<string[]>((resolve) => { finish = resolve; }));
    start();
    await settle();
    options.onOfflineReady?.();
    finish([]);
    await settle();
    expect(store.getSnapshot().kind).toBe('ready');
  });

  it('does not publish a stale successful check after a newer failure', async () => {
    sw.controller = controller;
    let finish!: (value: string[]) => void;
    keys.mockReturnValueOnce(new Promise<string[]>((resolve) => { finish = resolve; }));
    const old = store.recheck();
    await settle();
    keys.mockResolvedValue([]);
    await store.recheck();
    finish([precacheCacheName(scope)]);
    await old;
    expect(store.getSnapshot()).toMatchObject({ kind: 'unavailable', reason: 'download missing' });
  });
});
