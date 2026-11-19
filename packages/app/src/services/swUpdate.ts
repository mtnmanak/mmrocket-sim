import { useSyncExternalStore } from 'react';
import { pageActivity } from './pageActivity.js';

export type SwUpdateState = {
  kind: 'idle' | 'downloading' | 'ready' | 'failed'; applying: boolean;
  readyVersion?: string; reloadRequired?: boolean;
};
export interface SwUpdateDeps {
  container: ServiceWorkerContainer;
  initialController: ServiceWorker | null;
  reload: () => void;
  now: () => number;
  otherTabsOpen: () => Promise<boolean>;
  isUntouched: () => boolean;
  workerVersion?: (worker: ServiceWorker) => Promise<string | null>;
}

/** Ask the waiting worker for its baked-in build version. */
export function waitingWorkerVersion(worker: ServiceWorker): Promise<string | null> {
  return new Promise(resolve => {
    let channel: MessageChannel | undefined;
    const finish = (version: string | null) => {
      clearTimeout(timer);
      channel?.port1.close();
      channel?.port2.close();
      resolve(version);
    };
    const timer = setTimeout(() => finish(null), 1000);
    try {
      channel = new MessageChannel();
      channel.port1.onmessage = (event: MessageEvent<{ version?: unknown }>) => {
        const version = event.data?.version;
        finish(typeof version === 'string' && /^\d+(\.\d+)+$/.test(version) ? version : null);
      };
      channel.port1.onmessageerror = () => finish(null);
      worker.postMessage({ type: 'MMR_VERSION' }, [channel.port2]);
    } catch { finish(null); }
  });
}

/** The worker sees frozen and busy windows that cannot answer a page ping. */
export function otherTabsOpen(reg: ServiceWorkerRegistration): Promise<boolean> {
  return new Promise(resolve => {
    if (!reg.active) { resolve(true); return; }
    let channel: MessageChannel | undefined;
    const finish = (others: boolean) => {
      clearTimeout(timer);
      channel?.port1.close();
      channel?.port2.close();
      resolve(others);
    };
    const timer = setTimeout(() => finish(true), 1000);
    try {
      channel = new MessageChannel();
      channel.port1.onmessage = (event: MessageEvent<{ windows?: unknown }>) => {
        const count = event.data?.windows;
        finish(typeof count !== 'number' || !Number.isFinite(count) || count < 1 || count > 1);
      };
      channel.port1.onmessageerror = () => finish(true);
      reg.active.postMessage({ type: 'MMR_COUNT_WINDOWS' }, [channel.port2]);
    } catch { finish(true); }
  });
}

export const AUTO_APPLY_WINDOW_MS = 5 * 60_000;

export function createSwUpdateStore() {
  let state: SwUpdateState = { kind: 'idle', applying: false };
  const listeners = new Set<() => void>();
  let apply = () => { publish('failed'); return Promise.resolve(); };
  let controllerChanged = () => {};
  let recheckAutoApply = () => {};
  let recheckHeldReload = () => {};
  let pendingReload: ((requested: boolean) => Promise<unknown>) | undefined;
  let repairing = false;
  let stop = () => {};
  const publish = (kind: SwUpdateState['kind'], applying = false, readyVersion?: string, reloadRequired = false) => {
    if (pendingReload || repairing) {
      kind = 'ready';
      applying = repairing;
      reloadRequired = true;
    }
    if (state.kind === kind && state.applying === applying && state.readyVersion === readyVersion
      && state.reloadRequired === reloadRequired) return;
    state = { kind, applying, readyVersion, reloadRequired };
    listeners.forEach((listener) => listener());
  };
  const resumeReload = async (requested: boolean) => {
    if (!pendingReload || repairing) return;
    const repair = pendingReload;
    repairing = true;
    publish('ready');
    try { await repair(requested); }
    // A failed repair or cancelled beforeunload leaves this document alive.
    // Keep the same repair (including its unregister state) for the next click.
    finally { repairing = false; publish('ready'); }
  };

  function start(reg: ServiceWorkerRegistration, deps: SwUpdateDeps): () => void {
    stop();
    const registeredAt = deps.now();
    const activeAtStart = reg.active;
    const workers = new Map<ServiceWorker, { atLoad: boolean; waited: boolean }>();
    let stopped = false;
    let reloaded = false;
    let applying = false;
    let reloadRequested = false;
    let readyWorker: ServiceWorker | undefined;
    let readyVersion: string | undefined;
    let controllerSwitched = !!deps.initialController && deps.container.controller !== deps.initialController;
    const publishUpdate = (kind: SwUpdateState['kind'], busy = applying, version = readyVersion) => {
      publish(kind, busy, version, controllerSwitched);
    };
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let recovery: ReturnType<typeof setTimeout> | undefined;
    const reloadOnce = () => {
      if (stopped || reloaded) return;
      if (!reloadRequested && isReloadHeld()) {
        applying = false;
        clearTimeout(fallback);
        publishUpdate('ready');
        return;
      }
      reloaded = true;
      applying = true;
      clearTimeout(fallback);
      publishUpdate(state.kind);
      deps.reload();
      // A cancelled beforeunload leaves this document and its timers alive.
      recovery = setTimeout(() => {
        reloaded = false;
        applying = false;
        reloadRequested = false;
        publishUpdate(reg.waiting || controllerSwitched ? 'ready' : state.kind);
      }, 1000);
    };
    recheckHeldReload = () => {
      if (controllerSwitched && !applying) reloadOnce();
    };
    // Reload when the controller is switched, including an uncontrolled hard
    // reload with an older active worker; a true first claim stays on the page.
    // Tracked per change, not only at load: a page that began as a first
    // visit is controlled after its first claim, and a later update must
    // still reload it.
    let controlled = !!deps.container.controller;
    const onControllerChange = () => {
      const wasControlled = controlled;
      controlled = !!deps.container.controller;
      if (wasControlled || applying || (activeAtStart && deps.container.controller && deps.container.controller !== activeAtStart)) {
        controllerSwitched = true;
        reloadOnce();
      }
    };
    controllerChanged = onControllerChange;

    const applyWaiting = (requested = false) => {
      if (!reg.waiting || applying || stopped) return;
      reloadRequested = requested;
      applying = true;
      publishUpdate('ready');
      fallback = setTimeout(reloadOnce, 5000);
      try { reg.waiting.postMessage({ type: 'SKIP_WAITING' }); }
      catch { /* The fallback still reloads if the worker disappeared. */ }
    };
    // "A fresh open": a page applies an update by itself only within this long
    // of loading — enough for a slow download (~6 MB at ~0.2 Mbit/s), and never
    // hours later in a tab left open, when another tab closes and it is alone.
    const fresh = () => deps.now() - registeredAt <= AUTO_APPLY_WINDOW_MS;
    const autoApply = async (worker: ServiceWorker) => {
      if (!workers.get(worker)?.atLoad || !fresh() || !deps.isUntouched() || isReloadHeld()) return;
      try {
        const others = await deps.otherTabsOpen();
        // Recheck after the worker answers: work may have started meanwhile.
        if (!stopped && reg.waiting === worker && !others && fresh() && deps.isUntouched() && !isReloadHeld()) applyWaiting();
      } catch { /* Uncertain tab presence leaves the prompt visible. */ }
    };
    // App may mount after an existing waiting worker was inspected. One attempt
    // per predicate registration, with the same load/untouched/presence guards.
    recheckAutoApply = () => {
      const worker = reg.waiting;
      if (!stopped && worker && workers.get(worker)?.waited) void autoApply(worker);
    };
    const inspect = (worker: ServiceWorker) => {
      // An UPDATE is a new worker while an older one is active. A first
      // install (no active worker yet) is not an update and shows nothing.
      const older = reg.active ?? deps.container.controller;
      if (stopped || applying || !older || reg.active === worker || deps.container.controller === worker) return;
      const tracked = workers.get(worker)!;
      if (reg.waiting === worker) {
        if (!tracked.waited) {
          tracked.waited = true;
          readyWorker = worker;
          readyVersion = undefined;
          publishUpdate('ready');
          void (deps.workerVersion ?? waitingWorkerVersion)(worker).then(version => {
            if (stopped || readyWorker !== worker || reg.waiting !== worker) return;
            readyVersion = version ?? undefined;
            publishUpdate('ready');
          }).catch(() => { /* Unknown version keeps the generic ready label. */ });
          void autoApply(worker);
        }
      } else if (reg.waiting) {
        // A newer worker may be installing while another is already ready.
        watch(reg.waiting, false);
      } else if (worker.state === 'installing') publishUpdate('downloading');
      else if (worker.state === 'redundant' && !tracked.waited) publishUpdate('failed');
    };
    const watch = (worker: ServiceWorker, atLoad: boolean) => {
      if (workers.has(worker)) return;
      workers.set(worker, { atLoad, waited: false });
      worker.addEventListener('statechange', onStateChange);
      inspect(worker);
    };
    function onStateChange(event: Event) { inspect(event.target as ServiceWorker); }
    const updateFound = () => {
      if (reg.installing) watch(reg.installing, deps.now() - registeredAt <= 60_000);
    };
    deps.container.addEventListener('controllerchange', onControllerChange);
    reg.addEventListener('updatefound', updateFound);
    publishUpdate('idle');
    if (reg.waiting) watch(reg.waiting, true);
    if (reg.installing) watch(reg.installing, true);

    apply = async () => {
      if (applying || stopped) return;
      if (controllerSwitched) { reloadRequested = true; reloadOnce(); return; }
      if (reg.waiting) { applyWaiting(true); return; }
      try { await reg.update(); } catch { /* Keep the current session on failure. */ }
      if (stopped) return;
      if (reg.waiting) applyWaiting(true);
      else if (reg.installing) { watch(reg.installing, false); inspect(reg.installing); }
      else if (!deps.container.controller || controllerSwitched) { reloadRequested = true; reloadOnce(); }
      else publishUpdate('failed');
    };
    stop = () => {
      stopped = true;
      pendingReload = undefined;
      repairing = false;
      clearTimeout(fallback);
      clearTimeout(recovery);
      deps.container.removeEventListener('controllerchange', onControllerChange);
      reg.removeEventListener('updatefound', updateFound);
      workers.forEach((_value, worker) => worker.removeEventListener('statechange', onStateChange));
    };
    if (controllerSwitched) reloadOnce();
    return stop;
  }
  return {
    start,
    applyUpdate: () => pendingReload ? resumeReload(true) : apply(),
    deferReload: (repair: (requested: boolean) => Promise<unknown>) => {
      pendingReload = repair;
      publish('ready', false, undefined, true);
    },
    reloadOnControllerChange: () => controllerChanged(),
    recheckAutoApply: () => recheckAutoApply(),
    recheckHeldReload: () => {
      if (pendingReload) return isReloadHeld() ? Promise.resolve() : resumeReload(false);
      recheckHeldReload();
      return Promise.resolve();
    },
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export const swUpdate = createSwUpdateStore();
// Before App knows what was restored, keep the page. On a crash/unmount,
// retain its last answer unless App supplies a live crash-panel check.
let reloadHold = () => true;
export const isReloadHeld = () => reloadHold();
export function setReloadHold(check: () => boolean, afterUnmount?: () => boolean): () => void {
  reloadHold = check;
  void swUpdate.recheckHeldReload();
  return () => {
    if (reloadHold === check) {
      const held = check();
      reloadHold = afterUnmount ?? (() => held);
    }
  };
}
/** App calls once after the mount-time saved-mark seed/migrations have rendered. */
export async function settleReloadHold(): Promise<void> {
  await swUpdate.recheckHeldReload();
  swUpdate.recheckAutoApply();
}
let untouched = () => false;
export function setIsUntouched(check: () => boolean): () => void {
  untouched = check;
  swUpdate.recheckAutoApply();
  return () => { if (untouched === check) untouched = () => false; };
}
export const isPageUntouched = () => pageActivity.isUntouched() && untouched();
export const startSwUpdate = swUpdate.start;
export const applyUpdate = swUpdate.applyUpdate;
export function useSwUpdate(): SwUpdateState {
  return useSyncExternalStore(swUpdate.subscribe, swUpdate.getSnapshot);
}
