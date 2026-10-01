// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App.js';
import { DEFAULT_CONDITIONS } from './components/LaunchPanel.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { testMotor, testResolution } from './services/autoDelay.testSupport.js';
import { flyLaunch, reflyRun } from './services/flightRunner.js';
import { loadCatalogueMotor } from './services/motorMatch.js';
import type { SessionState } from './services/session.js';
import { addChild, defaultTree, motorMounts } from './tree/treeModel.js';
import { APP_VERSION } from './version.js';

/**
 * LAUNCH AND RE-FLY STATE, rendered (audit 2026-09-30, Step 2): what App hands
 * the flight runner when it flies and re-flies a design, and what it does with
 * what comes back. services/flightRunner.test.ts flies the protocol itself;
 * this is App's half — the build's refusals passed on, the gates on its
 * buttons, and which design a flight's results land on.
 *
 * The harness is App.render.test.tsx's: the real TeaVM kernel, the bundled
 * catalogue and curves, fetch stubbed to fail as offline. The flight runner's
 * two entry points are passed straight through with a handle, so a test can
 * count the re-flies and hold a Launch at its await; the flight-plots block
 * and the run table are passed through with their props kept, so a test can
 * call what App hands them the way any other caller could.
 */
vi.mock('./services/flightRunner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/flightRunner.js')>();
  return { ...real, flyLaunch: vi.fn(real.flyLaunch), reflyRun: vi.fn(real.reflyRun) };
});
type ChartsProps = Parameters<typeof import('./components/FlightCharts.js').FlightCharts>[0];
let charts: ChartsProps | null = null;
vi.mock('./components/FlightCharts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./components/FlightCharts.js')>();
  return {
    ...real,
    FlightCharts: (p: ChartsProps) => {
      charts = p;
      return <real.FlightCharts {...p} />;
    },
  };
});
type HistoryProps = Parameters<typeof import('./components/SimResults.js').SimHistory>[0];
let history: HistoryProps | null = null;
vi.mock('./components/SimResults.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./components/SimResults.js')>();
  return {
    ...real,
    SimHistory: (p: HistoryProps) => {
      history = p;
      return <real.SimHistory {...p} />;
    },
  };
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

function button(host: ParentNode, text: string): HTMLButtonElement {
  const b = [...host.querySelectorAll('button')].find((x) => x.textContent?.includes(text));
  if (!b) throw new Error(`no button "${text}"`);
  return b;
}

const hasButton = (host: ParentNode, text: string): boolean =>
  [...host.querySelectorAll('button')].some((b) => b.textContent?.includes(text));

/** How many runs Saved simulations holds. */
const runs = (): number => (JSON.parse(localStorage.getItem(RUNS_KEY) ?? '[]') as unknown[]).length;

/** The vitals strip's Launch button, pressed. */
async function launch(host: HTMLElement): Promise<void> {
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Launch')!.click();
  });
}

/** The Saved simulations panel, opened. */
async function openHistory(host: HTMLElement): Promise<HTMLElement> {
  const panel = [...host.querySelectorAll('h2')]
    .find((h) => h.textContent?.startsWith('Saved simulations'))!.parentElement!;
  if (hasButton(panel, 'Show')) await act(async () => { button(panel, 'Show').click(); });
  return panel;
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

/** A workspace tab, pressed. */
async function openTab(host: HTMLElement, name: 'Design' | 'Motors & Launch' | 'Results'): Promise<void> {
  const b = [...host.querySelectorAll<HTMLButtonElement>('.workspace-tabs button')]
    .find((x) => x.textContent?.trim() === name);
  if (!b) throw new Error(`no tab "${name}"`);
  await act(async () => { b.click(); });
}

/** `file` chosen in the header's Open… picker, as a user choosing it does. */
async function pick(host: HTMLElement, file: File): Promise<void> {
  const picker = input(host, 'Open a design file');
  Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
  await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })); });
}

function storedSession(): SessionState | null {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) as SessionState : null;
}

/** The starter motor has landed and been autosaved: a first visit is settled. */
const starterStored = () => Object.keys(storedSession()?.mountMotors ?? {}).length > 0;

/** The rocket's name as the vitals strip shows it, on every tab. */
const shownName = (host: HTMLElement) => host.querySelector('.vitals-item-name .vitals-value')?.textContent;

const hasHeading = (host: HTMLElement, start: string): boolean =>
  [...host.querySelectorAll('h2')].some((h) => h.textContent?.startsWith(start));

/**
 * The next Launch, held between its click and its flight — the window the
 * auto-delay solver's yields leave open, for as long as a test needs it. `land`
 * lets it fly. `upgrade` has it cross Mach 0.9 on the way, as an Auto-aero
 * design does: the runner's own upgrade is flown in flightRunner.test.ts, and
 * what matters here is what App does with the callback, which the runner
 * calls only after its last await. `fail` has it throw instead, as a flight
 * the solver refuses does.
 */
function holdLaunch({ upgrade = false, fail }: { upgrade?: boolean; fail?: string } = {}): {
  land: () => Promise<void>;
} {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const real = vi.mocked(flyLaunch).getMockImplementation()!;
  vi.mocked(flyLaunch).mockImplementationOnce(async (rocket, launchInput) => {
    await gate;
    if (fail !== undefined) throw new Error(fail);
    const flight = await real(rocket, launchInput);
    if (!upgrade) return flight;
    launchInput.onSupersonicUpgrade();
    return { ...flight, usedSupersonic: true };
  });
  return { land: () => act(async () => { open(); }) };
}

beforeEach(() => {
  charts = null;
  history = null;
  vi.mocked(flyLaunch).mockClear();
  vi.mocked(reflyRun).mockClear();
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
 * A MOTOR THE BUILD REFUSED IS LEFT OUT OF EVERY RE-FLY, AS IT WAS OUT OF THE
 * LAUNCH (audit 2026-09-30). Launch stores the delay vector for the mounts it
 * flew; App checked it against every assigned mount and passed the re-fly no
 * refusals, so on a design whose pod motor the kernel refused, "Show charts"
 * was hidden for every run and the flight-data download refused with "Saved
 * mount delays are incomplete" — and a fresh Launch could not clear either.
 * The refusal here is the kernel's own (a curve ending below zero mass), not an
 * unknown ignition event, which the flight runner can see for itself: only the
 * build knows about this one, so only App can pass it on.
 */
describe('a design whose pod motor the kernel refused', () => {
  it('still re-flies its runs: the flight-data download, and Show charts on a stored run', async () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    try {
      const tree = podTree(defaultTree());
      const core = motorMounts(tree).find((m) => m.id !== 'pod-mmt')!.id!;
      const c6 = (await loadCatalogueMotor('Estes', 'C6', 5))!;
      const refused = {
        ...c6, spec: { ...c6.spec, masses: c6.spec.masses.map((m, i, all) => (i === all.length - 1 ? -0.001 : m)) },
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        tree, mountMotors: { [core]: c6, 'pod-mmt': refused },
        launch: DEFAULT_CONDITIONS, appVersion: APP_VERSION, savedAt: Date.now(),
      }));
      const host = await mountApp();
      await settle(50);
      // The build refused the pod's motor, and says so — else nothing below is tested.
      expect(document.querySelector('.notice-bar')?.textContent).toContain('ends at a negative mass');

      await launch(host);
      await waitFor(() => runs() === 1, 'the flight to be saved');
      await settle(0);
      // 1. The flight-data download re-flies the flight on screen.
      await act(async () => { button(host, '⬇ Flight data (.csv)').click(); });
      await waitFor(() => created.mock.calls.length > 0
        || (document.body.textContent ?? '').includes('Saved mount delays'), 'the flight data to download');
      expect(document.body.textContent).not.toContain('Saved mount delays');
      expect(created).toHaveBeenCalled();

      // 2. A second flight, so the first is a stored run with no plots in memory:
      // its 📈 Charts is offered, and re-flies it.
      await launch(host);
      await waitFor(() => runs() === 2, 'the second flight to be saved');
      await settle(0);
      await openHistory(host);
      expect(hasButton(host, '📈 Charts'), 'Show charts is offered on the stored run').toBe(true);
      await act(async () => { button(host, '📈 Charts').click(); });
      // Every button of a re-fly in progress reads ⏳ — wait until none does.
      await waitFor(() => !hasButton(host, '⏳'), 'the re-fly to finish');
      expect(document.body.textContent).not.toContain('Saved mount delays');
      // Its series are in memory now: the button has gone, and the plots are drawn.
      expect(hasButton(host, '📈 Charts')).toBe(false);
      expect([...host.querySelectorAll('h2')].some((h) => h.textContent === 'Flight plots')).toBe(true);
    } finally {
      created.mockRestore();
      revoked.mockRestore();
    }
  }, 30000);
});

/**
 * A RE-FLY WAITS FOR A LAUNCH (audit 2026-09-30). "Show charts" and the
 * flight-data download re-fly on the same engine handle a Launch is flying,
 * and an auto-delay Launch yields between up to eight probes, so the UI is
 * live mid-solve. Neither checked: a re-fly's `finally` hands the handle back
 * on the CURRENT model, so on an Auto design the probe had upgraded, the rest
 * of the Launch — probes and final flight — flew Classic under an
 * auto-supersonic stamp, a wrong apogee saved under the wrong label. Here the
 * Launch is held at its await and every way in is tried: the buttons, and the
 * two paths themselves, called the way any other caller could call them.
 */
describe('Show charts and the flight-data download, while a Launch holds the engine', () => {
  it('wait: their buttons say so, the paths refuse, and both work once it has landed', async () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    try {
      const host = await mountApp();
      await waitFor(starterStored, 'the starter motor to be autosaved');
      // Two flights: the second's plots are on screen, the first is a stored run.
      await launch(host);
      await waitFor(() => runs() === 1, 'the first flight to be saved');
      await launch(host);
      await waitFor(() => runs() === 2, 'the second flight to be saved');
      await settle(0);
      await openHistory(host);

      const { land } = holdLaunch();
      await launch(host);
      await settle(50); // past the Launch's paint: in flight, and held there
      expect(vi.mocked(flyLaunch)).toHaveBeenCalledTimes(3);
      // The buttons wait, and the download says why.
      expect(button(host, '⬇ Flight data (.csv)').disabled, 'the download').toBe(true);
      expect(host.querySelector('#flight-data-stale')?.textContent).toBe('Not available while a flight is running.');
      expect(button(host, '📈 Charts').disabled, 'the stored run’s Show charts').toBe(true);
      // Behind them, the two paths refuse whoever calls them.
      await expect(charts!.onFullSeries!()).rejects.toThrow('a flight is running');
      const stored = history!.runs.find((r) => history!.canShowCharts!(r))!;
      await act(async () => { history!.onShowCharts!(stored); });
      await settle(50);
      expect(vi.mocked(reflyRun), 'nothing re-flew on the Launch’s handle').not.toHaveBeenCalled();

      // Landed: both work again.
      await land();
      await waitFor(() => runs() === 3, 'the held flight to be saved');
      await settle(0);
      expect(button(host, '📈 Charts').disabled).toBe(false);
      await act(async () => { button(host, '⬇ Flight data (.csv)').click(); });
      await waitFor(() => created.mock.calls.length > 0, 'the flight data to download');
      expect(vi.mocked(reflyRun)).toHaveBeenCalledTimes(1);
    } finally {
      created.mockRestore();
      revoked.mockRestore();
    }
  }, 30000);

  it('and so do the Results panels’ own Show-charts buttons', async () => {
    let host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await launch(host);
    await waitFor(() => runs() === 1, 'the flight to be saved');
    await settle(0);
    // A reload: the run is stored, nothing is in memory, and the empty panel offers it.
    await unmountAll();
    host = await mountApp();
    await settle(50);
    await openTab(host, 'Results');
    expect(button(host, '📈 Show the last saved flight').disabled).toBe(false);

    const { land } = holdLaunch();
    await launch(host);
    await settle(50);
    expect(button(host, '📈 Show the last saved flight').disabled, 'the empty panel’s').toBe(true);
    // The stored run opened mid-flight: its own panel's button waits as well.
    await openHistory(host);
    await act(async () => { host.querySelector<HTMLElement>('tr.motor-row')!.click(); });
    expect(button(host, '📈 Show charts').disabled, 'the stored run’s panel’s').toBe(true);
    await land();
    await waitFor(() => runs() === 2, 'the held flight to be saved');
    await settle(0);
    expect(vi.mocked(reflyRun)).not.toHaveBeenCalled();
  }, 30000);
});

const fixture = (name: string) => readFileSync(join(here, 'services', '__fixtures__', name), 'utf8');
/** rocksimTestRocket1.rkt opens as “FooBar Test”, with no launch conditions of its own. */
const RKT = 'rocksimTestRocket1.rkt';
const RKT_NAME = 'FooBar Test';

/**
 * WHAT A LAUNCH COMPUTED LANDS ONLY ON THE DESIGN IT FLEW (audit 2026-09-30).
 * Every write after the flight's last await — the Auto aero upgrade, the run on
 * screen, the measured cost the time-step caution quotes, the flown-since-save
 * flag, the spoken "Flight complete" — used to land on whatever was on screen
 * by then. Open a file mid-solve and the opened design showed "M+", flew its
 * next flights supersonic, and asked to be saved for a flight it never flew.
 *
 * Each way the design can change while a Launch awaits is taken here, with the
 * Launch held and set to cross Mach 0.9 on an Auto design. Undo and Redo are
 * not among them: they refuse while a flight holds the engine (App.save.test).
 * An edit to the SAME design counts as a change, the physics reset effect's own
 * rule: the effect has already cleared the shown flight, the upgrade and the
 * cost for the edited design. Either way the flight itself is kept in Saved
 * simulations, stamped with the design it flew — where selecting it shows what
 * changed since — so a Launch press never vanishes.
 *
 * The Rail button row is the one change that moves the airframe ALONE: every
 * other path here moves the motors or the conditions as well, so without it a
 * Launch that compared only those two would pass the whole table.
 *
 * `cost`: whether the time-step caution prices a flight in seconds afterwards.
 * Where the design and its motors are still the ones that flew (a wind typed),
 * the stored run answers for it in place of the dropped write (storedSimCost).
 */
describe('what a Launch computed lands only on the design it flew', () => {
  type Change = (host: HTMLElement) => Promise<void>;
  const paths: [string, Change, boolean][] = [
    ['nothing: the control', async () => {}, true],
    ['Open… a file', async (host) => {
      await pick(host, new File([fixture(RKT)], RKT));
      await act(async () => { button(document.body, 'Open without saving').click(); });
      await waitFor(() => shownName(host) === RKT_NAME, 'the file to open');
      // An open sets the file's own time step — none here, so the default
      // (importApply.importedLaunch). The fine one again, so the caution is up.
      await openTab(host, 'Motors & Launch');
      await type(input(host, 'Time step'), '0.025');
    }, false],
    ['✕ New', async (host) => {
      await openTab(host, 'Design');
      await act(async () => { button(host, '✕ New').click(); });
      await act(async () => { button(document.body, 'Discard & start new').click(); });
      await waitFor(() => shownName(host) === 'New Rocket', 'the new design');
    }, false],
    ['⏏ Unload', async (host) => {
      await act(async () => { button(host, '⏏ Unload').click(); });
    }, false],
    ['a Rail button added on Design: the same motors and conditions, another airframe', async (host) => {
      await openTab(host, 'Design');
      const tube = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')]
        .find((r) => r.querySelector('.tree-label')?.textContent === 'Body tube')!;
      await act(async () => { tube.click(); });
      await act(async () => { button(host, '+ Add to Body tube').click(); });
      const item = [...host.querySelectorAll<HTMLButtonElement>('.add-menu-item')]
        .find((b) => b.textContent?.includes('Rail button'))!;
      await act(async () => { item.click(); });
      await waitFor(() => [...host.querySelectorAll('[role="treeitem"] .tree-label')]
        .some((l) => l.textContent?.includes('Rail button')), 'the Rail button to be added');
    }, false],
    ['a wind typed on Motors & Launch', async (host) => {
      await openTab(host, 'Motors & Launch');
      await type(input(host, 'Wind avg'), '8');
    }, true],
  ];

  it.each(paths)('%s, while the flight is held', async (_what, change, cost) => {
    const landed = change === paths[0]![1]; // only the control's design still stands
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true, aeroModel: 'auto' }));
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    // A step finer than the default, so the caution is up and can quote seconds.
    await openTab(host, 'Motors & Launch');
    await type(input(host, 'Time step'), '0.025');
    const { land } = holdLaunch({ upgrade: true });
    await launch(host);
    await settle(50);
    await change(host);
    await land();
    await waitFor(() => runs() === 1, 'the flight to be saved');
    await settle(50);

    // The flight is kept either way, as a run of the design that flew.
    expect(runs()).toBe(1);
    expect(host.querySelector('.vitals-aero') !== null, 'the Auto aero upgrade ("M+")').toBe(landed);
    expect(document.body.textContent?.includes('Flight complete — apogee'), 'the spoken result').toBe(landed);
    await openTab(host, 'Results');
    expect(hasHeading(host, 'Launch report'), 'the run on screen').toBe(landed);
    await openTab(host, 'Motors & Launch');
    const caution = host.querySelector('.field-caution')?.textContent ?? '';
    expect(caution, 'the time-step caution is up').toContain('0.025 s is finer than');
    expect(caution.includes('per flight instead of'), 'the measured cost').toBe(cost);
    window.dispatchEvent(new Event('pagehide'));
    expect(storedSession()?.flownSinceSave ?? false, 'flown since save').toBe(landed);
  }, 30000);

  /**
   * A flight that fails, likewise: its error is the launched design's, and the
   * reset effect clears an error with the design that threw it — so it does
   * not come back over the one that replaced it.
   */
  it.each([
    ['with nothing done meanwhile (the control)', false],
    ['after ✕ New was pressed while it was held', true],
  ])('a flight that fails, %s', async (_what, replaced) => {
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    const { land } = holdLaunch({ fail: 'the solver gave up (test)' });
    await launch(host);
    await settle(50);
    if (replaced) {
      await openTab(host, 'Design');
      await act(async () => { button(host, '✕ New').click(); }); // an untouched starter: no question
      await waitFor(() => shownName(host) === 'New Rocket', 'the new design');
    }
    await land();
    await waitFor(() => !hasButton(host, 'Simulating…'), 'the flight to end');
    await settle(50);
    expect(document.body.textContent?.includes('the solver gave up (test)'), 'the error').toBe(!replaced);
  }, 30000);
});

/**
 * THE TIME-STEP CAUTION PRICES A DESIGN FROM ITS OWN FLIGHTS (audit 2026-09-30).
 * With no flight this session it falls back to a stored run — which it found
 * by rocket NAME, and ✕ New names every design "New Rocket": fly a big one at
 * twelve seconds a flight, ✕ New, build a small one, and the caution quoted the
 * old flight's cost, the "roughly 64 s per flight" the reset effect beside
 * lastSimCost exists to prevent. Matched now on the design and its motors.
 */
describe('the time-step caution’s measured cost', () => {
  /** The caution on Motors & Launch: up (asserted), and whether it quotes seconds. */
  async function quotesSeconds(host: HTMLElement): Promise<boolean> {
    await openTab(host, 'Motors & Launch');
    const caution = host.querySelector('.field-caution')?.textContent ?? '';
    expect(caution, 'the time-step caution is up').toContain('0.025 s is finer than');
    return caution.includes('per flight instead of');
  }

  /** The starter, named `name`, flown once at a fine step. */
  async function flownAtFineStep(name: string): Promise<HTMLElement> {
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await type(host.querySelector<HTMLInputElement>('#rocket-name')!, name);
    await openTab(host, 'Motors & Launch');
    await type(input(host, 'Time step'), '0.025');
    await launch(host);
    await waitFor(() => runs() === 1, 'the flight to be saved');
    await settle(50);
    expect(await quotesSeconds(host), 'this session’s own flight').toBe(true);
    return host;
  }

  it('is not another design’s that happens to share its name', async () => {
    const host = await flownAtFineStep('New Rocket');
    await openTab(host, 'Design');
    await act(async () => { button(host, '✕ New').click(); });
    await act(async () => { button(document.body, 'Discard & start new').click(); });
    await waitFor(() => shownName(host) === 'New Rocket', 'the new design');
    expect(await quotesSeconds(host)).toBe(false);
  }, 30000);

  it('is the stored flight of the same design and motors after a reload', async () => {
    await flownAtFineStep('Fine step');
    await unmountAll();
    const host = await mountApp();
    await settle(50);
    expect(await quotesSeconds(host)).toBe(true);
  }, 30000);
});

/**
 * THE AUTO-DELAY CARD QUOTES ONLY THIS DESIGN'S FLIGHTS (audit 2026-09-30).
 * With no flight of the design as it stands, the card under an Auto motor falls
 * back to an earlier flight's Auto delay for its mount, found by mount id — and
 * the run list is global, while mount ids are counter values every load mints
 * afresh. So another design's run under the same id put "Previous flight: Auto
 * flew 7 s · ballistic optimum 7.0 s · <that design's branch>" under this motor.
 */
describe('the Auto-delay card under a motor', () => {
  it('quotes no other design’s flight, even one stored under the same mount id', async () => {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const c6 = (await loadCatalogueMotor('Estes', 'C6', 5))!;
    localStorage.setItem(RUNS_KEY, JSON.stringify([{
      id: 'another-design', when: Date.now() - 60_000, rocket: 'Another rocket', motor: 'C6-5',
      delayS: 7, execMs: 100,
      designKey: 'another-design', motorSetKey: 'another-motors', conditionsKey: 'another-conditions',
      delayResolution: testResolution([[mount, testMotor(true)]], [7]),
    }]));
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      tree, mountMotors: { [mount]: { ...c6, meta: { ...c6.meta, autoDelay: true } } },
      launch: DEFAULT_CONDITIONS, appVersion: APP_VERSION, savedAt: Date.now(),
    }));
    const host = await mountApp();
    await settle(50);
    await openTab(host, 'Motors & Launch');
    const card = () => [...host.querySelectorAll('.mount-card p.field-hint')]
      .map((p) => p.textContent ?? '').find((t) => /Auto (delay|flew)/.test(t));
    expect(card()).toBe('Auto delay not yet calculated.');

    // The control: this design's own flight is quoted, and still quoted, as a
    // previous flight, once the conditions move on from it.
    await launch(host);
    await waitFor(() => runs() === 2, 'the flight to be saved');
    await settle(50);
    await openTab(host, 'Motors & Launch');
    expect(card()).toMatch(/^Auto flew \d+ s · ballistic optimum/);
    await type(input(host, 'Wind avg'), '8');
    expect(card()).toMatch(/^Previous flight: Auto flew \d+ s · ballistic optimum/);
  }, 30000);
});
