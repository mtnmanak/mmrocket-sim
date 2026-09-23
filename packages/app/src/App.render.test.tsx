// @vitest-environment happy-dom
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
import { classLabel } from './services/motorDb.js';
import { loadCatalogueMotor } from './services/motorMatch.js';
import { nozzleOversize } from './services/nozzleCheck.js';
import { designMatchKeyOf } from './services/simReport.js';
import { addChild, addStage, defaultTree, motorMounts } from './tree/treeModel.js';
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
  localStorage.setItem('online-openrocket.workspace.v1', 'design');
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
});

afterEach(async () => {
  await unmountAll();
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

/**
 * A WEIGHING SAVED ON A POD'S RECORD MOVES TO THE CORE'S, AND SAYS SO (audit
 * 2026-09-22, row 356). A session saved with a pod motor picked before the
 * core's has its pad mass on the record that has just stopped being primary;
 * the restore moves it (treeModel.padMassOntoRankedPrimary) and the notice bar
 * says where, so the value is not seen to jump cards unexplained.
 * primaryMount.test.ts checked App's half as a regex for the ref it read.
 */
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
 * THE AUTO DELAY BOX GOES ON THE PRIMARY'S CARD (audit 2026-09-22, row 356).
 * flightRunner writes the rounded optimum onto the primary mount alone, so the
 * working "auto (optimal)" box is that card's; any other card whose motor
 * carries the flag gets a box saying it applies to the top motor only, so it
 * can be unticked (treeModel.autoDelayBox, tested in primaryMount.test.ts).
 * It used to show "auto (optimal)" on every sustainer-stage card, over a pod
 * that flew its spec delay. primaryMount.test.ts held App's call as a string
 * match.
 */
describe('the Auto delay box on a motor card', () => {
  it('is "auto (optimal)" on the core\'s card and "auto — top motor only" on the pods\'', async () => {
    const probe = podTree(defaultTree());
    const core = motorMounts(probe).find((m) => m.id !== 'pod-mmt')!;
    const c6 = (await loadCatalogueMotor('Estes', 'C6', 5))!;
    const auto = { ...c6, meta: { ...c6.meta, autoDelay: true } };
    await seedStarterSession({ edit: () => probe, over: { mountMotors: { 'pod-mmt': auto, [core.id!]: auto } } });
    const host = await mountApp();
    await openTab(host, 'Motors & Launch');
    await settle(50);
    const box = (mountName: string) => [...host.querySelectorAll('.mount-card')]
      .find((c) => c.querySelector('label')?.firstChild?.textContent === mountName)
      ?.querySelector('input[type="checkbox"]:checked')?.parentElement?.textContent?.trim();
    // The ticked box on each card — "plugged" is the other checkbox, unticked here.
    expect(box(core.name!)).toBe('auto (optimal)');
    expect(box('Pod MMT')).toBe('auto — top motor only');
  }, 30000);
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

  it('is shut below 981px, with the chip to open it', async () => {
    viewport(800);
    const host = await mountApp();
    await waitFor(() => host.querySelector('.stats-drawer-chip') !== null, 'the All-stats chip');
    await settle(50);
    expect(host.querySelector('.stats-drawer')).toBeNull();
    // And the chip still opens it — as a block under the canvas at this width.
    await act(async () => { button(host, '▤ All stats').click(); });
    expect(host.querySelector('.stats-drawer')?.className).toContain('stats-drawer-flow');
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
async function openTab(host: HTMLElement, name: 'Fly' | 'Design' | 'Motors & Launch' | 'Results'): Promise<void> {
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
describe('the Batch simulate button', () => {
  const batchButton = (host: HTMLElement) => button(host, 'Batch simulate motors…');

  it('on a staged rocket is off, and says why ON SCREEN, not only in a tooltip', async () => {
    await seedStarterSession({ edit: (t) => addStage(t).tree });
    const host = await mountApp();
    await openTab(host, 'Motors & Launch');
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
    await openTab(host, 'Motors & Launch');
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
    await openTab(host, 'Motors & Launch');
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
