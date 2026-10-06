// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { registerSW } from 'virtual:pwa-register';
import { guardPrecache } from './services/precacheGuard.js';
import { setSwRegistration } from './services/versionCheck.js';

vi.mock('virtual:pwa-register', () => ({ registerSW: vi.fn(() => async () => {}) }));
vi.mock('react-dom/client', () => ({ createRoot: vi.fn(() => ({ render: vi.fn() })) }));
vi.mock('./root.js', () => ({ AppRoot: () => null }));
vi.mock('./services/versionCheck.js', () => ({ setSwRegistration: vi.fn() }));
vi.mock('./services/precacheGuard.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./services/precacheGuard.js')>(),
  guardPrecache: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

it('wires entry-point registration callbacks to the real offline status singleton and preserves registration hooks', async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('location', { hostname: 'mmrsim.mountainmanrockets.com' });
  // An uncontrolled first install cannot gain readiness from a cache probe.
  vi.stubGlobal('navigator', { serviceWorker: Object.assign(new EventTarget(), { controller: null }) });
  vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
  // Import the same unmocked module used by App's useOfflineStatus hook.
  const { offlineStatus } = await import('./services/offlineStatus.js');
  expect(offlineStatus.getSnapshot()).toEqual({ kind: 'unknown' });

  await import('./main.js');

  expect(registerSW).toHaveBeenCalledTimes(1);
  const options = vi.mocked(registerSW).mock.calls[0]![0]!;
  expect(options.immediate).toBe(true);
  expect(options.onNeedReload).toBeUndefined();
  expect(offlineStatus.getSnapshot()).toEqual({ kind: 'unknown' });

  const registration = { scope: 'https://mmrsim.mountainmanrockets.com/' } as ServiceWorkerRegistration;
  options.onRegisteredSW?.('./sw.js', registration);
  expect(setSwRegistration).toHaveBeenCalledExactlyOnceWith(registration);
  expect(guardPrecache).toHaveBeenCalledExactlyOnceWith(registration);

  options.onOfflineReady?.();
  expect(offlineStatus.getSnapshot()).toMatchObject({ kind: 'ready' });

  options.onRegisterError?.(new Error('Registration blocked'));
  expect(offlineStatus.getSnapshot()).toEqual({
    kind: 'unavailable', reason: 'registration failed', detail: 'Registration blocked',
  });

  options.onOfflineReady?.();
  expect(offlineStatus.getSnapshot()).toMatchObject({ kind: 'ready' });
});
