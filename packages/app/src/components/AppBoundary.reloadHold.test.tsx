// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); });

it.each([false, true])('V211-11 first-render crash replaces the startup hold, held design=%s', async held => {
  vi.resetModules();
  const session = await import('../services/session.js');
  vi.spyOn(session, 'heldSession').mockImplementation(() => held ? {} as NonNullable<ReturnType<typeof session.heldSession>> : null);
  const { AppBoundary } = await import('./AppBoundary.js');
  const update = await import('../services/swUpdate.js');
  expect(update.isReloadHeld()).toBe(true);
  const active = {} as ServiceWorker;
  const container = Object.assign(new EventTarget(), { controller: active });
  const reload = vi.fn();
  const stop = update.swUpdate.start(Object.assign(new EventTarget(), { active }) as unknown as ServiceWorkerRegistration, {
    container: container as unknown as ServiceWorkerContainer, initialController: active,
    reload, now: () => 0, isUntouched: () => false, otherTabsOpen: async () => false,
  });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const Boom = () => { throw new Error('first render'); };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await act(async () => root.render(<AppBoundary><Boom /></AppBoundary>));
    expect(update.isReloadHeld()).toBe(held);
    container.controller = {} as ServiceWorker;
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(held ? 0 : 1);
  } finally { await act(async () => root.unmount()); host.remove(); stop(); }
});
