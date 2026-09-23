// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from './App.js';
import { DEFAULT_CONDITIONS } from './components/LaunchPanel.js';
import type { MountMotor } from './model/design.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { loadCatalogueMotor } from './services/motorMatch.js';
import { exportOrk } from './services/orkFile.js';
import type { SaveOutcome } from './services/saveFile.js';
import type { SessionState } from './services/session.js';
import { addChild, addStage, defaultTree, motorMounts } from './tree/treeModel.js';
import { APP_VERSION } from './version.js';

/**
 * WHAT App HANDS THE NOZZLE RULES (audit 2026-09-22, row 477). Each rule is a
 * unit tested by behaviour where it lives — the follow hook's seed and
 * `restoring` (useNozzleFollow.test.tsx, nozzleWiring.test.ts), the report's
 * pressure-thrust sentence and the stored-run stamp (simReport.test.ts), the
 * .ork flight-data guard (orkFlightData.test.ts) — and each needs App to hand
 * it the right thing. nozzleWiring.test.ts held those hand-offs as string
 * matches over App.tsx; here App is mounted and each is driven to what the
 * user sees: the nozzle field, the launch report, "Show the last saved
 * flight" and what Save .ork writes.
 *
 * The harness is App.render.test.tsx's (the real TeaVM kernel, the bundled
 * catalogue, fetch stubbed to fail as offline), with the file writer stubbed so
 * no download happens and the .ork writer passed through to read what a Save
 * wrote.
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no canvas (the same stand-in App.session.test.tsx uses).
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
  window.dispatchEvent(new Event('pagehide'));
  for (const { root, host } of mounted) {
    await act(async () => { root.unmount(); });
    host.remove();
  }
  mounted = [];
}

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

/** Native setter + change event, for a <select>. */
async function choose(el: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** A workspace tab, pressed. */
async function openTab(host: HTMLElement, name: 'Design' | 'Motors & Launch' | 'Results'): Promise<void> {
  const b = [...host.querySelectorAll<HTMLButtonElement>('.workspace-tabs button')]
    .find((x) => x.textContent?.trim() === name);
  if (!b) throw new Error(`no tab "${name}"`);
  await act(async () => { b.click(); });
}

const shownName = (host: HTMLElement) => host.querySelector('.vitals-item-name .vitals-value')?.textContent;
const storedSession = (): SessionState => JSON.parse(localStorage.getItem(SESSION_KEY)!) as SessionState;
const storedRuns = () => JSON.parse(localStorage.getItem(RUNS_KEY) ?? '[]') as { nozzleStages?: string[] }[];

/** Launch pressed, and the flight it records saved. */
async function launch(host: HTMLElement): Promise<void> {
  const before = storedRuns().length;
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Launch')!.click();
  });
  await waitFor(() => storedRuns().length > before, 'the flight to be saved');
  await settle(0);
}

/** `t` with a nozzle exit of `m` metres on stage `stage` (0 = the sustainer). */
const withNozzle = (t: RocketTree, m: number, stage = 0): RocketTree => ({
  ...t,
  components: t.components.map((st, i) => (i === stage ? { ...st, nozzleExitDiameter: m } as ComponentNode : st)),
});

/** A stored session holding `tree` with `motors` on it, written as the autosave writes one. */
function seedSession(tree: RocketTree, motors: Record<string, MountMotor>, over: object = {}): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    tree, mountMotors: motors, launch: DEFAULT_CONDITIONS, appVersion: APP_VERSION, savedAt: Date.now(), ...over,
  }));
}

const c6 = async () => (await loadCatalogueMotor('Estes', 'C6', 5))!;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('online-openrocket.workspace.v1', 'design');
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  vi.mocked(exportOrk).mockClear();
});

afterEach(async () => {
  await unmountAll();
  vi.unstubAllGlobals();
});

/**
 * A CONFIGURATION SWITCH KEEPS THE NOZZLE THE CONFIGURATION STATES (audit
 * 2026-09-22, row 279). Measured by the audit on ThreeCarbYen-2018.CDX1:
 * switching to sim-2 deleted its stated 25.40 mm sustainer exit under a false
 * note ("was for M745…"), and Save then dropped it — the follow hook had never
 * seen the new loadout and took the switch for a motor swap. App hands the
 * switch the hook's seed; nozzleWiring.test.ts has the switch and the hook
 * together, and held App's hand-off as a string match.
 */
describe('a flight-configuration switch in App', () => {
  it('keeps the sustainer exit the configuration states, with no "was for" note', async () => {
    const host = await mountApp();
    await waitFor(() => Object.keys(JSON.parse(localStorage.getItem(SESSION_KEY) ?? '{}').mountMotors ?? {}).length > 0,
      'the starter motor to be autosaved');
    const picker = input(host, 'Open a design file');
    const file = new File([readFileSync(join(here, 'services/__fixtures__/ThreeCarbYen-2018.CDX1'), 'utf8')],
      'ThreeCarbYen-2018.CDX1');
    Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
    await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => shownName(host) === 'ThreeCarbYen-2018', 'the file to open');
    await openTab(host, 'Motors & Launch');
    const exit = (stage: string) => Number(input(host, `Nozzle exit diameter for ${stage} (`).value);
    // sim-1 as opened: 1.000 in on the sustainer, 1.750 in on the first booster.
    expect(exit('Sustainer')).toBeCloseTo(25.4, 2);
    expect(exit('Booster')).toBeCloseTo(44.45, 2);
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Apply [M1401-P, N1560-P, N5800-0]"]')!.click();
    });
    await settle(50); // the follow hook's lookups
    // sim-2 states 1.000 in and 2.500 in, and the switch keeps both…
    expect(exit('Sustainer')).toBeCloseTo(25.4, 2);
    expect(exit('Booster')).toBeCloseTo(63.5, 2);
    // …without the "Cleared — … was for M745-P" note a motor swap earns.
    expect(host.querySelector('[data-nozzle="cleared"]')).toBeNull();
    window.dispatchEvent(new Event('pagehide'));
    expect(storedSession().tree.components[0]!['nozzleExitDiameter']).toBeCloseTo(0.0254, 6);
  }, 30000);
});

/**
 * UNDO AFTER A MOTOR CHANGE (audit 2026-09-22, from review). The undo stack
 * holds the tree alone, so a state recorded before the motor changed carries
 * that motor's exit; App hands every tree coming off the stack to the follow
 * hook (`onRestore` → `restoring`) before it is written, and the hook makes
 * the same decision on it the motor change made. useNozzleFollow.test.tsx has
 * the hook with and without that hand-off; nozzleWiring.test.ts held App's
 * as a regex. Here: rename, unload the C6 (its 5 mm exit is cleared — the
 * motor it belonged to has gone), then Undo the rename.
 */
describe('Undo after a motor is unloaded', () => {
  it('takes the rename back and leaves the unloaded motor’s exit cleared', async () => {
    const tree = withNozzle(defaultTree(), 0.005);
    const mount = motorMounts(tree)[0]!;
    const motor = await c6();
    seedSession(tree, { [mount.id!]: motor });
    const host = await mountApp();
    await settle(50);
    await type(host.querySelector<HTMLInputElement>('#rocket-name')!, 'Renamed');
    await openTab(host, 'Motors & Launch');
    const exit = () => input(host, 'Nozzle exit diameter for Sustainer').value;
    expect(Number(exit())).toBeCloseTo(5, 2);
    await act(async () => {
      host.querySelector<HTMLButtonElement>(`button[aria-label="Remove ${motor.label} from ${mount.name}"]`)!.click();
    });
    await settle(50);
    expect(exit()).toBe('');
    expect(host.querySelector('[data-nozzle="cleared"]')?.textContent).toContain(`was for ${motor.label}`);
    await act(async () => { button(host, '↩ Undo').click(); });
    await settle(50);
    expect(shownName(host)).toBe('My Rocket'); // the rename came off…
    expect(exit()).toBe('');                   // …and the 5 mm did not come back with it
    window.dispatchEvent(new Event('pagehide'));
    expect('nozzleExitDiameter' in storedSession().tree.components[0]!).toBe(false);
  }, 30000);
});

/**
 * THE LAUNCH REPORT NAMES THE STAGES THAT FLEW A NOZZLE (2026-09-08). The
 * sentence is simReport's, tested there; App hands it the names — of the
 * stages that carry a nozzle AND flew a motor (the kernel's own gate is
 * `getThrust(t) > 0`, so a nozzle on an empty stage bought nothing), and
 * never gated on the aero model, which the report decides from the run's own
 * stamps. nozzleWiring.test.ts held both as string matches over App.tsx.
 */
describe('the launch report on a design with a nozzle', () => {
  it('names the stage that flew a motor, not the empty one above it', async () => {
    // Two stages, a nozzle on each; the C6 on the BOOSTER's mount, the sustainer's mount empty.
    const { tree: staged, newId } = addStage(defaultTree());
    const tree = withNozzle(withNozzle(addChild(staged, newId, {
      type: 'bodytube', id: 'booster-bt', name: 'Booster tube', length: 0.2, outerRadius: 0.0125,
      thickness: 0.0003, children: [{
        type: 'innertube', id: 'booster-mmt', name: 'Booster mount', motorMount: true,
        length: 0.07, outerRadius: 0.0095, thickness: 0.0003,
      } as ComponentNode],
    } as ComponentNode), 0.005, 0), 0.005, 1);
    seedSession(tree, { 'booster-mmt': await c6() });
    const host = await mountApp();
    await settle(50);
    await launch(host);
    const said = /Thrust was corrected for ambient pressure: (.*?) carr(?:y|ies) a nozzle exit diameter/
      .exec(host.textContent ?? '');
    expect(said?.[1]).toBe(tree.components[1]!.name);
    expect(storedRuns()[0]!.nozzleStages).toEqual([tree.components[1]!.name]);
  }, 30000);

  /**
   * Flown on Classic Extended Barrowman — where the term is off — the run still
   * carries the names, so switching back to Rogers Kbf says only that the MODEL
   * differs. Names gated on the model would leave the run unstamped, and the
   * report would add that the motor thrust model changed since: two answers to
   * one question.
   */
  it('stamps the run on every model, so a model switch is not reported as a thrust-model change', async () => {
    const tree = withNozzle(defaultTree(), 0.005);
    seedSession(tree, { [motorMounts(tree)[0]!.id!]: await c6() });
    const host = await mountApp();
    await settle(50);
    const aero = host.querySelector<HTMLSelectElement>('select[aria-label="Aerodynamics model (this session)"]')!;
    await choose(aero, 'eb');
    await launch(host);
    expect(host.textContent).not.toContain('Thrust was corrected for ambient pressure'); // the term is off
    expect(storedRuns()[0]!.nozzleStages).toEqual([tree.components[0]!.name]);
    await choose(aero, 'kbf');
    expect(host.textContent).toContain('These numbers were flown on Classic Extended Barrowman');
    expect(host.textContent).not.toContain('the motor thrust model');
  }, 30000);
});

/**
 * THE STORED-RUN GUARD (2026-09-08, review). A run flown before v0.119 has no
 * pressure-thrust stamp, and none of the three keys that match a run to the
 * design hashes the kernel, so on a design that spends the term such a run
 * used to count as "matches the design as it stands" — re-flown up to +29.7 %
 * higher, and written into a .ork as the configuration's result. The rules are
 * simReport's and orkFlightData's, tested there; App tells both whether the
 * design HAS a nozzle (`hasNozzle`), which nozzleWiring.test.ts held as string
 * matches over App.tsx and orkFlightData.ts. Here a real flight is stored, then
 * stripped of its stamp the way an older build wrote it.
 */
describe('a stored run from before the pressure-thrust term, on a design with a nozzle', () => {
  it('is not offered to redraw, and Save .ork writes no flight data for it', async () => {
    const tree = withNozzle(defaultTree(), 0.005);
    // In a flight configuration, as an opened .ork is: a .ork carries a
    // configuration's flight, and a flight flown with none has none to go under.
    const motors = { [motorMounts(tree)[0]!.id!]: await c6() };
    seedSession(tree, motors, {
      savedConfigs: [{ id: 'A', name: 'A', isDefault: true, motors }], activeConfigId: 'A',
    });
    let host = await mountApp();
    await settle(50);
    await launch(host);
    expect(storedRuns()[0]!.nozzleStages).toEqual([tree.components[0]!.name]);
    await unmountAll();

    /** After a reload: whether Results offers the saved flight, and what Save .ork writes. */
    const afterReload = async () => {
      host = await mountApp();
      await settle(50);
      await openTab(host, 'Results');
      const offered = (host.textContent ?? '').includes('📈 Show the last saved flight');
      vi.mocked(exportOrk).mockClear();
      await act(async () => { button(host, 'Save As / Export').click(); });
      await act(async () => { button(host.querySelector('.file-menu')!, 'Save .ork').click(); });
      await settle(0);
      const flightData = vi.mocked(exportOrk).mock.calls.at(-1)![0].flightData ?? {};
      await unmountAll();
      return { offered, flightData: Object.keys(flightData).length };
    };
    // The control: stamped, it matches — offered, and written.
    expect(await afterReload()).toEqual({ offered: true, flightData: 1 });
    // The same flight as a build before v0.119 stored it.
    localStorage.setItem(RUNS_KEY, JSON.stringify(storedRuns().map(({ nozzleStages: _n, ...r }) => r)));
    expect(await afterReload()).toEqual({ offered: false, flightData: 0 });
  }, 30000);
});
