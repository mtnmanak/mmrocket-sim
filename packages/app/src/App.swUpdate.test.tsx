// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { APP_VERSION } from './version.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { useVersionCheck } from './services/versionCheck.js';
import { applyUpdate, isPageUntouched, setIsUntouched, useSwUpdate, isReloadHeld, setReloadHold, swUpdate } from './services/swUpdate.js';
import { heldSession, sessionConflicted } from './services/session.js';
import { DEFAULT_CONDITIONS } from './components/LaunchPanel.js';
import { designFingerprint, type DesignSnapshot } from './services/dirtyState.js';
import { guardPrecache } from './services/precacheGuard.js';
import { saveFile } from './services/saveFile.js';
import { createPageActivity, pageActivity } from './services/pageActivity.js';
import * as shareLink from './services/shareLink.js';
import * as importApply from './services/importApply.js';
import { useDialog } from './components/useDialog.js';
import { ReloadPageButton } from './components/ReloadPageButton.js';
import { defaultTree } from './tree/treeModel.js';

const dirtyOverride = vi.hoisted(() => ({ value: undefined as boolean | undefined }));

function restoreUserDesign() {
  const tree = { ...defaultTree(), name: 'A design to keep' };
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ tree, mountMotors: {},
    launch: DEFAULT_CONDITIONS, appVersion: APP_VERSION, savedAt: Date.now() }));
}

it('r5 lets an unchanged first-visit starter leave and update despite a failed autosave', async () => {
  dirtyOverride.value = false;
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.mocked(heldSession).mockReturnValue({} as NonNullable<ReturnType<typeof heldSession>>);
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'ready', applying: false });
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>('.version-update')!.click());
    expect(applyUpdate).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain('before applying the update');
  } finally { await act(async () => root.unmount()); }
}, 30_000);

it('r4 checks live imports again when the update confirmation proceeds', async () => {
  dirtyOverride.value = true;
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'ready', applying: false });
  const host = document.createElement('div'); const root = createRoot(host);
  let finish: (() => void) | undefined;
  try {
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    await act(async () => host.querySelector<HTMLButtonElement>('.version-update')!.click());
    const proceed = () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Apply update and reload anyway')!;
    expect(proceed()).toBeDefined();
    // Imports are live activity: this starts after the confirmation's render.
    finish = pageActivity.startImport();
    await act(async () => proceed().click());
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Finish or cancel the pending open before reloading');
    finish(); finish = undefined;
    await act(async () => host.querySelector<HTMLButtonElement>('.version-update')!.click());
    await act(async () => proceed().click());
    expect(applyUpdate).toHaveBeenCalledOnce();
  } finally { finish?.(); await act(async () => root.unmount()); host.remove(); }
}, 30000);

it('J6 holds an unattended update while a clean tab has a modal draft', async () => {
  dirtyOverride.value = false;
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'idle', applying: false });
  function Draft() { const ref = useDialog(() => {}); return <div ref={ref} role="dialog" aria-modal="true"><input defaultValue="Unsaved material draft" /></div>; }
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const update = pendingTakeover(false);
  try {
    await act(async () => root.render(<PrefsProvider><App /><Draft /></PrefsProvider>));
    expect(isReloadHeld()).toBe(true);
    update.container.dispatchEvent(new Event('controllerchange'));
    expect(update.reload).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); update.stop(); }
});
it.each(['before tracking', 'before offer commit'])('r2 protects a clean restored share link %s', async mode => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  dirtyOverride.value = false;
  const snapshot: DesignSnapshot = {
    tree: { name: 'Clean restored design', components: [{ type: 'stage', id: 's', children: [] }] },
    launch: DEFAULT_CONDITIONS, mountMotors: {}, savedConfigs: [], activeConfigId: null,
    maxMotorLengthByStage: {}, measured: { massKg: null, cgM: null },
  };
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...snapshot,
    savedAt: Date.now(), appVersion: APP_VERSION, savedMark: designFingerprint(snapshot) }));
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'ready', applying: false, reloadRequired: true });
  let decode!: (xml: string) => void;
  vi.spyOn(shareLink, 'decodeShareFragment').mockImplementation(() => new Promise(resolve => { decode = resolve; }));
  window.history.replaceState(null, '', '/#d=restored');
  setReloadHold(() => true);
  const s = pendingTakeover(mode === 'before tracking');
  const heldAtFinish: boolean[] = [];
  const start = pageActivity.startImport;
  vi.spyOn(pageActivity, 'startImport').mockImplementation(() => {
    const finish = start();
    return () => {
      finish();
      heldAtFinish.push(isReloadHeld());
      if (mode === 'before offer commit') s.container.dispatchEvent(new Event('controllerchange'));
    };
  });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    expect(s.reload).not.toHaveBeenCalled();
    await act(async () => {
      decode('<openrocket version="1.10"><rocket><name>Linked design</name><subcomponents><stage><subcomponents>'
        + '<bodytube><length>0.3</length><radius>0.02</radius><thickness>0.001</thickness></bodytube>'
        + '</subcomponents></stage></subcomponents></rocket></openrocket>');
      await vi.waitFor(() => expect(pageActivity.importsInProgress()).toBe(0));
    });
    expect(heldAtFinish).toContain(true);
    expect(host.querySelector('[aria-label="Open design from link"]')).not.toBeNull();
    expect(s.reload).not.toHaveBeenCalled();
    const confirm = vi.fn(() => false); vi.stubGlobal('confirm', confirm);
    await act(async () => host.querySelector<HTMLButtonElement>('.version-update')!.click());
    expect(confirm).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Finish or cancel the pending open before reloading');
    expect(applyUpdate).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); s.stop(); window.history.replaceState(null, '', '/'); }
});

it.each(['held reload', 'waiting worker', 'stale version'].flatMap(mode => [false, true].map(late => [mode, late] as const)))('r3 warns before activating an update from a clean held tab (%s, late hold %s)', async (mode, late) => {
  restoreUserDesign();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  dirtyOverride.value = false;
  vi.mocked(heldSession).mockReturnValue(late ? null : {} as NonNullable<ReturnType<typeof heldSession>>);
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'stale', latest: { version: '0.999' } }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: mode === 'stale version' ? 'idle' : 'ready', applying: false, reloadRequired: mode === 'held reload' });
  const confirm = vi.fn(() => false); vi.stubGlobal('confirm', confirm);
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    const button = host.querySelector<HTMLButtonElement>('.version-update')!;
    if (!late) expect(button.title).toContain('.ork');
    // A failed debounced write can acquire the hold without another App render.
    vi.mocked(heldSession).mockReturnValue({} as NonNullable<ReturnType<typeof heldSession>>);
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);
    await act(async () => button.click());
    expect(confirm).not.toHaveBeenCalled();
    expect(applyUpdate).not.toHaveBeenCalled();
    expect(host.textContent).toContain('before applying the update');
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Keep working')!.click());
    expect(applyUpdate).not.toHaveBeenCalled();
    await act(async () => button.click());
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Apply update and reload anyway')!.click());
    expect(applyUpdate).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); }
});

it('r3 reloads a clean tab on the first click from a failed lazy modal', async () => {
  dirtyOverride.value = false;
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'idle', applying: false });
  function FailedDialog() { const ref = useDialog(() => {}); return <div ref={ref} role="dialog" aria-modal="true"><ReloadPageButton /></div>; }
  const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PrefsProvider><App /><FailedDialog /></PrefsProvider>));
    expect(isReloadHeld()).toBe(true);
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === '↻ Reload the page')!.click());
    expect(reload).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain('This tab has work to keep');
  } finally { await act(async () => root.unmount()); host.remove(); reload.mockRestore(); }
}, 30_000);
vi.mock('./hooks/useDesignDirty.js', async original => {
  const real = await original<typeof import('./hooks/useDesignDirty.js')>();
  return { ...real, useDesignDirty: (...args: Parameters<typeof real.useDesignDirty>) => {
    const result = real.useDesignDirty(...args);
    return { ...result, dirty: dirtyOverride.value ?? result.dirty };
  } };
});

vi.mock('./services/versionCheck.js', async original => ({
  ...await original<typeof import('./services/versionCheck.js')>(), useVersionCheck: vi.fn(),
}));
vi.mock('./services/swUpdate.js', async original => {
  const real = await original<typeof import('./services/swUpdate.js')>();
  return { ...real, useSwUpdate: vi.fn(), applyUpdate: vi.fn(), setIsUntouched: vi.fn(real.setIsUntouched), setReloadHold: vi.fn(real.setReloadHold) };
});
vi.mock('./services/saveFile.js', async original => ({
  ...await original<typeof import('./services/saveFile.js')>(),
  saveFile: vi.fn(async () => ({ kind: 'downloaded', name: 'saved.ork' })),
}));
vi.mock('./services/session.js', async original => {
  const real = await original<typeof import('./services/session.js')>();
  return { ...real, sessionConflicted: vi.fn(real.sessionConflicted), heldSession: vi.fn(real.heldSession) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  dirtyOverride.value = undefined;
  pendingTakeover(false).stop();
  vi.mocked(sessionConflicted).mockReset().mockReturnValue(false);
  vi.mocked(heldSession).mockReset().mockReturnValue(null);
  Object.assign(pageActivity, createPageActivity());
  setReloadHold(() => false);
  vi.mocked(setReloadHold).mockClear();
});

it.each(['conflict', 'held design'])('round 3 clean unmount keeps later %s live', async reason => {
  restoreUserDesign();
  dirtyOverride.value = false;
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'idle', applying: false });
  const s = pendingTakeover(false);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    expect(isReloadHeld()).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); }
  try {
    expect(isReloadHeld()).toBe(false);
    if (reason === 'conflict') vi.mocked(sessionConflicted).mockReturnValue(true);
    else vi.mocked(heldSession).mockReturnValue({} as NonNullable<ReturnType<typeof heldSession>>);
    expect(isReloadHeld()).toBe(true);
    s.container.dispatchEvent(new Event('controllerchange'));
    expect(s.reload).not.toHaveBeenCalled();
  } finally { s.stop(); }
});

it('round 3 startup settlement retries waiting-worker auto-apply', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'idle', applying: false });
  setReloadHold(() => true);
  const active = {} as ServiceWorker;
  const worker = Object.assign(new EventTarget(), { state: 'installed', postMessage: vi.fn() });
  const stop = swUpdate.start(Object.assign(new EventTarget(), { active, waiting: worker }) as unknown as ServiceWorkerRegistration, {
    container: Object.assign(new EventTarget(), { controller: active }) as unknown as ServiceWorkerContainer,
    initialController: active, reload: vi.fn(), now: () => 0, isUntouched: isPageUntouched,
    otherTabsOpen: async () => false, workerVersion: async () => null,
  });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    expect(worker.postMessage).not.toHaveBeenCalled();
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    expect(isReloadHeld()).toBe(false);
    expect(isPageUntouched()).toBe(true);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  } finally { await act(async () => root.unmount()); host.remove(); stop(); }
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); localStorage.clear(); });

function pendingTakeover(switched = true) {
  const old = {} as ServiceWorker;
  const container = Object.assign(new EventTarget(), { controller: switched ? {} as ServiceWorker : old });
  const reload = vi.fn();
  const stop = swUpdate.start(Object.assign(new EventTarget(), { active: old }) as unknown as ServiceWorkerRegistration, {
    container: container as unknown as ServiceWorkerContainer, initialController: old,
    reload, now: () => 0, isUntouched: () => false, otherTabsOpen: async () => false,
  });
  return { container, reload, stop };
}

it('round 2 restored flown design stays held on a fresh lone untouched open with a waiting worker', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  const snapshot: DesignSnapshot = {
    tree: { name: 'Restored flight', components: [{ type: 'stage', id: 's', children: [] }] },
    launch: DEFAULT_CONDITIONS, mountMotors: {}, savedConfigs: [], activeConfigId: null,
    maxMotorLengthByStage: {}, measured: { massKg: null, cgM: null },
  };
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ ...snapshot,
    savedAt: Date.now(), appVersion: APP_VERSION, savedMark: designFingerprint(snapshot), flownSinceSave: true }));
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  const real = await vi.importActual<typeof import('./services/swUpdate.js')>('./services/swUpdate.js');
  vi.mocked(useSwUpdate).mockImplementation(real.useSwUpdate);
  setReloadHold(() => true);
  const worker = Object.assign(new EventTarget(), { state: 'installed', postMessage: vi.fn() });
  const active = {} as ServiceWorker;
  const reload = vi.fn();
  const stop = swUpdate.start(Object.assign(new EventTarget(), { active, waiting: worker }) as unknown as ServiceWorkerRegistration, {
    container: Object.assign(new EventTarget(), { controller: active }) as unknown as ServiceWorkerContainer,
    initialController: active, reload, now: () => 0, isUntouched: isPageUntouched,
    otherTabsOpen: async () => false, workerVersion: async () => null,
  });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    expect(isPageUntouched()).toBe(true);
    expect(isReloadHeld()).toBe(true);
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(host.querySelector('.version-update')?.textContent).toContain('ready — Reload');
  } finally { await act(async () => root.unmount()); host.remove(); stop(); }
});

it.each(['click', 'startup settle'])('round 2 App resumes a held precache repair through %s', async mode => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(sessionConflicted).mockReturnValueOnce(mode === 'click');
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  const real = await vi.importActual<typeof import('./services/swUpdate.js')>('./services/swUpdate.js');
  vi.mocked(useSwUpdate).mockImplementation(real.useSwUpdate);
  if (mode === 'click') vi.mocked(applyUpdate).mockImplementationOnce(real.applyUpdate);
  setReloadHold(() => true);
  const unregister = vi.fn(async () => true);
  const reload = vi.fn();
  expect(await guardPrecache({ active: {}, scope: 'https://example.test/', unregister } as unknown as ServiceWorkerRegistration, {
    dev: false, online: () => true, session: () => ({ getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }),
    caches: () => ({ keys: async () => [], open: vi.fn() }), serverAnswers: async () => true, reload,
  })).toBe('held');
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    if (mode === 'click') {
      const button = host.querySelector<HTMLButtonElement>('.version-update')!;
      expect(button.textContent).toBe('↻ Reload to finish the update');
      expect(reload).not.toHaveBeenCalled();
      await act(async () => button.click());
    }
    expect(unregister).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('round 2 startup transient dirty settles clean and retries an early takeover once', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'ready', applying: false, reloadRequired: true });
  setReloadHold(() => true);
  const s = pendingTakeover();
  expect(s.reload).not.toHaveBeenCalled();
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    expect(isReloadHeld()).toBe(false);
    expect(s.reload).toHaveBeenCalledOnce();
    await act(async () => host.querySelector<HTMLButtonElement>('.tour-close')?.click());
    expect(s.reload).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); host.remove(); s.stop(); }
});

it('round 2 holds a clean design with a session conflict and explains that cause', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.mocked(sessionConflicted).mockReturnValueOnce(true);
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'ready', applying: false, reloadRequired: true });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    expect(host.querySelector('.save-status')?.textContent ?? host.textContent).toContain('No unsaved changes');
    expect(isReloadHeld()).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('.version-update')!.title).toContain('another tab');
    expect(host.querySelector<HTMLButtonElement>('.version-update')!.title).not.toContain('unsaved changes');
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('149 B registers once, holds edits, explains the wait, and releases after Save .ork', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'ready', applying: false, reloadRequired: true });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const s = pendingTakeover(false);
  const button = (scope: Element, text: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')]
    .find(b => b.textContent?.includes(text))!;
  try {
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    await act(async () => host.querySelector<HTMLButtonElement>('.tour-close')?.click());
    expect(isReloadHeld()).toBe(false);
    const name = host.querySelector<HTMLInputElement>('#rocket-name')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Unsaved tab design');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(isReloadHeld()).toBe(true);
    s.container.dispatchEvent(new Event('controllerchange'));
    expect(s.reload).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>('.version-update')!.title)
      .toBe('This tab has unsaved changes: save them (.ork) if you want to keep them, then Reload.');
    await act(async () => button(host, 'Save As / Export').click());
    await act(async () => button(host.querySelector('.file-menu')!, 'Save .ork').click());
    expect(saveFile).toHaveBeenCalledOnce();
    expect(isReloadHeld()).toBe(false);
    expect(s.reload).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>('.version-update')!.title).toContain('Reload to finish updating this tab');
    expect(setReloadHold).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); host.remove(); s.stop(); }
  expect(isReloadHeld()).toBe(false);
});

it('149 B keeps the dirty hold when App unmounts into a crash panel', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'idle', applying: false });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    await act(async () => host.querySelector<HTMLButtonElement>('.tour-close')?.click());
    const name = host.querySelector<HTMLInputElement>('#rocket-name')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Keep after crash');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(isReloadHeld()).toBe(true);
  } finally { await act(async () => root.unmount()); host.remove(); }
  expect(isReloadHeld()).toBe(true);
});

it('renders ready, downloading, available and version-check states in one polite region', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  const recheck = vi.fn();
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'stale', latest: { version: '0.999' } }, recheck, checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'ready', applying: false, readyVersion: '0.998' });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () => act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
  try {
    await render();
    const region = host.querySelector('.version-check')!;
    expect(region.getAttribute('aria-live')).toBe('polite');
    let button = region.querySelector('button')!;
    expect(button.textContent).toBe('↻ v0.998 ready — Reload');
    await act(async () => button.click());
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    vi.mocked(useSwUpdate).mockReturnValue({ kind: 'ready', applying: true });
    await render();
    expect(region.querySelector('button')?.disabled).toBe(true);
    expect(region.querySelector('button')?.textContent).toBe('↻ Updating…');

    vi.mocked(useSwUpdate).mockReturnValue({ kind: 'ready', applying: true, reloadRequired: true });
    await render();
    expect(region.querySelector('button')?.textContent).toBe('↻ Updating…');
    expect(region.querySelector('button')?.disabled).toBe(true);

    vi.mocked(useSwUpdate).mockReturnValue({ kind: 'downloading', applying: false });
    await render();
    expect(region.querySelector('button')).toBeNull();
    expect(region.textContent).toContain('↻ Downloading the new version…');
    expect(region.textContent).not.toContain('0.999');
    expect(region.querySelector('.version-update')?.getAttribute('title')).toContain('offer a reload when it is ready');

    for (const kind of ['idle', 'failed'] as const) {
      vi.mocked(useSwUpdate).mockReturnValue({ kind, applying: false });
      await render();
      button = region.querySelector('button')!;
      expect(button.textContent).toContain('↻ v0.999 available — Reload');
      if (kind === 'failed') expect(button.title).toBe('The download did not start. Check your connection and click again.');
      await act(async () => button.click());
    }
    expect(applyUpdate).toHaveBeenCalledTimes(3);

    vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'current', version: '0.001' }, recheck, checking: false });
    await render();
    button = region.querySelector('button')!;
    expect(button.textContent).toBe('✓ Up to date');
    button.focus();
    await act(async () => button.click());
    expect(recheck).toHaveBeenCalledOnce();
    vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'checking' }, recheck, checking: true });
    await render();
    expect(region.querySelector('button')).toBe(button);
    expect(button.textContent).toBe('Checking…');
    expect(button.disabled).toBe(true);
    vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck, checking: false });
    await render();
    expect(region.querySelector('button')).toBe(button);
    expect(button.textContent).toBe('Version unknown');
    expect(document.activeElement).toBe(button);

    vi.mocked(useSwUpdate).mockReturnValue({ kind: 'ready', applying: false });
    await render();
    expect(region.textContent).toContain('↻ New version ready — Reload');
    expect(region.textContent).not.toContain('v0.001');
    for (const readyVersion of [APP_VERSION, '0.001']) {
      vi.mocked(useSwUpdate).mockReturnValue({ kind: 'ready', applying: false, readyVersion });
      await render();
      expect(region.querySelector('button')?.textContent).toBe('↻ New version ready — Reload');
    }
    vi.mocked(useSwUpdate).mockReturnValue({ kind: 'downloading', applying: false });
    await render();
    expect(region.textContent).toContain('↻ Downloading the new version…');
    vi.mocked(useSwUpdate).mockReturnValue({ kind: 'ready', applying: false, reloadRequired: true });
    await render();
    expect(region.querySelector('button')?.textContent).toBe('↻ Reload to finish the update');
    await act(async () => region.querySelector('button')!.click());
    expect(applyUpdate).toHaveBeenCalledTimes(4);
    for (const kind of ['downloading', 'failed', 'ready'] as const) {
      vi.mocked(useSwUpdate).mockReturnValue({ kind, applying: false, reloadRequired: true });
      await render();
      expect(region.querySelector('button')?.textContent).toBe('↻ Reload to finish the update');
      expect(region.querySelector('button')?.disabled).toBe(false);
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
  expect(isPageUntouched()).toBe(false);
});

it('excludes the non-modal first-run tour from untouched', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'idle', applying: false });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    expect(host.querySelector('.tour-card[role="dialog"]')).not.toBeNull();
    expect(isPageUntouched()).toBe(false);
    await act(async () => host.querySelector<HTMLButtonElement>('.tour-close')!.click());
    expect(isPageUntouched()).toBe(true);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('marks an Open touched before reading bytes and releases failed imports without clearing the latch', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'idle', applying: false });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let rejectRead!: (error: Error) => void;
  const file = new File(['bad'], 'rocket.ork');
  Object.defineProperty(file, 'arrayBuffer', { value: () => new Promise((_resolve, reject) => { rejectRead = reject; }) });
  try {
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    await act(async () => host.querySelector<HTMLButtonElement>('.tour-close')!.click());
    expect(isPageUntouched()).toBe(true);
    const picker = host.querySelector<HTMLInputElement>('input[aria-label="Open a design file"]')!;
    Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
    await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })));
    expect(pageActivity.importsInProgress()).toBe(1);
    expect(isPageUntouched()).toBe(false);
    // Exercise the in-progress predicate independently of the sticky latch.
    const activityCheck = vi.spyOn(pageActivity, 'isUntouched').mockReturnValue(true);
    expect(isPageUntouched()).toBe(false);
    activityCheck.mockRestore();
    await act(async () => rejectRead(new Error('read failed')));
    expect(pageActivity.importsInProgress()).toBe(0);
    expect(host.querySelector<HTMLButtonElement>('button[title^="Undo the last change"]')?.disabled).toBe(true);
    expect(isPageUntouched()).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('uses the capture input latch even when the App history and dialogs stay empty', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'idle', applying: false });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const stop = pageActivity.listen(window);
  try {
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    await act(async () => host.querySelector<HTMLButtonElement>('.tour-close')!.click());
    expect(isPageUntouched()).toBe(true);
    window.dispatchEvent(new Event('pointerdown'));
    expect(isPageUntouched()).toBe(false);
  } finally { stop(); await act(async () => root.unmount()); host.remove(); }
});

it('tracks applyImported through motor resolution and stays touched after a successful history reset', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'idle', applying: false });
  const resolve = importApply.resolveImportMotors;
  const motorResolution = vi.spyOn(importApply, 'resolveImportMotors').mockImplementation(async (...args) => {
    expect(pageActivity.importsInProgress()).toBe(2);
    return resolve(...args);
  });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const xml = '<openrocket version="1.10"><rocket><name>Opened rocket</name><subcomponents><stage><subcomponents>'
    + '<bodytube><length>0.3</length><radius>0.02</radius><thickness>0.001</thickness></bodytube>'
    + '</subcomponents></stage></subcomponents></rocket></openrocket>';
  try {
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    await act(async () => host.querySelector<HTMLButtonElement>('.tour-close')!.click());
    const picker = host.querySelector<HTMLInputElement>('input[aria-label="Open a design file"]')!;
    Object.defineProperty(picker, 'files', { configurable: true, value: [new File([xml], 'opened.ork')] });
    await act(async () => {
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      await vi.waitFor(() => expect(pageActivity.importsInProgress()).toBe(0));
    });
    expect(motorResolution).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('Opened rocket');
    expect(host.querySelector<HTMLButtonElement>('button[title^="Undo the last change"]')?.disabled).toBe(true);
    expect(isPageUntouched()).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it.each(['before tracking', 'during decode'])('V211-3 holds a share import on takeover %s', async mode => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'idle', applying: false });
  let rejectDecode!: (error: Error) => void;
  vi.spyOn(shareLink, 'decodeShareFragment').mockImplementation(() => new Promise((_resolve, reject) => { rejectDecode = reject; }));
  window.history.replaceState(null, '', '/#d=test');
  const replace = window.history.replaceState.bind(window.history);
  const strippedAt: { imports: number; untouched: boolean }[] = [];
  const strip = vi.spyOn(window.history, 'replaceState').mockImplementation((...args) => {
    strippedAt.push({ imports: pageActivity.importsInProgress(), untouched: pageActivity.isUntouched() });
    replace(...args);
  });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  setReloadHold(() => true);
  const s = pendingTakeover(mode === 'before tracking');
  try {
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    expect(strip).toHaveBeenCalledOnce();
    expect(strippedAt).toEqual([{ imports: 1, untouched: false }]);
    expect(pageActivity.importsInProgress()).toBe(1);
    expect(isPageUntouched()).toBe(false);
    expect(isReloadHeld()).toBe(true);
    if (mode === 'during decode') s.container.dispatchEvent(new Event('controllerchange'));
    expect(s.reload).not.toHaveBeenCalled();
    await act(async () => rejectDecode(new Error('invalid link')));
    expect(pageActivity.importsInProgress()).toBe(0);
    expect(isPageUntouched()).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); s.stop(); strip.mockRestore(); replace(null, '', '/'); }
});

it.each(['held design', 'live conflict'])('V211-4/10 holds a mounted clean tab with %s before rerender', async reason => {
  restoreUserDesign();
  dirtyOverride.value = false;
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'idle', applying: false });
  const s = pendingTakeover(false);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    expect(isReloadHeld()).toBe(false);
    if (reason === 'held design') vi.mocked(heldSession).mockReturnValue({} as NonNullable<ReturnType<typeof heldSession>>);
    else vi.mocked(sessionConflicted).mockReturnValue(true);
    expect(isReloadHeld()).toBe(true);
    s.container.dispatchEvent(new Event('controllerchange'));
    expect(s.reload).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); s.stop(); }
});

it.each(['file', 'share'])('V211-3 holds a pending %s offer even after its current design becomes clean', async mode => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'idle', applying: false });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const s = pendingTakeover(false);
  let decode!: (xml: string) => void;
  if (mode === 'share') {
    vi.spyOn(shareLink, 'decodeShareFragment').mockImplementation(() => new Promise(resolve => { decode = resolve; }));
    window.history.replaceState(null, '', '/#d=offer');
  }
  try {
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    await act(async () => host.querySelector<HTMLButtonElement>('.tour-close')?.click());
    const name = host.querySelector<HTMLInputElement>('#rocket-name')!;
    const original = name.value;
    const changeName = (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, value);
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await changeName('Changed for replace offer');
    if (mode === 'file') {
      const picker = host.querySelector<HTMLInputElement>('input[aria-label="Open a design file"]')!;
      Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['bad'], 'offered.ork')] });
      await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })));
      expect(host.textContent).toContain('Save .ork, then open');
    } else {
      await act(async () => {
        decode('<openrocket version="1.10"><rocket><name>Linked design</name><subcomponents><stage><subcomponents>'
          + '<bodytube><length>0.3</length><radius>0.02</radius><thickness>0.001</thickness></bodytube>'
          + '</subcomponents></stage></subcomponents></rocket></openrocket>');
        await vi.waitFor(() => expect(pageActivity.importsInProgress()).toBe(0));
      });
      expect(host.querySelector('[aria-label="Open design from link"]')).not.toBeNull();
    }
    await changeName(original);
    expect(host.textContent).toContain('No unsaved changes');
    expect(isReloadHeld()).toBe(true);
    s.container.dispatchEvent(new Event('controllerchange'));
    expect(s.reload).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); s.stop(); window.history.replaceState(null, '', '/'); }
});

it('V211-10 publishes the committed dirty hold before passive effects', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'unknown' }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'idle', applying: false });
  dirtyOverride.value = false;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const layout = vi.fn();
  function Probe() { useLayoutEffect(() => { layout(isReloadHeld()); }); return null; }
  const render = () => act(async () => root.render(<><PrefsProvider><App /></PrefsProvider><Probe /></>));
  try {
    await render();
    expect(isReloadHeld()).toBe(false);
    layout.mockClear();
    dirtyOverride.value = true;
    await render();
    expect(layout).toHaveBeenCalledWith(true);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('registers the untouched predicate once, however often App renders, and it reads the latest state', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  vi.mocked(useVersionCheck).mockReturnValue({ state: { kind: 'current', version: APP_VERSION }, recheck: vi.fn(), checking: false });
  vi.mocked(useSwUpdate).mockReturnValue({ kind: 'idle', applying: false });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    for (let i = 0; i < 4; i++) await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    await act(async () => host.querySelector<HTMLButtonElement>('.tour-close')?.click());
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    expect(setIsUntouched).toHaveBeenCalledTimes(1);
    expect(isPageUntouched()).toBe(true);
    const imported = pageActivity.startImport();
    expect(isPageUntouched()).toBe(false);
    imported();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
