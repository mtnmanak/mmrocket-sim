// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import type { TreeHistory } from './hooks/useTreeHistory.js';
import { flyLaunch } from './services/flightRunner.js';
import { MACH_AUTO_THRESHOLD } from './services/machProbe.js';
import { addChild, makeNode, updateNode } from './tree/treeModel.js';

/**
 * The App's live regions exist, empty, before their first message (audit
 * 2026-09-22: "a region inserted with its text already in place is announced
 * unreliably, so the containers exist before their first message"). Each case
 * finds the region, drives the app into the state that fills it, and checks
 * the SAME element now holds the message. jsdom cannot show whether a screen
 * reader speaks; this is the DOM contract only.
 */
let history: TreeHistory;
vi.mock('./hooks/useTreeHistory.js', async importOriginal => {
  const real = await importOriginal<typeof import('./hooks/useTreeHistory.js')>();
  return { ...real, useTreeHistory: (...args: Parameters<typeof real.useTreeHistory>) => {
    history = real.useTreeHistory(...args);
    return history;
  } };
});
// Design notes appended here are added to every build's warningTexts; while
// failBuild is set, every build fails with BUILD_FAILURE instead.
let extraNotes: string[] = [];
let failBuild = false;
const BUILD_FAILURE = 'Live-region test build failure.';
vi.mock('./services/buildDesign.js', async original => {
  const real = await original<typeof import('./services/buildDesign.js')>();
  return { ...real, buildDesign: vi.fn((...args: Parameters<typeof real.buildDesign>) => {
    if (failBuild) return { error: BUILD_FAILURE };
    const result = real.buildDesign(...args);
    if (!('error' in result)) result.info.warningTexts.push(...extraNotes);
    return result;
  }) };
});
vi.mock('./services/flightRunner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/flightRunner.js')>();
  return { ...real, flyLaunch: vi.fn(real.flyLaunch) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ctx2d = new Proxy({}, { get: (_t, prop) => prop === 'measureText' ? () => ({ width: 0 }) : () => undefined });
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;

const SESSION_KEY = 'online-openrocket.session.v1';
const PREFS_KEY = 'online-openrocket.prefs.v1';
const RUNS_KEY = 'online-openrocket.sim-runs.v1';
let host: HTMLDivElement;
let root: Root;

async function settle(ms = 0): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}
async function waitFor(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await settle(25);
  }
}
const starterStored = () => {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw !== null && Object.keys((JSON.parse(raw) as { mountMotors?: object }).mountMotors ?? {}).length > 0;
};
async function mountApp(): Promise<void> {
  await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
  await waitFor(starterStored, 'the starter motor to be autosaved');
}
/** A rename: an edit that rebuilds the design and schedules an autosave. */
async function edit(name: string): Promise<void> {
  await act(async () => history.setTree({ ...history.tree, name }));
}
/** A geometry edit, so the design is built again (a rename alone is not). */
async function reshape(): Promise<void> {
  const tube = (function find(nodes: ComponentNode[]): ComponentNode | null {
    for (const n of nodes) {
      if (n.type === 'bodytube') return n;
      const inner = find(n.children ?? []);
      if (inner) return inner;
    }
    return null;
  })(history.tree.components)!;
  await act(async () => history.setTree(updateNode(history.tree, tube.id!, { length: (tube['length'] as number) * 1.01 })));
}
function button(text: string): HTMLButtonElement {
  const b = [...host.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no button "${text}"`);
  return b;
}
async function openTab(name: 'Design' | 'Results'): Promise<void> {
  const b = [...host.querySelectorAll<HTMLButtonElement>('.workspace-tabs button')]
    .find((x) => x.textContent?.trim() === name)!;
  await act(async () => { b.click(); });
}
/** Every way a storage write can be refused, for keys matching `refuse`. */
function refuseWrites(refuse: (key: string) => boolean): void {
  const own = localStorage.setItem;
  Object.defineProperty(localStorage, 'setItem', { configurable: true, value: (key: string, value: string) => {
    if (refuse(key)) throw new DOMException('full', 'QuotaExceededError');
    return own.call(localStorage, key, value);
  } });
  onTestFinished(() => { Object.defineProperty(localStorage, 'setItem', { configurable: true, value: own }); });
}
/** The live region, asserted present with its role and empty. */
function emptyRegion(selector: string, role: 'alert' | 'status' = 'alert'): Element {
  const region = host.querySelector(selector);
  expect(region, selector).not.toBeNull();
  expect(region!.getAttribute('role')).toBe(role);
  expect(region!.textContent).toBe('');
  return region!;
}

beforeEach(() => {
  extraNotes = [];
  failBuild = false;
  localStorage.clear();
  localStorage.setItem('online-openrocket.workspace.v1', 'design');
  localStorage.setItem(PREFS_KEY, JSON.stringify({ tourOff: true }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  vi.mocked(flyLaunch).mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  window.dispatchEvent(new Event('pagehide'));
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('App header banners — regions mounted before their message', () => {
  it('autosave paused: its region is there, empty, when autosave is not paused', async () => {
    // autosavePaused is only ever true from the first render (a refused
    // restore), so no mid-session transition exists to drive. The region's
    // presence is what this can check.
    await mountApp();
    emptyRegion('.autosave-paused-alert');
  }, 30_000);

  it('autosave can\'t write: the alert lands in the region that was already there', async () => {
    await mountApp();
    const region = emptyRegion('.autosave-failing-alert');
    refuseWrites(key => key === SESSION_KEY);
    await edit('Unsaved storage failure');
    await waitFor(() => !!host.querySelector('.autosave-warn.message-danger'), 'the autosave banner');
    expect(host.querySelector('.autosave-failing-alert')).toBe(region);
    expect(region.textContent).toContain('Autosave can\'t write (storage full or blocked)');
    // The message keeps its own classes; the region carries none of them.
    expect(region.querySelector('.autosave-warn.file-note-error')).not.toBeNull();
    expect(region.classList.contains('autosave-warn')).toBe(false);
  }, 30_000);

  it('another tab\'s write: the conflict lands in the region that was already there', async () => {
    await mountApp();
    await settle(600);
    const region = emptyRegion('.session-conflict-alert');
    const other = JSON.parse(localStorage.getItem(SESSION_KEY)!) as { tree: object };
    localStorage.setItem(SESSION_KEY, JSON.stringify({ ...other, stamp: 'othertab',
      tree: { ...other.tree, name: 'The other tab\'s rocket' } }));
    await edit('This tab\'s rocket');
    await waitFor(() => (host.textContent ?? '').includes('changed in another tab'), 'the conflict banner');
    expect(host.querySelector('.session-conflict-alert')).toBe(region);
    expect(region.textContent).toContain('This design was changed in another tab.');
    expect(region.querySelector('.autosave-warn.message-caution')).not.toBeNull();
  }, 30_000);

  it('preferences not kept: the alert lands in the region that was already there', async () => {
    await mountApp();
    const region = emptyRegion('.prefs-failing-alert');
    refuseWrites(key => key === PREFS_KEY);
    await act(async () => { host.querySelector<HTMLButtonElement>('.hc-toggle')!.click(); });
    await waitFor(() => (host.textContent ?? '').includes('isn\'t keeping your preferences'), 'the preferences banner');
    expect(host.querySelector('.prefs-failing-alert')).toBe(region);
    expect(region.textContent).toContain('This browser isn\'t keeping your preferences');
    expect(region.querySelector('.autosave-warn.file-note-warn')).not.toBeNull();
  }, 30_000);
});

describe('App design notes — one region per tier, mounted with the design', () => {
  // Danger and caution interrupt; an information note waits its turn (owner
  // ruling, row 113 (a)).
  it.each([
    ['danger', '[Warning.NO_RECOVERY_DEVICE]', 'message-danger', 'alert'],
    ['caution', '[Warning.ZERO_AREA_FIN]', 'message-caution', 'alert'],
    ['information', 'A live-region test note.', 'file-note', 'status'],
  ] as const)('the first %s note lands in its tier\'s region', async (tier, text, cls, role) => {
    await mountApp();
    const notes = host.querySelector('#design-notes');
    expect(notes, '#design-notes').not.toBeNull();
    const region = emptyRegion(`#design-notes > .design-notes-${tier}`, role);
    extraNotes = [text];
    await reshape();
    await waitFor(() => (region.textContent ?? '') !== '', `the ${tier} note`);
    expect(host.querySelector('#design-notes')).toBe(notes);
    expect(host.querySelector(`#design-notes > .design-notes-${tier}`)).toBe(region);
    expect(region.querySelector(`.${cls}`)).not.toBeNull();
    // Tiers stay in their order: danger, caution, information, then rail fit.
    expect([...notes!.children].map(c => c.className))
      .toEqual(['design-notes-danger', 'design-notes-caution', 'design-notes-information', 'rail-fit-alert']);
  }, 30_000);

  it('an empty #design-notes is there with no box of its own', async () => {
    await mountApp();
    const notes = host.querySelector<HTMLElement>('#design-notes')!;
    expect(notes.textContent).toBe('');
    expect(notes.getAttribute('class')).toBeNull();
    expect(notes.getAttribute('style')).toBeNull();
    for (const region of notes.children) {
      expect(region.getAttribute('style')).toBeNull();
      expect(region.children).toHaveLength(0);
    }
  }, 30_000);

  it('a build error keeps the regions mounted, and the notes after it land in the same ones', async () => {
    // `built` is null while the design fails to build. #design-notes sat under
    // `{built && …}`, so fixing the edit re-mounted all four regions with
    // their notes already inside.
    await mountApp();
    const notes = host.querySelector('#design-notes');
    const regions = [...notes!.children];
    expect(regions).toHaveLength(4);
    failBuild = true;
    await reshape();
    await waitFor(() => (host.textContent ?? '').includes(BUILD_FAILURE), 'the build error');
    expect(host.querySelector('#design-notes')).toBe(notes);
    expect([...notes!.children]).toEqual(regions);
    for (const region of regions) expect(region.textContent).toBe('');
    failBuild = false;
    extraNotes = ['[Warning.NO_RECOVERY_DEVICE]', '[Warning.ZERO_AREA_FIN]', 'A live-region test note.'];
    await reshape();
    await waitFor(() => regions.slice(0, 3).every((r) => (r.textContent ?? '') !== ''), 'the notes');
    expect(host.querySelector('#design-notes')).toBe(notes);
    for (const [i, region] of regions.entries()) expect(notes!.children[i]).toBe(region);
    expect(regions[0]!.querySelector('.message-danger')).not.toBeNull();
    expect(regions[1]!.querySelector('.message-caution')).not.toBeNull();
    expect(regions[2]!.querySelector('.file-note')).not.toBeNull();
  }, 30_000);

  it('the first rail-fit finding lands in the region that was already there', async () => {
    await mountApp();
    // Polite: a fit finding changes no flight number (owner ruling, row 113 (a)).
    const region = emptyRegion('#design-notes > .rail-fit-alert', 'status');
    const withFins = (nodes: ComponentNode[]): ComponentNode | null => {
      for (const n of nodes) {
        if ((n.children ?? []).some((k) => (k.type as string).endsWith('finset'))) return n;
        const inner = withFins(n.children ?? []);
        if (inner) return inner;
      }
      return null;
    };
    const tube = withFins(history.tree.components)!;
    const fins = tube.children!.find((k) => (k.type as string).endsWith('finset'))!;
    const rail = { ...makeNode('railbutton'), id: 'rb-live', name: 'Fwd button',
      angleOffset: (fins['rotation'] as number | undefined) ?? 0 } as ComponentNode;
    await act(async () => history.setTree(addChild(history.tree, tube.id!, rail)));
    await waitFor(() => (region.textContent ?? '') !== '', 'the rail-fit finding');
    expect(host.querySelector('#design-notes > .rail-fit-alert')).toBe(region);
    expect(region.querySelector('.rail-fit-findings')?.textContent).toMatch(/^Rail fit on the pad/);
  }, 30_000);
});

describe('App results column — regions toggled to sr-only while empty', () => {
  it('the classic-model Mach warning lands in the region that was already there', async () => {
    await mountApp();
    const aero = host.querySelector<HTMLSelectElement>('.vitals-aero-select')!;
    await act(async () => { aero.value = 'eb'; aero.dispatchEvent(new Event('change', { bubbles: true })); });
    const real = vi.mocked(flyLaunch).getMockImplementation()!;
    vi.mocked(flyLaunch).mockImplementationOnce(async (...args) => {
      const flight = await real(...args);
      return { ...flight, result: { ...flight.result,
        summary: { ...flight.result.summary, maxMachNumber: MACH_AUTO_THRESHOLD + 0.3 } } };
    });
    await openTab('Results');
    const region = emptyRegion('.results-column > .mach-warn-alert');
    // In the column's flex gap, so it is out of the flow while empty.
    expect(region.classList.contains('sr-only')).toBe(true);
    await act(async () => { button('Launch').click(); });
    await waitFor(() => (region.textContent ?? '').includes('on the classic aero model'), 'the Mach warning');
    expect(host.querySelector('.results-column > .mach-warn-alert')).toBe(region);
    expect(region.classList.contains('sr-only')).toBe(false);
    expect(region.querySelector('.file-note.file-note-warn')).not.toBeNull();
  }, 30_000);

  it('a run that could not be saved: the warning lands in the region that was already there', async () => {
    await mountApp();
    await openTab('Results');
    const region = emptyRegion('.results-column > .runs-quota-alert');
    expect(region.classList.contains('sr-only')).toBe(true);
    refuseWrites(key => key === RUNS_KEY);
    await act(async () => { button('Launch').click(); });
    await waitFor(() => (region.textContent ?? '').includes('could not be'), 'the run-history warning');
    expect(host.querySelector('.results-column > .runs-quota-alert')).toBe(region);
    expect(region.classList.contains('sr-only')).toBe(false);
    expect(region.querySelector('.file-note.message-danger')).not.toBeNull();
  }, 30_000);
});
