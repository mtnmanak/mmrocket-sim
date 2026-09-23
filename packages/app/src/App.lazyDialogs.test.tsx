// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';

/**
 * THE GUIDE AND THE CHANGELOG STAY OUT OF STARTUP (audit 2026-09-22, row 510).
 * ~730 KB of their source rode in the entry chunk until App.tsx lazy-loaded
 * the two dialogs and the changelog moved out of version.ts. What keeps them
 * out is that no module on the startup path imports either dialog or either
 * text — and any one new import would fold a chunk back in with nothing
 * visibly wrong.
 *
 * Each factory below passes the real module straight through and records
 * that it was asked for. Vitest runs a factory when the module is first
 * imported, not when vi.mock is declared, so an empty record after App has
 * mounted and settled means startup never imported them.
 */
const loaded = vi.hoisted(() => new Set<string>());
vi.mock('./components/GuideDialog.js', async (importOriginal) => {
  loaded.add('GuideDialog');
  return importOriginal();
});
vi.mock('./data/userGuide.js', async (importOriginal) => {
  loaded.add('userGuide');
  return importOriginal();
});
vi.mock('./components/ChangelogDialog.js', async (importOriginal) => {
  loaded.add('ChangelogDialog');
  return importOriginal();
});
vi.mock('./changelog.js', async (importOriginal) => {
  loaded.add('changelog');
  return importOriginal();
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no canvas (the same stub App.session.test.tsx uses).
const ctx2d = new Proxy({}, {
  get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 0 }) : () => undefined),
});
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;

const SESSION_KEY = 'online-openrocket.session.v1';

let mounted: { root: Root; host: HTMLElement }[] = [];
const settle = async (ms = 0) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
async function waitFor(pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await settle(50);
  }
}
/** The starter motor has landed and been autosaved: startup is over. */
const starterStored = (): boolean => {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw !== null && Object.keys((JSON.parse(raw) as { mountMotors?: object }).mountMotors ?? {}).length > 0;
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
});

afterEach(async () => {
  window.dispatchEvent(new Event('pagehide'));
  for (const { root, host } of mounted) {
    await act(async () => { root.unmount(); });
    host.remove();
  }
  mounted = [];
  vi.unstubAllGlobals();
});

describe('App loads the guide and the changelog only when they are opened', () => {
  it('starts without either, and each arrives on its own button', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    await act(async () => { root.render(<PrefsProvider><App /></PrefsProvider>); });
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await settle(50);
    expect([...loaded], 'imported during startup').toEqual([]);

    const dialog = (label: string) => host.querySelector(`[role="dialog"][aria-label="${label}"]`);

    await act(async () => { host.querySelector<HTMLButtonElement>('[data-tour="guide"]')!.click(); });
    await waitFor(() => dialog('User guide')?.classList.contains('guide-dialog') === true, 'the guide');
    expect([...loaded].sort()).toEqual(['GuideDialog', 'userGuide']);
    await act(async () => { dialog('User guide')!.querySelector<HTMLButtonElement>('[aria-label="Close user guide"]')!.click(); });
    expect(dialog('User guide')).toBeNull();

    await act(async () => { host.querySelector<HTMLButtonElement>('.version-badge')!.click(); });
    await waitFor(() => (dialog('Changelog')?.querySelectorAll('.changelog-entry').length ?? 0) > 0, 'the changelog');
    expect([...loaded].sort()).toEqual(['ChangelogDialog', 'GuideDialog', 'changelog', 'userGuide']);
  }, 30000);
});
