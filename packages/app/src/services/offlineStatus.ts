import { useSyncExternalStore } from 'react';
import type { registerSW } from 'virtual:pwa-register';
import { precacheCacheName } from './precacheGuard.js';

type Register = typeof registerSW;
type Registered = NonNullable<NonNullable<Parameters<Register>[0]>['onRegisteredSW']>;
export type OfflineStatus =
  | { kind: 'unknown' }
  | { kind: 'ready'; detail: string }
  | { kind: 'unavailable'; reason: string; detail: string };

export function offlineStatusText(status: OfflineStatus): string {
  if (status.kind === 'unknown') return '';
  if (status.kind === 'ready') return 'Offline copy ready';
  return status.reason === 'unsupported'
    ? 'Offline copy not available in this browser'
    : `Offline copy not available — ${status.reason}`;
}

function errorText(error: unknown): string {
  try { return error instanceof Error ? error.message : String(error); }
  catch { return 'Unknown browser error'; }
}

/** No stored flag: readiness belongs to this browser/container and this load. */
export function createOfflineStatusStore() {
  let state: OfflineStatus = { kind: 'unknown' };
  const listeners = new Set<() => void>();
  let generation = 0;
  let registrationError = '';
  const publish = (next: OfflineStatus) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const unavailable = (reason: string, detail: string): OfflineStatus => ({ kind: 'unavailable', reason, detail });

  // registerSW has no general "controlling" callback. Its onNeedReload is an
  // update-only reload override; leave that alone and use controllerchange.
  async function recheck(): Promise<void> {
    const ticket = ++generation;
    let next: OfflineStatus;
    try {
      const sw = navigator.serviceWorker;
      if (!sw) {
        next = unavailable('unsupported', 'Service workers are unavailable in this browser context.');
      } else {
        const controller = sw.controller;
        const reg = controller ? await sw.getRegistration() : undefined;
        if (!controller || !reg || reg.active?.scriptURL !== controller.scriptURL) {
          next = registrationError
            ? unavailable('registration failed', registrationError)
            : { kind: 'unknown' };
        } else {
          const storage = globalThis.caches;
          if (!storage) throw new Error('Cache Storage is unavailable.');
          // Workbox 7's default is workbox-precache-v2-<registration.scope>.
          // Never accept a different app's cache, and never create a missing one.
          const name = precacheCacheName(reg.scope);
          const present = (await storage.keys()).includes(name);
          const entries = present ? (await (await storage.open(name)).keys()).length : 0;
          // Do not publish evidence from a worker that lost control while awaiting storage.
          if (sw.controller !== controller) return;
          next = entries > 0
            ? { kind: 'ready', detail: `Service worker ${controller.state}; ${entries} precache entries in ${name}.`
              + (registrationError ? ` Registration check failed: ${registrationError}` : '') }
            : unavailable('download missing', `Service worker ${controller.state}; precache ${present ? 'empty' : 'missing'}. Reopen with a connection.`);
        }
      }
    } catch (error) {
      next = unavailable('could not verify', errorText(error));
    }
    // An install callback or a newer probe is stronger than an older async result.
    if (ticket === generation) publish(next);
  }

  function start(register: Register, onRegisteredSW: Registered): () => void {
    let sw: ServiceWorkerContainer | undefined;
    const check = () => { void recheck(); };
    try {
      sw = navigator.serviceWorker;
      if (!sw) {
        publish(unavailable('unsupported', 'Service workers are unavailable in this browser context.'));
        return () => {};
      }
      sw.addEventListener('controllerchange', check);
      check();
      register({
        immediate: true,
        onOfflineReady: () => {
          ++generation;
          registrationError = '';
          publish({ kind: 'ready', detail: 'The service worker reported that the offline download finished. Rehearse in airplane mode before field use.' });
        },
        onRegisterError: (error: unknown) => {
          ++generation;
          registrationError = errorText(error);
          // A failed update check need not destroy an existing offline copy.
          publish(unavailable('registration failed', registrationError));
          check();
        },
        onRegisteredSW: (url, reg) => {
          check();
          onRegisteredSW(url, reg);
        },
      });
    } catch (error) {
      ++generation;
      publish(unavailable('could not verify', errorText(error)));
    }
    return () => {
      ++generation;
      try { sw?.removeEventListener('controllerchange', check); } catch { /* browser denied access */ }
    };
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start,
    recheck,
  };
}

export const offlineStatus = createOfflineStatusStore();
export function useOfflineStatus(): OfflineStatus {
  return useSyncExternalStore(offlineStatus.subscribe, offlineStatus.getSnapshot);
}
