// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from './App.js';
import { DEFAULT_CONDITIONS } from './components/LaunchPanel.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { loadCatalogueMotor } from './services/motorMatch.js';
import { exportOrk } from './services/orkFile.js';
import { saveFile, type SaveOutcome } from './services/saveFile.js';
import type { SessionState } from './services/session.js';
import { decodeShareFragment, encodeShareFragment } from './services/shareLink.js';
import { defaultTree, motorMounts } from './tree/treeModel.js';
import { APP_VERSION } from './version.js';

/**
 * WHICH ACTIONS MAY SAY "THIS DESIGN IS SAVED", AND WHAT App HANDS THE UNITS
 * THOSE ACTIONS RUN THROUGH (audit 2026-09-22, row 477). savedMarkSites.test.ts
 * held all of this as regexes over App.tsx — a count of `markSaved` sites, the
 * text of the .ork save's guard, the absence of a mark in two export handlers
 * and the share link, and six hand-offs to importApply, session and
 * useTreeHistory — and a regex stays green while the behaviour it names is
 * wrong. Here the whole App is mounted and each action is taken the way a user
 * takes it; whether the design is saved is read the way a user meets it: ✕ New
 * asks "Start a new design?" only over work no file on disk has.
 *
 * The harness is App.render.test.tsx's: the real TeaVM kernel, the bundled
 * catalogue and curves, fetch stubbed to fail as offline. Four modules keep
 * everything real but one function each. The file writer's is REPLACED: a
 * stub that reports a download without making one, which a test can hold open
 * (the Save-As picker) or cancel — so what App hands saveFile is not checked
 * here beyond the name the save line reports. The other three are passed
 * straight through with a handle, and none changes what its function does: the
 * .ork writer (to read what a Save wrote), the starter motor's loader and the
 * share link's decoder (each an await a test can hold, so an action can land
 * inside it).
 */
vi.mock('./services/saveFile.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/saveFile.js')>();
  return {
    ...real,
    saveFile: vi.fn(async (_data: BlobPart, o: { suggestedName: string }): Promise<SaveOutcome> =>
      ({ kind: 'downloaded', name: o.suggestedName })),
  };
});
vi.mock('./services/orkFile.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/orkFile.js')>();
  return { ...real, exportOrk: vi.fn(real.exportOrk) };
});
vi.mock('./services/motorMatch.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/motorMatch.js')>();
  return { ...real, loadCatalogueMotor: vi.fn(real.loadCatalogueMotor) };
});
vi.mock('./services/shareLink.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/shareLink.js')>();
  return { ...real, decodeShareFragment: vi.fn(real.decodeShareFragment) };
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

const here = dirname(fileURLToPath(import.meta.url));
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

/** The starter motor has landed and been autosaved: a first visit is settled. */
const starterStored = () => Object.keys(storedSession()?.mountMotors ?? {}).length > 0;

function button(host: ParentNode, text: string): HTMLButtonElement {
  const b = [...host.querySelectorAll('button')].find((x) => x.textContent?.includes(text));
  if (!b) throw new Error(`no button "${text}"`);
  return b;
}

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

/** The rocket's name as the vitals strip shows it, on every tab. */
const shownName = (host: HTMLElement) => host.querySelector('.vitals-item-name .vitals-value')?.textContent;

/** A workspace tab, pressed. */
async function openTab(host: HTMLElement, name: 'Design' | 'Motors & Launch' | 'Results'): Promise<void> {
  const b = [...host.querySelectorAll<HTMLButtonElement>('.workspace-tabs button')]
    .find((x) => x.textContent?.trim() === name);
  if (!b) throw new Error(`no tab "${name}"`);
  await act(async () => { b.click(); });
}

/**
 * IS THE DESIGN GUARDED AS UNSAVED WORK? ✕ New asks "Start a new design?" only
 * over work a file on disk does not have (hooks/useDesignDirty.ts) — the same
 * answer the Open prompt reads. A question is cancelled, so the design stays
 * for the next step; with nothing to lose ✕ New goes straight through, and the
 * design on screen is replaced by an empty one.
 */
async function guarded(host: HTMLElement): Promise<boolean> {
  await act(async () => { button(host, '✕ New').click(); });
  if (!(host.textContent ?? '').includes('Start a new design?')) return false;
  const modal = [...document.querySelectorAll('.modal-actions')]
    .find((m) => m.textContent?.includes('Discard & start new'))!;
  await act(async () => { button(modal, 'Cancel').click(); });
  return true;
}

/** An entry of the header's Save As / Export menu, pressed. */
async function saveAs(host: HTMLElement, entry: string): Promise<void> {
  await act(async () => { button(host, 'Save As / Export').click(); });
  await act(async () => { button(host.querySelector('.file-menu')!, entry).click(); });
}

/** `file` chosen in the header's Open… picker, as a user choosing it does. */
async function pick(host: HTMLElement, file: File): Promise<void> {
  const picker = input(host, 'Open a design file');
  Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
  await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })); });
}

/**
 * A design file whose bytes arrive only when `release` is called: an open held
 * at its first await, so something else can happen while it is in flight.
 */
function heldFile(text: string, name: string): { file: File; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const file = new File([text], name);
  const bytes = file.arrayBuffer.bind(file);
  Object.defineProperty(file, 'arrayBuffer', { value: async () => { await gate; return bytes(); } });
  return { file, release };
}

const fixture = (name: string) => readFileSync(join(here, 'services', '__fixtures__', name), 'utf8');
/** rocksimTestRocket1.rkt opens as “FooBar Test”, with no launch conditions of its own. */
const RKT = 'rocksimTestRocket1.rkt';
const RKT_NAME = 'FooBar Test';

beforeEach(() => {
  localStorage.clear();
  // Start on the Design tab with the tour off, as a returning desktop user would.
  localStorage.setItem('online-openrocket.workspace.v1', 'design');
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  vi.mocked(saveFile).mockClear();
  vi.mocked(exportOrk).mockClear();
});

afterEach(async () => {
  await unmountAll();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', window.location.pathname);
});

/**
 * ONLY A FULL-FIDELITY SAVE CLEARS THE GUARD. The .rkt and .CDX1 exports are
 * LOSSY (RockSim drops launch conditions, flight configurations and the
 * measured mass/CG; RASAero keeps launch but drops configurations, measured and
 * flight data), the 3D and table exports are not designs at all, and a share
 * link puts nothing on disk — marking any of them would let the next Open
 * discard exactly what the file does not hold. savedMarkSites.test.ts counted
 * `markSaved` in App.tsx's text (three) and searched two handlers and the share
 * link for it; here every entry of the Save As / Export menu is pressed, read
 * off the menu itself so an entry added later is swept too, and so are the
 * actions that fly. The count is the lint gate's now (eslint.config.mjs
 * refuses any `markSaved` in App.tsx beyond the three reasoned sites): a mark
 * added to an action no test here drives passes every behavioural test, as
 * one on Launch did before the flight case below (AUDIT row 477, review).
 */
describe('only a full-fidelity save clears the unsaved-work guard', () => {
  it('every Save As / Export entry but Save .ork — the share link among them — leaves the design unsaved', async () => {
    const writeText = vi.fn(async (_url: string) => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      const host = await mountApp();
      await waitFor(starterStored, 'the starter motor to be autosaved');
      await type(input(host, 'Measured mass'), '31'); // work worth asking about
      await act(async () => { button(host, 'Save As / Export').click(); });
      const entries = [...host.querySelectorAll('.file-menu button')].map((b) => b.textContent!.trim());
      await act(async () => { button(host, 'Save As / Export').click(); }); // shut it again
      const others = entries.filter((e) => !e.startsWith('Save .ork'));
      // Swept from the menu, so an entry added later is swept too; these are
      // the eight there today, lossy or not a design at all.
      expect(entries.length - others.length).toBe(1);
      expect(others).toEqual(expect.arrayContaining([
        '🔗 Copy share link', 'Save .rkt — RockSim', 'Save .CDX1 — RASAero II', 'Export .obj — 3D geometry',
        'Export .glb — 3D model with colors', 'Export .stl — 3D shell (reference)', 'Export .csv — component data',
        'Export .xlsx — component data',
      ]));
      for (const entry of others) {
        const wrote = () => vi.mocked(saveFile).mock.calls.length + writeText.mock.calls.length;
        const before = wrote();
        await saveAs(host, entry);
        // Each one really wrote (or copied) — a throw would pass vacuously.
        await waitFor(() => wrote() > before, `“${entry}” to write`);
        await settle(0);
        expect(await guarded(host), `“${entry}” must not clear the unsaved-work guard`).toBe(true);
      }
      // The control: the one full-fidelity save does clear it.
      await saveAs(host, 'Save .ork');
      await settle(0);
      expect(await guarded(host)).toBe(false);
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  }, 30000);

  it('a Save .ork cancelled at the picker leaves the design unsaved; one that writes clears it', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await type(input(host, 'Measured mass'), '31');
    vi.mocked(saveFile).mockResolvedValueOnce({ kind: 'cancelled' });
    await saveAs(host, 'Save .ork');
    await settle(0);
    expect(vi.mocked(saveFile)).toHaveBeenCalledTimes(1);
    expect(await guarded(host)).toBe(true);
    await saveAs(host, 'Save .ork');
    await settle(0);
    expect(await guarded(host)).toBe(false);
  }, 30000);

  /**
   * The Save-As picker can sit open indefinitely with the user editing behind
   * it. The mark is the design the file holds — taken when Save was pressed —
   * so an edit made while the picker is open is still unsaved work once it
   * writes. (savedMarkSites.test.ts held this as a regex: no `await` between
   * planOrkSave and the download.)
   */
  it('an edit made while the Save-As picker is open is still unsaved once the file is written', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await type(input(host, 'Measured mass'), '31');
    let written!: (o: SaveOutcome) => void;
    vi.mocked(saveFile).mockImplementationOnce(() => new Promise<SaveOutcome>((r) => { written = r; }));
    await saveAs(host, 'Save .ork');
    await waitFor(() => vi.mocked(saveFile).mock.calls.length === 1, 'the picker to open');
    await type(input(host, 'Measured mass'), '32'); // behind the open picker
    await act(async () => { written({ kind: 'saved', name: 'My Rocket.ork' }); });
    await settle(0);
    // The file holds 31 g; the screen says 32.
    expect(vi.mocked(exportOrk).mock.calls.at(-1)![0].measured?.massKg).toBeCloseTo(0.031, 9);
    expect(await guarded(host)).toBe(true);
    // Saved again, with nothing moving behind it, the 32 g design is saved.
    await saveAs(host, 'Save .ork');
    await settle(0);
    expect(await guarded(host)).toBe(false);
  }, 30000);

  /**
   * Nor does flying it. A Launch records a run, and the flight-data export and
   * a history row's "📈 Charts" re-fly one; none writes a design file. A mark
   * after Launch's markFlown passed the whole suite until this case (AUDIT
   * row 477, review): the typed 31 g and the flight were then discarded by
   * the next Open without a question.
   */
  it('a Launch, its flight-data export and a Show-charts re-fly leave the design unsaved', async () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const host = await mountApp();
    const runs = () => (JSON.parse(localStorage.getItem(RUNS_KEY) ?? '[]') as unknown[]).length;
    const launch = async (n: number) => {
      await act(async () => {
        [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Launch')!.click();
      });
      await waitFor(() => runs() === n, `flight ${n} to be saved`);
      await settle(0);
    };
    /** ✕ New lives in the Design workspace's header; a flight lands on Results. */
    const guardedOnDesign = async () => { await openTab(host, 'Design'); return guarded(host); };
    try {
      await waitFor(starterStored, 'the starter motor to be autosaved');
      await type(input(host, 'Measured mass'), '31');
      await launch(1);
      expect(await guardedOnDesign(), 'after Launch').toBe(true);
      // A second flight, so the first is a stored run with no plots in memory.
      await launch(2);
      await act(async () => { button(host, '⬇ Flight data (.csv)').click(); });
      await waitFor(() => created.mock.calls.length > 0, 'the flight data to download');
      await settle(0);
      expect(await guardedOnDesign(), 'after the flight-data export').toBe(true);
      await openTab(host, 'Results');
      const history = [...host.querySelectorAll('h2')]
        .find((h) => h.textContent?.startsWith('Saved simulations'))!.parentElement!;
      await act(async () => { button(history, 'Show').click(); });
      await act(async () => { button(host, '📈 Charts').click(); });
      await waitFor(() => ![...host.querySelectorAll('button')].some((b) => b.textContent?.includes('📈 Charts')),
        'the re-fly to draw its charts');
      await settle(0);
      expect(await guardedOnDesign(), 'after the Show-charts re-fly').toBe(true);
    } finally {
      created.mockRestore();
      revoked.mockRestore();
    }
  }, 30000);
});

/**
 * AN OPEN AND ✕ NEW LEAVE A SAVED DESIGN: the design on screen IS the file on
 * disk, or is an empty design nobody would mind losing. Both marks are taken
 * in services/importApply.ts from the plan App writes (tested there by what
 * they do); these are App handing the plan its mark and the launch conditions
 * the plan merges.
 */
describe('an open and ✕ New leave a design that reads saved', () => {
  it('an opened file reads saved, and so does the empty design ✕ New leaves', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await type(input(host, 'Measured mass'), '31');
    await pick(host, new File([fixture(RKT)], RKT));
    await act(async () => { button(document.body, 'Open without saving').click(); });
    await waitFor(() => shownName(host) === RKT_NAME, 'the file to open');
    // ✕ New goes straight through — nothing to lose — and leaves an empty design…
    expect(await guarded(host)).toBe(false);
    expect(shownName(host)).not.toBe(RKT_NAME);
    // …which reads saved too: a second ✕ New does not ask about it.
    expect(await guarded(host)).toBe(false);
  }, 30000);

  /**
   * A WIND TYPED WHILE A FILE OPENS (audit 2026-09-22, row 304). Opening is
   * asynchronous; the open's own closure holds the launch conditions of the
   * render that started it. App hands the plan the launch as it stands after
   * the open's last await, so the typed wind is kept AND is in the mark. (The
   * render's copy loses the wind — savedMarkSites.test.ts held the hand-off as
   * a string match.) A .rkt carries no launch conditions, so nothing in the
   * file competes with the wind.
   */
  it('keeps a wind typed while a file is opening, and the opened design reads saved', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await openTab(host, 'Motors & Launch');
    const held = heldFile(fixture(RKT), RKT);
    await pick(host, held.file); // clean first visit: opens with no question
    await type(input(host, 'Wind avg'), '8');
    await act(async () => { held.release(); });
    await waitFor(() => shownName(host) === RKT_NAME, 'the file to open');
    expect(input(host, 'Wind avg').value).toBe('8');
    await openTab(host, 'Design');
    expect(await guarded(host)).toBe(false);
  }, 30000);
});

/**
 * THE AUTOSAVE KEEPS A FILE'S UNRESOLVED MOTOR REFERENCES (audit 2026-09-22,
 * row 299). A file naming a motor the catalogue lacks keeps the reference so
 * Save .ork writes it back instead of an empty mount. With no flight
 * configuration to hold it — here a .ork declaring none, which the reader
 * takes as a hand-rolled file — the working set is its only copy, and a reload
 * used to lose it. App writes it with the autosave and reads it back at
 * restore (services/configSync.ts restoreUnmatchedRefs, tested there);
 * savedMarkSites.test.ts held both hand-offs as regexes. The autosave effect's
 * dependency list, which it also matched, is the lint gate's: removing
 * `unmatchedRefs` from it is a react-hooks/exhaustive-deps warning, and the
 * deploy runs lint with --max-warnings 0.
 */
describe('a reload keeps the motor a file names but the catalogue lacks', () => {
  it('survives a reload, and Save .ork writes it back', async () => {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!;
    const xml = exportOrk({
      name: 'Unresolved', tree: { ...tree, name: 'Unresolved' },
      motors: { [mount.id!]: { designation: 'ZQ9999X', manufacturer: 'AeroTech', diameter: 0.018, length: 0.07, delay: 5 } },
    }).replace(/<motorconfiguration\b[\s\S]*?<\/motorconfiguration>/g, '');
    vi.mocked(exportOrk).mockClear();
    let host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await pick(host, new File([xml], 'Unresolved.ork'));
    await waitFor(() => shownName(host) === 'Unresolved', 'the file to open');
    await settle(600);
    await unmountAll();
    // No configuration anywhere to fall back on: only the session holds it.
    expect(storedSession()?.savedConfigs ?? []).toEqual([]);

    host = await mountApp();
    await settle(50);
    await saveAs(host, 'Save .ork');
    await settle(0);
    const written = vi.mocked(exportOrk).mock.calls.at(-1)![0].motors!;
    expect(Object.values(written).map((m) => m.designation)).toEqual(['ZQ9999X']);
  }, 30000);
});

/**
 * UNDO WAITS WHILE A FLIGHT HOLDS THE ENGINE (audit 2026-09-22, row 278).
 * Launch, "Show charts" and the flight-data export each hold THIS build's
 * engine handle across a paint before their synchronous flight; an undo in
 * that frame rebuilds the engine under them (a handle held across a rebuild
 * throws `stale engine handle`). The history hook refuses to step while
 * App's `blocked` says one is pending (useTreeHistory.test.tsx has the
 * refusal); savedMarkSites.test.ts held App's two sources for it as strings.
 * Here each is caught mid-paint — requestAnimationFrame held — and Undo pressed.
 */
describe('Undo waits while a flight holds the engine', () => {
  it('during a Launch, a flight-data export and a Show-charts re-fly — and steps once each is done', async () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await type(host.querySelector<HTMLInputElement>('#rocket-name')!, 'Renamed'); // one step to undo
    const undo = () => act(async () => { button(host, '↩ Undo').click(); });
    const runs = () => (JSON.parse(localStorage.getItem(RUNS_KEY) ?? '[]') as unknown[]).length;
    /** Everything the next paint would run, held until `release`. */
    const holdPaint = () => {
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
      return async () => {
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
        await act(async () => { for (const cb of frames.splice(0)) cb(0); });
      };
    };
    const launch = () => act(async () => {
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Launch')!.click();
    });
    try {
      // 1. A Launch, caught between its click and its flight.
      let release = holdPaint();
      await launch();
      await undo();
      expect(shownName(host)).toBe('Renamed');
      await release();
      await waitFor(() => runs() === 1, 'the flight to be saved');
      // A second flight, so the first is a stored run with no plots in memory.
      await launch();
      await waitFor(() => runs() === 2, 'the second flight to be saved');
      await settle(0);

      // 2. The flight-data export re-flying the shown flight.
      release = holdPaint();
      await act(async () => { button(host, '⬇ Flight data (.csv)').click(); });
      await undo();
      expect(shownName(host)).toBe('Renamed');
      await release();
      await waitFor(() => created.mock.calls.length > 0, 'the flight data to download');

      // 3. "Show charts" on the earlier run, re-flying it.
      const history = [...host.querySelectorAll('h2')]
        .find((h) => h.textContent?.startsWith('Saved simulations'))!.parentElement!;
      await act(async () => { button(history, 'Show').click(); });
      release = holdPaint();
      await act(async () => { button(host, '📈 Charts').click(); });
      await undo();
      expect(shownName(host)).toBe('Renamed');
      await release();
      await settle(50);
      expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('📈 Charts'))).toBe(false);

      // Nothing held: Undo steps, so the refusals above were the hold's.
      await undo();
      expect(shownName(host)).toBe('My Rocket');
    } finally {
      created.mockRestore();
      revoked.mockRestore();
    }
  }, 30000);
});

/**
 * THE STARTER MOTOR, ✕ NEW AND A SHARE LINK TAKE THEIR TURN IN THE OPEN
 * SEQUENCE (audit 2026-09-22, row 303). Each is an await, and whatever the
 * user does inside one wins: the later action owns the screen, and the earlier
 * one lands on nothing. importApply.test.ts has the sequencer and the
 * starter's rule; savedMarkSites.test.ts held App's three hand-offs to them as
 * strings.
 */
describe('an action taken while another is in flight owns the screen', () => {
  it('✕ New pressed before the starter motor arrives: the motor never lands on the empty design', async () => {
    let arrive!: () => void;
    const gate = new Promise<void>((r) => { arrive = r; });
    const real = vi.mocked(loadCatalogueMotor).getMockImplementation()!;
    vi.mocked(loadCatalogueMotor).mockImplementationOnce(async (...a) => { await gate; return real(...a); });
    const host = await mountApp();
    expect(await guarded(host)).toBe(false); // a first visit is clean: New goes through
    await act(async () => { arrive(); });
    await settle(600);
    window.dispatchEvent(new Event('pagehide'));
    // The C6 was chosen for the starter's mount, which the empty design does not have.
    expect(storedSession()?.tree.name).toBe('New Rocket');
    expect(storedSession()?.mountMotors).toEqual({});
  }, 30000);

  it('✕ New pressed while a file is opening: the file does not land', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    const held = heldFile(fixture(RKT), RKT);
    await pick(host, held.file);
    expect(await guarded(host)).toBe(false);
    await act(async () => { held.release(); });
    await settle(600);
    expect(shownName(host)).toBe('New Rocket');
    expect(host.textContent).not.toContain(RKT_NAME);
  }, 30000);

  it('a file opened while a share link decodes: the link does not land over it', async () => {
    const xml = exportOrk({ name: 'Linked', tree: { ...defaultTree(), name: 'Linked' } });
    window.location.hash = (await encodeShareFragment(xml)).replace(/^#/, '');
    let decoded!: () => void;
    const gate = new Promise<void>((r) => { decoded = r; });
    const real = vi.mocked(decodeShareFragment).getMockImplementation()!;
    vi.mocked(decodeShareFragment).mockImplementationOnce(async (h) => { await gate; return real(h); });
    const host = await mountApp();
    await pick(host, new File([fixture(RKT)], RKT));
    await waitFor(() => shownName(host) === RKT_NAME, 'the file to open');
    await act(async () => { decoded(); });
    await settle(600);
    expect(vi.mocked(decodeShareFragment)).toHaveBeenCalled();
    expect(shownName(host)).toBe(RKT_NAME);
    expect(host.textContent).not.toContain('Linked');
  }, 30000);
});

/**
 * WHAT A .rkt COULD NOT CARRY, SAID UNDER THE SAVE LINE (seam review of audit
 * 2026-09-22). RockSim times the stage that leaves the pad from launch, so a
 * motor set never to light cannot be written as one; the writer names each
 * ignition it had to change, and App puts that under "Saved …" as a warning,
 * since the file reopens flying differently. saveOutcomeNote is tested in
 * saveFile.test.ts; saveFile.test.ts held App's three hand-offs as regexes.
 */
describe('a Save .rkt that could not carry an ignition', () => {
  it('says so under the save line, as a warning', async () => {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const c6 = (await loadCatalogueMotor('Estes', 'C6', 5))!;
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      tree, mountMotors: { [mount]: { ...c6, ignition: { event: 'never', delay: 0 } } },
      launch: DEFAULT_CONDITIONS, appVersion: APP_VERSION, savedAt: Date.now(),
    }));
    const host = await mountApp();
    await settle(50);
    await saveAs(host, 'Save .rkt');
    await waitFor(() => vi.mocked(saveFile).mock.calls.length === 1, 'the .rkt save');
    await settle(0);
    const item = [...document.querySelectorAll('.notice-bar .notice-item')]
      .find((li) => li.textContent?.includes('Saved “My_Rocket.rkt”'));
    expect(item?.textContent).toContain('“C6” is set never to light.');
    expect(item?.textContent).toContain('so the .rkt lights it 0 s after launch.');
    expect(item?.className).toContain('notice-warn');
  }, 30000);
});
