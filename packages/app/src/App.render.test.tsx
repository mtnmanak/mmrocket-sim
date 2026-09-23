// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { findAllowance } from './services/buildAllowance.js';
import { classLabel } from './services/motorDb.js';
import { nozzleOversize } from './services/nozzleCheck.js';
import { designMatchKeyOf } from './services/simReport.js';

/**
 * App, rendered — for what App itself decides: which of its memos a keystroke
 * re-runs, and what its layout and gates put on screen. The behavioural
 * replacements for the regexes statsDrawerDefault.test.ts, panelHeadWrap.test.ts
 * and noticeBarPhoneLift.test.ts used to run over App.tsx's text (audit
 * 2026-09-22, row 477). The same harness as App.session.test.tsx: the real
 * TeaVM kernel, the bundled starter motor, fetch stubbed to fail as offline.
 *
 * The four spies below pass straight through to the real functions. Each is
 * called, on the Design tab, by exactly ONE of App's memos — which is what
 * lets a count of its calls stand for "that memo re-ran".
 */
vi.mock('./services/buildAllowance.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/buildAllowance.js')>();
  return { ...real, findAllowance: vi.fn(real.findAllowance) };
});
vi.mock('./services/nozzleCheck.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/nozzleCheck.js')>();
  return { ...real, nozzleOversize: vi.fn(real.nozzleOversize) };
});
vi.mock('./services/simReport.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/simReport.js')>();
  return { ...real, designMatchKeyOf: vi.fn(real.designMatchKeyOf) };
});
vi.mock('./services/motorDb.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/motorDb.js')>();
  return { ...real, classLabel: vi.fn(real.classLabel) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no canvas; the Results tab draws uPlot charts. Nothing here is
// about pixels (the same stand-in App.session.test.tsx uses).
const ctx2d = new Proxy({}, {
  get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 0 }) : () => undefined),
});
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;

const SESSION_KEY = 'online-openrocket.session.v1';

let mounted: { root: Root; host: HTMLElement }[] = [];

async function settle(ms = 0): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

async function waitFor(pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await settle(50);
  }
}

async function mountApp(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => { root.render(<PrefsProvider><App /></PrefsProvider>); });
  return host;
}

async function unmountAll(): Promise<void> {
  window.dispatchEvent(new Event('pagehide'));
  for (const { root, host } of mounted) {
    await act(async () => { root.unmount(); });
    host.remove();
  }
  mounted = [];
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const b = [...host.querySelectorAll('button')].find((x) => x.textContent?.includes(text));
  if (!b) throw new Error(`no button "${text}"`);
  return b;
}

/** Native setter + input event — how React sees a real keystroke. */
async function type(el: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The starter motor has landed and been autosaved: the app is settled. */
const starterStored = (): boolean => {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw !== null && Object.keys((JSON.parse(raw) as { mountMotors?: object }).mountMotors ?? {}).length > 0;
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('online-openrocket.workspace.v1', 'design');
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
});

afterEach(async () => {
  await unmountAll();
  vi.unstubAllGlobals();
});

/**
 * THE ROCKET NAME IS NOT PHYSICS (audit 2026-09-22, row 513). The name field
 * does `setTree({ ...tree, name })` on every keystroke — a fresh `tree` around
 * the SAME components array — so a memo keyed on the whole tree re-ran per
 * character for a field that cannot change its answer. f5a4993 narrowed four
 * of the nine the 8 September audit named; these are the other five (the
 * allowance lookup, the pin check beside it, the notice list, the mount-size
 * chips and the provenance key — whose new identity also re-ran the saved-run
 * matching behind it).
 */
describe('a keystroke in the Rocket name re-runs none of the design memos', () => {
  const spies = () => ({
    allowance: vi.mocked(findAllowance).mock.calls.length,
    notices: vi.mocked(nozzleOversize).mock.calls.length,
    provenance: vi.mocked(designMatchKeyOf).mock.calls.length,
    mountSizes: vi.mocked(classLabel).mock.calls.length,
  });

  it('renames on screen, and runs each of them again only when the design itself changes', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await settle(50);
    const before = spies();
    // Each spy stands for a memo that DID run at mount — else a zero proves nothing.
    for (const [memo, n] of Object.entries(before)) expect(n, memo).toBeGreaterThan(0);

    const name = host.querySelector<HTMLInputElement>('#rocket-name')!;
    await type(name, 'Renamed rocket');
    await type(name, 'Renamed rocket 2');
    await settle(50);
    // The rename reached the screen — the app re-rendered around it…
    expect(host.querySelector('.vitals-item-name .vitals-value')?.textContent).toBe('Renamed rocket 2');
    // …and none of the five memos ran for it.
    expect(spies()).toEqual(before);

    // The control: new components run every one of them again. ✕ New, then
    // Undo — the empty design has no mount for the size chips to size, and the
    // undone starter rocket does.
    await act(async () => { button(host, '✕ New').click(); });
    await act(async () => { button(host, 'Discard & start new').click(); });
    await settle(50);
    await act(async () => { button(host, '↩ Undo').click(); });
    await settle(50);
    expect(host.querySelector('.mount-size-chip')).not.toBeNull(); // the starter's mount is back
    const after = spies();
    for (const memo of Object.keys(before) as (keyof typeof before)[]) {
      expect(after[memo], memo).toBeGreaterThan(before[memo]);
    }
  }, 30000);
});
