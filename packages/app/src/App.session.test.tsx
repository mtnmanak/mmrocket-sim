// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import type { SessionState } from './services/session.js';
import { exportOrk } from './services/orkFile.js';

// The real writer, passed through; one test makes a single save throw.
vi.mock('./services/orkFile.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/orkFile.js')>();
  return { ...real, exportOrk: vi.fn(real.exportOrk) };
});
// The real report, unless a test sets `reportThrows` (the boundary test).
let reportThrows = false;
vi.mock('./components/SimResults.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./components/SimResults.js')>();
  return {
    ...real,
    SimRunDetails: (props: Parameters<typeof real.SimRunDetails>[0]) => {
      if (reportThrows) throw new Error('a stored run the report cannot read');
      return <real.SimRunDetails {...props} />;
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no canvas, and the Results tab a Launch lands on draws uPlot
// charts on a rAF tick. The same no-op 2D context FlightCharts.test.tsx uses:
// nothing here is about pixels.
const ctx2d = new Proxy({}, {
  get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 0 }) : () => undefined),
});
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;

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

describe('the 500-run cap is reported (audit 2026-09-22)', () => {
  it('a Launch with 500 runs saved says one old run was removed', async () => {
    const old = Array.from({ length: 500 }, (_, i) => ({ id: `old${i}`, when: i, rocket: 'Old', motor: 'A8-3' }));
    localStorage.setItem('online-openrocket.sim-runs.v1', JSON.stringify(old));
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await act(async () => {
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Launch')!.click();
    });
    await waitFor(() => (JSON.parse(localStorage.getItem('online-openrocket.sim-runs.v1')!) as { id: string }[])
      .some((r) => !r.id.startsWith('old')), 'the flight to be saved');
    await settle(50);
    expect(document.body.textContent).toContain(
      'Saved simulations keeps the newest 500 runs, so the oldest 1 was removed to make room.');
  }, 30000);
});

describe('another tab\'s autosave is not overwritten (audit 2026-09-22)', () => {
  const CONFLICT = 'changed in another tab';

  it('one tab editing, reloading and editing again never raises the conflict', async () => {
    let host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await type(input(host, 'Measured mass'), '31');
    await settle(600);
    await unmountAll();
    host = await mountApp();
    await type(input(host, 'Measured mass'), '32');
    await settle(600);
    expect(host.textContent).not.toContain(CONFLICT);
    expect(storedSession()?.measured?.massKg).toBeCloseTo(0.032, 9);
  }, 30000);

  it('an edit here after another tab wrote holds back, says so, and "Keep" takes the slot', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await settle(600);
    // Another tab of the same origin writes its own design into the slot.
    const other = { ...storedSession()!, stamp: 'othertab' };
    other.tree = { ...other.tree, name: 'The other tab\'s rocket' };
    localStorage.setItem(SESSION_KEY, JSON.stringify(other));

    await type(input(host, 'Measured mass'), '33');
    await settle(600);
    expect(host.textContent).toContain(CONFLICT);
    expect(storedSession()?.tree.name).toBe('The other tab\'s rocket');
    window.dispatchEvent(new Event('pagehide')); // closing the tab flushes — and still holds back
    expect(storedSession()?.tree.name).toBe('The other tab\'s rocket');

    await act(async () => { button(host, 'Keep this tab').click(); });
    expect(storedSession()?.tree.name).toBe('My Rocket');
    expect(storedSession()?.measured?.massKg).toBeCloseTo(0.033, 9);
    expect(host.textContent).not.toContain(CONFLICT);
  }, 30000);
});

describe('Save .ork that throws (audit 2026-09-22)', () => {
  it('says the save failed, leaves the design unsaved, and rejects nothing', async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => { rejections.push(e); };
    process.on('unhandledRejection', onRejection);
    try {
      const host = await mountApp();
      await waitFor(starterStored, 'the starter motor to be autosaved');
      await type(input(host, 'Measured mass'), '34'); // work worth asking about
      vi.mocked(exportOrk).mockImplementationOnce(() => { throw new Error('writer gave up'); });
      await act(async () => { button(host, 'Save As / Export').click(); });
      await act(async () => { button(host, 'Save .ork — OpenRocket design').click(); });
      await settle(50);
      expect(document.body.textContent).toContain('Save .ork failed — nothing was written: writer gave up');
      expect(rejections).toEqual([]);
      // Not marked saved: ✕ New still asks.
      await act(async () => { button(host, '✕ New').click(); });
      expect(host.textContent).toContain('Start a new design?');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  }, 30000);
});

describe('a Results panel that throws stays in its panel (audit 2026-09-22)', () => {
  it('the report says it could not be drawn; the app, the plots and the run table carry on', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportThrows = true;
    try {
      const host = await mountApp();
      await waitFor(starterStored, 'the starter motor to be autosaved');
      await act(async () => {
        [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Launch')!.click();
      });
      await waitFor(() => (host.textContent ?? '').includes('Saved simulations (1)'), 'the flight to be listed');
      expect(host.textContent).toContain('This flight\'s report could not be drawn.');
      expect(host.textContent).toContain('a stored run the report cannot read');
      // Not the whole app: the workspace tabs and the rest of the tab are still there.
      expect(host.textContent).not.toContain('Something went wrong');
      expect([...host.querySelectorAll('[role="tab"]')].length).toBeGreaterThan(0);
      expect(button(host, 'Clear all')).toBeTruthy();
    } finally {
      reportThrows = false;
      errors.mockRestore();
    }
  }, 30000);
});
