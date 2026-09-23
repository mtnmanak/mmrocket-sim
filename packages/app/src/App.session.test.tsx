// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import type { SessionState } from './services/session.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The whole App, mounted — for the session, saved-mark and autosave behaviour
 * that lives in App's own effects and cannot be reached through a service.
 * About 2.5 s a mount under happy-dom; the kernel is the real TeaVM artifact
 * and the starter motor comes from the bundled curves, so nothing here needs
 * the network (fetch is stubbed to fail, as it would offline).
 */

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
  // pagehide first: it is what flushes the debounced autosave on a real close.
  window.dispatchEvent(new Event('pagehide'));
  for (const { root, host } of mounted) {
    await act(async () => { root.unmount(); });
    host.remove();
  }
  mounted = [];
}

function storedSession(): SessionState | null {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) as SessionState : null;
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const b = [...host.querySelectorAll('button')].find((x) => x.textContent?.includes(text));
  if (!b) throw new Error(`no button "${text}"`);
  return b;
}

/** Starter motor present in the stored session — the async C6 has landed and been autosaved. */
const starterStored = () => Object.keys(storedSession()?.mountMotors ?? {}).length > 0;

function input(host: HTMLElement, ariaLabelStart: string): HTMLInputElement {
  const el = [...host.querySelectorAll('input')]
    .find((i) => i.getAttribute('aria-label')?.startsWith(ariaLabelStart));
  if (!el) throw new Error(`no input "${ariaLabelStart}"`);
  return el;
}

/** Native setter + input event — how React sees a real keystroke. */
async function type(el: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  // Start on the Design tab with the tour off, as a returning desktop user would.
  localStorage.setItem('online-openrocket.workspace.v1', 'design');
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
});

afterEach(async () => {
  await unmountAll();
  vi.unstubAllGlobals();
});

describe('a first visit is clean once the starter motor lands (audit 2026-09-22)', () => {
  it('✕ New on the untouched starter rocket does not ask "Start a new design?"', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await act(async () => { button(host, '✕ New').click(); });
    expect(host.textContent).not.toContain('Start a new design?');
  }, 30000);

  it('and stays clean across a reload', async () => {
    await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await unmountAll();
    const host = await mountApp();
    await settle(600);
    await act(async () => { button(host, '✕ New').click(); });
    expect(host.textContent).not.toContain('Start a new design?');
  }, 30000);

  it('an edit after it lands still asks — the re-seed does not bless work', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await type(input(host, 'Measured mass'), '31');
    await act(async () => { button(host, '✕ New').click(); });
    expect(host.textContent).toContain('Start a new design?');
  }, 30000);
});

describe('✕ New forgets the previous rocket\'s measured mass & CG (audit 2026-09-22)', () => {
  it('clears the box, and the fresh design is saved-clean with it cleared', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await type(input(host, 'Measured mass'), '2000');
    await type(input(host, 'Measured balance point'), '250');
    await act(async () => { button(host, '✕ New').click(); });
    await act(async () => { button(host, 'Discard & start new').click(); });
    await settle(600);
    window.dispatchEvent(new Event('pagehide'));
    // The rocket that was weighed is gone, so is its weighing: the hardware
    // term (services/hardwareMass.ts) would otherwise take 2000 g as the NEW
    // rocket's dry mass.
    expect(storedSession()?.measured).toEqual({ massKg: null, cgM: null });
    // ...and the mark New takes is over THAT, so a second ✕ New does not ask.
    await act(async () => { button(host, '✕ New').click(); });
    expect(host.textContent).not.toContain('Start a new design?');
  }, 30000);
});
