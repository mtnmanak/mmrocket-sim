// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_APPLY_WINDOW_MS, createSwUpdateStore, isPageUntouched, setIsUntouched, otherTabsOpen, waitingWorkerVersion, swUpdate, isReloadHeld, setReloadHold } from './swUpdate.js';

class Worker extends EventTarget {
  state: ServiceWorkerState = 'installing';
  postMessage = vi.fn();
  change(state: ServiceWorkerState) { this.state = state; this.dispatchEvent(new Event('statechange')); }
}
function setup(options: {
  first?: boolean; waiting?: boolean; installing?: boolean; untouched?: boolean; others?: boolean;
  activeNull?: boolean; initialController?: ServiceWorker | null; claimedBeforeStart?: boolean;
  uncontrolled?: boolean; pagePredicate?: boolean;
  workerVersion?: () => Promise<string | null>;
} = {}) {
  const worker = new Worker();
  if (options.waiting) worker.state = 'installed';
  const reg = Object.assign(new EventTarget(), {
    installing: options.installing ? worker : null,
    waiting: options.waiting ? worker : null,
    active: options.first || options.activeNull ? null : new Worker(),
    update: vi.fn().mockResolvedValue(undefined),
  });
  const container = Object.assign(new EventTarget(), { controller: options.uncontrolled || (options.first && !options.claimedBeforeStart) ? null : new Worker() });
  const reload = vi.fn();
  const isUntouched = vi.fn(() => options.untouched ?? false);
  const otherTabsOpen = vi.fn(async () => options.others ?? false);
  let now = 0;
  const store = options.pagePredicate ? swUpdate : createSwUpdateStore();
  const stop = store.start(reg as unknown as ServiceWorkerRegistration, {
    container: container as unknown as ServiceWorkerContainer,
    initialController: ('initialController' in options ? options.initialController! : container.controller) as ServiceWorker | null,
    workerVersion: options.workerVersion ?? vi.fn().mockResolvedValue(null),
    reload, now: () => now, isUntouched: options.pagePredicate ? isPageUntouched : isUntouched, otherTabsOpen,
  });
  cleanups.push(stop);
  const found = (time = 0) => {
    now = time;
    reg.installing = worker;
    reg.dispatchEvent(new Event('updatefound'));
  };
  const ready = () => { reg.installing = null; reg.waiting = worker; worker.change('installed'); };
  const changeController = () => container.dispatchEvent(new Event('controllerchange'));
  const setNow = (time: number) => { now = time; };
  return { worker, reg, container, reload, store, stop, found, ready, changeController, isUntouched, otherTabsOpen, setNow };
}
const cleanups: (() => void)[] = [];
it.each(['idle', 'waiting', 'requested'])('r2 retires a terminal repair into the actual %s state', async mode => {
  const s = setup({ waiting: mode === 'waiting', workerVersion: async () => '0.999' });
  if (mode === 'waiting') await vi.waitFor(() => expect(s.store.getSnapshot().readyVersion).toBe('0.999'));
  s.store.deferReload(async () => 'continue');
  if (mode === 'requested') await s.store.applyUpdate();
  else await s.store.recheckHeldReload();
  expect(s.store.getSnapshot()).toMatchObject({
    kind: mode === 'waiting' ? 'ready' : 'idle', reloadRequired: false,
  });
  if (mode === 'waiting') expect(s.store.getSnapshot().readyVersion).toBe('0.999');
  expect(s.reload).toHaveBeenCalledTimes(mode === 'requested' ? 1 : 0);
});
beforeEach(() => { setReloadHold(() => false); });
afterEach(() => { cleanups.splice(0).forEach(stop => stop()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('149 B: hold unattended reloads with the production predicate', () => {
  it('V211-15 a stale disposer leaves the newer live predicate installed', () => {
    const stale = setReloadHold(() => false);
    let held = true;
    const current = setReloadHold(() => held);
    stale();
    expect(isReloadHeld()).toBe(true);
    held = false;
    expect(isReloadHeld()).toBe(false);
    current();
  });
  it('V211-15 sibling: a stale untouched disposer leaves the newer predicate live', () => {
    const stale = setIsUntouched(() => false);
    let untouched = true;
    const current = setIsUntouched(() => untouched);
    stale();
    expect(isPageUntouched()).toBe(true);
    untouched = false;
    expect(isPageUntouched()).toBe(false);
    current();
  });
  it.each(['after start', 'before tracking'])('round 2 defaults to held before ANY registration: %s', async mode => {
    vi.resetModules();
    const fresh = await import('./swUpdate.js');
    expect(fresh.isReloadHeld()).toBe(true);
    const old = new Worker();
    const container = Object.assign(new EventTarget(), { controller: old });
    const reload = vi.fn();
    if (mode === 'before tracking') container.controller = new Worker();
    const stop = fresh.swUpdate.start(Object.assign(new EventTarget(), { active: old }) as unknown as ServiceWorkerRegistration, {
      container: container as unknown as ServiceWorkerContainer, initialController: old as unknown as ServiceWorker,
      reload, now: () => 0, isUntouched: () => true, otherTabsOpen: async () => false,
    });
    cleanups.push(stop);
    if (mode === 'after start') container.dispatchEvent(new Event('controllerchange'));
    expect(reload).not.toHaveBeenCalled();
    expect(fresh.swUpdate.getSnapshot()).toMatchObject({ kind: 'ready', reloadRequired: true });
  });
  it.each(['controllerchange', 'callback', 'before tracking'])(
    'keeps unsaved work on %s and offers an explicit reload', async mode => {
      setReloadHold(() => true);
      const s = setup(mode === 'before tracking' ? { initialController: new Worker() as unknown as ServiceWorker } : {});
      if (mode === 'controllerchange') s.changeController();
      if (mode === 'callback') s.store.reloadOnControllerChange();
      expect(s.reload).not.toHaveBeenCalled();
      expect(s.store.getSnapshot()).toMatchObject({ kind: 'ready', applying: false, reloadRequired: true });
      await s.store.applyUpdate();
      expect(s.reload).toHaveBeenCalledOnce();
    });
  it('holds the 5 s auto-apply fallback if edits started after activation was requested', async () => {
    vi.useFakeTimers();
    const s = setup({ waiting: true, untouched: true });
    await Promise.resolve();
    expect(s.worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    setReloadHold(() => true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.reload).not.toHaveBeenCalled();
    expect(s.store.getSnapshot()).toMatchObject({ kind: 'ready', applying: false, reloadRequired: false });
    await s.store.applyUpdate();
    expect(s.worker.postMessage).toHaveBeenCalledTimes(2);
    s.changeController();
    expect(s.reload).toHaveBeenCalledOnce();
  });
  it.each(['controllerchange', 'fallback'])('honours this held tab own Reload through %s', async mode => {
    vi.useFakeTimers();
    setReloadHold(() => true);
    const s = setup({ waiting: true });
    await s.store.applyUpdate();
    if (mode === 'controllerchange') s.changeController();
    else await vi.advanceTimersByTimeAsync(5000);
    expect(s.reload).toHaveBeenCalledOnce();
  });
  it('does not let a failed earlier click authorize a later unattended reload', async () => {
    const s = setup();
    await s.store.applyUpdate();
    setReloadHold(() => true);
    s.changeController();
    expect(s.reload).not.toHaveBeenCalled();
    expect(s.store.getSnapshot()).toMatchObject({ kind: 'ready', reloadRequired: true });
  });
  it('round 3 clears local reload authorization after cancelled beforeunload', async () => {
    vi.useFakeTimers();
    setReloadHold(() => true);
    const s = setup({ waiting: true });
    await s.store.applyUpdate();
    s.changeController();
    expect(s.reload).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    s.changeController();
    expect(s.reload).toHaveBeenCalledOnce();
    expect(s.store.getSnapshot()).toMatchObject({ kind: 'ready', applying: false, reloadRequired: true });
  });
  it.each(['waiting', 'uncontrolled'])('round 3 authorizes a held local Reload after update: %s', async mode => {
    setReloadHold(() => true);
    const s = setup();
    s.reg.update.mockImplementation(async () => {
      if (mode === 'waiting') s.reg.waiting = s.worker;
      else s.container.controller = null;
    });
    await s.store.applyUpdate();
    if (mode === 'waiting') {
      expect(s.worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
      s.changeController();
    }
    expect(s.reload).toHaveBeenCalledOnce();
  });
  it('rechecks a takeover held before App registered a clean predicate', () => {
    setReloadHold(() => true);
    const s = setup({ pagePredicate: true, initialController: new Worker() as unknown as ServiceWorker });
    expect(s.reload).not.toHaveBeenCalled();
    setReloadHold(() => false);
    expect(s.reload).toHaveBeenCalledOnce();
  });
  it.each([true, false])('retains the last hold value on unmount: %s', held => {
    let value = !held;
    const remove = setReloadHold(() => value);
    value = held;
    remove();
    value = !held;
    expect(isReloadHeld()).toBe(held);
  });
});

describe('native update lifecycle', () => {
  it('observes a worker already installing on registration (reload during download)', () => {
    const s = setup({ installing: true });
    expect(s.store.getSnapshot().kind).toBe('downloading');
    s.ready();
    expect(s.store.getSnapshot().kind).toBe('ready');
    expect(s.reload).not.toHaveBeenCalled();
  });
  it('observes updatefound and an already waiting worker', () => {
    const s = setup();
    s.found();
    expect(s.store.getSnapshot().kind).toBe('downloading');
    s.ready();
    expect(s.store.getSnapshot().kind).toBe('ready');
    expect(setup({ waiting: true }).store.getSnapshot().kind).toBe('ready');
  });
  it('reports a failed install, but not redundancy after waiting', () => {
    const s = setup({ installing: true });
    s.worker.change('redundant');
    expect(s.store.getSnapshot().kind).toBe('failed');
    const waited = setup({ waiting: true });
    waited.reg.waiting = null;
    waited.worker.change('redundant');
    expect(waited.store.getSnapshot().kind).toBe('ready');
  });
  it('keeps a waiting worker visible while a newer worker downloads', () => {
    const s = setup({ waiting: true });
    s.reg.installing = new Worker();
    s.reg.dispatchEvent(new Event('updatefound'));
    expect(s.store.getSnapshot().kind).toBe('ready');
  });
  it('first visit stays idle and clientsClaim does not reload it', () => {
    const s = setup({ first: true, installing: true, untouched: true });
    expect(s.store.getSnapshot().kind).toBe('idle');
    s.reg.installing = null;
    s.reg.active = s.worker;
    s.worker.change('activated');
    expect(s.store.getSnapshot().kind).toBe('idle');
    s.container.controller = s.worker;
    s.changeController();
    expect(s.reload).not.toHaveBeenCalled();
  });
  it('a first visit later observes an update and reloads once when its controller switches', () => {
    const s = setup({ first: true, installing: true });
    const firstWorker = s.worker;
    s.reg.installing = null;
    s.reg.active = firstWorker;
    firstWorker.change('activated');
    s.container.controller = firstWorker;
    s.changeController();
    expect(s.reload).not.toHaveBeenCalled();
    const update = new Worker();
    s.reg.installing = update;
    s.reg.dispatchEvent(new Event('updatefound'));
    expect(s.store.getSnapshot().kind).toBe('downloading');
    s.reg.installing = null;
    s.reg.waiting = update;
    update.change('installed');
    expect(s.store.getSnapshot().kind).toBe('ready');
    expect(update.postMessage).not.toHaveBeenCalled();
    s.container.controller = update;
    s.changeController();
    s.changeController();
    expect(s.reload).toHaveBeenCalledTimes(1);
  });
  it('activates on request and reloads once across native, plugin and timeout callbacks', async () => {
    vi.useFakeTimers();
    const s = setup({ waiting: true });
    await s.store.applyUpdate();
    await s.store.applyUpdate();
    expect(s.worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'SKIP_WAITING' });
    expect(s.store.getSnapshot().applying).toBe(true);
    expect(s.reload).not.toHaveBeenCalled();
    s.changeController();
    s.store.reloadOnControllerChange();
    s.changeController();
    await vi.advanceTimersByTimeAsync(999);
    expect(s.reload).toHaveBeenCalledTimes(1);
  });
  it('reloads other controlled tabs when another tab activates', () => {
    const s = setup();
    s.container.controller = new Worker();
    s.changeController();
    s.store.reloadOnControllerChange();
    s.changeController();
    expect(s.worker.postMessage).not.toHaveBeenCalled();
    expect(s.reload).toHaveBeenCalledTimes(1);
  });
  it('reloads an uncontrolled hard-reload tab once when another tab activates an update', () => {
    const s = setup({ uncontrolled: true, waiting: true });
    expect(s.reload).not.toHaveBeenCalled();
    s.reg.active = s.worker;
    s.reg.waiting = null;
    s.container.controller = s.worker;
    s.changeController();
    expect(s.reload).toHaveBeenCalledOnce();
    s.store.reloadOnControllerChange();
    s.changeController();
    expect(s.reload).toHaveBeenCalledOnce();
    expect(s.worker.postMessage).not.toHaveBeenCalled();
  });
  it('does not reload an uncontrolled tab when no controller arrives or its original active worker claims it', () => {
    const s = setup({ uncontrolled: true });
    s.changeController();
    expect(s.reload).not.toHaveBeenCalled();
    s.container.controller = s.reg.active;
    s.changeController();
    expect(s.reload).not.toHaveBeenCalled();
  });
  it('reloads a first visit that explicitly applied an update', async () => {
    const s = setup({ first: true });
    // The first worker activated before claiming this page, then an update arrived.
    s.reg.active = new Worker();
    s.found();
    s.ready();
    await s.store.applyUpdate();
    s.container.controller = s.worker;
    s.changeController();
    expect(s.reload).toHaveBeenCalledTimes(1);
  });
  it('falls back after 5 seconds, including a postMessage failure', async () => {
    vi.useFakeTimers();
    const s = setup({ waiting: true });
    s.worker.postMessage.mockImplementation(() => { throw new Error('gone'); });
    await s.store.applyUpdate();
    await vi.advanceTimersByTimeAsync(4999);
    expect(s.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.reload).toHaveBeenCalledTimes(1);
  });
  it('checks before applying, waits for downloads, and reloads plainly only when no worker exists', async () => {
    const s = setup();
    s.reg.update.mockImplementation(async () => { s.found(61_000); });
    await s.store.applyUpdate();
    expect(s.store.getSnapshot().kind).toBe('downloading');
    expect(s.reload).not.toHaveBeenCalled();
    s.ready();
    await s.store.applyUpdate();
    expect(s.worker.postMessage).toHaveBeenCalledOnce();
    const empty = setup({ first: true });
    await empty.store.applyUpdate();
    await empty.store.applyUpdate();
    expect(empty.reg.update).toHaveBeenCalledTimes(1);
    expect(empty.reload).toHaveBeenCalledOnce();
    const waiting = setup();
    waiting.reg.update.mockImplementation(async () => { waiting.reg.waiting = waiting.worker; });
    await waiting.store.applyUpdate();
    expect(waiting.worker.postMessage).toHaveBeenCalledOnce();
  });
  it('removes listeners and cancels pending fallback/auto-apply on stop', async () => {
    vi.useFakeTimers();
    const s = setup({ waiting: true });
    await s.store.applyUpdate();
    s.stop();
    s.changeController();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.reload).not.toHaveBeenCalled();
  });
});

describe('round 3 lifecycle guards', () => {
  it.each(['downloading', 'failed', 'ready'] as const)(
    'retains reloadRequired after a cancelled takeover followed by %s', async kind => {
      vi.useFakeTimers();
      const s = setup();
      s.container.controller = new Worker();
      s.changeController();
      expect(s.store.getSnapshot()).toMatchObject({ applying: true, reloadRequired: true });
      await vi.advanceTimersByTimeAsync(1000);
      if (kind === 'ready') s.reg.waiting = s.worker;
      s.found(61_000);
      if (kind === 'failed') s.worker.change('redundant');
      expect(s.store.getSnapshot()).toMatchObject({ kind, applying: false, reloadRequired: true });
      await Promise.resolve();
      expect(s.store.getSnapshot()).toMatchObject({ kind, applying: false, reloadRequired: true });
      await s.store.applyUpdate();
      expect(s.reload).toHaveBeenCalledTimes(2);
      expect(s.reg.update).not.toHaveBeenCalled();
    });
  it('keeps the session if apply is requested before registration', async () => {
    const store = createSwUpdateStore();
    await store.applyUpdate();
    expect(store.getSnapshot().kind).toBe('failed');
  });
  it('shows downloading immediately with a controller but no registration.active', () => {
    expect(setup({ activeNull: true, installing: true }).store.getSnapshot().kind).toBe('downloading');
  });
  it('does not call the current controller an older worker during first installation', () => {
    const s = setup({ first: true, installing: true });
    s.container.controller = s.worker;
    s.worker.change('installing');
    expect(s.store.getSnapshot().kind).toBe('idle');
  });
  it('tracks a first claim during registration so a later controller switch reloads', () => {
    const s = setup({ first: true, claimedBeforeStart: true, initialController: null });
    expect(s.reload).not.toHaveBeenCalled();
    s.container.controller = new Worker();
    s.changeController();
    expect(s.reload).toHaveBeenCalledOnce();
  });
  it('reloads once for a controller switched before tracking began', () => {
    const s = setup({ initialController: new Worker() as unknown as ServiceWorker });
    expect(s.reload).toHaveBeenCalledOnce();
    s.changeController();
    expect(s.reload).toHaveBeenCalledOnce();
  });
  it('binds the worker version to each waiting worker, ignoring an older worker answer', async () => {
    let answer!: (value: string) => void;
    const workerVersion = vi.fn().mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }))
      .mockResolvedValue('0.210');
    const s = setup({ waiting: true, workerVersion });
    expect(s.store.getSnapshot().readyVersion).toBeUndefined();
    const next = new Worker();
    s.reg.waiting = next;
    s.reg.installing = next;
    s.reg.dispatchEvent(new Event('updatefound'));
    await Promise.resolve();
    expect(s.store.getSnapshot().readyVersion).toBe('0.210');
    answer('0.209');
    await Promise.resolve();
    expect(s.store.getSnapshot().readyVersion).toBe('0.210');
    next.change('installed');
    expect(workerVersion).toHaveBeenCalledTimes(2);
  });
  it('queries once on ready and never relabels that worker on later state events', async () => {
    const workerVersion = vi.fn().mockResolvedValue('0.210');
    const s = setup({ installing: true, workerVersion });
    expect(workerVersion).not.toHaveBeenCalled();
    s.ready();
    await Promise.resolve();
    expect(s.store.getSnapshot().readyVersion).toBe('0.210');
    workerVersion.mockResolvedValue('0.211');
    s.worker.change('installed');
    expect(workerVersion).toHaveBeenCalledOnce();
    expect(s.store.getSnapshot().readyVersion).toBe('0.210');
  });
  it.each(['stopped', 'departed'])('ignores a ready-version answer after the worker is %s', async reason => {
    let answer!: (value: string) => void;
    const s = setup({ waiting: true, workerVersion: () => new Promise(resolve => { answer = resolve; }) });
    if (reason === 'stopped') s.stop();
    else s.reg.waiting = null;
    answer('0.211');
    await Promise.resolve();
    expect(s.store.getSnapshot().readyVersion).toBeUndefined();
  });
  it.each(['nothing', 'rejection'])('keeps a controlled old session when update returns %s', async result => {
    const s = setup();
    if (result === 'rejection') s.reg.update.mockRejectedValue(new Error('offline'));
    await s.store.applyUpdate();
    expect(s.store.getSnapshot().kind).toBe('failed');
    expect(s.reload).not.toHaveBeenCalled();
  });
  it('re-enables apply after a cancelled fallback reload', async () => {
    vi.useFakeTimers();
    const s = setup({ waiting: true });
    await s.store.applyUpdate();
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.reload).toHaveBeenCalledOnce();
    expect(s.store.getSnapshot().applying).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(s.store.getSnapshot().applying).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.store.getSnapshot().applying).toBe(false);
    await s.store.applyUpdate();
    expect(s.worker.postMessage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.reload).toHaveBeenCalledTimes(2);
  });
  it('offers a plain reload after controller takeover and a cancelled unload', async () => {
    vi.useFakeTimers();
    const s = setup({ waiting: true });
    await s.store.applyUpdate();
    s.reg.waiting = null;
    s.container.controller = s.worker;
    s.changeController();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.store.getSnapshot()).toMatchObject({ kind: 'ready', applying: false, reloadRequired: true });
    await s.store.applyUpdate();
    expect(s.reload).toHaveBeenCalledTimes(2);
    expect(s.reg.update).not.toHaveBeenCalled();
  });
});

describe('waiting worker version query', () => {
  class Channel {
    port1 = { onmessage: (_event: { data: unknown }) => {}, onmessageerror: () => {}, close: vi.fn() };
    port2 = { reply: (data: unknown) => this.port1.onmessage({ data }), close: vi.fn() };
  }
  it('binds the actual waiting worker answer without fetching the deployed version at ready', async () => {
    vi.stubGlobal('MessageChannel', Channel);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const worker = new Worker();
    worker.postMessage.mockImplementation((_message, ports) => ports[0].reply({ version: '0.210' }));
    const reg = Object.assign(new EventTarget(), { active: new Worker(), installing: null, waiting: worker });
    const container = Object.assign(new EventTarget(), { controller: reg.active });
    const store = createSwUpdateStore();
    cleanups.push(store.start(reg as unknown as ServiceWorkerRegistration, {
      container: container as unknown as ServiceWorkerContainer,
      initialController: reg.active as unknown as ServiceWorker,
      now: () => 0, reload: vi.fn(), isUntouched: () => false, otherTabsOpen: async () => true,
    }));
    await Promise.resolve();
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'MMR_VERSION' }, expect.any(Array));
    expect(store.getSnapshot().readyVersion).toBe('0.210');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ version: '0.210' }, { version: null }, {}, null, { version: 0.21 }, { version: 210 }, { version: 'release' }])(
    'reads the waiting worker answer safely: %j', async answer => {
      vi.stubGlobal('MessageChannel', Channel);
      const postMessage = vi.fn((_message, ports) => ports[0].reply(answer));
      await expect(waitingWorkerVersion({ postMessage } as unknown as ServiceWorker))
        .resolves.toBe(answer?.version === '0.210' ? '0.210' : null);
      expect(postMessage.mock.calls[0]![0]).toEqual({ type: 'MMR_VERSION' });
    });
  it('times out at one second and uses unknown on messaging failures', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('MessageChannel', Channel);
    const worker = new Worker();
    const done = vi.fn();
    const pending = waitingWorkerVersion(worker as unknown as ServiceWorker).then(done);
    await vi.advanceTimersByTimeAsync(999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toHaveBeenCalledWith(null);
    worker.postMessage.mockImplementation(() => { throw new Error('stopped'); });
    await expect(waitingWorkerVersion(worker as unknown as ServiceWorker)).resolves.toBeNull();
    vi.stubGlobal('MessageChannel', undefined);
    await expect(waitingWorkerVersion(worker as unknown as ServiceWorker)).resolves.toBeNull();
  });
  it('uses unknown on message decoding errors and closes both ports', async () => {
    let ports!: [Channel['port1'], Channel['port2']];
    class ErrorChannel extends Channel { constructor() { super(); ports = [this.port1, this.port2]; } }
    vi.stubGlobal('MessageChannel', ErrorChannel);
    const worker = new Worker();
    worker.postMessage.mockImplementation(() => ports[0].onmessageerror());
    await expect(waitingWorkerVersion(worker as unknown as ServiceWorker)).resolves.toBeNull();
    expect(ports[0].close).toHaveBeenCalledOnce();
    expect(ports[1].close).toHaveBeenCalledOnce();
  });
});

describe('worker window count', () => {
  class Channel {
    port1 = { onmessage: (_event: { data: unknown }) => {}, onmessageerror: () => {}, close: vi.fn() };
    port2 = { reply: (data: unknown) => this.port1.onmessage({ data }), close: vi.fn() };
  }
  it.each([{ windows: 1 }, { windows: 2 }, {}, { windows: '1' }, { windows: NaN }, { windows: 0 }])(
    'uses the active worker answer safely: %j', async answer => {
      vi.stubGlobal('MessageChannel', Channel);
      const postMessage = vi.fn((_data, ports) => ports[0].reply(answer));
      await expect(otherTabsOpen({ active: { postMessage } } as unknown as ServiceWorkerRegistration))
        .resolves.toBe(answer.windows !== 1);
      expect(postMessage.mock.calls[0]![0]).toEqual({ type: 'MMR_COUNT_WINDOWS' });
    });
  it('assumes another tab on silence, missing active, message errors or messaging failure', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('MessageChannel', Channel);
    const reg = { active: { postMessage: vi.fn() } } as unknown as ServiceWorkerRegistration;
    const done = vi.fn();
    const pending = otherTabsOpen(reg).then(done);
    await vi.advanceTimersByTimeAsync(999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toHaveBeenCalledWith(true);
    await expect(otherTabsOpen({ active: null } as ServiceWorkerRegistration)).resolves.toBe(true);
    reg.active!.postMessage = vi.fn(() => { throw new Error('gone'); });
    await expect(otherTabsOpen(reg)).resolves.toBe(true);
    reg.active!.postMessage = vi.fn((_data, ports) => { (ports as unknown as { reply: (data: unknown) => void }[])[0]!.reply(null); });
    await expect(otherTabsOpen(reg)).resolves.toBe(true);
  });
  it('assumes another tab on a message decoding error or missing MessageChannel', async () => {
    class ErrorChannel extends Channel {
      constructor() { super(); error = () => this.port1.onmessageerror(); }
    }
    let error = () => {};
    vi.stubGlobal('MessageChannel', ErrorChannel);
    const reg = { active: { postMessage: vi.fn(() => error()) } } as unknown as ServiceWorkerRegistration;
    await expect(otherTabsOpen(reg)).resolves.toBe(true);
    vi.stubGlobal('MessageChannel', undefined);
    await expect(otherTabsOpen(reg)).resolves.toBe(true);
  });
});

describe('fresh-open auto-apply', () => {
  it.each(['restored dirty', 'held during presence check', 'clean'])('round 2 fresh lone untouched tab: %s', async mode => {
    let held = mode === 'restored dirty';
    setReloadHold(() => held);
    const s = setup({ waiting: true, untouched: true });
    if (mode === 'held during presence check') held = true;
    await Promise.resolve();
    expect(s.worker.postMessage).toHaveBeenCalledTimes(mode === 'clean' ? 1 : 0);
    expect(s.store.getSnapshot()).toMatchObject({ kind: 'ready', applying: mode === 'clean', reloadRequired: false });
  });
  it.each(['untouched', 'touched', 'other tab', 'late update', 'departed', 'stopped', 'untracked', 'first install'])(
    'rechecks an existing waiting worker when App registers its predicate: %s', async mode => {
      const s = setup({ waiting: mode !== 'late update', first: mode === 'first install', pagePredicate: true, others: mode === 'other tab' });
      if (mode === 'late update') { s.found(60_001); s.ready(); }
      await Promise.resolve();
      expect(s.worker.postMessage).not.toHaveBeenCalled();
      expect(s.otherTabsOpen).not.toHaveBeenCalled();
      if (mode === 'departed') s.reg.waiting = null;
      if (mode === 'stopped') s.stop();
      if (mode === 'untracked') s.reg.waiting = new Worker();
      const remove = setIsUntouched(() => mode !== 'touched');
      cleanups.push(remove);
      s.worker.change('installed');
      await Promise.resolve();
      expect(s.worker.postMessage).toHaveBeenCalledTimes(mode === 'untouched' ? 1 : 0);
      expect(s.otherTabsOpen).toHaveBeenCalledTimes(mode === 'untouched' || mode === 'other tab' ? 1 : 0);
      expect(s.store.getSnapshot()).toMatchObject({ kind: mode === 'first install' ? 'idle' : 'ready', applying: mode === 'untouched' });
    });
  it('retries once per predicate registration without looping on waiting worker events', async () => {
    const s = setup({ waiting: true, pagePredicate: true, others: true });
    const remove = setIsUntouched(() => true);
    cleanups.push(remove);
    await Promise.resolve();
    s.worker.change('installed');
    s.worker.change('installed');
    await Promise.resolve();
    expect(s.otherTabsOpen).toHaveBeenCalledOnce();
    const removeAgain = setIsUntouched(() => true);
    cleanups.push(removeAgain);
    await Promise.resolve();
    expect(s.otherTabsOpen).toHaveBeenCalledTimes(2);
    expect(s.worker.postMessage).not.toHaveBeenCalled();
  });
  it.each(['installing', 'waiting', 'found'] as const)('applies an untouched lone tab with %s at load', async mode => {
    const s = setup({ installing: mode === 'installing', waiting: mode === 'waiting', untouched: true });
    if (mode === 'found') s.found(60_000);
    if (mode !== 'waiting') s.ready();
    await Promise.resolve();
    expect(s.worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'SKIP_WAITING' });
  });
  it.each([{ untouched: false, others: false }, { untouched: true, others: true }])('requires untouched AND alone: %j', async options => {
    const s = setup({ waiting: true, ...options });
    await Promise.resolve();
    expect(s.store.getSnapshot().kind).toBe('ready');
    expect(s.worker.postMessage).not.toHaveBeenCalled();
    if (!options.untouched) expect(s.otherTabsOpen).not.toHaveBeenCalled();
  });
  it('never auto-applies an update found more than 60 s after registration', async () => {
    const s = setup({ untouched: true });
    s.found(60_001);
    s.ready();
    await Promise.resolve();
    expect(s.worker.postMessage).not.toHaveBeenCalled();
  });
  it('auto-applies only within AUTO_APPLY_WINDOW_MS of loading (a fresh open), never later', async () => {
    const late = setup({ untouched: true });
    late.found(30_000);
    late.setNow(AUTO_APPLY_WINDOW_MS + 1);
    late.ready();
    await Promise.resolve();
    expect(late.store.getSnapshot().kind).toBe('ready');
    expect(late.worker.postMessage).not.toHaveBeenCalled();
    const inTime = setup({ untouched: true });
    inTime.found(30_000);
    inTime.setNow(AUTO_APPLY_WINDOW_MS);
    inTime.ready();
    await Promise.resolve();
    expect(inTime.worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'SKIP_WAITING' });
  });
  it('a predicate registered long after load does not apply a load-time update', async () => {
    const s = setup({ waiting: true, pagePredicate: true, others: false });
    await Promise.resolve();
    s.setNow(2 * 60 * 60_000);
    const remove = setIsUntouched(() => true);
    cleanups.push(remove);
    await Promise.resolve();
    expect(s.worker.postMessage).not.toHaveBeenCalled();
  });
  it('checks untouched again after awaiting other tabs', async () => {
    const s = setup({ untouched: true });
    s.found();
    s.ready();
    s.isUntouched.mockReturnValue(false);
    await Promise.resolve();
    expect(s.worker.postMessage).not.toHaveBeenCalled();
  });
  it.each(['stopped', 'replaced'] as const)('does not auto-apply after the presence window when %s', async reason => {
    const s = setup({ untouched: true });
    s.found();
    s.ready();
    if (reason === 'stopped') s.stop();
    else s.reg.waiting = new Worker();
    await Promise.resolve();
    expect(s.worker.postMessage).not.toHaveBeenCalled();
    expect(s.reg.waiting?.postMessage).not.toHaveBeenCalled();
  });
  it('defaults to touched until App publishes its check and resets on unmount', () => {
    expect(isPageUntouched()).toBe(false);
    const stop = setIsUntouched(() => true);
    expect(isPageUntouched()).toBe(true);
    stop();
    expect(isPageUntouched()).toBe(false);
  });
});
