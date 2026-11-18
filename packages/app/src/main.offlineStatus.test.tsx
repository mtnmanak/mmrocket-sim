// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { registerSW } from 'virtual:pwa-register';
import { createRoot } from 'react-dom/client';
import { guardPrecache } from './services/precacheGuard.js';
import { setSwRegistration } from './services/versionCheck.js';
import { startSwUpdate } from './services/swUpdate.js';

vi.mock('virtual:pwa-register', () => ({ registerSW: vi.fn(() => async () => {}) }));
vi.mock('react-dom/client', () => ({ createRoot: vi.fn(() => ({ render: vi.fn() })) }));
vi.mock('./root.js', () => ({ AppRoot: () => null }));
vi.mock('./services/versionCheck.js', () => ({ setSwRegistration: vi.fn() }));
vi.mock('./services/swUpdate.js', async original => ({
  ...await original<typeof import('./services/swUpdate.js')>(), startSwUpdate: vi.fn(() => () => {}),
}));
vi.mock('./services/precacheGuard.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./services/precacheGuard.js')>(),
  guardPrecache: vi.fn().mockResolvedValue(undefined),
}));

const fetchSpy = vi.fn(async () => new Response('{}'));
const catalogueRequests = () => fetchSpy.mock.calls.map(c => String((c as unknown[])[0])).filter(u => u.startsWith('https://catalogue.mountainmanrockets.com/'));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

it.each(['serviceWorker getter', 'controller getter', 'lookup', 'activity listener'])(
  'renders with update tracking disabled when the startup %s throws', async failure => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchSpy);
    const denied = () => { throw new DOMException('Site storage blocked', 'SecurityError'); };
    const serviceWorker = Object.assign(new EventTarget(), { controller: null, getRegistration: vi.fn().mockResolvedValue(undefined) });
    const nav = { serviceWorker };
    if (failure === 'serviceWorker getter') Object.defineProperty(nav, 'serviceWorker', { get: denied });
    if (failure === 'controller getter') Object.defineProperty(serviceWorker, 'controller', { get: denied });
    if (failure === 'lookup') serviceWorker.getRegistration.mockImplementation(denied);
    if (failure === 'activity listener') {
      const { pageActivity: activity } = await import('./services/pageActivity.js');
      vi.spyOn(activity, 'listen').mockImplementation(denied);
    }
    vi.stubGlobal('navigator', nav);
    document.body.innerHTML = '<div id="root"></div>';
    await expect(import('./main.js')).resolves.toBeDefined();
    expect(createRoot).toHaveBeenCalledExactlyOnceWith(document.getElementById('root'));
    const root = vi.mocked(createRoot).mock.results[0]!.value;
    expect(root.render).toHaveBeenCalledOnce();
    const options = vi.mocked(registerSW).mock.calls[0]?.[0];
    expect(registerSW).toHaveBeenCalledTimes(failure === 'serviceWorker getter' ? 0 : 1);
    options?.onRegisteredSW?.('./sw.js', new EventTarget() as ServiceWorkerRegistration);
    expect(startSwUpdate).not.toHaveBeenCalled();
  });

it('wires entry-point registration callbacks to the real offline status singleton and preserves registration hooks', async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal('location', { hostname: 'mmrsim.mountainmanrockets.com' });
  // An uncontrolled first install cannot gain readiness from a cache probe.
  vi.stubGlobal('navigator', { serviceWorker: Object.assign(new EventTarget(), { controller: null }) });
  const listen = vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
  // Import the same unmocked module used by App's useOfflineStatus hook.
  const { offlineStatus } = await import('./services/offlineStatus.js');
  expect(offlineStatus.getSnapshot()).toEqual({ kind: 'unknown' });

  await import('./main.js');

  for (const event of ['pointerdown', 'keydown', 'drop', 'paste']) {
    expect(listen).toHaveBeenCalledWith(event, expect.any(Function), true);
  }

  expect(registerSW).toHaveBeenCalledTimes(1);
  const options = vi.mocked(registerSW).mock.calls[0]![0]!;
  expect(options.immediate).toBe(true);
  expect(options.onNeedReload).toEqual(expect.any(Function));
  expect(options.onNeedRefresh).toEqual(expect.any(Function));
  expect(offlineStatus.getSnapshot()).toEqual({ kind: 'unknown' });

  const registration = Object.assign(new EventTarget(), {
    scope: 'https://mmrsim.mountainmanrockets.com/', installing: null, waiting: null,
  }) as ServiceWorkerRegistration;
  options.onRegisteredSW?.('./sw.js', registration);
  expect(setSwRegistration).toHaveBeenCalledExactlyOnceWith(registration);
  expect(guardPrecache).toHaveBeenCalledExactlyOnceWith(registration);

  options.onOfflineReady?.();
  expect(offlineStatus.getSnapshot()).toMatchObject({ kind: 'ready' });

  options.onRegisterError?.(new Error('Registration blocked'));
  const { sessionDebugLog } = await import('./services/sessionDebugLog.js');
  navigator.serviceWorker.dispatchEvent(new Event('messageerror'));
  expect(sessionDebugLog.text()).toContain('worker-message-error');
  expect(sessionDebugLog.text()).toContain('worker-error: Error: Message omitted for privacy');
  expect(offlineStatus.getSnapshot()).toEqual({
    kind: 'unavailable', reason: 'registration failed', detail: 'Registration blocked',
  });

  options.onOfflineReady?.();
  expect(offlineStatus.getSnapshot()).toMatchObject({ kind: 'ready' });
  // No App mounted, so no restore and no catalogue request (main.catalogueCheck.test.tsx has the positive case).
  expect(catalogueRequests()).toEqual([]);
});

it.each(['existing', 'first visit', 'callback first', 'late different lookup', 'lookup rejected', 'replacement'])(
  'starts tracking once per registration with %s', async order => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchSpy);
    const reg = Object.assign(new EventTarget(), { installing: {}, waiting: null });
    let answer!: (reg: unknown) => void;
    const late = order === 'callback first' || order === 'late different lookup';
    const getRegistration = vi.fn(() => late
      ? new Promise(resolve => { answer = resolve; })
      : order === 'lookup rejected' ? Promise.reject(new Error('lookup failed'))
      : Promise.resolve(order === 'first visit' ? undefined : reg));
    vi.stubGlobal('navigator', { serviceWorker: Object.assign(new EventTarget(), { controller: null, getRegistration }) });
    await import('./main.js');
    await Promise.resolve();
    expect(getRegistration).toHaveBeenCalledOnce();
    const early = order === 'existing' || order === 'replacement';
    expect(startSwUpdate).toHaveBeenCalledTimes(early ? 1 : 0);
    expect(setSwRegistration).toHaveBeenCalledTimes(early ? 1 : 0);
    if (early) expect(setSwRegistration).toHaveBeenCalledWith(reg);
    const registered = (order === 'replacement' ? new EventTarget() : reg) as ServiceWorkerRegistration;
    const options = vi.mocked(registerSW).mock.calls[0]![0]!;
    options.onRegisteredSW?.('./sw.js', registered);
    if (late) { answer(order === 'late different lookup' ? new EventTarget() : reg); await Promise.resolve(); }
    expect(startSwUpdate).toHaveBeenCalledTimes(order === 'replacement' ? 2 : 1);
    expect(startSwUpdate).toHaveBeenLastCalledWith(registered, expect.any(Object));
    expect(setSwRegistration).toHaveBeenLastCalledWith(registered);
    expect(guardPrecache).toHaveBeenCalledExactlyOnceWith(registered);
  });
