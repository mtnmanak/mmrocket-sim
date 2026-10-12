// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App.js';
import { DEFAULT_CONDITIONS } from './components/LaunchPanel.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { findAllowance, solePinnedStage } from './services/buildAllowance.js';
import { buildDesign, KERNEL_HANDLES } from './services/buildDesign.js';
import { catalogueMotorMass } from './services/hardwareMass.js';
import { classLabel, MOTOR_DB, setCatalogueOverlay } from './services/motorDb.js';
import { discardCatalogueOverlay } from './services/catalogueOverlay.js';
import { designFingerprint } from './services/dirtyState.js';
import { getExMotor, loadExMotors } from './services/exMotors.js';
import { motorTooltip } from './services/motorLabels.js';
import { loadCatalogueMotor } from './services/motorMatch.js';
import { nozzleOversize } from './services/nozzleCheck.js';
import { peekSession } from './services/session.js';
import { resolveFlightState } from './services/flightState.js';
import { designMatchKeyOf, type SimRun } from './services/simReport.js';
import * as simStore from './services/simStore.js';
import { addChild, addStage, defaultTree, findNode, motorMounts, updateNode } from './tree/treeModel.js';
import type { MountMotor } from './model/design.js';
import { APP_VERSION } from './version.js';

/**
 * App, rendered — for what App itself decides: which of its memos a keystroke
 * re-runs, and what its layout and gates put on screen. The behavioural
 * replacements for the regexes statsDrawerDefault.test.ts, panelHeadWrap.test.ts
 * and noticeBarPhoneLift.test.ts used to run over App.tsx's text, and for some
 * of those in nozzleWiring.test.ts, primaryMount.test.ts, BatchSimulate.test.tsx
 * and appA11y.test.ts (audit 2026-09-22, row 477). The rest of those, and
 * savedMarkSites.test.ts's, are App.a11y, App.save and App.nozzle.test.tsx.
 * The same harness as App.session.test.tsx: the real TeaVM kernel, the bundled
 * starter motor, fetch stubbed to fail as offline.
 *
 * The five spies below pass straight through to the real functions. Each is
 * called, on the Design tab, by exactly ONE of App's memos — which is what
 * lets a count of its calls stand for "that memo re-ran".
 */
vi.mock('./services/buildAllowance.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/buildAllowance.js')>();
  return {
    ...real,
    findAllowance: vi.fn(real.findAllowance),
    solePinnedStage: vi.fn(real.solePinnedStage),
  };
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
vi.mock('./services/motorLabels.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/motorLabels.js')>();
  return { ...real, motorTooltip: vi.fn(real.motorTooltip) };
});
vi.mock('./services/exMotors.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/exMotors.js')>();
  return { ...real, getExMotor: vi.fn(real.getExMotor), loadExMotors: vi.fn(real.loadExMotors) };
});
/**
 * The hero canvas's schematic, passed through with its props kept, so a test
 * can see what App hands it (the chip headroom) and call back what it reports
 * (its natural height). Only the Design tab's hero draws with `fillHeight`.
 */
type SchematicProps = Parameters<typeof import('./components/TreeSchematic.js').TreeSchematic>[0];
let heroSchematic: SchematicProps | null = null;
vi.mock('./components/TreeSchematic.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./components/TreeSchematic.js')>();
  return {
    ...real,
    TreeSchematic: (p: SchematicProps) => {
      if (p.fillHeight) heroSchematic = p;
      return <real.TreeSchematic {...p} />;
    },
  };
});
/**
 * The batch dialog, passed through the same way, so a test can read what App
 * hands it (the loaded motors' nozzle-database ids).
 */
type BatchProps = Parameters<typeof import('./components/BatchSimulate.js').BatchSimulate>[0];
let batchDialog: BatchProps | null = null;
vi.mock('./components/BatchSimulate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./components/BatchSimulate.js')>();
  return {
    ...real,
    BatchSimulate: (p: BatchProps) => {
      batchDialog = p;
      return <real.BatchSimulate {...p} />;
    },
  };
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

/**
 * A window `w` px wide, as matchMedia answers for it — min/max-width queries
 * evaluated, everything else (the colour scheme) false, listeners accepted.
 * Undone by afterEach's unstubAllGlobals.
 */
function viewport(w: number): void {
  vi.stubGlobal('matchMedia', (q: string) => {
    const min = /\(min-width:\s*(\d+)px\)/.exec(q);
    const max = /\(max-width:\s*(\d+)px\)/.exec(q);
    return {
      matches: min ? w >= Number(min[1]) : max ? w <= Number(max[1]) : false,
      media: q,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
    } as unknown as MediaQueryList;
  });
}

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
  heroSchematic = null;
  batchDialog = null;
  localStorage.clear();
  setCatalogueOverlay(null);
  localStorage.setItem('online-openrocket.workspace.v1', 'design');
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
});

afterEach(async () => {
  await unmountAll();
  discardCatalogueOverlay();
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
 * matching behind it). Those five, and only those: a few other memos still key
 * on the whole tree (`stageMotorLoadout`, the two primary-mount lookups,
 * `quickPicksOffered` — the last reads the name) and are not claimed here.
 */
describe('a keystroke in the Rocket name re-runs none of the five memos row 513 narrowed', () => {
  const spies = () => ({
    allowance: vi.mocked(findAllowance).mock.calls.length,
    pinCheck: vi.mocked(solePinnedStage).mock.calls.length,
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

/** The notice bar App renders into (NoticeBar's own element). */
const noticeBar = (): HTMLElement | null => document.querySelector<HTMLElement>('.notice-bar');

describe('flight configuration panel visibility', () => {
  it.each([[0, false], [0, true], [1, false], [2, true]] as const)(
    '%i configurations, loaded motor %s: first full-width row including empty state', async (count, hasMotor) => {
      const tree = defaultTree();
      const mount = motorMounts(tree)[0]!.id!;
      const c6 = (await loadCatalogueMotor('Estes', 'C6', 5))!;
      localStorage.setItem(SESSION_KEY, JSON.stringify({ tree, launch: DEFAULT_CONDITIONS,
        mountMotors: hasMotor ? { [mount]: c6 } : {}, activeConfigId: null,
        // Named: a lone unnamed motorless configuration is a v0.159 phantom
        // that restore drops (sessionRestore), which is not what this pins.
        savedConfigs: Array.from({ length: count }, (_, i) => ({ id: String(i), name: `Config ${i}`, isDefault: false, motors: {} })),
        appVersion: APP_VERSION, savedAt: Date.now() }));
      const host = await mountApp();
      await act(async () => { button(host, 'Motors & Configuration').click(); });
      const panel = host.querySelector('.config-panel');
      expect(panel).not.toBeNull();
      expect(panel!.parentElement!.firstElementChild).toBe(panel);
    }, 30000);
});

/**
 * A stored session holding the starter rocket (`edit` applied to it) with the
 * catalogue C6-5 on its mount, written as the autosave writes one; anything in
 * `over` goes in beside. Returns the rocket and its mount.
 */
async function seedStarterSession(
  { edit = (t) => t, over = {} }: { edit?: (t: RocketTree) => RocketTree; over?: object } = {},
): Promise<{ tree: RocketTree; mount: string; c6: MountMotor }> {
  const tree = edit(defaultTree());
  const mount = motorMounts(tree)[0]!.id!;
  const c6 = (await loadCatalogueMotor('Estes', 'C6', 5))!;
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    tree,
    mountMotors: { [mount]: c6 },
    launch: DEFAULT_CONDITIONS,
    appVersion: APP_VERSION,
    savedAt: Date.now(),
    ...over,
  }));
  return { tree, mount, c6 };
}

/**
 * THE STALE-AUTOSAVE NOTICE IS ADVISORY, AND SAYS SO BY STAYING QUIET. It fires
 * for every returning user after every release (the stored appVersion is not
 * this build's), so at `warn` the bar opened itself on most loads — and on a
 * phone that bar covered the tab bar. noticeBarPhoneLift.test.ts held this as
 * a regex over App.tsx; here it is what App actually puts on the bar.
 */
describe('a design restored from an older build', () => {
  it('is named on the notice bar as information, and the bar stays shut for it', async () => {
    await seedStarterSession({ over: { appVersion: '0.001' } });
    await mountApp();
    await settle(50);
    const bar = noticeBar();
    expect(bar?.textContent).toContain('This design was restored from autosave and was read in by an earlier build');
    expect(bar?.className).toContain('notice-info');
    expect(bar?.className).not.toContain('expanded');
  }, 30000);
});

/**
 * A NOZZLE EXIT WIDER THAN THE MOTOR IT COMES OUT OF (2026-09-08). The check and
 * its sentence are services/nozzleCheck.ts's and the notice is
 * services/notices.ts's, each tested there; this is App handing them the design
 * on screen and the motors actually loaded — the wiring nozzleWiring.test.ts
 * held as regexes over App.tsx until the list had a unit of its own.
 */
describe('a nozzle exit wider than the loaded motor', () => {
  it('is a warning on the bar, in the user\'s unit, with no ×', async () => {
    await seedStarterSession({
      edit: (t) => ({
        ...t,
        components: t.components.map((st) => ({ ...st, nozzleExitDiameter: 0.05 }) as ComponentNode),
      }),
    });
    await mountApp();
    await settle(50);
    const bar = noticeBar();
    expect(bar?.className).toContain('expanded');
    const item = [...(bar?.querySelectorAll('.notice-item') ?? [])]
      .find((li) => li.textContent?.includes('the nozzle exit diameter is'));
    expect(item?.textContent).toContain('the nozzle exit diameter is 50.0 mm, wider than the 18.0 mm casing');
    expect(item?.className).toContain('notice-warn');
    expect(item?.querySelector('.notice-dismiss')).toBeNull();
  }, 30000);

  /**
   * The list is a memo, and the length unit is one of its keys: without it
   * the bar keeps printing millimetres to someone who has just switched to
   * inches. nozzleWiring.test.ts held that key as a string match on the memo's
   * dependency list; this is the switch made where a user makes it (a unit
   * chip on the Design tab) and the bar read back.
   */
  it('follows the length unit when it is switched', async () => {
    await seedStarterSession({
      edit: (t) => ({
        ...t,
        components: t.components.map((st) => ({ ...st, nozzleExitDiameter: 0.05 }) as ComponentNode),
      }),
    });
    const host = await mountApp();
    await settle(50);
    const unit = host.querySelector<HTMLSelectElement>('select[aria-label="Rocket dimensions unit"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(unit, 'in');
      unit.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const item = [...(noticeBar()?.querySelectorAll('.notice-item') ?? [])]
      .find((li) => li.textContent?.includes('the nozzle exit diameter is'));
    expect(item?.textContent).toContain('the nozzle exit diameter is 1.97 in, wider than the 0.709 in casing');
  }, 30000);
});

/**
 * PIN THE STAGE, BUT ONLY WHEN THERE IS ONE TO PIN (v0.074). A weighed rocket
 * whose stage carries a whole-contents mass override cannot take a Build
 * allowance — the override swallows it — so the Measured box offers to pin that
 * stage to the scale instead. The measured figures are whole-airframe and the
 * overrides per-stage, so the offer is made only when exactly one stage is
 * pinned: with two, nothing says which should absorb the difference, and the
 * box says so rather than guess. The session is the starter rocket with its
 * stage(s) pinned and the box holding a weighing 20 g over the pinned mass at
 * the computed CG, which puts the solved ballast inside the pinned sustainer.
 */
describe('a weighed rocket whose stage stands in for its own mass', () => {
  async function pinnedSession(twoStages: boolean): Promise<string> {
    const pin = (st: ComponentNode) =>
      ({ ...st, overrideSubcomponentsMass: true, overrideMass: 0.1 }) as ComponentNode;
    const staged = (t: RocketTree): RocketTree => {
      if (!twoStages) return t;
      const { tree, newId } = addStage(t);
      return addChild(tree, newId, {
        type: 'bodytube', id: 'booster-bt', name: 'Booster tube', length: 0.2, outerRadius: 0.0125,
        thickness: 0.0003,
      } as ComponentNode);
    };
    const probe = ((t: RocketTree) => ({ ...t, components: t.components.map(pin) }))(staged(defaultTree()));
    const mount = motorMounts(probe)[0]!.id!;
    const c6 = (await loadCatalogueMotor('Estes', 'C6', 5))!;
    const built = buildDesign({
      tree: probe, assigned: [[mount, c6]], kbf: true, supersonic: false,
      measuredDryMassKg: null, primaryMountId: mount, currentSetKey: '',
    }, KERNEL_HANDLES);
    if ('error' in built) throw new Error(built.error);
    await seedStarterSession({
      edit: () => probe,
      over: { measured: { massKg: built.info.massEmpty + 0.02, cgM: built.info.cgEmpty } },
    });
    return probe.components[0]!.name!;
  }

  it('offers to pin the one pinned stage to the measured figures', async () => {
    const sustainer = await pinnedSession(false);
    const host = await mountApp();
    await settle(50);
    expect(host.textContent).toContain('stands in for the mass of everything inside it');
    expect(button(host, `Pin “${sustainer}” to my measured mass & CG`)).toBeTruthy();
  }, 30000);

  it('offers nothing when two stages are pinned, and says why', async () => {
    await pinnedSession(true);
    const host = await mountApp();
    await settle(50);
    expect(host.textContent).toContain('stands in for the mass of everything inside it');
    expect(host.textContent).toContain('more than one stage is pinned');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.startsWith('Pin “'))).toBe(false);
  }, 30000);
});

/**
 * A PAD MASS CARRIED IN FROM v0.116/v0.117 (the Measured box's third key, before
 * it moved onto the motor's record) is decided after the first build: placed
 * under the motor it was weighed with when the arithmetic accepts it, dropped
 * with the value and the motor named when it refuses. The session is written
 * the way those builds wrote it — the starter rocket, the catalogue C6-5 on its
 * mount, and `measured.padMassKg`.
 */
describe('a v0.117 session\'s weighed pad mass', () => {
  async function legacySession(padOverKg: (dryKg: number, motorKg: number) => number): Promise<string> {
    const probe = defaultTree();
    const mount = motorMounts(probe)[0]!.id!;
    const c6 = (await loadCatalogueMotor('Estes', 'C6', 5))!;
    // The rocket the kernel flies with no pad mass: what the arithmetic
    // subtracts the pad weight from.
    const bare = buildDesign({
      tree: probe, assigned: [[mount, c6]], kbf: true, supersonic: false,
      measuredDryMassKg: null, primaryMountId: mount, currentSetKey: '',
    }, KERNEL_HANDLES);
    if ('error' in bare) throw new Error(bare.error);
    const motorKg = catalogueMotorMass(probe, [[mount, c6]])!;
    const padMassKg = padOverKg(bare.info.massEmpty, motorKg);
    return (await seedStarterSession({ over: { measured: { massKg: null, cgM: null, padMassKg } } })).mount;
  }

  const storedRecord = (mount: string) => (JSON.parse(localStorage.getItem(SESSION_KEY)!) as {
    mountMotors: Record<string, { padMassKg?: number; padMassWeighedWith?: string }>;
  }).mountMotors[mount]!;

  it('is placed under the motor it was weighed with, re-keyed to the set, and the bar says where', async () => {
    const mount = await legacySession((dry, motor) => dry + motor + 0.005);
    await mountApp();
    await settle(600);
    window.dispatchEvent(new Event('pagehide'));
    const rec = storedRecord(mount);
    expect(rec.padMassKg).toBeGreaterThan(0);
    expect(rec.padMassWeighedWith).not.toBe('legacy');
    expect(rec.padMassWeighedWith).toContain('C6');
    const bar = noticeBar();
    expect(bar?.textContent).toContain(
      'The weighed pad mass you entered in the Measured mass & CG box');
    expect(bar?.className).toContain('notice-info');
  }, 30000);

  it('is dropped, value and motor named, when it is lighter than the rocket and that motor', async () => {
    const mount = await legacySession(() => 0.001);
    await mountApp();
    await settle(600);
    window.dispatchEvent(new Event('pagehide'));
    const rec = storedRecord(mount);
    expect('padMassKg' in rec).toBe(false);
    expect('padMassWeighedWith' in rec).toBe(false);
    const bar = noticeBar();
    // A warning opens the bar, so the whole sentence is on screen.
    expect(bar?.className).toContain('expanded');
    expect(bar?.textContent).toContain('was not kept: it is lighter than the dry rocket plus the catalogue C6,');
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
 * A WEIGHING SAVED ON A POD'S RECORD MOVES TO THE CORE'S, AND SAYS SO (audit
 * 2026-09-22, row 356). A session saved with a pod motor picked before the
 * core's has its pad mass on the record that has just stopped being primary;
 * the restore moves it (treeModel.padMassOntoRankedPrimary) and the notice bar
 * says where, so the value is not seen to jump cards unexplained.
 * primaryMount.test.ts checked App's half as a regex for the ref it read.
 */
describe('a session\'s pad mass saved under a pod picked first', () => {
  it('is moved onto the core motor\'s record, and the bar names both mounts', async () => {
    const probe = podTree(defaultTree());
    const core = motorMounts(probe).find((m) => m.id !== 'pod-mmt')!;
    const c6 = (await loadCatalogueMotor('Estes', 'C6', 5))!;
    await seedStarterSession({
      edit: () => probe,
      over: {
        // The pod's record FIRST: the tie-break that named it primary before row 356.
        mountMotors: { 'pod-mmt': { ...c6, padMassKg: 0.25, padMassWeighedWith: 'weighed-set' }, [core.id!]: c6 },
      },
    });
    await mountApp();
    await settle(50);
    expect(noticeBar()?.textContent).toContain(
      `now sits under C6 on ${core.name}, not under C6 on Pod MMT:`);
    window.dispatchEvent(new Event('pagehide'));
    const stored = (JSON.parse(localStorage.getItem(SESSION_KEY)!) as {
      mountMotors: Record<string, { padMassKg?: number }>;
    }).mountMotors;
    expect(stored[core.id!]?.padMassKg).toBe(0.25);
    expect('padMassKg' in stored['pod-mmt']!).toBe(false);
  }, 30000);

  /**
   * And in every stored flight configuration, or applying one saved with the
   * pod picked first would orphan the weighing again (App's savedConfigs
   * restore). primaryMount.test.ts held both of App's calls as string matches.
   * Here only configuration B — not the one on screen — carries it on the pod.
   */
  it('is moved in a flight configuration that is not the active one, too', async () => {
    const probe = podTree(defaultTree());
    const core = motorMounts(probe).find((m) => m.id !== 'pod-mmt')!;
    const c6 = (await loadCatalogueMotor('Estes', 'C6', 5))!;
    const weighed = { ...c6, padMassKg: 0.25, padMassWeighedWith: 'weighed-set' };
    const onCore = { 'pod-mmt': c6, [core.id!]: weighed };
    await seedStarterSession({
      edit: () => probe,
      over: {
        mountMotors: onCore,
        savedConfigs: [
          { id: 'A', name: 'A', isDefault: true, motors: onCore },
          // The pod's record first, as above.
          { id: 'B', name: 'B', isDefault: false, motors: { 'pod-mmt': weighed, [core.id!]: c6 } },
        ],
        activeConfigId: 'A',
      },
    });
    await mountApp();
    await settle(50);
    window.dispatchEvent(new Event('pagehide'));
    const b = (JSON.parse(localStorage.getItem(SESSION_KEY)!) as {
      savedConfigs: { id: string; motors: Record<string, { padMassKg?: number }> }[];
    }).savedConfigs.find((c) => c.id === 'B')!;
    expect(b.motors[core.id!]?.padMassKg).toBe(0.25);
    expect('padMassKg' in b.motors['pod-mmt']!).toBe(false);
  }, 30000);
});

/**
 * THE AUTO DELAY BOX IS ON EVERY MOUNT'S CARD (v0.144). Each mount's Auto
 * delay is its own carrier branch's (autoDelaySolver), so every loaded mount's
 * card shows the working "auto (optimal)" box (treeModel.autoDelayBox, tested
 * in primaryMount.test.ts). From audit 2026-09-22 row 356 until then,
 * flightRunner wrote the rounded optimum onto the primary mount alone, so the
 * working box was that card's, and any other card whose motor carried the flag
 * got a box saying it applied to the top motor only. primaryMount.test.ts held
 * App's call as a string match.
 */
describe('the Auto delay box on a motor card', () => {
  it('renders the motor card with null motorDataKeys even when load validation is bypassed', async () => {
    await seedStarterSession();
    await mountApp();
    const key = vi.mocked(designMatchKeyOf).mock.results.at(-1)!.value;
    await unmountAll();
    // Same design, but no current motor-set stamp: exercise the previous-flight fallback.
    const run = { id: 'corrupt-map', designKey: key.designKey, motorDataKeys: null } as unknown as SimRun;
    const load = vi.spyOn(simStore, 'loadRuns').mockReturnValueOnce([run]);
    try {
      const host = await mountApp();
      await openTab(host, 'Motors & Configuration');
      const card = host.querySelector('.mount-card');
      expect(card).not.toBeNull();
      expect(card!.textContent).toContain('C6');
      expect(card!.querySelector('input[aria-label^="Ejection delay"]')).not.toBeNull();
    } finally {
      load.mockRestore();
    }
  }, 30000);

  it('is "auto (optimal)" on the core\'s card and "auto (optimal)" on the pods\'', async () => {
    const probe = podTree(defaultTree());
    const core = motorMounts(probe).find((m) => m.id !== 'pod-mmt')!;
    const c6 = (await loadCatalogueMotor('Estes', 'C6', 5))!;
    const auto = { ...c6, meta: { ...c6.meta, autoDelay: true } };
    await seedStarterSession({ edit: () => probe, over: { mountMotors: { 'pod-mmt': auto, [core.id!]: auto } } });
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    await settle(50);
    const box = (mountName: string) => [...host.querySelectorAll('.mount-card')]
      .find((c) => c.querySelector('.mount-card-title')?.firstChild?.textContent === mountName)
      ?.querySelector('input[type="checkbox"]:checked')?.parentElement?.textContent?.trim();
    // The ticked box on each card — "plugged" is the other checkbox, unticked here.
    expect(box(core.name!)).toBe('auto (optimal)');
    expect(box('Pod MMT')).toBe('auto (optimal)');
  }, 30000);
});

/**
 * THE MOTOR CARD'S DELAY WRITERS (audit 2026-09-30, item 20). Typing a delay,
 * the plugged box and the auto box each rewrite three things on the mount's
 * motor — its delay, its Auto flag and its label, whose "(auto delay)" the
 * pad-mass line and the batch note read — and no test drove any of them: the
 * case above only reads which box is ticked. Driven here as a user does, and
 * read back from the autosave, which is what a reload restores. Each writer's
 * rules are services/mountDelayEdits.test.ts's.
 */
describe('the delay writers on a motor card', () => {
  it('Auto on, a typed delay, plugged, unplugged, then Auto on and off again', async () => {
    const { mount, c6 } = await seedStarterSession();
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    await settle(50);
    const card = host.querySelector<HTMLElement>('.mount-card')!;
    const tick = (text: string) => act(async () => {
      [...card.querySelectorAll('label')].find((l) => l.textContent?.trim() === text)!
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    });
    /** The mount's motor as the autosave holds it: delay, Auto flag, label. */
    const stored = () => {
      window.dispatchEvent(new Event('pagehide')); // closes the debounce
      const mm = peekSession()!.mountMotors![mount]!;
      return [mm.spec.ejectionDelay, mm.meta.autoDelay === true, mm.label];
    };
    expect(stored()).toEqual([5, false, 'C6-5']);
    await tick('auto (optimal)');
    expect(stored()).toEqual([5, true, 'C6 (auto delay)']);
    // A typed delay overrides Auto.
    await type(card.querySelector<HTMLInputElement>('input[aria-label^="Ejection delay"]')!, '3');
    expect(stored()).toEqual([3, false, 'C6-3']);
    await tick('plugged');
    expect(stored()).toEqual([Infinity, false, 'C6-P']);
    // Unplugged: the longest delay the motor is sold with, not the 3 s it had.
    const longest = Math.max(...(c6.meta.availableDelays ?? []).filter(Number.isFinite));
    expect(longest).toBe(7);
    await tick('plugged');
    expect(stored()).toEqual([7, false, 'C6-7']);
    await tick('auto (optimal)');
    expect(stored()).toEqual([7, true, 'C6 (auto delay)']);
    await tick('auto (optimal)');
    expect(stored()).toEqual([7, false, 'C6-7']);
  }, 30000);
});

/**
 * A MOTOR CARD'S DELAY BOXES NAME THEIR MOUNT AS THE CARD DOES (audit
 * 2026-09-30). The ejection- and ignition-delay boxes were named
 * `${m.name ?? m.id}`: on a mount with no name a screen reader heard its
 * internal id ("c4"), and on one with no id either it heard "undefined". A
 * nested part arrives with neither from a stored session or a share link
 * written without them: normalizeTree mints ids for stages only. Its motor
 * then sits under the key App itself reads it by, mountMotors[m.id!], which is
 * "undefined" (the seed below stores it there the same way). The card's
 * heading, its ✕ and its Max motor length box already said "Motor mount".
 */
describe('the delay boxes on a motor card', () => {
  /** A two-stage design, so the ignition box shows, whose mount has lost `drop`. */
  const bareMount = (...drop: ('name' | 'id')[]) => (t: RocketTree): RocketTree => {
    const staged = structuredClone(addStage(t).tree);
    const mount = motorMounts(staged)[0]! as Record<string, unknown>;
    for (const key of drop) delete mount[key];
    return staged;
  };
  const delayLabels = (host: HTMLElement) => [...host.querySelectorAll<HTMLInputElement>('.mount-card input[aria-label]')]
    .map((i) => i.getAttribute('aria-label')!).filter((l) => / delay for /.test(l));

  for (const drop of [['name'], ['name', 'id']] as const) {
    it(`name a mount with no ${drop.join(' and no ')} "Motor mount", never an id or "undefined"`, async () => {
      await seedStarterSession({ edit: bareMount(...drop) });
      const host = await mountApp();
      await openTab(host, 'Motors & Configuration');
      await settle(50);
      expect(delayLabels(host)).toEqual(['Ejection delay for Motor mount', 'Ignition delay for Motor mount']);
    }, 30000);
  }
});

/**
 * THE LAUNCH REPORT NAMES A MOUNT AS ITS CARD DOES (review of the audit
 * 2026-09-30 fixes). The report's per-mount ejection-delay table, and the
 * "Auto delay did not settle for …" refusal, name each mount from the map App
 * hands flyLaunch, and that map fell back to the internal id (`m.name ??
 * m.id!`): on a mount with no name the card said "Motor mount" while the
 * report flown from it said "c4". A mount has no name when a desktop file's
 * part has an empty or absent <name> (orkFile names a node only from a
 * non-empty one), or when a stored session or share link was written without
 * it, as seeded here.
 */
describe('the ejection-delay table in the launch report', () => {
  it('names a mount with no name "Motor mount", as its card does, never by its internal id', async () => {
    const { mount } = await seedStarterSession({
      edit: (t) => {
        const bare = structuredClone(t);
        delete (motorMounts(bare)[0]! as Record<string, unknown>)['name'];
        return bare;
      },
    });
    expect(mount).toMatch(/^c\d+$/); // the internal id the row used to read
    const host = await mountApp();
    const launch = () => host.querySelector<HTMLButtonElement>('.vitals-launch');
    await waitFor(() => launch()?.disabled === false, 'Launch to be ready');
    await act(async () => { launch()!.click(); });
    const rowHeads = () => [...host.querySelectorAll('section[aria-label="Per-mount ejection delays"] tbody th[scope="row"]')]
      .map((th) => th.textContent);
    await waitFor(() => rowHeads().length > 0, 'the per-mount delay table');
    expect(rowHeads()).toEqual(['Motor mount']);
  }, 30000);
});

/**
 * AN EMPTIED MOUNT NAME (board Tier 2, v0.148). Clearing a mount's Name box
 * stores '' — a name, to `??` — so the card heading, its ✕, its delay boxes
 * and the launch report's delays table all went blank where a mount with no
 * name at all reads "Motor mount". A name of spaces is as blank.
 */
describe('a mount whose name was emptied', () => {
  for (const blank of ['', '   ']) {
    it(`is "Motor mount" on its card, its delay boxes and the delays table (name ${JSON.stringify(blank)})`, async () => {
      await seedStarterSession({
        edit: (t) => {
          const staged = structuredClone(addStage(t).tree);
          (motorMounts(staged)[0]! as Record<string, unknown>)['name'] = blank;
          return staged;
        },
      });
      const host = await mountApp();
      await openTab(host, 'Motors & Configuration');
      await settle(50);
      const title = host.querySelector('.mount-card .mount-card-title')!;
      expect(title.firstChild?.textContent).toBe('Motor mount');
      const labels = [...host.querySelectorAll<HTMLElement>('.mount-card [aria-label]')].map((e) => e.getAttribute('aria-label')!);
      expect(labels.filter((l) => / delay for /.test(l))).toEqual(['Ejection delay for Motor mount', 'Ignition delay for Motor mount']);
      expect(labels.some((l) => /^Remove .+ from Motor mount$/.test(l))).toBe(true);
      const launch = () => host.querySelector<HTMLButtonElement>('.vitals-launch');
      await waitFor(() => launch()?.disabled === false, 'Launch to be ready');
      await act(async () => { launch()!.click(); });
      const rowHeads = () => [...host.querySelectorAll('section[aria-label="Per-mount ejection delays"] tbody th[scope="row"]')]
        .map((th) => th.textContent);
      await waitFor(() => rowHeads().length > 0, 'the per-mount delay table');
      expect(rowHeads()).toEqual(['Motor mount']);
    }, 30000);
  }
});

/**
 * THE HERO CANVAS SIZES TO THE DRAWING (v0.076, v0.092). The schematic reports
 * its natural height and App's stage asks for that plus the stats chip's
 * headroom plus the open drawer, and publishes the drawer's height on its own
 * so the CSS ceiling can grow by it. statsDrawerDefault.test.ts held App's
 * half of this as three regexes over App.tsx (the callback's name, the
 * variable's template, the headroom prop); the arithmetic is
 * hooks/useHeroDrawer.test.tsx's, and this is App doing the wiring.
 */
describe('the Design tab\'s hero canvas', () => {
  const stage = (host: HTMLElement) => host.querySelector<HTMLElement>('.hero-stage')!;

  it('sizes the stage from what the schematic reports, with the chip\'s headroom and the drawer\'s', async () => {
    viewport(1200);
    const host = await mountApp();
    await waitFor(() => heroSchematic !== null && host.querySelector('.stats-drawer') !== null,
      'the hero schematic and the open drawer');
    // Spend the chip's headroom above the rocket (HERO_CHIP_RESERVE).
    expect(heroSchematic!.topReserve).toBe(140);
    // The schematic has already reported once, on its own.
    expect(stage(host).style.getPropertyValue('--hero-natural')).toMatch(/^\d+px$/);
    await act(async () => { heroSchematic!.onNaturalHeight!(400); });
    // happy-dom lays nothing out, so the open drawer measures 0 + the 20px gap.
    expect(stage(host).style.getPropertyValue('--drawer-clearance')).toBe('20px');
    expect(stage(host).style.getPropertyValue('--hero-natural')).toBe(`${400 + 140 + 20}px`);
  }, 30000);

  it('in ⟳90° draws along the height axis: no headroom to reserve, and the pure CSS clamp', async () => {
    viewport(1200);
    const host = await mountApp();
    await waitFor(() => heroSchematic !== null, 'the hero schematic');
    await act(async () => { button(host, '⟳ 90°').click(); });
    expect(heroSchematic!.vertical).toBe(true);
    expect(heroSchematic!.topReserve).toBe(0);
    expect(stage(host).getAttribute('data-vert')).toBe('on');
    expect(stage(host).style.getPropertyValue('--hero-natural')).toBe('');
  }, 30000);
});

/**
 * "ALL STATS" OPENS ON A DESKTOP AND STAYS SHUT ON ANYTHING NARROWER (the
 * owner, 2026-08-23). statsDrawerDefault.test.ts held App's half of this as a
 * regex for the 981px literal in the drawer's initializer — which stayed green
 * through v0.136, when the short-canvas rule began opening the drawer on every
 * narrow window's Design tab (hooks/useHeroDrawer.ts has the mechanism).
 */
describe('the All-stats drawer on a first look at the Design tab', () => {
  it('is open on a desktop', async () => {
    viewport(1200);
    const host = await mountApp();
    await waitFor(() => host.querySelector('.stats-drawer') !== null, 'the drawer');
    expect(host.querySelector('.stats-drawer-chip')).toBeNull();
  }, 30000);

  /**
   * AUDIT ROW 462: each half of the disclosure says its state, and a press
   * hands focus to the half that replaces it — they are different buttons,
   * so the one pressed unmounts and focus fell to <body>, with neither
   * aria-expanded ever heard changing. appA11y.test.ts held the wiring as
   * regexes over App.tsx; useFocusHandoff.test.tsx has the mechanism.
   */
  it('says whether it is open, on both halves, and a press hands focus across', async () => {
    viewport(1200);
    const host = await mountApp();
    await waitFor(() => host.querySelector('.stats-drawer') !== null, 'the drawer');
    const collapse = button(host, '▾ Collapse');
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    await act(async () => { collapse.click(); });
    const chip = button(host, '▤ All stats');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(chip);
    await act(async () => { chip.click(); });
    expect(document.activeElement).toBe(button(host, '▾ Collapse'));
  }, 30000);

  /**
   * 950 px is in the band the board's Tier 1 row 22 (2026-09-18) called dead:
   * `.hero-view` is positioned only from 981 px, so the lift that keeps the
   * drawing clear of an overlaid drawer cannot act between 901 and 980 px.
   * Since v0.136 nothing there needs it — below 981 px the drawer is a block
   * AFTER the stage, never over the drawing — which is what this pins.
   */
  it.each([800, 950])('is shut at %i px, and the chip opens it as a block under the canvas', async (w) => {
    viewport(w);
    const host = await mountApp();
    await waitFor(() => host.querySelector('.stats-drawer-chip') !== null, 'the All-stats chip');
    await settle(50);
    expect(host.querySelector('.stats-drawer')).toBeNull();
    // And the chip still opens it — as a block under the canvas at this width.
    await act(async () => { button(host, '▤ All stats').click(); });
    expect(host.querySelector('.stats-drawer')?.className).toContain('stats-drawer-flow');
    expect(host.querySelector('.hero-stage .stats-drawer'), 'the drawer is over the drawing').toBeNull();
    expect(host.querySelector<HTMLElement>('.hero-view')!.style.bottom).toBe('');
  }, 30000);
});

/**
 * A PHONE OPENS ON FLY (S4, batch 08-21c), and the rule for it is 767px — not
 * the hero canvas's 981px, or a phone inherits the desktop drawer.
 * statsDrawerDefault.test.ts held the literal as a regex over App.tsx; the
 * breakpoint itself is hooks/useWorkspaceTab.test.tsx's.
 */
describe('the workspace a first load lands on', () => {
  const current = (host: HTMLElement) =>
    host.querySelector('.workspace-tabs [aria-current="page"]')?.textContent?.trim();

  it('is Fly on a phone', async () => {
    localStorage.removeItem('online-openrocket.workspace.v1');
    viewport(400);
    const host = await mountApp();
    expect(current(host)).toMatch(/Fly/);
  }, 30000);

  it('is Design on anything wider', async () => {
    localStorage.removeItem('online-openrocket.workspace.v1');
    viewport(800);
    const host = await mountApp();
    expect(current(host)).toMatch(/Design/);
  }, 30000);
});

/** A workspace tab, pressed. */
async function openTab(host: HTMLElement, name: 'Fly' | 'Design' | 'Motors & Configuration' | 'Results'): Promise<void> {
  const b = [...host.querySelectorAll<HTMLButtonElement>('.workspace-tabs button')]
    .find((x) => x.textContent?.trim() === name);
  if (!b) throw new Error(`no tab "${name}"`);
  await act(async () => { b.click(); });
}

/**
 * BATCH SIMULATE SAYS WHY IT IS OFF, AND ASKS FOR A MOUNT, NOT A MOTOR. Owner
 * reports 2026-09-01b: first *"when I click the button, nothing happens"* — it
 * was disabled, his design being staged, and a disabled button gives no click
 * feedback; then, once the reason was on screen, *"it says this rocket has no
 * motor mount, but the rocket clearly has a 75mm motor mount"* — the gate read
 * the ASSIGNED motors, so a mount with nothing loaded had "no mount", and the
 * feature that exists to FIND a motor was unavailable on exactly the designs it
 * is for. statsDrawerDefault.test.ts held both as regexes over App.tsx.
 */
describe('FC-5 configuration editors', () => {
  it('fixup3: establishing native ignition defaults preserves other configurations and detached values in one step', async () => {
    const { tree, mount, c6 } = await seedStarterSession();
    const composite = (await loadCatalogueMotor('AeroTech', 'D21', 4))!;
    expect(composite).toBeTruthy();
    const b = { ...composite, ignition: { event: 'burnout', delay: 1 } } as MountMotor;
    await seedStarterSession({ edit: () => tree, over: { configLayers: 1, activeConfigId: 'a',
      detachedOverrides: { ignitions: { [mount]: { event: 'launch', delay: 4 } } },
      savedConfigs: [
        { id: 'a', name: 'A', isDefault: true, motors: { [mount]: c6 }, ignitions: {} },
        { id: 'b', name: 'B', isDefault: false, motors: { [mount]: b }, ignitions: {} },
      ] } });
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    const select = host.querySelector<HTMLSelectElement>(`#ignition-${mount}`)!;
    await act(async () => { select.value = 'never'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    window.dispatchEvent(new Event('pagehide'));
    const edited = peekSession()!;
    const savedB = edited.savedConfigs![1]!;
    expect(resolveFlightState(edited.tree, edited.savedConfigs!, 'b', edited.detachedOverrides!, savedB.motors)
      .mountMotors[mount]!.ignition).toEqual({ event: 'burnout', delay: 1 });
    expect(resolveFlightState(edited.tree, edited.savedConfigs!, null, edited.detachedOverrides!, { [mount]: c6 })
      .mountMotors[mount]!.ignition).toEqual({ event: 'launch', delay: 4 });
    await act(async () => { button(host, 'Undo').click(); });
    window.dispatchEvent(new Event('pagehide'));
    const undone = peekSession()!;
    expect(undone.tree.ignitionDefaults?.[mount]).toBeUndefined();
    expect(undone.savedConfigs!.map(c => c.ignitions)).toEqual([{}, {}]);
    expect(undone.detachedOverrides?.ignitions?.[mount]).toEqual({ event: 'launch', delay: 4 });
    expect(button(host, 'Undo').disabled).toBe(true);
  }, 30000);

  it('fixup3: None prevents detached recovery resurrection across Undo and Redo', async () => {
    const { tree, mount, c6 } = await seedStarterSession();
    const chute = tree.components[0]!.children!.flatMap(n => [n, ...(n.children ?? [])]).find(n => n.type === 'parachute')!;
    await seedStarterSession({ edit: () => updateNode(tree, chute.id!, { deployEvent: 'altitude', deployAltitude: 91.44, deployDelay: 0 }),
      over: { configLayers: 1, activeConfigId: 'a', detachedOverrides: {}, savedConfigs: [{
        id: 'a', name: 'A', isDefault: true, motors: { [mount]: c6 },
        deployments: { [chute.id!]: { deployEvent: 'ejection', deployAltitude: 200, deployDelay: 0 } },
      }] } });
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label^="Delete A"]')!.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label^="Confirm delete A"]')!.click(); });
    await openTab(host, 'Design');
    await act(async () => { [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')]
      .find(r => r.querySelector('.tree-label')?.textContent === 'Parachute')!.click(); });
    await act(async () => { button(host, 'Edit the override').click(); });
    const field = host.querySelector<HTMLInputElement>('[aria-label="Override delay (s)"]')!;
    await act(async () => { field.focus(); });
    await type(field, '2');
    await act(async () => { field.blur(); });
    await act(async () => { button(host, 'Unload').click(); });
    expect(button(host, 'Undo').disabled).toBe(false);
    for (const action of ['Undo', 'Redo', 'Undo']) {
      await act(async () => { button(host, action).click(); });
      window.dispatchEvent(new Event('pagehide'));
      const state = peekSession()!;
      expect(state.detachedOverrides).toEqual({});
      expect(state.mountMotors).toEqual({});
      // The same resolver used when a motor is loaded must still fly defaults.
      const loaded = resolveFlightState(state.tree, state.savedConfigs!, null, state.detachedOverrides!, { [mount]: c6 });
      expect(findNode(loaded.tree, chute.id!)).toMatchObject({ deployEvent: 'altitude', deployAltitude: 91.44, deployDelay: 0 });
    }
    await openTab(host, 'Motors & Configuration');
    await act(async () => { button(host, 'Browse motors').click(); });
    await type(host.querySelector<HTMLInputElement>('[aria-label="Search motor designation"]')!, 'C6');
    await act(async () => { [...host.querySelectorAll<HTMLTableRowElement>('.motor-browser tbody tr')]
      .find(row => row.cells[0]?.textContent?.trim() === 'C6' && row.cells[1]?.textContent === 'Estes')!.click(); });
    await act(async () => { button(host, 'Load motor').click(); });
    await waitFor(() => !!host.querySelector('[aria-label^="Ignition delay for"]'), 'loaded motor after None');
    window.dispatchEvent(new Event('pagehide'));
    const reloaded = peekSession()!;
    expect(reloaded.detachedOverrides).toEqual({});
    const flown = resolveFlightState(reloaded.tree, reloaded.savedConfigs!, reloaded.activeConfigId!, reloaded.detachedOverrides!, reloaded.mountMotors!);
    expect(findNode(flown.tree, chute.id!)).toMatchObject({ deployEvent: 'altitude', deployAltitude: 91.44, deployDelay: 0 });
  }, 30000);

  it.each([
    ['ignition', 'delay'], ['recovery', 'delay'], ['recovery', 'altitude'],
    ['separation', 'delay'], ['separation', 'altitude'],
  ] as const)('fixup3: Escape cancels %s %s numeric edits without changing history', async (kind, fieldName) => {
    const { tree, mount, c6 } = await seedStarterSession();
    const chute = tree.components[0]!.children!.flatMap(n => [n, ...(n.children ?? [])]).find(n => n.type === 'parachute')!;
    const target = kind === 'separation' ? tree.components[0]! : chute;
    await seedStarterSession({ edit: () => ({ ...tree, ignitionDefaults: { [mount]: { event: 'automatic', delay: 0 } } }),
      over: { configLayers: 1, activeConfigId: 'a', detachedOverrides: {}, savedConfigs: [{
        id: 'a', name: 'A', isDefault: true, motors: { [mount]: c6 },
        ignitions: { [mount]: { event: 'launch', delay: 1 } },
        deployments: { [chute.id!]: { deployEvent: 'ejection', deployAltitude: 1, deployDelay: 1 } },
        separations: { [tree.components[0]!.id!]: { separationEvent: 'ejection', separationAltitude: 1, separationDelay: 1 } },
      }] } });
    const host = await mountApp();
    await openTab(host, kind === 'ignition' ? 'Motors & Configuration' : 'Design');
    if (kind !== 'ignition') {
      await act(async () => { [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')]
        .find(r => r.querySelector('.tree-label')?.textContent === target.name)!.click(); });
      await act(async () => { button(host, 'Edit the override').click(); });
    }
    const field = host.querySelector<HTMLInputElement>(kind === 'ignition'
      ? '[aria-label^="Ignition delay for"]' : `[aria-label="Override ${fieldName} (${fieldName === 'altitude' ? 'm' : 's'})"]`)!;
    const read = () => { window.dispatchEvent(new Event('pagehide')); return peekSession()!; };
    const before = read();
    await act(async () => { field.focus(); });
    await type(field, '9');
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(field.value).toBe('1');
    expect(document.activeElement).not.toBe(field);
    expect(read().savedConfigs).toEqual(before.savedConfigs);
    expect(button(host, 'Undo').disabled).toBe(true);
    expect(button(host, 'Redo').disabled).toBe(true);
    // Cancellation must retain a pre-existing redo branch as well.
    await act(async () => { field.focus(); });
    await type(field, '3');
    await act(async () => { field.blur(); });
    await act(async () => { button(host, 'Undo').click(); });
    await act(async () => { field.focus(); });
    await type(field, '8');
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(button(host, 'Undo').disabled).toBe(true);
    expect(button(host, 'Redo').disabled).toBe(false);
    await act(async () => { button(host, 'Redo').click(); });
    expect(field.value).toBe('3');
  }, 30000);

  it.each(['detached', 'saved'] as const)('FC-5 gesture: %s ignition keeps its owner through an equal prefix and coalesces history', async owner => {
    const { tree, mount, c6 } = await seedStarterSession();
    const ignitions = { [mount]: { event: 'launch', delay: 1 } };
    await seedStarterSession({ edit: () => ({ ...tree, ignitionDefaults: { [mount]: { event: 'launch', delay: 0 } } }),
      over: { configLayers: 1, activeConfigId: owner === 'saved' ? 'a' : null,
        detachedOverrides: owner === 'detached' ? { ignitions } : {},
        savedConfigs: [{ id: 'a', name: 'A', isDefault: true, motors: { [mount]: c6 },
          ...(owner === 'saved' ? { ignitions } : {}) },
        { id: 'b', name: 'Inherits', isDefault: false, motors: { [mount]: c6 } }] } });
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    const field = host.querySelector<HTMLInputElement>('[aria-label^="Ignition delay for"]')!;
    const read = () => {
      window.dispatchEvent(new Event('pagehide'));
      const state = peekSession()!;
      return { state, tuple: (owner === 'saved' ? state.savedConfigs![0] : state.detachedOverrides)?.ignitions?.[mount] };
    };
    await act(async () => { field.focus(); });
    for (const prefix of ['0', '0.', '0.5']) {
      await type(field, prefix);
      expect(read().tuple, `override survives ${prefix}`).toEqual({ event: 'launch', delay: Number(prefix) });
      expect(document.activeElement).toBe(field);
    }
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(read().state.tree.ignitionDefaults?.[mount]).toEqual({ event: 'launch', delay: 0 });
    expect(read().state.savedConfigs![1]!.ignitions?.[mount]).toBeUndefined();
    await act(async () => { button(host, 'Undo').click(); });
    expect(read().tuple).toEqual({ event: 'launch', delay: 1 });
    await act(async () => { button(host, 'Redo').click(); });
    expect(read().tuple).toEqual({ event: 'launch', delay: 0.5 });
    // A second gesture is separate even when it immediately follows the first.
    await act(async () => { field.focus(); });
    for (const prefix of ['1', '10']) await type(field, prefix);
    await act(async () => { field.blur(); });
    await act(async () => { button(host, 'Undo').click(); });
    expect(read().tuple).toEqual({ event: 'launch', delay: 0.5 });
    await act(async () => { button(host, 'Redo').click(); });
    expect(read().tuple).toEqual({ event: 'launch', delay: 10 });
    await act(async () => { field.focus(); });
    await type(field, '0');
    expect(read().tuple).toEqual({ event: 'launch', delay: 0 });
    await act(async () => { field.blur(); });
    expect(read().tuple).toBeUndefined();
    await act(async () => { button(host, 'Undo').click(); });
    expect(read().tuple).toEqual({ event: 'launch', delay: 10 });
  }, 30000);

  it('FC-5 gesture: an unfocused ignition spinner starts a separate step after an editor unmount', async () => {
    const { tree, mount, c6 } = await seedStarterSession();
    await seedStarterSession({ edit: () => tree, over: { configLayers: 1, activeConfigId: 'a', detachedOverrides: {},
      savedConfigs: [{ id: 'a', name: 'A', isDefault: true, motors: { [mount]: c6 },
        ignitions: { [mount]: { event: 'launch', delay: 1 } } }] } });
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    const field = host.querySelector<HTMLInputElement>('[aria-label^="Ignition delay for"]')!;
    await act(async () => { field.focus(); });
    for (const prefix of ['1', '10']) await type(field, prefix);
    // Removing a focused input does not emit React's onBlur. The next card
    // must not reuse that field's history transaction for its spinner.
    await openTab(host, 'Design');
    await openTab(host, 'Motors & Configuration');
    const next = host.querySelector<HTMLInputElement>('[aria-label^="Ignition delay for"]')!;
    await act(async () => { next.parentElement!.querySelector<HTMLButtonElement>('[aria-label="Increment"]')!.click(); });
    expect(next.value).toBe('10.5');
    await act(async () => { button(host, 'Undo').click(); });
    expect(next.value).toBe('10');
    await act(async () => { next.focus(); });
    await type(next, 'invalid');
    await act(async () => { next.blur(); });
    expect(next.value).toBe('10');
    await act(async () => { button(host, 'Undo').click(); });
    expect(next.value).toBe('1');
  }, 30000);

  it.each([
    ['parachute', 'altitude'], ['parachute', 'delay'], ['streamer', 'altitude'],
    ['streamer', 'delay'], ['stage', 'altitude'], ['stage', 'delay'],
  ] as const)('FC-5 gesture: %s %s retains the focused editor and one undo step', async (kind, fieldName) => {
    const { tree, mount, c6 } = await seedStarterSession();
    const node = kind === 'stage' ? tree.components[0]!
      : tree.components[0]!.children!.flatMap(n => [n, ...(n.children ?? [])]).find(n => n.type === 'parachute')!;
    const defaults = kind === 'stage'
      ? { separationEvent: 'altitudedescending', separationAltitude: 1, separationDelay: 1 }
      : { deployEvent: 'altitude', deployAltitude: 1, deployDelay: 1 };
    const tuple = kind === 'stage'
      ? { ...defaults, [fieldName === 'altitude' ? 'separationAltitude' : 'separationDelay']: 2 }
      : { ...defaults, [fieldName === 'altitude' ? 'deployAltitude' : 'deployDelay']: 2 };
    await seedStarterSession({ edit: () => updateNode(tree, node.id!, { ...defaults, name: 'Gesture part', type: kind }),
      over: { configLayers: 1, activeConfigId: 'a', detachedOverrides: {}, savedConfigs: [{
        id: 'a', name: 'A', isDefault: true, motors: { [mount]: c6 },
        [kind === 'stage' ? 'separations' : 'deployments']: { [node.id!]: tuple },
      }] } });
    const host = await mountApp();
    await openTab(host, 'Design');
    await act(async () => { [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')]
      .find(r => r.querySelector('.tree-label')?.textContent === 'Gesture part')!.click(); });
    const banner = () => host.querySelector(`[aria-label="${kind === 'stage' ? 'Stage separation' : 'Recovery'} override"]`);
    await act(async () => { button(host, 'Edit the override').click(); });
    const field = host.querySelector<HTMLInputElement>(`[aria-label="Override ${fieldName} (${fieldName === 'altitude' ? 'm' : 's'})"]`)!;
    await act(async () => { field.focus(); });
    for (const prefix of ['1', '10', '100']) {
      await type(field, prefix);
      expect(banner(), `banner survives ${prefix}`).not.toBeNull();
      expect(document.activeElement).toBe(field);
      expect(field.isConnected).toBe(true);
      expect(field.value).toBe(prefix);
    }
    await act(async () => { field.blur(); });
    await act(async () => { button(host, 'Undo').click(); });
    expect(field.value).toBe('2');
    await act(async () => { button(host, 'Redo').click(); });
    expect(field.value).toBe('100');
    await act(async () => { field.focus(); });
    await type(field, '1');
    expect(banner()).not.toBeNull();
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(banner()).toBeNull();
    await act(async () => { button(host, 'Undo').click(); });
    expect(banner()).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>(`[aria-label^="Override ${fieldName}"]`)!.value).toBe('100');
  }, 30000);

  it('CFG-1 resets all families in one undo step, keeps other owners/defaults and supports detached reset', async () => {
    const { tree, mount, c6 } = await seedStarterSession();
    const staged = addStage(tree).tree;
    const chute = tree.components[0]!.children!.flatMap(n => [n, ...(n.children ?? [])]).find(n => n.type === 'parachute')!;
    const maps = {
      deployments: { [chute.id!]: { deployEvent: 'altitude', deployAltitude: 91.44, deployDelay: 2 } },
      separations: { [staged.components[1]!.id!]: { separationEvent: 'launch', separationDelay: 3, separationAltitude: 100 } },
      ignitions: { [mount]: { event: 'launch' as const, delay: 4 } },
    };
    await seedStarterSession({ edit: () => staged, over: { configLayers: 1, activeConfigId: 'a', detachedOverrides: {},
      savedConfigs: ['a', 'b'].map(id => ({ id, name: id, isDefault: id === 'a', motors: { [mount]: c6 }, ...maps })) } });
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    expect(host.querySelector('.motors-layout')!.firstElementChild!.classList.contains('config-panel')).toBe(true);
    const chooser = host.querySelector<HTMLSelectElement>('select[aria-label="Flight configuration"]')!;
    const reset = async () => {
      await act(async () => button(host, 'Reset every override in this configuration').click());
      expect(document.activeElement?.textContent).toBe('Cancel');
      await act(async () => button(host, 'Confirm reset every override').click());
      await settle(450);
    };
    await settle(450);
    const before = structuredClone(peekSession()!);
    await reset();
    expect(peekSession()!.savedConfigs![0]).toMatchObject({ deployments: {}, separations: {}, ignitions: {} });
    expect(peekSession()!.savedConfigs![1]).toEqual(before.savedConfigs![1]);
    expect(peekSession()!.tree).toEqual(before.tree);
    expect(peekSession()!.mountMotors).toEqual(before.mountMotors);
    expect(peekSession()!.launch).toEqual(before.launch);
    await act(async () => button(host, 'Undo').click()); await settle(450);
    expect(peekSession()!.savedConfigs![0]).toMatchObject(maps);
    await act(async () => button(host, 'Redo').click()); await settle(450);
    expect(peekSession()!.savedConfigs![0]).toMatchObject({ deployments: {}, separations: {}, ignitions: {} });
    await act(async () => { chooser.value = 'b'; chooser.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Delete b — configuration 2"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Confirm delete b — configuration 2"]')!.click());
    expect(chooser.selectedOptions[0]!.textContent).toBe('Working settings (not saved)');
    await reset(); expect(peekSession()!.detachedOverrides).toEqual({ deployments: {}, separations: {}, ignitions: {} });
    await act(async () => button(host, 'Undo').click()); await settle(450);
    expect(peekSession()!.detachedOverrides).toEqual(maps);
  }, 30000);

  it('CFG-1 Duplicate activates an independent copy of current edits and keeps launch conditions', async () => {
    const { tree, mount, c6 } = await seedStarterSession();
    await seedStarterSession({ edit: () => tree, over: { configLayers: 1, activeConfigId: 'a', detachedOverrides: {},
      savedConfigs: [{ id: 'a', name: 'Club', isDefault: true, motors: { [mount]: c6 },
        ignitions: { [mount]: { event: 'launch', delay: 2 } } }] } });
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    const ignition = host.querySelector<HTMLSelectElement>(`#ignition-${mount}`)!;
    await act(async () => { ignition.value = 'never'; ignition.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle(450);
    const before = structuredClone(peekSession()!);
    await act(async () => button(host, 'Duplicate').click()); await settle(450);
    const after = peekSession()!;
    expect(after.savedConfigs).toHaveLength(2);
    const copy = after.savedConfigs![1]!;
    expect(copy.id).not.toBe('a'); expect(after.activeConfigId).toBe(copy.id);
    expect(copy).toMatchObject({ name: 'Club copy', isDefault: false, motors: before.mountMotors,
      ignitions: before.savedConfigs![0]!.ignitions });
    expect(after.tree).toEqual(before.tree); expect(after.launch).toEqual(before.launch);
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Flight configuration"]')!.value).toBe(copy.id);
    await act(async () => { ignition.value = 'launch'; ignition.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle(450);
    expect(peekSession()!.savedConfigs![0]!.ignitions![mount]!.event).toBe('never');
    expect(peekSession()!.savedConfigs![1]!.ignitions![mount]!.event).toBe('launch');
  }, 30000);

  it('CFG-1 table part cells apply once and focus stable recovery, stage and motor destinations', async () => {
    const { tree, mount, c6 } = await seedStarterSession();
    const staged = addStage(tree).tree;
    await seedStarterSession({ edit: () => staged, over: { configLayers: 1, activeConfigId: 'a', detachedOverrides: {},
      savedConfigs: ['a', 'b'].map(id => ({ id, name: id, isDefault: id === 'a', motors: { [mount]: c6 } })) } });
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    for (const family of ['Motor · ignition', 'Recovery', 'Separation']) {
      const headers = [...host.querySelectorAll('.config-table thead th')];
      const index = headers.findIndex(th => th.textContent?.includes(family));
      const cell = host.querySelectorAll('.config-table tbody tr')[1]!.children[index]!;
      await act(async () => cell.querySelector<HTMLButtonElement>('button')!.click());
      expect(host.querySelector<HTMLSelectElement>('select[aria-label="Flight configuration"]')!.value).toBe('b');
      expect(document.activeElement?.id).toMatch(family === 'Motor · ignition' ? /^cfg-mount-/ : /^cfg-part-/);
    }
  }, 30000);

  it('no override banners or counts appear for inheriting recovery, stage and ignition', async () => {
    const { tree, mount, c6 } = await seedStarterSession();
    await seedStarterSession({ edit: () => tree, over: { configLayers: 1, activeConfigId: 'plain', detachedOverrides: {},
      savedConfigs: [{ id: 'plain', name: 'Plain', isDefault: true, motors: { [mount]: c6 } }] } });
    const host = await mountApp();
    await openTab(host, 'Design');
    const rows = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    for (const label of ['Parachute', tree.components[0]!.name]) {
      await act(async () => { rows.find(r => r.querySelector('.tree-label')?.textContent === label)!.click(); });
      expect(host.querySelector('[aria-label="Recovery override"]')).toBeNull();
      expect(host.querySelector('[aria-label="Stage separation override"]')).toBeNull();
    }
    await openTab(host, 'Motors & Configuration');
    // CFG-2 wording: status text, not colour alone.
    expect(host.textContent).toContain("Ignition: uses the mount's own setting — Automatic");
    expect(host.textContent).not.toContain('overridden here');
    expect(host.textContent).not.toContain('This configuration: overridden');
    expect(host.querySelector('[aria-label^="Apply Plain"]')!.getAttribute('aria-describedby')).toBeNull();
  }, 30000);

  it('stage separation Reset and Use everywhere are single undo steps, including detached entries', async () => {
    const { tree, mount, c6 } = await seedStarterSession();
    const staged = addStage(tree).tree;
    const stage = staged.components[1]!;
    const tuple = { separationEvent: 'altitudedescending', separationDelay: 2, separationAltitude: 91.44 };
    await seedStarterSession({ edit: () => updateNode(staged, stage.id!, { name: 'Booster', separationEvent: 'ejection', separationDelay: 0, separationAltitude: 200 }),
      over: { configLayers: 1, activeConfigId: 'a', detachedOverrides: { separations: { [stage.id!]: tuple } },
        savedConfigs: ['a', 'b'].map(id => ({ id, name: id, isDefault: id === 'a', motors: { [mount]: c6 }, separations: { [stage.id!]: tuple } })) } });
    const host = await mountApp();
    await openTab(host, 'Design');
    await act(async () => { [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(r => r.querySelector('.tree-label')?.textContent === 'Booster')!.click(); });
    const banner = () => host.querySelector('[role="region"][aria-label="Stage separation override"]');
    expect(banner()?.textContent).toContain('Flight configuration “a”');
    expect(banner()?.textContent).toContain('Altitude (descending)');
    expect(host.querySelector<HTMLInputElement>('[aria-label^="Separation altitude"]')).not.toBeNull();
    await act(async () => { button(host, 'Edit the override').click(); });
    await type(host.querySelector<HTMLInputElement>('[aria-label="Override altitude (m)"]')!, '100');
    expect(banner()?.textContent).toContain('Altitude (descending) 100 m');
    await act(async () => { button(host, '↩ Undo').click(); });
    expect(banner()?.textContent).toContain('Altitude (descending) 91.44 m');
    await act(async () => { button(host, 'Reset to this setting').click(); });
    expect(banner()).toBeNull();
    await settle(450);
    expect(peekSession()!.savedConfigs![0]!.separations?.[stage.id!]).toBeUndefined();
    await act(async () => { button(host, '↩ Undo').click(); });
    expect(banner()).not.toBeNull();
    await act(async () => { button(host, 'Use the override everywhere').click(); });
    await settle(450);
    expect(findNode(peekSession()!.tree, stage.id!)).toMatchObject(tuple);
    for (const config of peekSession()!.savedConfigs!) expect(config.separations?.[stage.id!]).toBeUndefined();
    expect(peekSession()!.detachedOverrides?.separations?.[stage.id!]).toBeUndefined();
    expect(banner()).toBeNull();
    await act(async () => { button(host, '↩ Undo').click(); });
    expect(banner()).not.toBeNull();
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Separate at (lower stages)"]')!.value).toBe('ejection');
  }, 30000);

  it('a detached streamer override stays visible; editing the default leaves what flies alone; reset and redo work', async () => {
    const { tree, mount, c6 } = await seedStarterSession();
    const chute = tree.components[0]!.children!.flatMap(n => [n, ...(n.children ?? [])]).find(n => n.type === 'parachute')!;
    await seedStarterSession({ edit: () => updateNode(tree, chute.id!, { type: 'streamer', name: 'Ribbon', deployEvent: 'altitude', deployAltitude: 91.44 }),
      over: { configLayers: 1, activeConfigId: null, savedConfigs: [], mountMotors: { [mount]: c6 },
        detachedOverrides: { deployments: { [chute.id!]: { deployEvent: 'apogee', deployAltitude: 200, deployDelay: 1 } } } } });
    const host = await mountApp();
    await openTab(host, 'Design');
    await act(async () => { [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(r => r.querySelector('.tree-label')?.textContent === 'Ribbon')!.click(); });
    const banner = () => host.querySelector('[aria-label="Recovery override"]');
    expect(banner()?.textContent).toContain('detached working settings');
    expect(banner()?.textContent).toContain('overrides this streamer');
    const select = host.querySelector<HTMLSelectElement>('[aria-label="Deploy at"]')!;
    await act(async () => { select.value = 'launch'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(banner()?.textContent).toContain('it deploys at Apogee');
    expect(banner()?.textContent).toContain("streamer's own setting (Launch");
    await act(async () => { button(host, 'Edit the override').click(); });
    await type(host.querySelector<HTMLInputElement>('[aria-label="Override delay (s)"]')!, '2');
    expect(banner()?.textContent).toContain('delay 2 s');
    await act(async () => { button(host, '↩ Undo').click(); });
    expect(banner()?.textContent).toContain('delay 1 s');
    await act(async () => { button(host, 'Reset to this setting').click(); });
    expect(banner()).toBeNull();
    await act(async () => { button(host, '↩ Undo').click(); });
    expect(banner()).not.toBeNull();
    await act(async () => { button(host, '↪ Redo').click(); });
    expect(banner()).toBeNull();
    await settle(450);
    expect(peekSession()!.detachedOverrides?.deployments?.[chute.id!]).toBeUndefined();
  }, 30000);

  it('labels ignition overrides, Reset to own setting inherits the default, and unconfigured edits change the default', async () => {
    const { tree, mount, c6 } = await seedStarterSession();
    await seedStarterSession({ edit: () => ({ ...tree, ignitionDefaults: { [mount]: { event: 'automatic', delay: 0 } } }),
      over: { configLayers: 1, detachedOverrides: {}, activeConfigId: 'a', savedConfigs: [
        { id: 'a', name: 'Layered', isDefault: true, motors: { [mount]: c6 }, ignitions: { [mount]: { event: 'launch', delay: 2 } } },
      ] } });
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    expect(host.textContent).toContain('Ignition: overridden here — Launch + delay (timer), delay 2 s; own setting: Automatic');
    expect(host.querySelector('.config-panel')!.textContent).toContain('overrides motor mount');
    await act(async () => { button(host, 'Reset to own setting').click(); });
    expect(host.textContent).toContain("Ignition: uses the mount's own setting");
    expect(host.textContent).not.toContain('1 override: ignition');
    await settle(450);
    expect(peekSession()!.savedConfigs![0]!.ignitions?.[mount]).toBeUndefined();
    await act(async () => { button(host, '↩ Undo').click(); });
    expect(host.textContent).toContain('Ignition: overridden here');
    await unmountAll();
    await seedStarterSession({ edit: () => tree, over: { configLayers: 1, activeConfigId: null, savedConfigs: [], detachedOverrides: {} } });
    const plain = await mountApp();
    await openTab(plain, 'Motors & Configuration');
    // No configuration and no working overrides: only the own setting exists, so no scope radios.
    expect(plain.querySelector('.mount-card fieldset')).toBeNull();
    const select = plain.querySelector<HTMLSelectElement>(`#ignition-${mount}`)!;
    await act(async () => { select.value = 'launch'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle(450);
    expect(peekSession()!.tree.ignitionDefaults?.[mount]).toEqual({ event: 'launch', delay: 0 });
    expect(peekSession()!.detachedOverrides).toEqual({});
    expect(plain.querySelector('[aria-label="Recovery override"]')).toBeNull();
    expect(plain.querySelector('[aria-label="Stage separation override"]')).toBeNull();
  }, 30000);
});

/**
 * CFG-2 (CFG-SPEC A2/A3): Recovery and Stages rows and the motor card's
 * ignition edit an EXPLICIT scope — the part's own setting, or the active
 * owner's override — and the Launch warning's Show lands on the row.
 */
describe('CFG-2 scoped recovery, stage and ignition editors', () => {
  const read = () => { window.dispatchEvent(new Event('pagehide')); return peekSession()!; };
  const chuteOf = (tree: RocketTree) => tree.components[0]!.children!.flatMap(n => [n, ...(n.children ?? [])]).find(n => n.type === 'parachute')!;
  const choose = async (select: HTMLSelectElement, value: string) =>
    act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
  const radio = (scope: Element, text: string) =>
    [...scope.querySelectorAll('fieldset label')].find(l => l.textContent?.includes(text))!.querySelector<HTMLInputElement>('input')!;
  const OWN = "Change the part's own setting — every configuration that uses it";

  it('a recovery row defaults to the override scope, and each scope edits only its own layer; an equal override disappears; Reset is one step', async () => {
    const { tree, mount, c6 } = await seedStarterSession();
    const chute = chuteOf(tree);
    const override = { deployEvent: 'ejection', deployAltitude: 200, deployDelay: 0 };
    await seedStarterSession({ edit: () => updateNode(tree, chute.id!, { deployEvent: 'altitude', deployAltitude: 91.44, deployDelay: 0 }),
      over: { configLayers: 1, activeConfigId: 'a', detachedOverrides: {}, savedConfigs: ['a', 'b'].map(id => ({
        id, name: id.toUpperCase(), isDefault: id === 'a', motors: { [mount]: c6 }, deployments: { [chute.id!]: override } })) } });
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    const row = host.querySelector<HTMLElement>(`[id="cfg-part-${chute.id!}"]`)!;
    expect(row.textContent).toContain('Own setting: Altitude (descending), 91.44 m');
    expect(row.textContent).toContain('This configuration: overridden — Motor ejection charge');
    expect(row.querySelector('fieldset')).toBeNull();
    await act(async () => { button(row, 'Edit…').click(); });
    expect(row.querySelector('fieldset legend')!.textContent).toBe('Apply changes to');
    expect([...row.querySelectorAll('fieldset label')].map(l => l.textContent?.trim())).toEqual([OWN, 'Override for “A” only']);
    expect(radio(row, 'Override for').checked).toBe(true);
    const event = () => row.querySelector<HTMLSelectElement>('.config-part-editor select')!;
    expect(event().value).toBe('ejection');
    // Own setting: the tree default changes; neither configuration's override moves.
    await act(async () => { radio(row, OWN).click(); });
    expect(event().value).toBe('altitude');
    await choose(event(), 'apogee');
    let state = read();
    expect(findNode(state.tree, chute.id!)!['deployEvent']).toBe('apogee');
    for (const config of state.savedConfigs!) expect(config.deployments![chute.id!]).toEqual(override);
    expect(row.textContent).toContain('Own setting: Apogee');
    await act(async () => { button(host, '↩ Undo').click(); });
    expect(findNode(read().tree, chute.id!)!['deployEvent']).toBe('altitude');
    // Override: only the active configuration's layer changes.
    await act(async () => { radio(row, 'Override for').click(); });
    await choose(event(), 'launch');
    state = read();
    expect(state.savedConfigs![0]!.deployments![chute.id!]).toEqual({ ...override, deployEvent: 'launch' });
    expect(state.savedConfigs![1]!.deployments![chute.id!]).toEqual(override);
    expect(findNode(state.tree, chute.id!)).toMatchObject({ deployEvent: 'altitude', deployAltitude: 91.44, deployDelay: 0 });
    expect(row.textContent).toContain('This configuration: overridden — Launch');
    expect(button(row, 'Use the override everywhere')).toBeTruthy();
    // Typing the override back to the own setting removes it when the gesture ends.
    await choose(event(), 'altitude');
    const altitude = row.querySelector<HTMLInputElement>('[aria-label="Parachute deploy altitude (m)"]')!;
    await act(async () => { altitude.focus(); });
    for (const prefix of ['9', '91', '91.4', '91.44']) await type(altitude, prefix);
    expect(read().savedConfigs![0]!.deployments![chute.id!]).toEqual({ deployEvent: 'altitude', deployAltitude: 91.44, deployDelay: 0 });
    await act(async () => { altitude.blur(); });
    expect(read().savedConfigs![0]!.deployments![chute.id!]).toBeUndefined();
    expect(row.textContent).toContain('This configuration: uses own setting');
    expect([...row.querySelectorAll('button')].some(b => b.textContent === 'Use the override everywhere')).toBe(false);
    // The typed gesture was one step: Undo restores the override as it was before typing.
    await act(async () => { button(host, '↩ Undo').click(); });
    expect(read().savedConfigs![0]!.deployments![chute.id!]).toEqual({ ...override, deployEvent: 'altitude' });
    await act(async () => { button(row, 'Reset to own setting').click(); });
    state = read();
    expect(state.savedConfigs![0]!.deployments![chute.id!]).toBeUndefined();
    expect(state.savedConfigs![1]!.deployments![chute.id!]).toEqual(override);
    await act(async () => { button(host, '↩ Undo').click(); });
    expect(read().savedConfigs![0]!.deployments![chute.id!]).toEqual({ ...override, deployEvent: 'altitude' });
  }, 60_000);

  it('a stage row edits its own separation without touching overrides, Escape cancels, and the top stage has no row', async () => {
    const { tree, mount, c6 } = await seedStarterSession();
    const staged = addStage(tree).tree;
    const [top, booster] = staged.components as [ComponentNode, ComponentNode];
    const sep = { separationEvent: 'launch', separationDelay: 3, separationAltitude: 200 };
    await seedStarterSession({ edit: () => staged, over: { configLayers: 1, activeConfigId: 'a', detachedOverrides: {},
      savedConfigs: [{ id: 'a', name: 'A', isDefault: true, motors: { [mount]: c6 }, separations: { [booster.id!]: sep } }] } });
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    expect(host.querySelector(`[id="cfg-part-${top.id!}"]`)).toBeNull();
    const row = host.querySelector<HTMLElement>(`[id="cfg-part-${booster.id!}"]`)!;
    expect(row.closest('section')!.getAttribute('aria-label')).toBe('Stages');
    expect(host.querySelector(`[id="cfg-part-${chuteOf(staged).id!}"] strong`)!.textContent).toBe('Parachute (in Sustainer)');
    expect(row.textContent).toContain('This configuration: overridden — Launch, delay 3 s');
    await act(async () => { button(row, 'Edit…').click(); });
    await act(async () => { radio(row, OWN).click(); });
    const delay = row.querySelector<HTMLInputElement>('[aria-label="Booster separation delay (s)"]')!;
    await act(async () => { delay.focus(); });
    await type(delay, '4');
    expect(findNode(read().tree, booster.id!)!['separationDelay']).toBe(4);
    await act(async () => { delay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(findNode(read().tree, booster.id!)!['separationDelay'] ?? 0).toBe(0);
    expect(button(host, 'Undo').disabled).toBe(true);
    await act(async () => { delay.focus(); });
    await type(delay, '2');
    await act(async () => { delay.blur(); });
    const state = read();
    expect(findNode(state.tree, booster.id!)!['separationDelay']).toBe(2);
    expect(state.savedConfigs![0]!.separations![booster.id!]).toEqual(sep);
  }, 60_000);

  it('section resets clear one family of the active configuration in ONE undo step each', async () => {
    const { tree, mount, c6 } = await seedStarterSession();
    const staged = addStage(tree).tree;
    const booster = staged.components[1]!;
    const chute = chuteOf(staged);
    const maps = {
      deployments: { [chute.id!]: { deployEvent: 'apogee', deployAltitude: 200, deployDelay: 1 } },
      separations: { [booster.id!]: { separationEvent: 'launch', separationDelay: 3, separationAltitude: 200 } },
      ignitions: { [mount]: { event: 'launch' as const, delay: 2 } },
    };
    await seedStarterSession({ edit: () => staged, over: { configLayers: 1, activeConfigId: 'a', detachedOverrides: {},
      savedConfigs: ['a', 'b'].map(id => ({ id, name: id, isDefault: id === 'a', motors: { [mount]: c6 }, ...maps })) } });
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    await settle(450);
    expect(button(host, 'Undo').disabled).toBe(true);
    const recovery = 'Reset all recovery overrides in this configuration';
    const stage = 'Reset all stage overrides in this configuration';
    const has = (text: string) => [...host.querySelectorAll('button')].some(b => b.textContent === text);
    await act(async () => { button(host, recovery).click(); });
    let state = read();
    expect(state.savedConfigs![0]).toMatchObject({ deployments: {}, separations: maps.separations, ignitions: maps.ignitions });
    expect(state.savedConfigs![1]).toMatchObject(maps);
    expect(has(recovery)).toBe(false);
    await act(async () => { button(host, stage).click(); });
    state = read();
    expect(state.savedConfigs![0]).toMatchObject({ deployments: {}, separations: {}, ignitions: maps.ignitions });
    expect(has(stage)).toBe(false);
    await act(async () => { button(host, '↩ Undo').click(); });
    expect(read().savedConfigs![0]).toMatchObject({ deployments: {}, separations: maps.separations });
    await act(async () => { button(host, '↩ Undo').click(); });
    expect(read().savedConfigs![0]).toMatchObject(maps);
    expect(button(host, 'Undo').disabled).toBe(true);
    expect(has(recovery) && has(stage)).toBe(true);
  }, 60_000);

  it('ignition: the scope pair shows only with an owner, defaults to own unless overridden, and each scope edits only its layer', async () => {
    const { tree, mount, c6 } = await seedStarterSession();
    await seedStarterSession({ edit: () => ({ ...tree, ignitionDefaults: { [mount]: { event: 'automatic', delay: 0 } } }),
      over: { configLayers: 1, activeConfigId: 'a', detachedOverrides: {}, savedConfigs: [
        { id: 'a', name: 'A', isDefault: true, motors: { [mount]: c6 } },
        { id: 'b', name: 'B', isDefault: false, motors: { [mount]: c6 }, ignitions: { [mount]: { event: 'launch', delay: 3 } } },
      ] } });
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    const card = () => host.querySelector(`[id="cfg-mount-${mount}"]`)!;
    expect(card().querySelector('fieldset legend')!.textContent).toBe('Ignition changes apply to');
    expect(radio(card(), OWN).checked).toBe(true);
    const select = () => card().querySelector<HTMLSelectElement>(`[id="ignition-${mount}"]`)!;
    await choose(select(), 'never');
    let state = read();
    expect(state.tree.ignitionDefaults![mount]).toEqual({ event: 'never', delay: 0 });
    expect(state.savedConfigs![0]!.ignitions?.[mount]).toBeUndefined();
    expect(state.savedConfigs![1]!.ignitions![mount]).toEqual({ event: 'launch', delay: 3 });
    expect(card().textContent).toContain("Ignition: uses the mount's own setting — Never");
    await act(async () => { radio(card(), 'Override for “A” only').click(); });
    await choose(select(), 'launch');
    state = read();
    expect(state.savedConfigs![0]!.ignitions![mount]).toEqual({ event: 'launch', delay: 0 });
    expect(state.tree.ignitionDefaults![mount]).toEqual({ event: 'never', delay: 0 });
    expect(card().textContent).toContain('Ignition: overridden here — Launch + delay (timer); own setting: Never');
    // Switching to a configuration that overrides opens in the override scope.
    const chooser = host.querySelector<HTMLSelectElement>('select[aria-label="Flight configuration"]')!;
    await choose(chooser, 'b');
    expect(radio(card(), 'Override for “B” only').checked).toBe(true);
    expect(select().value).toBe('launch');
    await act(async () => { button(card() as HTMLElement, 'Reset to own setting').click(); });
    expect(read().savedConfigs!.find(c => c.id === 'b')!.ignitions?.[mount]).toBeUndefined();
    expect(select().value).toBe('never');
  }, 60_000);

  it('with no configuration and no working overrides, a row edits only the own setting (no radios)', async () => {
    const { tree } = await seedStarterSession();
    const chute = chuteOf(tree);
    await seedStarterSession({ edit: () => tree, over: { configLayers: 1, activeConfigId: null, savedConfigs: [], detachedOverrides: {} } });
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    const row = host.querySelector<HTMLElement>(`[id="cfg-part-${chute.id!}"]`)!;
    await act(async () => { button(row, 'Edit…').click(); });
    expect(row.querySelector('fieldset')).toBeNull();
    expect(host.querySelector('.mount-card fieldset')).toBeNull();
    await choose(row.querySelector<HTMLSelectElement>('.config-part-editor select')!, 'apogee');
    const state = read();
    expect(findNode(state.tree, chute.id!)!['deployEvent']).toBe('apogee');
    expect(state.detachedOverrides).toEqual({});
  }, 60_000);

  it.each([false, true])('the Launch warning Show opens the recovery row and focuses Edit… (reduced motion %s)', async reduced => {
    const { tree, mount, c6 } = await seedStarterSession();
    const chute = chuteOf(tree);
    await seedStarterSession({ edit: () => updateNode(tree, chute.id!, { deployEvent: 'altitude', deployAltitude: 91.44, deployDelay: 0 }),
      over: { configLayers: 1, activeConfigId: 'a', detachedOverrides: {}, savedConfigs: [{ id: 'a', name: 'A', isDefault: true,
        motors: { [mount]: c6 }, deployments: { [chute.id!]: { deployEvent: 'ejection', deployAltitude: 200, deployDelay: 0 } } }] } });
    const matchMedia = window.matchMedia.bind(window);
    const media = vi.spyOn(window, 'matchMedia').mockImplementation(query => {
      const result = matchMedia(query);
      if (query === '(prefers-reduced-motion: reduce)') Object.defineProperty(result, 'matches', { value: reduced });
      return result;
    });
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    try {
      const host = await mountApp();
      await waitFor(() => !!host.querySelector('#launch-override-vitals'), 'recovery warning');
      // First opens the tab; second works while already on Motors & Configuration.
      for (let i = 0; i < 2; i++) {
        scroll.mockClear();
        const show = host.querySelector('#launch-override-vitals')!.parentElement!.querySelector<HTMLButtonElement>('button')!;
        await act(async () => show.click());
        const row = host.querySelector(`[id="cfg-part-${chute.id!}"]`)!;
        expect(host.querySelector('.motors-layout')).not.toBeNull();
        expect(document.activeElement).toBe(row.querySelector('.config-part-actions button'));
        expect(document.activeElement!.textContent).toBe('Edit…');
        expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: reduced ? 'instant' : 'smooth' });
        expect(scroll.mock.contexts.at(-1)).toBe(row);
      }
    } finally {
      scroll.mockRestore();
      media.mockRestore();
    }
  }, 60_000);
});

describe('the Batch simulate button', () => {
  const batchButton = (host: HTMLElement) => button(host, 'Batch simulate motors…');

  it('FC-4 passes effective recovery and ignition to Batch while defaults stay editable', async () => {
    const { tree, mount, c6 } = await seedStarterSession();
    const chute = tree.components[0]!.children!.flatMap(n => [n, ...(n.children ?? [])]).find(n => n.type === 'parachute')!;
    const defaults = updateNode(tree, chute.id!, { deployEvent: 'altitude', deployAltitude: 91.44 });
    await seedStarterSession({ edit: () => ({ ...defaults, ignitionDefaults: { [mount]: { event: 'automatic', delay: 0 } } }),
      over: { configLayers: 1, detachedOverrides: {}, activeConfigId: 'a', mountMotors: { [mount]: c6 },
        savedConfigs: [{ id: 'a', name: 'Layered', isDefault: true, motors: { [mount]: c6 },
          deployments: { [chute.id!]: { deployEvent: 'ejection', deployAltitude: 200, deployDelay: 0 } },
          ignitions: { [mount]: { event: 'launch', delay: 2 } } }] } });
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    await settle(50);
    await act(async () => { batchButton(host).click(); });
    expect(batchDialog!.assignedIgnitions).toEqual({ [mount]: { event: 'launch', delay: 2 } });
    expect(batchDialog!.assignedMountMotors[mount]!.ignition).toEqual({ event: 'launch', delay: 2 });
    expect(findNode(batchDialog!.tree, chute.id!)!['deployEvent']).toBe('ejection');
    await act(async () => { batchDialog!.onClose(); });
    await settle(450);
    expect(findNode(peekSession()!.tree, chute.id!)!['deployAltitude']).toBe(91.44);
  }, 30000);

  it('FC-4 ignition override edits undo and redo atomically; Delete keeps them and None clears them', async () => {
    const { tree, mount, c6 } = await seedStarterSession();
    await seedStarterSession({ edit: () => ({ ...tree, ignitionDefaults: { [mount]: { event: 'automatic', delay: 0 } } }),
      over: { configLayers: 1, detachedOverrides: {}, activeConfigId: 'a', mountMotors: { [mount]: c6 },
        savedConfigs: [{ id: 'a', name: 'Layered', isDefault: true, motors: { [mount]: c6 },
          ignitions: { [mount]: { event: 'launch', delay: 2 } } }] } });
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    const select = () => host.querySelector<HTMLSelectElement>(`#ignition-${mount}`)!;
    const choose = async (event: string) => act(async () => { select().value = event; select().dispatchEvent(new Event('change', { bubbles: true })); });
    await choose('never');
    expect(select().value).toBe('never');
    await act(async () => { button(host, '↩ Undo').click(); });
    expect(select().value).toBe('launch');
    await act(async () => { button(host, '↪ Redo').click(); });
    expect(select().value).toBe('never');
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label^="Delete Layered"]')!.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label^="Confirm delete Layered"]')!.click(); });
    expect(select().value).toBe('never');
    await settle(450);
    expect(peekSession()!.detachedOverrides?.ignitions?.[mount]).toEqual({ event: 'never', delay: 2 });
    expect(peekSession()!.tree.ignitionDefaults?.[mount]).toEqual({ event: 'automatic', delay: 0 });
    await act(async () => { button(host, '⏏ Unload').click(); });
    await settle(450);
    expect(peekSession()!.detachedOverrides).toEqual({});
  }, 30000);

  it('on a staged rocket is off, and says why ON SCREEN, not only in a tooltip', async () => {
    await seedStarterSession({ edit: (t) => addStage(t).tree });
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    await settle(50);
    const b = batchButton(host);
    expect(b.disabled).toBe(true);
    const reason = /^Batch simulation is not available here: (.+)\.$/.exec(b.title)?.[1];
    expect(reason).toBeTruthy();
    // The same reason, as visible text beside the button.
    expect(host.textContent).toContain(`Batch simulation is not available here — ${reason}.`);
    expect(reason).toBe('the motor combinations explode on a staged rocket');
  }, 30000);

  it('on a rocket with a mount and NO motor loaded is on, and opens the batch dialog', async () => {
    await seedStarterSession({ over: { mountMotors: {} } });
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    await settle(50);
    const b = batchButton(host);
    expect(b.disabled).toBe(false);
    expect(host.textContent).not.toContain('Batch simulation is not available here');
    // The dialog opens on the same condition, or the button enables and then
    // renders nothing — the original "nothing happens".
    await act(async () => { b.click(); });
    expect(host.querySelector('[role="dialog"][aria-label="Batch simulate motors"]')).not.toBeNull();
  }, 30000);

  /**
   * The dialog is handed each loaded motor by the id the nozzle database is
   * keyed on — an imported EX motor by its ex: id, the expression the
   * nozzle-follow rule reads (batchSweep.batchMotorIds, flown against it in
   * batchSweep.test.ts). App read `motorId` alone until the 2026-09-22 audit,
   * which kept every EX motor out of the sweep's nozzle rule on both sides;
   * BatchSimulate.test.tsx held App's call as a string match.
   */
  it('hands the dialog an imported motor by its ex: id', async () => {
    const { tree, mount, c6 } = await seedStarterSession();
    const { motorId: _catalogue, ...meta } = c6.meta;
    await seedStarterSession({
      edit: () => tree,
      over: { mountMotors: { [mount]: { ...c6, meta: { ...meta, manufacturer: 'EX', exMotorId: 'ex:test-c6' } } } },
    });
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    await settle(50);
    await act(async () => { batchButton(host).click(); });
    expect(batchDialog?.assignedMotorIds).toEqual({ [mount]: 'ex:test-c6' });
  }, 30000);
});

/**
 * A PANEL'S HEADER ROW WRAPS (reported 2026-09-01: "the new scale button pushes
 * the redo button out of the components panel"). Four panel headers share
 * `.panel-head`, whose rule wraps (panelHeadWrap.test.ts checks the rule);
 * here each is found in the app as drawn — Components and Rocket on Design,
 * Drag analysis on Results, and the Launch report once a flight has flown —
 * carrying the class and no inline flex of its own.
 */
describe('the panel header rows', () => {
  it('names plots after the flown rocket and motor even after the rocket is renamed', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await type(host.querySelector<HTMLInputElement>('#rocket-name')!, 'Flown rocket');
    await act(async () => { button(host, 'Launch').click(); });
    await waitFor(() => !!host.querySelector('.chart-panel h3'), 'flight plots');
    const report = [...host.querySelectorAll('h2')].find((h) => h.textContent?.startsWith('Launch report'))!;
    const identity = report.textContent!.replace('Launch report — ', '');
    expect(identity).toContain('Flown rocket · ');
    for (const h of host.querySelectorAll('.chart-panel h3')) expect(h.textContent).toContain(identity);
    await openTab(host, 'Design');
    await type(host.querySelector<HTMLInputElement>('#rocket-name')!, 'Edited rocket');
    await openTab(host, 'Results');
    expect(host.querySelectorAll('.charts-grid h3').length).toBeGreaterThan(0);
    for (const h of host.querySelectorAll('.charts-grid h3')) {
      expect(h.textContent).toContain(identity);
      expect(h.textContent).not.toContain('Edited rocket');
    }
  }, 30000);

  const headOf = (host: HTMLElement, title: string): HTMLElement => {
    const h2 = [...host.querySelectorAll('h2')].find((h) => h.textContent?.trim().startsWith(title));
    if (!h2) throw new Error(`no panel "${title}"`);
    return h2.parentElement!;
  };
  const expectWrapping = (row: HTMLElement, title: string) => {
    expect(row.className, title).toBe('panel-head');
    expect(row.getAttribute('style') ?? '', title).not.toMatch(/display:\s*flex/);
  };

  it('carry .panel-head, on every panel that has one', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    expectWrapping(headOf(host, 'Components'), 'Components');
    expectWrapping(headOf(host, 'Rocket'), 'Rocket');
    await act(async () => {
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Launch')!.click();
    });
    await waitFor(() => [...host.querySelectorAll('h2')].some((h) => h.textContent?.startsWith('Launch report')),
      'the launch report');
    expectWrapping(headOf(host, 'Launch report'), 'Launch report');
    expectWrapping(headOf(host, 'Drag analysis'), 'Drag analysis');
  }, 30000);
});

describe('the Motor vitals designation and tooltip', () => {
  it('keeps live check and discard labels, saved rows, tooltip and delay edits consistent', async () => {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const mm = (await loadCatalogueMotor('AeroTech', 'F67C', 9))!;
    const snapshot = { tree, mountMotors: { [mount]: mm }, launch: DEFAULT_CONDITIONS,
      savedConfigs: [
        { id: 'saved', name: null, isDefault: true, motors: { [mount]: mm } },
        { id: 'other', name: 'Other configuration', isDefault: false, motors: { [mount]: mm } },
      ],
      activeConfigId: 'saved', measured: { massKg: null, cgM: null } };
    localStorage.setItem(SESSION_KEY, JSON.stringify({ ...snapshot, savedMark: designFingerprint(snapshot),
      savedAt: Date.now(), appVersion: APP_VERSION }));
    const host = await mountApp();
    await settle(500);
    const original = peekSession()!;
    expect(original.savedMark).toBe(designFingerprint({ ...snapshot, ...original }));
    await openTab(host, 'Motors & Configuration');
    await act(async () => { button(host, 'Browse').click(); });
    // Drive the actual check through App -> MotorPicker -> MotorBrowser, with no network.
    const rows = MOTOR_DB.map(m => m.motorId === mm.meta.motorId ? { ...m, designation: 'F67C-UPDATED' } : m);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(url);
      const body = u.pathname.endsWith('/metadata.json')
        ? { manufacturers: [...new Set(rows.map(m => m.manufacturerAbbrev))].map(abbrev => ({ abbrev })), impulseClasses: [] }
        : { results: rows.filter(m => m.manufacturerAbbrev === u.searchParams.get('manufacturer')) };
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Check thrustcurve.org for newer motors"]')!.click(); });
    await waitFor(() => !!host.querySelector('.motor-check-status .file-note'), 'catalogue check');
    expect(host.querySelector('.motor-check-status')?.textContent).toContain('In this design: AeroTech F67C-UPDATED');
    const expectDisplay = (base: string, delay = 9) => {
      const value = host.querySelector('.vitals-motor-label')!;
      expect(value.textContent).toBe(`${base}-${delay}`);
      expect(value.closest('.vitals-item')?.getAttribute('title')).toContain(`AeroTech ${base}, ${delay} s delay (${base}-${delay})`);
      expect(host.querySelector<HTMLSelectElement>('select[aria-label="Flight configuration"]')!.selectedOptions[0]!.textContent).toContain(`[${base}-9]`);
    };
    expectDisplay('F67C-UPDATED');
    await settle(500);
    const installed = peekSession()!;
    expect(installed.mountMotors![mount]!.spec).toEqual(original.mountMotors![mount]!.spec);
    expect(installed.savedConfigs![0]!.motors[mount]!.spec).toEqual(original.savedConfigs![0]!.motors[mount]!.spec);
    expect(installed.savedMark).toBe(designFingerprint({ ...snapshot, ...installed }));
    await act(async () => { discardCatalogueOverlay(); });
    expectDisplay('F67C');
    await settle(500);
    expect(peekSession()!.savedMark).toBe(original.savedMark);
    // Repeat installation, then edit delay: all three views keep the updated base.
    await act(async () => { button(host, 'Check thrustcurve.org').click(); });
    await waitFor(() => host.querySelector('.vitals-motor-label')?.textContent === 'F67C-UPDATED-9', 'second check');
    const delay = host.querySelector<HTMLInputElement>(`[id="ejection-delay-${mount}"]`)!;
    await act(async () => { delay.focus(); });
    await type(delay, '7');
    await act(async () => { delay.blur(); });
    expectDisplay('F67C-UPDATED', 7);
    await settle(500);
    const edited = peekSession()!;
    expect(edited.savedMark).not.toBe(designFingerprint({ ...snapshot, ...edited }));
    await act(async () => { discardCatalogueOverlay(); });
    expectDisplay('F67C', 7);
    await settle(500);
    expect(peekSession()!.savedMark).toBe(edited.savedMark);
    expect(peekSession()!.savedMark).not.toBe(designFingerprint({ ...snapshot, ...peekSession()! }));
  }, 30000);

  it('memoizes the tooltip and never loads the EX library on unchanged-input rerenders', async () => {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const c6 = (await loadCatalogueMotor('Estes', 'C6', 5))!;
    const mm = { ...c6, label: 'F67-9', spec: { ...c6.spec, designation: 'F67', ejectionDelay: 9 },
      meta: { label: 'F67-9', manufacturer: 'EX', motorId: 'ex:old-f67', exMotorId: 'ex:old-f67' } };
    localStorage.setItem(SESSION_KEY, JSON.stringify({ tree, mountMotors: { [mount]: mm },
      launch: DEFAULT_CONDITIONS, savedAt: Date.now(), appVersion: APP_VERSION }));
    const host = await mountApp();
    await settle(500);
    vi.mocked(getExMotor).mockClear();
    vi.mocked(loadExMotors).mockClear();
    // Also cover the first tooltip calculation with an explicit catalogue: no library read.
    expect(motorTooltip(mm, MOTOR_DB)).toBe('EX F67, 9 s delay (F67-9)');
    expect(getExMotor).not.toHaveBeenCalled();
    expect(loadExMotors).not.toHaveBeenCalled();
    vi.mocked(motorTooltip).mockClear();
    const name = host.querySelector<HTMLInputElement>('#rocket-name')!;
    await type(name, 'EX rocket renamed');
    await type(name, 'EX rocket renamed again');
    expect(host.querySelector('.vitals-item-name .vitals-value')?.textContent).toBe('EX rocket renamed again');
    expect(motorTooltip).not.toHaveBeenCalled();
    expect(getExMotor).not.toHaveBeenCalled();
    expect(loadExMotors).not.toHaveBeenCalled();
    // Changing the catalogue invalidates the memo, even if the EX display stays the same.
    const before = MOTOR_DB[0]!;
    await act(async () => { setCatalogueOverlay({ baseGenerated: '', fetchedAt: '', liveCount: 1, added: [],
      changed: [{ motorId: before.motorId, before, after: { ...before, designation: 'UPDATED' }, fields: ['designation'] }],
      removed: [], rejected: [] }); });
    expect(motorTooltip).toHaveBeenCalled();
    expect(host.querySelector('.vitals-motor-label')?.closest('.vitals-item')?.getAttribute('title')).toContain('EX F67, 9 s delay');
  });

  it.each([1, 2])('keeps +%s other mounts outside a clipped long motor label', async (extra) => {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!;
    const mm = (await loadCatalogueMotor('AeroTech', 'F67C', 9))!;
    // Keep the supplied long identity unresolved so restore retains it.
    const label = '1685CC098LFX-L225FX (auto delay)';
    const long = { ...mm, label, spec: { ...mm.spec, designation: '1685CC098LFX-L225FX' },
      meta: { label, manufacturer: 'Hypertek', autoDelay: true } };
    const motors = { [mount.id!]: long };
    for (let i = 0; i < extra; i++) {
      const id = `extra-mount-${i}`;
      tree.components[0]!.children!.push({ ...mount, id });
      motors[id] = long;
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify({ tree, mountMotors: motors,
      launch: DEFAULT_CONDITIONS, savedAt: Date.now(), appVersion: '0.159' }));
    const host = await mountApp();
    const value = host.querySelector('.vitals-motor-label')!;
    const count = host.querySelector('.vitals-motor-count')!;
    expect(value.textContent).toBe(label);
    expect(count.textContent).toBe(` +${extra}`);
    expect(count.parentElement).toBe(value.parentElement);
    expect(value.contains(count)).toBe(false);
    // Happy DOM checks the applied rule; real clipping geometry remains browser QA.
    const style = document.createElement('style');
    style.textContent = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');
    document.head.appendChild(style);
    try {
      expect(getComputedStyle(count).flexShrink).toBe('0');
      expect(getComputedStyle(value).textOverflow).toBe('ellipsis');
    } finally {
      style.remove();
    }
    expect(value.closest('.vitals-item')?.getAttribute('title')).toContain(`(+${extra} more ${extra === 1 ? 'mount' : 'mounts'})`);
    expect(value.parentElement?.querySelector('button')?.textContent).toContain('Unload');
  });

  it.each([
    [9, false, 'F67C-9', '9 s delay'],
    [Infinity, false, 'F67C-P', 'plugged'],
    [9, true, 'F67C (auto delay)', 'automatic delay'],
  ] as const)('restores the full label at %s s, auto %s', async (delay, autoDelay, label, delayText) => {
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const mm = (await loadCatalogueMotor('AeroTech', 'F67C', delay))!;
    mm.label = 'F67-9';
    mm.meta.label = 'F67-9';
    mm.meta.autoDelay = autoDelay;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ tree, mountMotors: { [mount]: mm },
      launch: DEFAULT_CONDITIONS, savedAt: Date.now(), appVersion: '0.159' },
    (_key, value: unknown) => value === Infinity ? 'Infinity' : value));
    const host = await mountApp();
    const value = host.querySelector('.vitals-motor-label')!;
    expect(value.textContent).toBe(label);
    expect(value.closest('.vitals-item')?.getAttribute('title')).toContain('AeroTech F67C, ' + delayText);
    expect(value.closest('.vitals-item')?.getAttribute('title')).toContain(label);
    expect(value.parentElement?.querySelector('button')?.textContent).toContain('Unload');
  });
});

it('the Batch weighed-pad note receives the loaded designation without its delay', async () => {
  const tree = defaultTree();
  const mount = motorMounts(tree)[0]!.id!;
  const mm = (await loadCatalogueMotor('AeroTech', 'F67C', 9))!;
  const bare = buildDesign({ tree, assigned: [[mount, mm]], kbf: true, supersonic: false,
    measuredDryMassKg: null, primaryMountId: mount, currentSetKey: '' }, KERNEL_HANDLES);
  if ('error' in bare) throw new Error(bare.error);
  const padMassKg = bare.info.massEmpty + catalogueMotorMass(tree, [[mount, mm]])! + 0.005;
  await seedStarterSession({ over: { tree, mountMotors: { [mount]: mm },
    measured: { massKg: null, cgM: null, padMassKg } } });
  const host = await mountApp();
  await settle(600);
  await openTab(host, 'Motors & Configuration');
  await act(async () => { button(host, 'Batch simulate motors…').click(); });
  await waitFor(() => batchDialog !== null, 'batch dialog');
  expect(batchDialog!.weighed?.name).toBe('F67C');
  expect(batchDialog!.retainedHardware?.mountId).toBe(mount);
  expect(batchDialog!.retainedHardware?.deltaKg).toBeCloseTo(0.005, 8);
});

/**
 * K1 (board Tier 2): an air start on a SINGLE-stage rocket — a RockSim
 * IgnitionDelay, or desktop's launch + delay — flies, but the Ignition control
 * showed only on staged designs, so it could be neither seen nor cleared.
 */
describe('the Ignition control on a single-stage rocket', () => {
  const ignitionBox = (host: HTMLElement) => [...host.querySelectorAll<HTMLInputElement>('.mount-card input[aria-label]')]
    .some((i) => /^Ignition delay for /.test(i.getAttribute('aria-label')!));

  it('shows when the motor is not lit at launch, so it can be cleared', async () => {
    const { mount, c6 } = await seedStarterSession();
    const s = JSON.parse(localStorage.getItem(SESSION_KEY)!);
    s.mountMotors[mount] = { ...c6, ignition: { event: 'launch', delay: 2 } };
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    await settle(50);
    expect(ignitionBox(host)).toBe(true);
  }, 30000);

  it('FC-5 shows the editable mount default for an ordinary motor lit at launch', async () => {
    await seedStarterSession();
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    await settle(50);
    expect(ignitionBox(host)).toBe(true);
    expect(host.textContent).toContain("Ignition: uses the mount's own setting");
  }, 30000);
});

describe('the single-stage Ignition choices (review of v0.169)', () => {
  it('offer no lower-stage trigger, which could never light a launch-stage motor', async () => {
    const { mount, c6 } = await seedStarterSession();
    const s = JSON.parse(localStorage.getItem(SESSION_KEY)!);
    s.mountMotors[mount] = { ...c6, ignition: { event: 'launch', delay: 2 } };
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    const host = await mountApp();
    await openTab(host, 'Motors & Configuration');
    await settle(50);
    const values = [...host.querySelectorAll<HTMLOptionElement>('.mount-card select[id^="ignition-"] option')].map((o) => o.value);
    expect(values).toEqual(['automatic', 'launch', 'never']);
  }, 30000);
});
