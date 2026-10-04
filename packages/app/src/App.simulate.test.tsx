// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { diffCatalogue, OVERLAY_KEY } from './services/catalogueOverlay.js';
import { padMassSetKey } from './services/configSync.js';
import { applyDesignNameFallback } from './services/designFile.js';
import { deriveLaunchInputs, type AeroState, type DesignState } from './services/designDerivation.js';
import { catalogueMotorMass, LEGACY_PAD_MASS_KEY } from './services/hardwareMass.js';
import { importMark, type ImportedDesign } from './services/importApply.js';
import { DEFAULT_CONDITIONS } from './services/launchConditions.js';
import { MOTOR_DB, MOTOR_DB_DATE, setCatalogueOverlay } from './services/motorDb.js';
import { loadCatalogueMotor } from './services/motorMatch.js';
import type { HeldNote } from './services/notices.js';
import type { OrkMotorRef } from './services/orkFile.js';
import { peekSession } from './services/session.js';
import { designStateFromSession } from './services/sessionRestore.js';
import { comparable, idFree } from './services/simulate.testSupport.js';
import type { FreshSimRun } from './services/simReport.js';
import { flyBuiltDesign, simulateDesign, type SimulateDesignResult } from './services/simulateDesign.js';
import { simulateFile, simulateImported } from './services/simulateFile.js';
import { unzipMember } from './services/zipMember.js';
import { addChild, addStage, defaultTree, motorMounts } from './tree/treeModel.js';
import { APP_VERSION } from './version.js';

/**
 * THE LAUNCH BUTTON AND THE HEADLESS LAUNCH FLY THE SAME BYTES (2026-10-01;
 * response-2026-10-01b § 3.2).
 *
 * Each case mounts the real app on the real kernel, presses Launch, and keeps
 * what the button got back, the run Saved simulations actually persisted,
 * and what App handed the shared path (flyBuiltDesign's input).
 * Then, with App unmounted (the headless build resets the kernel, which would
 * make App's held handle stale), the same design goes through the headless
 * door: `simulateDesign` for a stored session, fed the SEED as App's restore
 * reads it (designStateFromSession — so App's own legacy pad-mass reconcile,
 * which runs after the first build, must be reproduced by simulateDesign's
 * settle, not inherited from App's autosave); `simulateImported` for a file,
 * fed the importer's OWN output, captured before App touched it.
 *
 * WHY CAPTURE AND NOT RE-PARSE. Node ids come from a module-level counter
 * (treeModel's freshId), so a second parse of the same bytes numbers the same
 * parts differently, and ids are in the design key, the motor-set key and the
 * delay vector. Fed the same parse, every field is comparable byte for byte.
 *
 * WHAT IS COMPARED, per case: every field of the run but its id, timestamp and
 * two wall-clock costs, with `toStrictEqual` — floats included (same process,
 * same kernel, same inputs; never a hard-coded kernel float, which differs in
 * the last bits between Node 22 and 24); the complete FlightResult; the
 * delay flown and the model; the full provenance key App stamped; the state
 * flown (tree, assigned motors, conditions, configurations, unmatched
 * references); the build's statics and weighed hardware; Auto's upgrade; the
 * legacy pad-mass settle's notice; and for a file, the saved mark App took
 * over its own plan — the plan-level proof — and the import note App shows.
 *
 * AND THE BYTES DOOR ITSELF. A file case also runs `simulateFile` on the same
 * bytes — its own parse, with the shipped presets and the default unit words —
 * and holds it to the button on every field that carries no node id
 * (simulate.testSupport's idFree: a second parse numbers the parts afresh).
 * So "the button and simulateFile agree" is proven on every committed file and
 * every corpus file, not only through simulateImported (verify-step1 finding 3).
 *
 * AERO WIRING. A case on Supersonic, one with Rogers Kbf off, and Auto's
 * SECOND Launch (after the upgrade) each make App's aero arguments to
 * flyBuiltDesign matter: with only Classic and a first Auto Launch, App could
 * hard-code `effectiveSupersonic: false` or `effectiveKbf: true` and still
 * agree (verify-step1 finding 1).
 *
 * WHAT IT CANNOT SEE. A mistake inside the shared functions (flyBuiltDesign,
 * designDerivation, sessionRestore) moves both sides together: their own tests
 * pin those (flyBuiltDesign.test.ts holds the Launch to a frozen copy of
 * 78d3015's onLaunch). This test pins the WIRING — what App and the headless
 * doors feed them — and that the button goes through flyBuiltDesign at all.
 *
 * The corpus cases (docs/User files, local-only) are skipped when absent.
 */

// What App's Launch got back, exactly, in memory. simulateDesign's own call
// is module-local, so it never reaches this spy: the count is App's alone.
vi.mock('./services/simulateDesign.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/simulateDesign.js')>();
  return { ...real, flyBuiltDesign: vi.fn(real.flyBuiltDesign) };
});
// Each importer's OWN output, cloned before App touches it (the name fallback
// mutates it). Three literal calls: vitest hoists only top-level vi.mock.
let parsed: ImportedDesign | null = null;
vi.mock('./services/orkFile.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/orkFile.js')>();
  return {
    ...real,
    importOrk: (...a: Parameters<typeof real.importOrk>) => {
      const r = real.importOrk(...a);
      parsed = structuredClone(r);
      return r;
    },
  };
});
vi.mock('./services/rocksimFile.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/rocksimFile.js')>();
  return {
    ...real,
    importRkt: (...a: Parameters<typeof real.importRkt>) => {
      const r = real.importRkt(...a);
      parsed = structuredClone(r);
      return r;
    },
  };
});
vi.mock('./services/rasaeroFile.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/rasaeroFile.js')>();
  return {
    ...real,
    importCdx1: (...a: Parameters<typeof real.importCdx1>) => {
      const r = real.importCdx1(...a);
      parsed = structuredClone(r);
      return r;
    },
  };
});

// The notes App holds when it builds its notice list: the file's import note
// and the legacy pad-mass settle's — read from what App hands the list, not
// from the collapsed bar's first line.
let notes: { fileNote: HeldNote | null; padMassNote: HeldNote | null } = { fileNote: null, padMassNote: null };
vi.mock('./services/notices.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/notices.js')>();
  return {
    ...real,
    designNotices: (...a: Parameters<typeof real.designNotices>) => {
      notes = { fileNote: a[0].fileNote, padMassNote: a[0].padMassNote };
      return real.designNotices(...a);
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no canvas, and a Launch lands on the Results tab's charts.
const ctx2d = new Proxy({}, {
  get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 0 }) : () => undefined),
});
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;

const SESSION_KEY = 'online-openrocket.session.v1';
const RUNS_KEY = 'online-openrocket.sim-runs.v1';

/**
 * Local inputs found by walking up from the working directory: under happy-dom
 * Vite hands this module a served `/@fs/` URL, so a URL-relative path can
 * silently resolve to nothing (lemivSweep.test.ts).
 */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'version.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}
const FIXTURES = join(repoRoot(), 'packages', 'app', 'src', 'services', '__fixtures__');
const CORPUS = join(repoRoot(), 'docs', 'User files');

let mounted: { root: Root; host: HTMLElement }[] = [];

async function settle(ms = 0): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

async function waitFor(pred: () => boolean, what: string, timeoutMs = 15000): Promise<void> {
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

const runs = (): number => (JSON.parse(localStorage.getItem(RUNS_KEY) ?? '[]') as unknown[]).length;
const shownName = (host: HTMLElement) => host.querySelector('.vitals-item-name .vitals-value')?.textContent;
const starterStored = () => Object.keys(peekSession()?.mountMotors ?? {}).length > 0;

async function launch(host: HTMLElement): Promise<void> {
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Launch')!.click();
  });
}

async function pick(host: HTMLElement, file: File): Promise<void> {
  const picker = [...host.querySelectorAll('input')]
    .find((i) => i.getAttribute('aria-label')?.startsWith('Open a design file'))!;
  Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
  await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })); });
}

const CLASSIC: AeroState = { aeroMode: 'classic', effectiveKbf: true, autoSupersonic: false };
const AUTO: AeroState = { aeroMode: 'auto', effectiveKbf: true, autoSupersonic: false };
const SUPERSONIC: AeroState = { aeroMode: 'supersonic', effectiveKbf: true, autoSupersonic: false };
/** Extended Barrowman: the classic model with Rogers Kbf off. */
const KBF_OFF: AeroState = { aeroMode: 'classic', effectiveKbf: false, autoSupersonic: false };

beforeEach(() => {
  parsed = null;
  notes = { fileNote: null, padMassNote: null };
  vi.mocked(flyBuiltDesign).mockClear();
  localStorage.clear();
  setCatalogueOverlay(null);
  localStorage.setItem('online-openrocket.workspace.v1', 'design');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
});

afterEach(async () => {
  await unmountAll();
  setCatalogueOverlay(null);
  vi.unstubAllGlobals();
});

/** Stores the preferences App mounts with: the tour off, and the aero model and Kbf when not the defaults. */
function prefs(aero: AeroState): void {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({
    tourOff: true,
    ...(aero.aeroMode !== 'classic' ? { aeroModel: aero.aeroMode } : {}),
    ...(aero.effectiveKbf ? {} : { rogersKbf: false }),
  }));
}

describe('RASAero import note uses the effective choice', () => {
  it.each([
    { stored: CLASSIC, override: 'supersonic', label: 'Supersonic' },
    { stored: CLASSIC, override: 'eb', label: null },
    { stored: KBF_OFF, override: 'hybrid', label: 'Hybrid (experimental)' },
    { stored: SUPERSONIC, override: null, label: 'Supersonic' },
  ])('stored $stored.aeroMode / session $override', async ({ stored, override, label }) => {
    prefs(stored);
    const host = await mountApp();
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Aerodynamics model (this session)"]')!;
    if (override) await act(async () => {
      select.value = override;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const storedBefore = localStorage.getItem('online-openrocket.prefs.v1');
    const selectedBefore = select.value;
    const xml = '<RASAeroDocument><RocketDesign><BodyTube><Length>20</Length><Diameter>3</Diameter></BodyTube>'
      + '<ModifiedBarrowman>False</ModifiedBarrowman></RocketDesign></RASAeroDocument>';
    await pick(host, new File([xml], 'Aero note.CDX1'));
    await waitFor(() => shownName(host) === 'Aero note', 'RASAero open');
    const note = notes.fileNote?.text ?? '';
    if (label) {
      expect(note.match(/author turned Modified Barrowman off/g)).toHaveLength(1);
      expect(note).toContain(`When this import began, the app’s aerodynamics model was ${label}.`);
    } else expect(note).not.toContain('Modified Barrowman');
    expect(select.value).toBe(selectedBefore);
    expect(localStorage.getItem('online-openrocket.prefs.v1')).toBe(storedBefore);
    await act(async () => {
      select.value = 'auto';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(notes.fileNote?.text).toBe(note);
  }, 30000);
});

/** What App's Launch flew and what it handed the shared path, read before App is unmounted. */
interface AppSide {
  out: Awaited<ReturnType<typeof flyBuiltDesign>>;
  persistedRun: FreshSimRun;
  args: Parameters<typeof flyBuiltDesign>[0];
  /** "M+" on the vitals strip after the flight: App's `autoSupersonic`. */
  upgraded: boolean;
  /** The unmatched references App holds, as its autosave wrote them. */
  unmatchedRefs: Record<string, OrkMotorRef>;
  /** The saved mark App took at the open (file cases). */
  savedMark: string | undefined;
  notice: string;
  /** The file note App held before the Launch: after an open, the import note. */
  fileNote: HeldNote | null;
  /** The legacy pad-mass settle's notice App held before the Launch, if any. */
  padMassNote: HeldNote | null;
}

/**
 * Press Launch `presses` times on the mounted app and keep everything the
 * comparison needs about the LAST one, then unmount. A second press flies what
 * App holds after the first: on Auto, the upgraded model.
 */
async function launchInApp(host: HTMLElement, presses = 1): Promise<AppSide> {
  const held = notes;
  for (let n = 1; n <= presses; n++) {
    await launch(host);
    await waitFor(() => runs() === n, `flight ${n} to be saved`);
    await settle(50);
  }
  // The button went through the shared path, once a press.
  expect(vi.mocked(flyBuiltDesign)).toHaveBeenCalledTimes(presses);
  const out = await (vi.mocked(flyBuiltDesign).mock.results[presses - 1]!.value as ReturnType<typeof flyBuiltDesign>);
  const args = vi.mocked(flyBuiltDesign).mock.calls[presses - 1]![0];
  // Counting writes cannot see App altering the run before addRun (2026-10-01).
  // Read the last Launch by id, with only JSON's own losses normalised below.
  const persisted = JSON.parse(localStorage.getItem(RUNS_KEY) ?? '[]') as FreshSimRun[];
  const persistedRun = persisted.find((run) => run.id === out.run.id);
  expect(persistedRun, 'the last Launch stored in run history').toBeDefined();
  // Flush the debounced autosave first (pagehide is what flushes it on a real
  // close): every change the flight made restarts the debounce, so without
  // this the stored copy can predate the reconcile's own writes.
  window.dispatchEvent(new Event('pagehide'));
  const stored = peekSession();
  const side: AppSide = {
    out, args, persistedRun: persistedRun!,
    upgraded: host.querySelector('.vitals-aero') !== null,
    unmatchedRefs: stored?.unmatchedRefs ?? {},
    savedMark: stored?.savedMark,
    notice: document.querySelector('.notice-bar')?.textContent ?? '',
    fileNote: held.fileNote,
    padMassNote: held.padMassNote,
  };
  await unmountAll();
  return side;
}

/**
 * A value as the autosave holds it: JSON, with an Infinity kept as the
 * autosave keeps it (session.ts revives "Infinity"). Undefined-valued keys
 * drop out, which is the only difference a JSON round trip makes here.
 */
const plain = (x: unknown): unknown => JSON.parse(JSON.stringify(x, (_k, v: unknown) => (v === Infinity ? 'Infinity' : v)));

/**
 * Every node id in `tree`, named by its place in a depth-first walk. Two
 * parses of one file mint different ids for the same parts (treeModel's
 * freshId) but agree on these, so a flight's events — which name the mount
 * and the part by id — compare across parses once both are renumbered.
 */
function positions(tree: RocketTree): Map<string, string> {
  const out = new Map<string, string>();
  let n = 0;
  const walk = (nodes: readonly ComponentNode[]) => {
    for (const node of nodes) {
      if (node.id) out.set(node.id, `#${n}`);
      n++;
      walk(node.children ?? []);
    }
  };
  walk(tree.components);
  return out;
}
// Keep undefined, nonfinite samples and every series value (2026-10-01): a
// JSON round trip would hide changes beyond the node ids that differ per parse.
const renumbered = (x: unknown, ids: Map<string, string>): unknown => {
  if (typeof x === 'string') return ids.get(x) ?? x;
  if (Array.isArray(x)) return x.map((v) => renumbered(v, ids));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, renumbered(v, ids)]));
  return x;
};

/**
 * The headless Launch against App's: every comparable field, exactly. `stored`:
 * the headless input was read from App's autosave (a first visit), so the state
 * is compared as the autosave holds it.
 */
function expectSameLaunch(app: AppSide, out: SimulateDesignResult, aero: AeroState, stored = false): void {
  const same = (a: unknown, b: unknown) => (stored ? expect(plain(a)).toStrictEqual(plain(b)) : expect(a).toStrictEqual(b));
  // The flight and the run.
  expect(comparable(out.run)).toStrictEqual(comparable(app.out.run));
  expect(plain(comparable(app.persistedRun))).toStrictEqual(plain(comparable(out.run)));
  // Series and separated branches are part of the answer too (2026-10-01);
  // summary/events alone let a truncated FlightResult agree with App.
  expect(out.result).toStrictEqual(app.out.flight.result);
  expect(out.flight.flownDelayS).toBe(app.out.flight.flownDelayS);
  expect(out.flight.usedSupersonic).toBe(app.out.flight.usedSupersonic);
  // What App handed the shared path: the provenance key, the state, the build.
  expect(out.provenance).toStrictEqual(app.args.provenance);
  expect(out.autoSupersonic).toBe(app.upgraded);
  same(out.state.tree, app.args.tree);
  same(deriveLaunchInputs(out.state, aero).assigned, app.args.derived.assigned);
  same(out.state.launch, app.args.launch);
  same(out.state.savedConfigs, app.args.savedConfigs);
  expect(out.state.activeConfigId).toBe(app.args.activeConfigId);
  expect(plain(out.state.unmatchedRefs ?? {})).toStrictEqual(plain(app.unmatchedRefs));
  expect(out.build.info).toStrictEqual(app.args.built.info);
  expect(out.build.hardware).toStrictEqual(app.args.built.hardware);
  expect(out.appVersion).toBe(APP_VERSION);
  // The settle's notice: what App's reconcile effect put on screen, or nothing on both.
  expect(out.padMassNote).toStrictEqual(app.padMassNote);
}

/**
 * A session case: seed, fly in App, fly the SEED headless (as App's restore
 * reads it). `presses`: Launches in App, the last compared; `headless`: the
 * aero state the headless run is handed for it (App's after the earlier ones).
 */
async function sessionCase(seed: object | null, aero: AeroState, opts: { presses?: number; headless?: AeroState } = {}) {
  prefs(aero);
  if (seed) localStorage.setItem(SESSION_KEY, JSON.stringify({ appVersion: APP_VERSION, savedAt: Date.now(), ...seed }));
  // Read before App mounts: the state App's initializers restore, BEFORE its
  // reconcile effect has run — so the headless settle has to do that work.
  const seeded = seed ? designStateFromSession(peekSession(), { legacyMaxMotorLengthM: null }).state : null;
  const host = await mountApp();
  if (!seed) await waitFor(starterStored, 'the starter motor to land');
  await settle(50);
  // A first visit's design exists only once the starter motor has landed:
  // read it from the autosave, through the same restore.
  const input: DesignState = seeded ?? designStateFromSession(peekSession(), { legacyMaxMotorLengthM: null }).state;
  const app = await launchInApp(host, opts.presses);
  const headless = opts.headless ?? aero;
  const out = await simulateDesign(input, { aero: headless });
  expectSameLaunch(app, out, headless, !seeded);
  return { app, out, input };
}

/** A file case: open in App, fly; fly the importer's own parse headless. */
async function fileCase(bytes: Uint8Array, name: string, aero: AeroState) {
  prefs(aero);
  const host = await mountApp();
  await waitFor(starterStored, 'the starter motor to land');
  await settle(50);
  const markBefore = peekSession()?.savedMark;
  await pick(host, new File([bytes as Uint8Array<ArrayBuffer>], name));
  await waitFor(() => parsed !== null, 'the importer to run');
  const named = structuredClone(parsed!);
  applyDesignNameFallback(named, name);
  await waitFor(() => shownName(host) === named.tree.name && peekSession()?.savedMark !== markBefore,
    'the file to open and be autosaved');
  // The reconcile effect and the rebuild it causes.
  await settle(100);
  const app = await launchInApp(host);
  const imported = structuredClone(parsed!);
  applyDesignNameFallback(imported, name);
  const out = await simulateImported(imported, { aero });
  // The plan-level proof: the fingerprint App took over its OWN plan.
  expect(importMark(out.plan)).toBe(app.savedMark);
  // The note App showed for the open (spec risk 10, verify-step1 finding 5).
  // Spec risk 10 limits this to files whose motors all resolve from the
  // shipped bundle; on every case here a motor either does (both sides load
  // it) or is in no catalogue at all (F7's sustainer: neither side can load
  // it), so App's note and the headless note are the same words. A file whose
  // motor App downloads and the bundle lacks would not belong in this list.
  expect(out.importNote).toStrictEqual(app.fileNote);
  expectSameLaunch(app, out, aero);
  // The bytes door: its own parse, its own presets, its own unit words.
  const viaBytes = await simulateFile(bytes, name, { aero });
  expect(plain(idFree(viaBytes.run))).toStrictEqual(plain(idFree(app.persistedRun)));
  expect(renumbered(viaBytes.result, positions(viaBytes.state.tree)))
    .toStrictEqual(renumbered(app.out.flight.result, positions(app.args.tree)));
  // A position, not an id: the delay table's mounts and the primary as well.
  expect(renumbered(viaBytes.run.delayResolution?.mounts.map((m) => m.mountId), positions(viaBytes.state.tree)))
    .toStrictEqual(renumbered(app.out.run.delayResolution?.mounts.map((m) => m.mountId), positions(app.args.tree)));
  expect(viaBytes.flight.flownDelayS).toBe(app.out.flight.flownDelayS);
  expect(viaBytes.flight.usedSupersonic).toBe(app.out.flight.usedSupersonic);
  const mine = positions(viaBytes.state.tree);
  const apps = positions(app.args.tree);
  expect(renumbered(viaBytes.build.info, mine)).toStrictEqual(renumbered(app.args.built.info, apps));
  expect(renumbered(viaBytes.build.hardware, mine)).toStrictEqual(renumbered(app.args.built.hardware, apps));
  expect(viaBytes.importNote).toStrictEqual(app.fileNote);
  expect(viaBytes.padMassNote).toStrictEqual(app.padMassNote);
  return { app, out };
}

const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

// ---------------------------------------------------------------------------

const c6 = async () => (await loadCatalogueMotor('Estes', 'C6', 5))!;

/** The pad mass that carries 20 g of hardware over `motor` on `tree` with a 100 g Measured dry mass. */
const weighed = (tree: RocketTree, mount: string, motor: Awaited<ReturnType<typeof c6>>) =>
  0.1 + catalogueMotorMass(tree, [[mount, motor]])! + 0.02;

describe('the Launch button and simulateDesign fly a stored design the same', () => {
  it('C1: the starter rocket on a first visit', async () => {
    const { out } = await sessionCase(null, CLASSIC);
    expect(out.run.motor).toBe('C6');
  }, 60000);

  it('C2: a weighed pad mass — the hardware flies', async () => {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const m = await c6();
    const { out } = await sessionCase({
      tree, launch: DEFAULT_CONDITIONS, measured: { massKg: 0.1, cgM: null },
      mountMotors: { [mount]: { ...m, padMassKg: weighed(tree, mount, m), padMassWeighedWith: padMassSetKey(tree, { [mount]: m }) } },
    }, CLASSIC);
    expect(out.build.hardware.state).toBe('ok');
  }, 60000);

  /**
   * C3: THE LEGACY PAD MASS THAT MOVES A NUMBER. The sustainer's motor is only
   * an unmatched reference and the booster carries a v0.117 value keyed
   * 'legacy': App's reconcile drops it before any Launch, where a build that
   * skipped it flies the value as hardware under the booster.
   */
  it('C3: a legacy pad mass the file’s primary cannot place — dropped, as App drops it', async () => {
    const base = defaultTree();
    const sustainer = motorMounts(base)[0]!.id!;
    const { tree: staged, newId } = addStage(base);
    const tree = addChild(staged, newId, {
      type: 'bodytube', id: 'boo-bt', name: 'Booster tube', length: 0.1, outerRadius: 0.0124, thickness: 0.0003,
      children: [{ type: 'innertube', id: 'boo-mmt', name: 'Booster MMT', motorMount: true,
        length: 0.07, outerRadius: 0.0095, thickness: 0.0003 } as ComponentNode],
    } as ComponentNode);
    const m = await c6();
    // The reference carries the file's own pad mass as well: the drop strips it
    // there too (padMassReconcile.legacyPadMassWrite's `refs`), and App's
    // write of that is a line of its own in the reconcile effect
    // (verify-step1 finding 4) — compared through `unmatchedRefs`.
    const { app, input, out } = await sessionCase({
      tree, launch: DEFAULT_CONDITIONS, measured: { massKg: 0.1, cgM: null },
      mountMotors: { 'boo-mmt': { ...m, padMassKg: weighed(tree, 'boo-mmt', m), padMassWeighedWith: LEGACY_PAD_MASS_KEY } },
      unmatchedRefs: { [sustainer]: { designation: 'K550', manufacturer: 'AeroTech', diameter: 0.054, length: 0.4, delay: 10, padMassKg: 1.2 } },
    }, CLASSIC);
    // The headless side was handed the value UNSETTLED — else the settle is not tested.
    expect(input.mountMotors['boo-mmt']!.padMassWeighedWith).toBe(LEGACY_PAD_MASS_KEY);
    expect(input.unmatchedRefs![sustainer]!.padMassKg).toBe(1.2);
    expect(app.notice).toContain('could not be placed');
    expect(out.padMassNote?.text).toContain('could not be placed');
    expect('padMassKg' in out.state.mountMotors['boo-mmt']!).toBe(false);
    expect('padMassKg' in app.unmatchedRefs[sustainer]!).toBe(false);
  }, 60000);

  it('C3′: a legacy pad mass that checks out — re-keyed to the set now loaded', async () => {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const m = await c6();
    const { input, out } = await sessionCase({
      tree, launch: DEFAULT_CONDITIONS, measured: { massKg: 0.1, cgM: null },
      mountMotors: { [mount]: { ...m, padMassKg: weighed(tree, mount, m), padMassWeighedWith: LEGACY_PAD_MASS_KEY } },
    }, CLASSIC);
    expect(input.mountMotors[mount]!.padMassWeighedWith).toBe(LEGACY_PAD_MASS_KEY);
    expect(out.state.mountMotors[mount]!.padMassWeighedWith).not.toBe(LEGACY_PAD_MASS_KEY);
    expect(out.build.hardware.state).toBe('ok');
  }, 60000);

  it('C3″: a v0.117 session — the pad mass in the Measured box, migrated by the restore', async () => {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const m = await c6();
    const { input, out } = await sessionCase({
      tree, launch: DEFAULT_CONDITIONS, measured: { massKg: 0.1, cgM: null, padMassKg: weighed(tree, mount, m) },
      mountMotors: { [mount]: m },
    }, CLASSIC);
    expect(input.mountMotors[mount]!.padMassWeighedWith).toBe(LEGACY_PAD_MASS_KEY);
    expect(out.build.hardware.state).toBe('ok');
  }, 60000);

  it('C4: a pod motor the kernel refused — left out of the flight and the delay vector', async () => {
    const base = defaultTree();
    const body = base.components[0]!.children!.find((n) => n.type === 'bodytube')!;
    const tree = addChild(base, body.id!, {
      type: 'podset', id: 'pods', name: 'Side pods', instanceCount: 2, children: [{
        type: 'bodytube', id: 'pod-bt', name: 'Pod tube', length: 0.1, outerRadius: 0.01, thickness: 0.0005,
        children: [{ type: 'innertube', id: 'pod-mmt', name: 'Pod MMT', motorMount: true,
          length: 0.07, outerRadius: 0.0095, thickness: 0.0003 } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode);
    const core = motorMounts(tree).find((n) => n.id !== 'pod-mmt')!.id!;
    const m = await c6();
    const refused = { ...m, spec: { ...m.spec, masses: m.spec.masses.map((x, i, all) => (i === all.length - 1 ? -0.001 : x)) } };
    const { out } = await sessionCase({ tree, launch: DEFAULT_CONDITIONS, mountMotors: { [core]: m, 'pod-mmt': refused } }, CLASSIC);
    expect(out.build.motorFailures).toHaveLength(1);
    expect(out.run.delayResolution?.mounts.map((x) => x.mountId)).toEqual([core]);
  }, 60000);

  it('C5: Auto aero and Auto delay — the probe upgrades it, the delay is re-solved', async () => {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const f67 = (await loadCatalogueMotor('AeroTech', 'F67', 6))!;
    const { app, out } = await sessionCase({
      tree, launch: DEFAULT_CONDITIONS, mountMotors: { [mount]: { ...f67, meta: { ...f67.meta, autoDelay: true } } },
    }, AUTO);
    expect(app.upgraded).toBe(true);
    expect(out.run.aeroModel).toBe('auto-supersonic');
    expect(out.run.delayResolution?.probes).toBeGreaterThan(0);
  }, 60000);

  it('C5′: Auto’s SECOND Launch — flown on the supersonic statics the first one switched on', async () => {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const f67 = (await loadCatalogueMotor('AeroTech', 'F67', 6))!;
    const { app, out } = await sessionCase({ tree, launch: DEFAULT_CONDITIONS, mountMotors: { [mount]: f67 } }, AUTO,
      { presses: 2, headless: { ...AUTO, autoSupersonic: true } });
    // App flew the second press on the upgraded model — else this is C5 again.
    expect(app.args.derived.effectiveSupersonic).toBe(true);
    expect(out.run.aeroModel).toBe('auto-supersonic');
  }, 90000);

  it('C6: the Supersonic model', async () => {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const f67 = (await loadCatalogueMotor('AeroTech', 'F67', 6))!;
    const { app, out } = await sessionCase({ tree, launch: DEFAULT_CONDITIONS, mountMotors: { [mount]: f67 } }, SUPERSONIC);
    expect(app.args.derived.effectiveSupersonic).toBe(true);
    expect(out.run.aeroModel).toBe('supersonic');
  }, 60000);

  it('Hybrid: the Launch button and headless run agree through the Mach band', async () => {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const f67 = (await loadCatalogueMotor('AeroTech', 'F67', 6))!;
    const { app, out } = await sessionCase({ tree, launch: DEFAULT_CONDITIONS,
      mountMotors: { [mount]: f67 } }, { ...CLASSIC, aeroMode: 'hybrid' });
    expect(app.args.derived.effectiveSupersonic).toBe(false);
    expect(app.upgraded).toBe(false);
    expect(out.run.aeroModel).toBe('hybrid');
    expect(out.run.rogersKbf).toBe(true);
    expect(out.result.summary.maxMachNumber).toBeGreaterThan(0.9);
  }, 60000);

  /**
   * C7: THE PRIMARY IS NOT THE FIRST MOTOR PICKED (verify-step1 finding 2). A
   * two-stage design whose booster motor is first in record order: the report
   * names the sustainer's motor. Both sides read the primary inside
   * flyBuiltDesign, so the agreement alone cannot see a slip there — the
   * explicit motor names can.
   */
  it('C7: a two-stage design whose booster motor was picked first — the sustainer’s motor is the report’s', async () => {
    const base = defaultTree();
    const sustainer = motorMounts(base)[0]!.id!;
    const { tree: staged, newId } = addStage(base);
    const tree = addChild(staged, newId, {
      type: 'bodytube', id: 'boo-bt', name: 'Booster tube', length: 0.1, outerRadius: 0.0124, thickness: 0.0003,
      children: [{ type: 'innertube', id: 'boo-mmt', name: 'Booster MMT', motorMount: true,
        length: 0.07, outerRadius: 0.0095, thickness: 0.0003 } as ComponentNode],
    } as ComponentNode);
    const b6 = (await loadCatalogueMotor('Estes', 'B6', 0))!;
    const c6m = await c6();
    const { app, out } = await sessionCase({
      tree, launch: DEFAULT_CONDITIONS, mountMotors: { 'boo-mmt': b6, [sustainer]: c6m },
    }, CLASSIC);
    expect(app.args.derived.assigned.map(([id]) => id)).toEqual(['boo-mmt', sustainer]);
    expect(app.out.run.motor).toBe(c6m.spec.designation);
    expect(out.run.motor).toBe(c6m.spec.designation);
    expect(out.run.boosterMotors).toEqual([b6.label]);
  }, 60000);
});

/** reference.ork's XML (unzipped: the .ork reader takes plain XML too) with `extra` as the rocket's first children. */
function referenceWith(extra: string): Uint8Array {
  const xml = new TextDecoder().decode(unzipMember(fixture('reference.ork'), '.ork', '.ork'));
  const at = xml.indexOf('<rocket>');
  expect(at).toBeGreaterThan(-1);
  const end = at + '<rocket>'.length;
  return new TextEncoder().encode(`${xml.slice(0, end)}${extra}${xml.slice(end)}`);
}
/** A v0.116-style bare <measuredpadmass> (no configid): opened keyed 'legacy'. */
const referenceWithLegacyPadMass = (kg: number) => referenceWith(`<measuredpadmass>${kg}</measuredpadmass>`);

describe('the Launch button and simulateFile fly an opened file the same', () => {
  // Headless isolation must not change App's own Open/Launch (2026-10-01).
  // Store a real overlay so the mount's restore effect takes the browser path.
  it('F12: App opens and launches with the browser catalogue overlay', async () => {
    const baseline = await simulateFile(fixture('reference.ork'), 'reference.ork');
    const c6 = MOTOR_DB.find((m) => m.manufacturerAbbrev === 'Estes' && m.designation === 'C6')!;
    expect(c6.length).toBe(70);
    localStorage.setItem(OVERLAY_KEY, JSON.stringify({
      ...diffCatalogue(MOTOR_DB, MOTOR_DB.map((m) => m === c6 ? { ...m, length: 71 } : m)),
      baseGenerated: MOTOR_DB_DATE, fetchedAt: '2026-10-01T00:00:00Z', liveCount: MOTOR_DB.length, rejected: [],
    }));
    prefs(CLASSIC);
    const host = await mountApp();
    await waitFor(starterStored, 'starter motor');
    await settle(50);
    const markBefore = peekSession()?.savedMark;
    parsed = null;
    await pick(host, new File([fixture('reference.ork') as Uint8Array<ArrayBuffer>], 'reference.ork'));
    await waitFor(() => parsed !== null && shownName(host) === baseline.state.tree.name
      && peekSession()?.savedMark !== markBefore, 'opened reference to be autosaved');
    await settle(100);
    const app = await launchInApp(host);
    const spec = app.args.derived.assigned[0]![1].spec;
    expect(spec.length).toBe(0.071);
    expect(spec.cgX).toBe(0.0355);
    expect(spec).not.toStrictEqual(Object.values(baseline.state.mountMotors)[0]!.spec);
  }, 60000);

  it('F1: a .ork', async () => {
    const { out } = await fileCase(fixture('reference.ork'), 'reference.ork', CLASSIC);
    expect(out.run.motor).toBe('C6');
  }, 60000);

  it('F2: a .ork with two configurations — the active one named on the run', async () => {
    const { out } = await fileCase(fixture('lemiv-motors.ork'), 'lemiv-motors.ork', CLASSIC);
    expect(out.run.flightConfig).toBeDefined();
    expect(out.state.savedConfigs).toHaveLength(2);
  }, 60000);

  it('F3: a .rkt', async () => {
    const { out } = await fileCase(fixture('rocksimTestRocket1.rkt'), 'rocksimTestRocket1.rkt', CLASSIC);
    expect(out.run.motor).toBe('E6');
  }, 60000);

  it('F4: a .CDX1 with two motor mounts', async () => {
    const { out } = await fileCase(fixture('Show-off.CDX1'), 'Show-off.CDX1', CLASSIC);
    expect(out.run.motor).toBe('1/4A2');
    expect(Object.keys(out.state.mountMotors).length).toBeGreaterThan(1);
  }, 60000);

  it('F5: a two-stage .CDX1 that names itself generically — named after its file', async () => {
    const { out } = await fileCase(fixture('Complex.Two-Stage.CDX1'), 'My_Test_Rocket.CDX1', CLASSIC);
    expect(out.run.rocket).toBe('My Test Rocket');
    expect(out.run.motor).toBe('J90W');
  }, 60000);

  it('F11: a .ork flown with Rogers Kbf off (Extended Barrowman) — stamped as flown', async () => {
    const { app, out } = await fileCase(fixture('reference.ork'), 'reference.ork', KBF_OFF);
    expect(app.out.run.rogersKbf).toBe(false);
    expect(out.run.rogersKbf).toBe(false);
  }, 60000);

  it('F6: a supersonic .CDX1 on Auto aero — upgraded mid-flight', async () => {
    const { app, out } = await fileCase(fixture('Wildman_Mach 2 this one.CDX1'), 'Wildman_Mach 2 this one.CDX1', AUTO);
    expect(app.upgraded).toBe(true);
    expect(out.run.aeroModel).toBe('auto-supersonic');
  }, 60000);

  it('F7: a .CDX1 whose sustainer motor no catalogue has — the reference kept, the booster flown', async () => {
    const xml = new TextDecoder().decode(fixture('Show-off.CDX1'))
      .replace('<SustainerEngine>1/4A2  (AP)</SustainerEngine>', '<SustainerEngine>Z9999  (ZZ)</SustainerEngine>');
    const { out } = await fileCase(new TextEncoder().encode(xml), 'Show-off.CDX1', CLASSIC);
    expect(Object.values(out.state.unmatchedRefs ?? {}).map((r) => r.designation)).toContain('Z9999');
  }, 60000);

  /**
   * F8/F9: A FILE'S LEGACY PAD MASS, OPEN → SETTLE END TO END. A v0.116 .ork
   * carries its pad mass with no configuration id; the open keys it 'legacy',
   * and App's reconcile decides it after the first build. One that checks out
   * is re-keyed and flown; one lighter than the rocket is dropped.
   */
  it('F8: a .ork with a legacy pad mass that checks out — re-keyed and flown', async () => {
    const probe = await simulateFile(fixture('reference.ork'), 'reference.ork');
    const kg = probe.build.info.massEmpty + catalogueMotorMass(probe.state.tree, Object.entries(probe.state.mountMotors))! + 0.005;
    const { out } = await fileCase(referenceWithLegacyPadMass(kg), 'reference.ork', CLASSIC);
    expect(out.plan.snapshot.mountMotors[Object.keys(out.plan.snapshot.mountMotors)[0]!]!.padMassWeighedWith)
      .toBe(LEGACY_PAD_MASS_KEY);
    expect(out.build.hardware.state).toBe('ok');
  }, 60000);

  it('F10: a .ork with a Measured mass and a weighed pad mass — the measured dry mass sets the hardware', async () => {
    const probe = await simulateFile(fixture('reference.ork'), 'reference.ork');
    const dry = probe.build.info.massEmpty * 1.1;
    const kg = dry + catalogueMotorMass(probe.state.tree, Object.entries(probe.state.mountMotors))! + 0.01;
    const { out } = await fileCase(referenceWith(`<measuredmass>${dry}</measuredmass>`
      + `<measuredpadmass configid="${probe.state.activeConfigId}">${kg}</measuredpadmass>`), 'reference.ork', CLASSIC);
    expect(out.state.measured.massKg).toBeCloseTo(dry, 12);
    expect(out.build.hardware).toMatchObject({ state: 'ok', drySource: 'measured' });
  }, 60000);

  it('F9: a .ork with a legacy pad mass lighter than the rocket — dropped', async () => {
    const { app, out } = await fileCase(referenceWithLegacyPadMass(0.001), 'reference.ork', CLASSIC);
    const [record] = Object.values(out.state.mountMotors);
    expect('padMassKg' in record!).toBe(false);
    expect(out.padMassNote?.text).toContain('was not kept');
    expect(app.padMassNote).toStrictEqual(out.padMassNote);
    expect(out.build.hardware.state).not.toBe('ok');
  }, 60000);
});

const corpus = (name: string) => join(CORPUS, name);
describe('the Launch button and simulateFile fly a real design the same (local corpus)', () => {
  it.skipIf(!existsSync(corpus('LEM-M2B.ork')))('K1: LEM-M2B.ork, seven configurations', async () => {
    const { out } = await fileCase(new Uint8Array(readFileSync(corpus('LEM-M2B.ork'))), 'LEM-M2B.ork', CLASSIC);
    expect(out.run.flightConfig).toBeDefined();
  }, 60000);

  it.skipIf(!existsSync(corpus('4in WM Extreme.rkt')))('K2: 4in WM Extreme.rkt, another simulation re-picked', async () => {
    await fileCase(new Uint8Array(readFileSync(corpus('4in WM Extreme.rkt'))), '4in WM Extreme.rkt', CLASSIC);
  }, 60000);

  it.skipIf(!existsSync(corpus('WM_4_Extreme.CDX1')))('K3: WM_4_Extreme.CDX1, a RASAero export', async () => {
    await fileCase(new Uint8Array(readFileSync(corpus('WM_4_Extreme.CDX1'))), 'WM_4_Extreme.CDX1', CLASSIC);
  }, 60000);

  it.skipIf(!existsSync(corpus('WM_4_Extreme.ork')))('K4: WM_4_Extreme.ork on Auto aero', async () => {
    const { app } = await fileCase(new Uint8Array(readFileSync(corpus('WM_4_Extreme.ork'))), 'WM_4_Extreme.ork', AUTO);
    expect(app.upgraded).toBe(true);
  }, 60000);
});
