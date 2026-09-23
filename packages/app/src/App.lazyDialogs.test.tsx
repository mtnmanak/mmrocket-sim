// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppRoot } from './root.js';

/**
 * THE GUIDE AND THE CHANGELOG STAY OUT OF STARTUP (audit 2026-09-22, row 510).
 * ~730 KB of their source rode in the entry chunk until App.tsx lazy-loaded
 * the two dialogs and the changelog moved out of version.ts. What keeps them
 * out is that no module on the startup path imports either dialog or either
 * text — and any one new import would fold a chunk back in with nothing
 * visibly wrong.
 *
 * Each factory below records that its module was asked for. Vitest runs a
 * factory when the module is first imported, not when vi.mock is declared, so
 * an empty record once the app has mounted and settled means startup never
 * imported them. It mounts AppRoot, the tree main.tsx mounts — root.tsx,
 * AppBoundary and what they import, not App alone, which let an import from
 * root.tsx pass (from review). main.tsx itself registers the service worker
 * and mounts into the page, so no test runs it; the build checks the entry
 * chunk for its imports and everyone else's (scripts/lazy-chunks.mjs).
 *
 * The factories also hold each dialog's import until the test lets it go, so
 * what App shows while a dialog loads can be looked at, and the changelog's
 * import then FAILS as a chunk the network could not deliver. Both check App's
 * own wiring, which LazyDialog.test.tsx cannot: that each dialog is wrapped in
 * LazyDialog, under its own name and in its own box — with no boundary there, a
 * failed download reaches AppBoundary and replaces the whole app.
 *
 * The gates hold only once the test has ARMED them, after the startup check.
 * An unarmed hold would turn the regression this file exists for — a static
 * import of either dialog — into a hang with no output: the factory would run
 * while this file's own import of root.js was being evaluated, and nothing
 * would ever open its gate (re-verification of v0.141). Unarmed, the factories
 * pass the real modules through, and the startup check names them in 5 s.
 */
const hold = vi.hoisted(() => {
  const gate = () => {
    let open!: () => void;
    const shut = new Promise<void>((r) => { open = r; });
    return { shut, open };
  };
  return { loaded: new Set<string>(), armed: false, guide: gate(), changelog: gate() };
});
vi.mock('./components/GuideDialog.js', async (importOriginal) => {
  hold.loaded.add('GuideDialog');
  if (hold.armed) await hold.guide.shut;
  return importOriginal();
});
vi.mock('./data/userGuide.js', async (importOriginal) => {
  hold.loaded.add('userGuide');
  return importOriginal();
});
vi.mock('./components/ChangelogDialog.js', async (importOriginal) => {
  hold.loaded.add('ChangelogDialog');
  if (!hold.armed) return importOriginal();
  await hold.changelog.shut;
  // Thrown where App's lazy() reads the export, not by the factory: vitest
  // wraps a factory's throw in a message of its own, and App's import must
  // reject with Chrome's words for a chunk it could not fetch, as it does at a
  // field with no signal (isChunkLoadError).
  return {
    get ChangelogDialog(): never {
      throw new TypeError('Failed to fetch dynamically imported module: '
        + 'https://example.test/assets/ChangelogDialog-x.js');
    },
  };
});
vi.mock('./changelog.js', async (importOriginal) => {
  hold.loaded.add('changelog');
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
  vi.restoreAllMocks();
});

describe('App loads the guide and the changelog only when they are opened', () => {
  it('starts without either; each stands in while it loads; a failed download stays in its dialog', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    await act(async () => { root.render(<AppRoot />); });
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await settle(50);
    expect([...hold.loaded], 'imported during startup').toEqual([]);
    hold.armed = true;

    const dialogs = () => [...host.querySelectorAll<HTMLElement>('[role="dialog"]')];
    const dialog = (label: string) => host.querySelector<HTMLElement>(`[role="dialog"][aria-label="${label}"]`);

    // The guide: the stand-in, under the guide's name and in its box, until it arrives.
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-tour="guide"]')!.click(); });
    await waitFor(() => hold.loaded.has('GuideDialog'), 'the guide to be asked for');
    expect(dialogs()).toHaveLength(1);
    expect(dialog('User guide')?.getAttribute('aria-busy')).toBe('true');
    expect(dialog('User guide')?.className).toBe('guide-dialog panel');
    expect(dialog('User guide')?.querySelector('[role="status"]')?.textContent).toBe('Loading the user guide…');
    hold.guide.open();
    await waitFor(() => dialog('User guide')?.querySelector('.guide-header') != null, 'the guide');
    expect(dialogs()).toHaveLength(1);
    expect(dialog('User guide')!.hasAttribute('aria-busy')).toBe(false);
    expect([...hold.loaded].sort()).toEqual(['GuideDialog', 'userGuide']);
    await act(async () => { dialog('User guide')!.querySelector<HTMLButtonElement>('[aria-label="Close user guide"]')!.click(); });
    expect(dialogs()).toHaveLength(0);

    // The changelog: the stand-in, then a download that fails. The notice is
    // the changelog's own dialog, and the app is still there around it.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => { host.querySelector<HTMLButtonElement>('.version-badge')!.click(); });
    await waitFor(() => hold.loaded.has('ChangelogDialog'), 'the changelog to be asked for');
    expect(dialogs()).toHaveLength(1);
    expect(dialog('Changelog')?.getAttribute('aria-busy')).toBe('true');
    expect(dialog('Changelog')?.className).toBe('prefs-dialog panel');
    expect(dialog('Changelog')?.querySelector('[role="status"]')?.textContent).toBe('Loading the changelog…');
    hold.changelog.open();
    // Whichever comes first: the notice, or a boundary further up — AppBoundary's
    // page-wide fallback or a panel's (both are .hero-fallback).
    await waitFor(() => dialog('Changelog')?.hasAttribute('aria-busy') === false
      || host.querySelector('.hero-fallback') !== null, 'the failure to be caught');
    expect(host.querySelector('.hero-fallback'), 'no boundary above LazyDialog caught it').toBeNull();
    expect(host.querySelector('[data-tour="guide"]'), 'the app is still there').not.toBeNull();
    expect(dialogs()).toHaveLength(1);
    const notice = dialog('Changelog')!;
    expect(notice.textContent).toContain('The changelog could not be downloaded.');
    expect([...notice.querySelectorAll('button')].map((b) => b.textContent))
      .toEqual(['✕ Close', '↻ Reload the page']);
    expect(logged).toHaveBeenCalledWith('Changelog failed to open:', expect.any(TypeError), expect.any(String));
    expect(hold.loaded.has('changelog'), 'the text never arrived').toBe(false);
    await act(async () => { notice.querySelector<HTMLButtonElement>('[aria-label="Close changelog"]')!.click(); });
    expect(dialogs()).toHaveLength(0);
  }, 30000);
});
