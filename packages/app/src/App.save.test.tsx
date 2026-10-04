// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { flyBuiltDesign } from './services/simulateDesign.js';
import { App } from './App.js';
import { DEFAULT_CONDITIONS } from './components/LaunchPanel.js';
import type { MountMotor } from './model/design.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { autosavedDesignFile } from './services/autosaveBackup.js';
import { loadCatalogueMotor } from './services/motorMatch.js';
import { exportOrk, importOrk } from './services/orkFile.js';
import { importRkt } from './services/rocksimFile.js';
import { saveFile, type SaveOutcome } from './services/saveFile.js';
import type { SessionState } from './services/session.js';
import type { SimRun } from './services/simReport.js';
import { decodeShareFragment, encodeShareFragment } from './services/shareLink.js';
import { addChild, defaultTree, motorMounts } from './tree/treeModel.js';
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
vi.mock('./services/simulateDesign.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/simulateDesign.js')>();
  return { ...real, flyBuiltDesign: vi.fn(real.flyBuiltDesign) };
});
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

/** The starter rocket with a two-pod set on its body tube, the pods' mount `pod-mmt`. */
const podTree = (t: RocketTree): RocketTree => {
  const body = t.components[0]!.children!.find((n) => n.type === 'bodytube')!;
  return addChild(t, body.id!, {
    type: 'podset', id: 'pods', name: 'Side pods', instanceCount: 2, children: [{
      type: 'bodytube', id: 'pod-bt', name: 'Pod tube', length: 0.1, outerRadius: 0.01, thickness: 0.0005,
      children: [{
        type: 'innertube', id: 'pod-mmt', name: 'Pod MMT', motorMount: true,
        length: 0.07, outerRadius: 0.0095, thickness: 0.0003,
      } as ComponentNode],
    } as ComponentNode],
  } as ComponentNode);
};

/**
 * WHAT A Save .ork HANDS THE WRITER FOR EACH MOTOR (audit 2026-09-30, item 23).
 * Turning a mount's motor record into the writer's <motor> — an EX motor's
 * real maker, an Auto delay, the weighed pad mass on the primary alone, a
 * stored configuration's own motors and the references it could not load —
 * was App's own closures, which nothing but a mounted App could reach. One
 * design that takes every branch, and what App hands exportOrk for it.
 */
describe('what a Save .ork hands the writer for each motor', () => {
  /** An imported X99 in the EX library, as one vendor's file named it. */
  const exEntry = (motorId: string, realManufacturer: string) => ({
    motorId, designation: 'X99', realManufacturer, diameter: 18, length: 70, totalWeightG: 24, propWeightG: 12,
    delays: '4', samples: [{ time: 0, thrust: 0 }, { time: 0.5, thrust: 10 }, { time: 1, thrust: 0 }],
  });

  it('the EX motor’s maker, the provisional Auto delay, one pad mass per configuration, a stored configuration’s references', async () => {
    const tree = podTree(defaultTree());
    const core = motorMounts(tree).find((m) => m.id !== 'pod-mmt')!.id!;
    const c6 = (await loadCatalogueMotor('Estes', 'C6', 5))!;
    // Two vendors' X99, Acme's first: a find by designation alone takes Acme's.
    localStorage.setItem('online-openrocket.ex-motors.v1', JSON.stringify([
      exEntry('ex:acme-x99', 'Acme'), exEntry('ex:loki-x99', 'Loki'),
    ]));
    const auto: MountMotor = { ...c6, label: 'C6 (auto delay)', meta: { ...c6.meta, autoDelay: true } };
    const ex: MountMotor = {
      ...c6, label: 'X99-4', spec: { ...c6.spec, designation: 'X99', ejectionDelay: 4 },
      meta: { label: 'X99-4', manufacturer: 'EX', exMotorId: 'ex:loki-x99', type: 'reload', orkDigest: 'not-an-ex-digest' },
      // Weighed on a record that is not the primary's: never written.
      padMassKg: 0.3, padMassWeighedWith: 'stale',
    };
    const fixed: MountMotor = {
      ...c6, label: 'C6-3', spec: { ...c6.spec, ejectionDelay: 3 },
      meta: { ...c6.meta, orkManufacturer: 'Estes Industries', orkType: 'single', orkDigest: 'abc123' },
      padMassKg: 0.25, padMassWeighedWith: 'weighed',
    };
    const working = { [core]: auto, 'pod-mmt': ex };
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      tree, mountMotors: working, launch: DEFAULT_CONDITIONS, appVersion: APP_VERSION, savedAt: Date.now(),
      activeConfigId: 'A',
      savedConfigs: [
        { id: 'A', name: null, isDefault: true, motors: working },
        {
          id: 'B', name: 'Backup', isDefault: false, motors: { [core]: fixed },
          // On the pod, which B has nothing loaded on; its pad mass is not the primary's.
          unmatchedRefs: { 'pod-mmt': { designation: 'ZQ9999X', manufacturer: 'AeroTech', diameter: 0.018, length: 0.07, delay: 6, padMassKg: 0.5 } },
          deployments: { chute: { deployEvent: 'altitude', deployAltitude: 150 } },
        },
      ],
    }));
    const host = await mountApp();
    await settle(50);
    await saveAs(host, 'Save .ork');
    await settle(0);

    const written = vi.mocked(exportOrk).mock.calls.at(-1)![0];
    const size = { diameter: c6.spec.diameter, length: c6.spec.length };
    const ignition = { ignitionEvent: c6.ignition.event, ignitionDelay: c6.ignition.delay };
    // No flight yet, so the Auto mount goes out at its provisional delay, and says so.
    const autoOut = {
      designation: 'C6', manufacturer: 'Estes', type: 'single', ...size, delay: 5,
      autoDelay: true, autoDelayFrom: 'provisional', ...ignition,
    };
    // Loki's, by the pinned library id; no digest, which is over desktop's own file.
    const exOut = { designation: 'X99', manufacturer: 'Loki', type: 'reload', ...size, delay: 4, ...ignition };
    expect(written.motors).toEqual({ [core]: autoOut, 'pod-mmt': exOut });
    expect(written.configs).toEqual([
      { id: 'A', name: null, isDefault: true, motors: { [core]: autoOut, 'pod-mmt': exOut } },
      {
        id: 'B', name: 'Backup', isDefault: false,
        motors: {
          [core]: {
            designation: 'C6', manufacturer: 'Estes Industries', type: 'single', digest: 'abc123', ...size, delay: 3,
            ...ignition, padMassKg: 0.25,
          },
          'pod-mmt': { designation: 'ZQ9999X', manufacturer: 'AeroTech', diameter: 0.018, length: 0.07, delay: 6 },
        },
        deployments: { chute: { deployEvent: 'altitude', deployAltitude: 150 } },
      },
    ]);
    // And the file says what the Auto mount was saved at.
    expect(document.body.textContent).toContain('it is saved at its provisional 5 s');
  }, 30000);
});

/**
 * A PAD MASS ON ONE OF TWO MOUNTS IN THE SAME STAGE (verifier's review of audit
 * 2026-09-30, item 23). A cluster built as separate mounts, one holding a motor
 * no catalogue has: primaryMountOf ranks the two by the order it is handed
 * them, so the order a set is built in decides which keeps the weighed pad
 * mass. The working set has always gone loaded motors first, and a stored
 * configuration references first. The shared mapping's first copy wrote both
 * loaded-first, and a stored configuration's pad mass, which the file had put
 * on the motor it could not load, was dropped from the saved file.
 */
describe('a pad mass on one of two mounts in the same stage', () => {
  it('is saved for every configuration, and the crash file keeps the same', async () => {
    const base = defaultTree();
    const body = base.components[0]!.children!.find((n) => n.type === 'bodytube')!;
    const tree = addChild(base, body.id!, {
      type: 'innertube', id: 'mmt-b', name: 'Second MMT', motorMount: true,
      length: 0.07, outerRadius: 0.0095, thickness: 0.0003,
    } as ComponentNode);
    const starter = motorMounts(tree).find((m) => m.id !== 'mmt-b')!.id!;
    const c6 = (await loadCatalogueMotor('Estes', 'C6', 5))!;
    const zq = { designation: 'ZQ9999X', manufacturer: 'AeroTech', diameter: 0.018, length: 0.07, delay: 6 };
    // Weighed under the second mount's card: in the working set the loaded
    // motor ranks ahead of the reference, so that is where the field is.
    const working = { 'mmt-b': { ...c6, padMassKg: 0.42, padMassWeighedWith: 'weighed' } };
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      tree, mountMotors: working, unmatchedRefs: { [starter]: zq },
      launch: DEFAULT_CONDITIONS, appVersion: APP_VERSION, savedAt: Date.now(), activeConfigId: 'W',
      savedConfigs: [
        { id: 'W', name: null, isDefault: true, motors: working, unmatchedRefs: { [starter]: zq } },
        // As importApply attaches a file's <measuredpadmass configid="X">: to the
        // first of the file's motors for X, here the one no catalogue has.
        {
          id: 'X', name: 'Other', isDefault: false, motors: { 'mmt-b': c6 },
          unmatchedRefs: { [starter]: { ...zq, padMassKg: 0.5 } },
        },
      ],
    }));
    const host = await mountApp();
    await settle(50);
    await saveAs(host, 'Save .ork');
    await settle(0);

    const padMasses = (xml: string) => Object.fromEntries(importOrk(xml).configs.map((c) => [c.id, c.padMassKg]));
    expect(padMasses(vi.mocked(exportOrk).mock.results.at(-1)!.value as string)).toEqual({ W: 0.42, X: 0.5 });
    // The crash-recovery file, from the session App stored, keeps the same.
    expect(padMasses(autosavedDesignFile()!.data)).toEqual({ W: 0.42, X: 0.5 });
  }, 30000);
});

/**
 * AN AUTO MOUNT FLOWN IN THE ACTIVE FLIGHT CONFIGURATION, SAVED (verifier's
 * review of audit 2026-09-30, item 23). A flight is filed under the
 * configuration it flew (SimRun.flightConfigId), and the working set — which
 * the writer puts in the file as the active configuration — takes its Auto
 * delays from the active configuration's flights. Every other Auto-flight Save
 * test flies a design with no configuration, where the key is '' either way: a
 * working set read under '' would pass them all, and save this one at its
 * provisional delay.
 */
describe('an Auto mount flown in the active flight configuration', () => {
  it('is saved at the delay it flew there', async () => {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const c6 = (await loadCatalogueMotor('Estes', 'C6', 5))!;
    const provisional = 0;
    const auto: MountMotor = {
      ...c6, label: 'C6 (auto delay)', spec: { ...c6.spec, ejectionDelay: provisional },
      meta: { ...c6.meta, autoDelay: true },
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      tree, mountMotors: { [mount]: auto }, launch: DEFAULT_CONDITIONS, appVersion: APP_VERSION, savedAt: Date.now(),
      activeConfigId: 'A', savedConfigs: [{ id: 'A', name: 'Calm', isDefault: true, motors: { [mount]: auto } }],
    }));
    const host = await mountApp();
    await settle(50);
    await act(async () => {
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Launch')!.click();
    });
    const stored = () => JSON.parse(localStorage.getItem(RUNS_KEY) ?? '[]') as SimRun[];
    await waitFor(() => stored().length === 1, 'the flight to be saved');
    const [run] = stored();
    expect(run!.flightConfigId).toBe('A');
    const flownS = run!.delayResolution!.mounts[0]!.flownDelay as number;
    // Else the file at its provisional delay would pass.
    expect(flownS).not.toBe(provisional);
    await saveAs(host, 'Save .ork');
    await settle(0);

    const back = importOrk(vi.mocked(exportOrk).mock.results.at(-1)!.value as string);
    const backMount = motorMounts(back.tree)[0]!.id!;
    expect(back.configs.find((c) => c.id === 'A')?.motors[backMount]?.delay).toBe(flownS);
    expect(document.body.textContent).toContain(`it is saved at ${flownS} s, the rounded optimum it flies on Auto`);
    expect(document.body.textContent).not.toContain('its provisional');
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

/**
 * WHAT A Save .rkt HANDS THE WRITER: THE MEASURED MASS & CG BOX (format audit
 * row 21). A one-stage rocket's box goes out as RockSim's known mass —
 * <Stage3Mass> and <Stage3CG> under <UseKnownMass>1, the figures importRkt
 * fills the box from — but exportRkt writes it only when App passes
 * `measured`, and taking that out of onSaveRkt left every test green
 * (rocksimFile.test.ts calls the writer with it directly). Here the box is
 * typed, the file read back as it was written, and opened again.
 */
describe('a Save .rkt carries the Measured mass & CG box', () => {
  it('writes the typed figures as the rocket’s known mass, and they reopen in the box', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await type(input(host, 'Measured mass'), '31');
    await type(input(host, 'Measured CG'), '250');
    await saveAs(host, 'Save .rkt');
    await waitFor(() => vi.mocked(saveFile).mock.calls.length === 1, 'the .rkt save');
    const xml = await (vi.mocked(saveFile).mock.calls[0]![0] as Blob).text();
    const field = (tag: string) => Number(new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1]);
    expect(field('Stage3Mass'), 'the box never reached the file').toBeCloseTo(31, 9);
    expect(field('Stage3CG')).toBeCloseTo(250, 9);
    expect(field('UseKnownMass')).toBe(1);
    expect(importRkt(xml).measured).toEqual({ massKg: expect.closeTo(0.031, 9), cgM: expect.closeTo(0.25, 9) });
  }, 30000);
});

/**
 * THE USER'S DISTANCE UNIT, HANDED TO THE RockSim READER. A reader holds no
 * unit preference, so App passes prefs.units.distance to importRkt, and the
 * import note's recovery line quotes a deployment altitude in it, as Flight
 * configurations does. Read the way a user meets it: someone who set feet
 * opens a .rkt whose main opens at 121.92 m (400 ft).
 */
describe('a RockSim import note in the user’s distance unit', () => {
  const RKT_MAIN_400FT = '<RockSimDocument><DesignInformation><RocketDesign><Name>Altitude Main</Name>'
    + '<StageCount>1</StageCount><Stage3Parts><BodyTube><Name>Body</Name><SerialNo>1</SerialNo><Len>500</Len>'
    + '<OD>50</OD><ID>48</ID><IsMotorMount>1</IsMotorMount><AttachedParts><Parachute><Name>Main</Name>'
    + '<SerialNo>12</SerialNo><Dia>450</Dia></Parachute></AttachedParts></BodyTube></Stage3Parts></RocketDesign>'
    + '</DesignInformation><SimulationResultsList><SimulationResults><SimulationName>Run</SimulationName>'
    + '<SimulationEvents><SimulationEvent><PartSerialNo>12</PartSerialNo><Type>5</Type>'
    + '<DeployAltitude>121.92</DeployAltitude><DeplyTime>0</DeplyTime></SimulationEvent></SimulationEvents>'
    + '<Stage3Engines><EngineSet><MountSerialNo>1</MountSerialNo><EngineCode>E15</EngineCode>'
    + '<EngineMfg>AeroTech</EngineMfg><EjectionDelay>4</EjectionDelay></EngineSet></Stage3Engines>'
    + '</SimulationResults></SimulationResultsList></RockSimDocument>';

  it('quotes the main’s deployment altitude in feet to a user who set feet', async () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true, units: { distance: 'ft' } }));
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await pick(host, new File([RKT_MAIN_400FT], 'Altitude_Main.rkt'));
    await waitFor(() => shownName(host) === 'Altitude Main', 'the file to open');
    const toggle = host.querySelector<HTMLButtonElement>('.notice-toggle[aria-expanded="false"]');
    if (toggle) await act(async () => { toggle.click(); });
    const notes = host.querySelector('[aria-label="Notices"]')?.textContent ?? '';
    expect(notes).toContain('recovery: Main at 400 ft descending.');
    expect(notes).not.toContain('121.92');
  }, 30000);
});


describe('maximum motor length export losses', () => {
  it.each(['.rkt', '.CDX1'])('reports a mount limit only when present on %s export', async (format) => {
    await mountApp();
    await waitFor(starterStored, 'starter session');
    await unmountAll();
    const saved = storedSession()!;
    const tree = defaultTree();
    const mounts = motorMounts(tree);
    expect(mounts.length).toBeGreaterThan(0);
    // The ordinary starter is supported by both exporters. Zero is a real limit.
    for (const limit of [undefined, 0]) {
      mounts[0]!.maxMotorLength = limit;
      localStorage.setItem(SESSION_KEY, JSON.stringify({ ...saved, tree, mountMotors: {}, savedConfigs: [] }));
      const host = await mountApp();
      await saveAs(host, 'Save ' + format);
      await settle(50);
      expect(vi.mocked(saveFile).mock.calls.length).toBeGreaterThan(0);
      const toggle = host.querySelector<HTMLButtonElement>('.notice-toggle[aria-expanded="false"]');
      if (toggle) await act(async () => { toggle.click(); });
      const notes = host.querySelector('[aria-label="Notices"]')?.textContent ?? '';
      expect(notes.includes('Maximum motor length settings are not saved in ' + format)).toBe(limit !== undefined);
      await unmountAll();
      vi.mocked(saveFile).mockClear();
    }
  }, 30000);
});

describe('pending motor choices across App actions', () => {
  it.each(['Unload', 'Remove', 'remount', 'tab only', 'Config', 'New', 'Open'])('retires a quick pick across %s', async (action) => {
    let host = await mountApp();
    await waitFor(starterStored, 'the starter motor');
    if (action === 'Config') {
      await unmountAll();
      const state = storedSession()!;
      const mount = motorMounts(state.tree)[0]!.id!;
      const b6 = (await loadCatalogueMotor('Estes', 'B6', 4))!;
      localStorage.setItem(SESSION_KEY, JSON.stringify({ ...state, savedConfigs: [
        { id: 'original', name: 'Original motors', isDefault: true, motors: state.mountMotors },
        { id: 'other', name: 'Other motors', isDefault: false, motors: { [mount]: b6 } },
      ] }));
      host = await mountApp();
    }
    const a8 = (await loadCatalogueMotor('Estes', 'A8', 3))!;
    let finish!: () => void;
    const gate = new Promise<void>((r) => { finish = r; });
    let started = false;
    vi.mocked(loadCatalogueMotor).mockImplementationOnce(async () => { started = true; await gate; return a8; });
    await openTab(host, 'Motors & Launch');
    const chooseQuick = async (value: string) => {
      const select = [...host.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === value))!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    await chooseQuick('Estes A8-3');
    expect(started).toBe(true);
    if (action === 'Unload') await act(async () => { button(host, 'Unload').click(); });
    if (action === 'Remove') await act(async () => { host.querySelector<HTMLButtonElement>('button[title="Remove this motor"]')!.click(); });
    if (action === 'Config') await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label^="Apply Other motors"]')!.click(); });
    if (action === 'tab only') { await openTab(host, 'Design'); await openTab(host, 'Motors & Launch'); }
    if (action === 'remount') {
      await openTab(host, 'Design');
      await openTab(host, 'Motors & Launch');
      await chooseQuick('Estes B6-4');
      await waitFor(() => { window.dispatchEvent(new Event('pagehide')); return Object.values(storedSession()?.mountMotors ?? {}).some((m) => m.spec.designation === 'B6'); }, 'the later choice');
    }
    if (action === 'New' || action === 'Open') {
      await openTab(host, 'Design');
      if (action === 'New') expect(await guarded(host)).toBe(false);
      else {
        await pick(host, new File([fixture(RKT)], RKT));
        await waitFor(() => shownName(host) === RKT_NAME, 'the opened design');
      }
    }
    await act(async () => { finish(); await gate; });
    window.dispatchEvent(new Event('pagehide'));
    const motors = Object.values(storedSession()?.mountMotors ?? {});
    if (action === 'remount' || action === 'Config') expect(motors.map((m) => m.spec.designation)).toEqual(['B6']);
    else if (action === 'tab only') expect(motors.map((m) => m.spec.designation)).toEqual(['A8']);
    else if (action === 'Open') expect(motors.map((m) => m.spec.designation)).toEqual(['E6']);
    else expect(motors).toEqual([]);
  }, 30000);
});

it('a flight completed behind the Save-As picker remains unsaved', async () => {
  const host = await mountApp();
  await waitFor(starterStored, 'the starter motor');
  let finishFlight!: () => void;
  const gate = new Promise<void>((r) => { finishFlight = r; });
  const real = vi.mocked(flyBuiltDesign).getMockImplementation()!;
  let started = false;
  vi.mocked(flyBuiltDesign).mockImplementationOnce(async (input) => {
    started = true;
    const flown = await real(input);
    await gate;
    return flown;
  });
  await act(async () => { button(host, 'Launch').click(); });
  await waitFor(() => started, 'the flight to start');
  let written!: (o: SaveOutcome) => void;
  vi.mocked(saveFile).mockImplementationOnce(() => new Promise<SaveOutcome>((r) => { written = r; }));
  await saveAs(host, 'Save .ork');
  await waitFor(() => !!written, 'the picker');
  await act(async () => { finishFlight(); await gate; });
  await waitFor(() => (JSON.parse(localStorage.getItem(RUNS_KEY) ?? '[]') as unknown[]).length === 1, 'the flight');
  await act(async () => { written({ kind: 'saved', name: 'My Rocket.ork' }); });
  await openTab(host, 'Design');
  expect(await guarded(host)).toBe(true);
}, 30000);

it('a first-visit share link applies without an offer dialog', async () => {
  expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  const xml = exportOrk({ name: 'First linked design', tree: { ...defaultTree(), name: 'First linked design' } });
  window.location.hash = (await encodeShareFragment(xml)).replace(/^#/, '');
  const host = await mountApp();
  await waitFor(() => shownName(host) === 'First linked design' || host.textContent?.includes('This link opens') === true,
    'the share link to decode');
  expect(host.textContent).not.toContain('This link opens');
  expect(shownName(host)).toBe('First linked design');
}, 30000);

it('a shared design asks before replacing non-tree work on the starter rocket', async () => {
  const first = await mountApp();
  await waitFor(starterStored, 'the starter motor');
  await openTab(first, 'Motors & Launch');
  await type(input(first, 'Wind avg'), '8');
  await unmountAll();
  const xml = exportOrk({ name: 'Linked', tree: { ...defaultTree(), name: 'Linked' } });
  window.location.hash = (await encodeShareFragment(xml)).replace(/^#/, '');
  const host = await mountApp();
  await waitFor(() => host.textContent?.includes('This link opens') === true, 'the share offer');
  expect(shownName(host)).toBe('My Rocket');
  expect(input(host, 'Wind avg').value).toBe('8');
}, 30000);
