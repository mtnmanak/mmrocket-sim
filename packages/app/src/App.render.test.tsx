// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App.js';
import { DEFAULT_CONDITIONS } from './components/LaunchPanel.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { findAllowance } from './services/buildAllowance.js';
import { buildDesign, KERNEL_HANDLES } from './services/buildDesign.js';
import { catalogueMotorMass } from './services/hardwareMass.js';
import { classLabel } from './services/motorDb.js';
import { loadCatalogueMotor } from './services/motorMatch.js';
import { nozzleOversize } from './services/nozzleCheck.js';
import { designMatchKeyOf } from './services/simReport.js';
import { defaultTree, motorMounts } from './tree/treeModel.js';
import type { MountMotor } from './model/design.js';
import { APP_VERSION } from './version.js';

/**
 * App, rendered — for what App itself decides: which of its memos a keystroke
 * re-runs, and what its layout and gates put on screen. The behavioural
 * replacements for the regexes statsDrawerDefault.test.ts, panelHeadWrap.test.ts
 * and noticeBarPhoneLift.test.ts used to run over App.tsx's text (audit
 * 2026-09-22, row 477). The same harness as App.session.test.tsx: the real
 * TeaVM kernel, the bundled starter motor, fetch stubbed to fail as offline.
 *
 * The four spies below pass straight through to the real functions. Each is
 * called, on the Design tab, by exactly ONE of App's memos — which is what
 * lets a count of its calls stand for "that memo re-ran".
 */
vi.mock('./services/buildAllowance.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/buildAllowance.js')>();
  return { ...real, findAllowance: vi.fn(real.findAllowance) };
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
 * matching behind it).
 */
describe('a keystroke in the Rocket name re-runs none of the design memos', () => {
  const spies = () => ({
    allowance: vi.mocked(findAllowance).mock.calls.length,
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
