// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { APP_VERSION } from './version.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { useVersionCheck } from './services/versionCheck.js';
import { applyUpdate, isPageUntouched, setIsUntouched, useSwUpdate } from './services/swUpdate.js';
import { createPageActivity, pageActivity } from './services/pageActivity.js';
import * as shareLink from './services/shareLink.js';
import * as importApply from './services/importApply.js';

vi.mock('./services/versionCheck.js', async original => ({
  ...await original<typeof import('./services/versionCheck.js')>(), useVersionCheck: vi.fn(),
}));
vi.mock('./services/swUpdate.js', async original => {
  const real = await original<typeof import('./services/swUpdate.js')>();
  return { ...real, useSwUpdate: vi.fn(), applyUpdate: vi.fn(), setIsUntouched: vi.fn(real.setIsUntouched) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => { Object.assign(pageActivity, createPageActivity()); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); localStorage.clear(); });

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

it('marks the share import before stripping its fragment and releases it on failure', async () => {
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
  try {
    await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
    expect(strip).toHaveBeenCalledOnce();
    expect(strippedAt).toEqual([{ imports: 1, untouched: false }]);
    expect(pageActivity.importsInProgress()).toBe(1);
    expect(isPageUntouched()).toBe(false);
    await act(async () => rejectDecode(new Error('invalid link')));
    expect(pageActivity.importsInProgress()).toBe(0);
    expect(isPageUntouched()).toBe(false);
  } finally { await act(async () => root.unmount()); host.remove(); strip.mockRestore(); replace(null, '', '/'); }
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
