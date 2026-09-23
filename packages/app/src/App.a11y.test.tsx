// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { flyLaunch } from './services/flightRunner.js';

/**
 * App-level accessibility from the 2026-09-22 audit (rows 443, 444, 445, 453,
 * 455), read off the App as it renders (row 477). appA11y.test.ts held these
 * as presence guards over App.tsx's text — they caught the wiring being
 * deleted or renamed, never a regression in what it does. Here the landmarks,
 * names and states are read from the DOM, and the one behaviour — what Launch
 * does with focus and the announcement, for a flight that lands, one that
 * repeats it and one that fails — is driven. Row 462, the stats drawer's two
 * halves, is App.render.test.tsx's; the notices' live regions are
 * NoticeBar.test.tsx's.
 *
 * The harness is App.render.test.tsx's: the real TeaVM kernel, the bundled
 * starter motor, fetch stubbed to fail as offline. The flight runner is passed
 * straight through with a handle, so one case can make a flight throw.
 */
vi.mock('./services/flightRunner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/flightRunner.js')>();
  return { ...real, flyLaunch: vi.fn(real.flyLaunch) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no canvas, and a Launch lands on the Results tab's uPlot
// charts (the same stand-in App.session.test.tsx uses).
const ctx2d = new Proxy({}, {
  get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 0 }) : () => undefined),
});
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;

const SESSION_KEY = 'online-openrocket.session.v1';
const RUNS_KEY = 'online-openrocket.sim-runs.v1';

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

/** The whole app on a first visit, once the starter motor has landed and been autosaved. */
async function mountApp(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => { root.render(<PrefsProvider><App /></PrefsProvider>); });
  await waitFor(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw !== null && Object.keys((JSON.parse(raw) as { mountMotors?: object }).mountMotors ?? {}).length > 0;
  }, 'the starter motor to be autosaved');
  return host;
}

/** A workspace tab, pressed. */
async function openTab(host: HTMLElement, name: 'Fly' | 'Design' | 'Motors & Launch' | 'Results'): Promise<void> {
  const b = [...host.querySelectorAll<HTMLButtonElement>('.workspace-tabs button')]
    .find((x) => x.textContent?.trim() === name);
  if (!b) throw new Error(`no tab "${name}"`);
  await act(async () => { b.click(); });
}

/** Launch pressed, and the flight it records saved as the `n`th. */
async function launch(host: HTMLElement, n = 1): Promise<void> {
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Launch')!.click();
  });
  await waitFor(() => (JSON.parse(localStorage.getItem(RUNS_KEY) ?? '[]') as unknown[]).length >= n,
    `flight ${n} to be saved`);
  await settle(0);
}

/** The polite region that says a flight is done (the notices have their own). */
const flightRegion = () => document.querySelector('.sr-only[role="status"][aria-live="polite"]:not(.notice-announce)');

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('online-openrocket.workspace.v1', 'design');
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  vi.mocked(flyLaunch).mockClear();
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

describe('App — accessibility, as rendered', () => {
  /**
   * Row 445: no tablist without the tab pattern. The workspace switch is a
   * <nav> of buttons marking the current one with aria-current="page", and
   * the drawing view is a group of toggle buttons (aria-pressed) — a
   * role="tab" promises arrow-key movement and panels nothing here provides.
   */
  it('row 445: the workspace is a nav that marks the current tab, the view switch a group of toggles — no tab roles', async () => {
    const host = await mountApp();
    const nav = host.querySelector('nav.workspace-tabs')!;
    expect(nav.getAttribute('aria-label')).toBe('Workspace');
    const current = () => [...nav.querySelectorAll('[aria-current]')]
      .map((b) => `${b.textContent?.trim()}=${b.getAttribute('aria-current')}`);
    expect(current()).toEqual(['Design=page']);
    for (const tab of ['Fly', 'Motors & Launch', 'Results', 'Design'] as const) {
      await openTab(host, tab);
      expect(current(), tab).toEqual([`${tab}=page`]);
      expect(document.querySelectorAll('[role="tab"], [role="tablist"], [role="tabpanel"]'), tab).toHaveLength(0);
    }
    const view = host.querySelector('.view-toggle')!;
    expect([view.getAttribute('role'), view.getAttribute('aria-label')]).toEqual(['group', 'Drawing view']);
    const pressed = () => [...view.querySelectorAll('button')]
      .map((b) => `${b.textContent?.trim()}=${b.getAttribute('aria-pressed')}`);
    expect(pressed()).toEqual(['2D=true', '3D=false', 'Aft=false']);
    await act(async () => { [...view.querySelectorAll('button')].find((b) => b.textContent === 'Aft')!.click(); });
    expect(pressed()).toEqual(['2D=false', '3D=false', 'Aft=true']);
  }, 30000);

  /**
   * Rows 453 and 455: the Rocket name box is named by its label, a motor's ✕
   * says which motor it removes and from where (it announced "multiplication
   * x"), and Motors & Launch is a <main> landmark as the other workspaces are.
   */
  it('rows 453 and 455: the name box and the motor ✕ have names; Motors & Launch is a <main>', async () => {
    const host = await mountApp();
    const box = host.querySelector<HTMLInputElement>('#rocket-name')!;
    expect(host.querySelector('label[for="rocket-name"]')?.textContent).toBe('Rocket name');
    expect(box.value).toBe('My Rocket');
    await openTab(host, 'Motors & Launch');
    expect(host.querySelector('.motors-layout')?.tagName).toBe('MAIN');
    const remove = [...host.querySelectorAll('button[title="Remove this motor"]')];
    const mount = host.querySelector('.mount-card label')!.firstChild!.textContent;
    expect(remove.map((b) => b.getAttribute('aria-label'))).toEqual([`Remove C6-5 from ${mount}`]);
  }, 30000);

  /**
   * Row 443: the pressed Launch button unmounts (Motors, Fly) or disables (the
   * vitals strip) as the tab switches to Results, so focus is PUT on the
   * Results <main> — focusable by script, not by Tab — and the finished flight
   * is announced in a polite region that was already mounted, so its first
   * message is heard.
   */
  it('row 443: Launch lands focus on the Results <main> and says the flight is done', async () => {
    const host = await mountApp();
    const region = flightRegion();
    expect(region, 'mounted before any flight').not.toBeNull();
    expect(region!.textContent).toBe('');
    await openTab(host, 'Motors & Launch');
    await launch(host);
    const main = host.querySelector<HTMLElement>('.results-column')!;
    expect(main.tagName).toBe('MAIN');
    expect(main.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(main);
    expect(region!.textContent).toMatch(/^Flight complete — apogee \d+(\.\d+)? m\.$/);
    expect(region!.isConnected).toBe(true);

    // The same design flown again says the same words, and must be heard
    // again: a screen reader reads what is ADDED to a polite region, and the
    // same text left in the same node is no change at all. Each flight's
    // announcement is a new node (keyed per flight in App) — a second flight
    // with the same apogee was silent without it (AUDIT row 477, review).
    const said = region!.textContent;
    const added: string[] = [];
    const note = (ms: MutationRecord[]) => {
      for (const m of ms) for (const n of m.addedNodes) added.push(n.textContent ?? '');
    };
    const watch = new MutationObserver(note);
    watch.observe(region!, { childList: true, subtree: true, characterData: true });
    await openTab(host, 'Motors & Launch');
    await launch(host, 2);
    note(watch.takeRecords());
    watch.disconnect();
    expect(region!.textContent, 'the second flight reached the same apogee').toBe(said);
    expect(added).toContain(said);
  }, 30000);

  /**
   * Row 443 again, for a flight that fails: focus moves BEFORE the flight, so
   * it is on the Results <main> whatever the flight does — the Launch button
   * pressed is gone either way. Moved only on success, a failed Launch left
   * focus on <body> (AUDIT row 477, review). Nothing is announced as done.
   */
  it('row 443: a Launch whose flight fails still lands focus on the Results <main>', async () => {
    const host = await mountApp();
    await openTab(host, 'Motors & Launch');
    vi.mocked(flyLaunch).mockImplementationOnce(() => { throw new Error('the flight failed (test)'); });
    await act(async () => {
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Launch')!.click();
    });
    await waitFor(() => (host.textContent ?? '').includes('the flight failed (test)'), 'the failure to be shown');
    expect(vi.mocked(flyLaunch)).toHaveBeenCalledTimes(1);
    const main = host.querySelector<HTMLElement>('.results-column')!;
    expect(document.activeElement).toBe(main);
    expect(flightRegion()!.textContent).toBe('');
    expect(JSON.parse(localStorage.getItem(RUNS_KEY) ?? '[]')).toEqual([]);
  }, 30000);

  /**
   * Row 444: the vitals apogee's ⚠ is aria-hidden, so what it means is said in
   * words beside it — the same sentence the tooltip carries, so the two cannot
   * differ. A screen reader heard a stale apogee as current.
   */
  it('row 444: a stale apogee carries its reason in words, the same words as its tooltip', async () => {
    const host = await mountApp();
    await launch(host);
    const apogee = () => [...host.querySelectorAll<HTMLElement>('.vitals-item')]
      .find((i) => i.querySelector('.vitals-label')?.textContent === 'Apogee')!;
    expect(apogee().querySelector('.vitals-stale')).toBeNull(); // current: nothing to say
    expect(apogee().title).toBe('Apogee of the most recent flight');
    // The model switched after the flight: the number stays, and belongs to the other model.
    const aero = host.querySelector<HTMLSelectElement>('select[aria-label="Aerodynamics model (this session)"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(aero, 'eb');
      aero.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const why = apogee().title;
    expect(why).toBe('Apogee of the most recent flight, which was flown on Rogers Modified Barrowman (Kbf)'
      + ' — not the model now selected. Press Launch to re-fly it.');
    expect(apogee().querySelector('.vitals-stale')?.getAttribute('aria-hidden')).toBe('true');
    expect(apogee().querySelector('.vitals-value .sr-only')?.textContent).toBe(` — warning: ${why}`);
  }, 30000);
});
