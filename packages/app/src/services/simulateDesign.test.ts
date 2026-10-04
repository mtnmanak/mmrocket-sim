// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { effectiveAero } from '../prefs/aeroChoice.js';
import { DEFAULT_PREFS } from '../prefs/preferences.js';
import { addChild, addStage, defaultTree, motorMounts } from '../tree/treeModel.js';
import { APP_VERSION } from '../version.js';
import { buildDesign, KERNEL_HANDLES } from './buildDesign.js';
import {
  deriveLaunchInputs, designBuildInputOf, hardwareDeltaKgOf, legacyPadMassStepOf, provenanceKeyOf, type AeroState,
  type DesignState,
} from './designDerivation.js';
import { catalogueMotorMass, LEGACY_PAD_MASS_KEY } from './hardwareMass.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { loadCatalogueMotor } from './motorMatch.js';
import type { OrkMotorRef } from './orkFile.js';
import { comparable } from './simulate.testSupport.js';
import { padMassTextFor } from './unitText.js';
import { INITIAL_UNITS } from '../prefs/units.js';
import {
  APP_DEFAULT_AERO, flyBuiltDesign, simulateDesign, SimulateDesignError, withKernel,
} from './simulateDesign.js';

/**
 * THE HEADLESS LAUNCH, on the real kernel (2026-10-01). What simulateDesign
 * adds around flyBuiltDesign — the build, the legacy pad-mass settle App's
 * reconcile effect makes before any Launch, the Launch gate, the kernel lock
 * — and what it says when it cannot fly. flyBuiltDesign.test.ts pins the
 * flight itself; App.simulate.test.tsx pins this against the button.
 */

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const CLASSIC: AeroState = { aeroMode: 'classic', effectiveKbf: true, autoSupersonic: false };
const AUTO: AeroState = { aeroMode: 'auto', effectiveKbf: true, autoSupersonic: false };
const state = (tree: RocketTree, mountMotors: Record<string, MountMotor>, over: Partial<DesignState> = {}): DesignState => ({
  tree, mountMotors, launch: DEFAULT_CONDITIONS, measured: { massKg: null, cgM: null }, savedConfigs: [],
  activeConfigId: null, unmatchedRefs: {}, ...over,
});
const c6 = async () => (await loadCatalogueMotor('Estes', 'C6', 5))!;

/** The starter rocket with its C6. */
async function starter(): Promise<DesignState> {
  const tree = defaultTree();
  return state(tree, { [motorMounts(tree)[0]!.id!]: await c6() });
}

/** The starter rocket with an AeroTech F67 on Auto delay: Auto aero crosses Mach 0.9 on it (measured 1.118). */
async function f67Auto(): Promise<DesignState> {
  const tree = defaultTree();
  const f67 = (await loadCatalogueMotor('AeroTech', 'F67', 6))!;
  return state(tree, { [motorMounts(tree)[0]!.id!]: { ...f67, meta: { ...f67.meta, autoDelay: true } } });
}

/** The pad mass a build of `s` (no pad mass) would carry 20 g of hardware at. */
function padFor20g(s: DesignState, mountId: string): number {
  const d = deriveLaunchInputs(s, CLASSIC);
  const b = buildDesign(designBuildInputOf({
    tree: s.tree, assigned: d.assigned, effectiveKbf: true, effectiveSupersonic: false,
    measuredDryMassKg: null, primaryMountId: d.primaryMountId, currentSetKey: d.currentSetKey,
  }), KERNEL_HANDLES);
  if ('error' in b) throw new Error(b.error);
  return b.info.massEmpty + catalogueMotorMass(s.tree, [[mountId, s.mountMotors[mountId]!]])! + 0.02;
}

describe('APP_DEFAULT_AERO', () => {
  it('is what a first visit flies: effectiveAero over the stored defaults, before any Auto upgrade', () => {
    expect(APP_DEFAULT_AERO).toStrictEqual({ ...effectiveAero(DEFAULT_PREFS, null), autoSupersonic: false });
    expect(APP_DEFAULT_AERO).toStrictEqual({ aeroMode: 'classic', effectiveKbf: true, autoSupersonic: false });
  });
});

describe('simulateDesign flies the design', () => {
  it('says which build flew it, the state it flew, and the full provenance key', async () => {
    const s = await starter();
    const out = await simulateDesign(s);
    expect(out.appVersion).toBe(APP_VERSION);
    expect(out.state).toBe(s); // no legacy value: nothing to settle
    expect(out.autoSupersonic).toBe(false);
    expect(out.build.hardware.state).toBe('none');
    const d = deriveLaunchInputs(s, APP_DEFAULT_AERO);
    expect(out.provenance).toStrictEqual(provenanceKeyOf({
      physicsKey: d.physicsKey, tree: s.tree, assigned: d.assigned, hardwareDeltaKg: 0, launch: s.launch,
      aero: APP_DEFAULT_AERO,
    }));
    expect(out.run.designKey).toBe(out.provenance.designKey);
    expect(out.run.motorSetKey).toBe(out.provenance.motorSetKey);
    expect(out.run.motorDataKeys).toEqual(out.provenance.motorDataKeys);
    expect(Object.keys(out.run.motorDataKeys!)).toEqual(d.assigned.map(([id]) => id));
    expect(out.result.summary.maxAltitude).toBeGreaterThan(0);
  }, 30000);

  it('says when Auto crossed Mach 0.9 — what App would now fly the design on', async () => {
    const out = await simulateDesign(await f67Auto(), { aero: AUTO });
    expect(out.flight.usedSupersonic).toBe(true);
    expect(out.autoSupersonic).toBe(true);
    expect(out.run.aeroModel).toBe('auto-supersonic');
    expect(out.provenance.autoSupersonic).toBe(false); // stamped as of the click, as App stamps it
  }, 30000);

  it('passes aero.autoSupersonic through: the second Launch App would fly', async () => {
    const out = await simulateDesign(await f67Auto(), { aero: { ...AUTO, autoSupersonic: true } });
    expect(out.autoSupersonic).toBe(true);
    expect(out.provenance.autoSupersonic).toBe(true);
  }, 30000);
});

/**
 * THE LEGACY PAD-MASS SETTLE. App's reconcile effect runs after the first
 * build and before any Launch, so the Launch button never flies a value keyed
 * 'legacy'. The branch that moves a number is the drop for a file whose
 * primary motor is not loaded: before the effect, the build flies the value as
 * hardware under the booster. The headless run must fly the settled state.
 */
describe('simulateDesign settles a legacy pad mass as App does before any Launch', () => {
  /** A sustainer whose motor is only an unmatched reference, over a booster carrying a C6 with a legacy pad mass. */
  async function legacyTwoStage(): Promise<{ legacy: DesignState; booster: string }> {
    const base = defaultTree();
    const sustainerMount = motorMounts(base)[0]!.id!;
    const { tree: staged, newId } = addStage(base);
    const tree = addChild(staged, newId, {
      type: 'bodytube', id: 'boo-bt', name: 'Booster tube', length: 0.1, outerRadius: 0.0124, thickness: 0.0003,
      children: [{ type: 'innertube', id: 'boo-mmt', name: 'Booster MMT', motorMount: true,
        length: 0.07, outerRadius: 0.0095, thickness: 0.0003 } as ComponentNode],
    } as ComponentNode);
    const booster = 'boo-mmt';
    expect(motorMounts(tree).map((m) => m.id)).toEqual([sustainerMount, booster]);
    const plain = state(tree, { [booster]: await c6() }, {
      unmatchedRefs: { [sustainerMount]: { designation: 'K550', delay: 10, padMassKg: 1.2 } as OrkMotorRef },
    });
    const kg = padFor20g(plain, booster);
    const legacy = { ...plain, mountMotors: { [booster]: { ...plain.mountMotors[booster]!, padMassKg: kg, padMassWeighedWith: LEGACY_PAD_MASS_KEY } } };
    return { legacy, booster };
  }

  it('drops it when the file’s primary is not loaded: flies the settled state, not the hardware', async () => {
    const { legacy, booster } = await legacyTwoStage();
    // Without the settle the value would fly as hardware — else this proves nothing.
    const d = deriveLaunchInputs(legacy, CLASSIC);
    const raw = buildDesign(designBuildInputOf({
      tree: legacy.tree, assigned: d.assigned, effectiveKbf: true, effectiveSupersonic: false, measuredDryMassKg: null,
      primaryMountId: d.primaryMountId, currentSetKey: d.currentSetKey,
    }), KERNEL_HANDLES);
    expect('error' in raw ? null : raw.hardware.state).toBe('ok');
    expect(d.filePrimaryMountId).not.toBe(d.primaryMountId);

    const out = await simulateDesign(legacy, { aero: CLASSIC });
    expect(out.build.hardware.state).not.toBe('ok');
    // The reason the apogee moved, in the notice App shows for it (verify-step1 finding 6).
    const step = legacyPadMassStepOf({ state: legacy, derived: d, hardware: 'error' in raw ? null : raw.hardware, text: padMassTextFor(INITIAL_UNITS) });
    expect(step?.kind).toBe('drop');
    expect(out.padMassNote).toStrictEqual(step!.note);
    expect('padMassKg' in out.state.mountMotors[booster]!).toBe(false);
    expect('padMassWeighedWith' in out.state.mountMotors[booster]!).toBe(false);
    expect(Object.values(out.state.unmatchedRefs ?? {}).some((r) => 'padMassKg' in r)).toBe(false);
    // The settled state, flown on its own, is the same flight: App's state after its effect.
    const settled = await simulateDesign(out.state, { aero: CLASSIC });
    expect(comparable(out.run)).toStrictEqual(comparable(settled.run));
    expect(out.result.summary).toStrictEqual(settled.result.summary);
  }, 60000);

  it('re-keys it to the set now loaded when it checks out: the value is kept and flown', async () => {
    const s = await starter();
    const mount = Object.keys(s.mountMotors)[0]!;
    const kg = padFor20g(s, mount);
    const legacy = { ...s, mountMotors: { [mount]: { ...s.mountMotors[mount]!, padMassKg: kg, padMassWeighedWith: LEGACY_PAD_MASS_KEY } } };
    const out = await simulateDesign(legacy, { aero: CLASSIC });
    const key = deriveLaunchInputs(legacy, CLASSIC).currentSetKey;
    expect(out.state.mountMotors[mount]).toMatchObject({ padMassKg: kg, padMassWeighedWith: key });
    expect(out.build.hardware.state).toBe('ok');
    expect(out.padMassNote).toMatchObject({ severity: 'info' });
    expect(out.padMassNote!.text).toContain('now belongs to the motor it was weighed with');
    const rekeyed = { ...legacy, mountMotors: { [mount]: { ...legacy.mountMotors[mount]!, padMassWeighedWith: key } } };
    const direct = await simulateDesign(rekeyed, { aero: CLASSIC });
    expect(comparable(out.run)).toStrictEqual(comparable(direct.run));
    // Nothing to settle, nothing to say.
    expect(direct.padMassNote).toBeNull();
  }, 60000);
});

describe('simulateDesign says why it did not fly, in the app’s words', () => {
  it("'no-motor' with no motor on any mount — App's Launch button is disabled", async () => {
    const tree = defaultTree();
    await expect(simulateDesign(state(tree, {}))).rejects.toMatchObject({ kind: 'no-motor' });
  }, 30000);

  it("'build' with the build's own error, verbatim, when the kernel will not build the design", async () => {
    const s = await starter();
    // A part the kernel does not know (buildDesign.test.ts's own refusal).
    const body = s.tree.components[0]!.children!.find((n) => n.type === 'bodytube')!;
    const broken = { ...s, tree: addChild(s.tree, body.id!, { id: 'w', type: 'widget', name: 'Widget' } as unknown as ComponentNode) };
    const d = deriveLaunchInputs(broken, APP_DEFAULT_AERO);
    const expected = buildDesign(designBuildInputOf({
      tree: broken.tree, assigned: d.assigned, effectiveKbf: true, effectiveSupersonic: false, measuredDryMassKg: null,
      primaryMountId: d.primaryMountId, currentSetKey: d.currentSetKey,
    }), KERNEL_HANDLES);
    expect('error' in expected).toBe(true);
    const err = await simulateDesign(broken).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SimulateDesignError);
    expect(err).toMatchObject({ kind: 'build', message: (expected as { error: string }).error });
  }, 30000);

  it("'flight' with the flight's own message when the flight refuses", async () => {
    // An Auto-delay motor the kernel refused: flyLaunch refuses by the mount's name.
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const m = await c6();
    const refused = { ...m, meta: { ...m.meta, autoDelay: true },
      spec: { ...m.spec, masses: m.spec.masses.map((x, i, all) => (i === all.length - 1 ? -0.001 : x)) } };
    const pod = addChild(tree, tree.components[0]!.children!.find((n) => n.type === 'bodytube')!.id!, {
      type: 'podset', instanceCount: 2, children: [{ type: 'bodytube', length: 0.1, outerRadius: 0.01, thickness: 0.0005,
        children: [{ type: 'innertube', id: 'pod-mmt', name: 'Pod MMT', motorMount: true, length: 0.07, outerRadius: 0.0095, thickness: 0.0003 } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode);
    const err = await simulateDesign(state(pod, { [mount]: m, 'pod-mmt': refused })).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'flight' });
    expect((err as Error).message).toMatch(/^Auto delay did not settle for Pod MMT/);
  }, 30000);
});

/**
 * A CANCEL IS THE CALLER'S ABORT, WHEREVER IT LANDS (verify-step1 finding 7).
 * Refused while queued, `withKernel` rejects with the abort; cancelled after
 * the build, the flight's own check threw it and the catch wrapped it as a
 * `'flight'` failure — two shapes for one event, and a caller reading
 * `kind: 'flight'` as "the simulation failed" misreports a cancel.
 */
describe('a cancel', () => {
  it('after the build is reported as the abort, exactly as a cancel before the queue is — never as a failed flight', async () => {
    const s = await starter();
    const mid = new AbortController();
    // Cancelled between the build and the flight: the factory aborts as it hands the handle over.
    const handles = { reset: KERNEL_HANDLES.reset, build: (t: RocketTree) => { const h = KERNEL_HANDLES.build(t); mid.abort('stop'); return h; } };
    const during = await simulateDesign(s, { handles, signal: mid.signal }).catch((e: unknown) => e);
    const early = new AbortController();
    early.abort('stop');
    const before = await simulateDesign(s, { signal: early.signal }).catch((e: unknown) => e);
    expect(before).toMatchObject({ name: 'AbortError', message: 'stop' });
    expect(during).not.toBeInstanceOf(SimulateDesignError);
    expect(during).toMatchObject({ name: 'AbortError', message: 'stop' });
    expect((during as object).constructor).toBe((before as object).constructor);
  }, 30000);
});

/**
 * ONE AT A TIME. A build resets the kernel and a flight awaits, so two runs
 * started together would interleave one's reset into the other's flight
 * ("stale engine handle"). An Auto-delay design yields between its probes
 * (setTimeout), so a second run started in the same tick lands inside it
 * every time without the lock.
 */
describe('the kernel lock', () => {
  it('two Launches started together each fly exactly as they fly alone', async () => {
    const a = await f67Auto();
    const b = await starter();
    const [ra, rb] = await Promise.all([simulateDesign(a, { aero: AUTO }), simulateDesign(b)]);
    const soloA = await simulateDesign(a, { aero: AUTO });
    const soloB = await simulateDesign(b);
    expect(ra.flight.delayResolution.probes).toBeGreaterThan(0); // it did yield
    expect(comparable(ra.run)).toStrictEqual(comparable(soloA.run));
    expect(comparable(rb.run)).toStrictEqual(comparable(soloB.run));
  }, 60000);

  it('runs one job at a time, in order', async () => {
    const log: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const first = withKernel(async () => { log.push('a-start'); await gate; log.push('a-end'); return 'a'; });
    const second = withKernel(() => { log.push('b'); return 'b'; });
    await new Promise((r) => setTimeout(r, 10));
    expect(log).toEqual(['a-start']);
    open();
    await expect(Promise.all([first, second])).resolves.toEqual(['a', 'b']);
    expect(log).toEqual(['a-start', 'a-end', 'b']);
  });

  it('a job that rejects does not block the next one', async () => {
    const failed = withKernel(() => { throw new Error('build refused'); });
    const next = withKernel(() => 'next');
    await expect(failed).rejects.toThrow('build refused');
    await expect(next).resolves.toBe('next');
  });

  it('an aborted caller is refused at once — before the queue, and while it waits — and its job never runs', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const holding = withKernel(async () => { await gate; return 'held'; });
    const ran: string[] = [];
    const already = new AbortController();
    already.abort(new Error('already aborted'));
    await expect(withKernel(() => { ran.push('already'); }, already.signal)).rejects.toThrow('already aborted');
    const later = new AbortController();
    const queued = withKernel(() => { ran.push('queued'); }, later.signal);
    later.abort(new Error('aborted while queued'));
    await expect(queued).rejects.toThrow('aborted while queued');
    open();
    await expect(holding).resolves.toBe('held');
    await withKernel(() => {});
    expect(ran).toEqual([]);
  });
});

/**
 * A HANDLE THAT HAS SERVED THE DESIGN PAGE FLIES THE SAME FLIGHT. App flies the
 * handle its drag panel, component table and statics have already read;
 * simulateDesign flies a fresh one. If these ever differ, App's numbers depend
 * on which panels the user opened — an App defect to fix in the kernel or the
 * bridge, never one to copy into the headless path.
 */
describe('a used handle and a fresh one', () => {
  it('fly the same flight', async () => {
    const s = await starter();
    const fly = async (use: boolean) => {
      const d = deriveLaunchInputs(s, CLASSIC);
      const built = buildDesign(designBuildInputOf({
        tree: s.tree, assigned: d.assigned, effectiveKbf: true, effectiveSupersonic: false, measuredDryMassKg: null,
        primaryMountId: d.primaryMountId, currentSetKey: d.currentSetKey,
      }), KERNEL_HANDLES);
      if ('error' in built) throw new Error(built.error);
      if (use) {
        built.rocket.dragSweep({ machMax: 1.5 });
        for (const n of d.mounts) built.rocket.componentInfo(n.id!);
        built.rocket.staticInfo();
      }
      return flyBuiltDesign({
        built, tree: s.tree, derived: { ...d, primaryMountId: d.primaryMountId! }, launch: s.launch, aero: CLASSIC,
        activeConfigId: null, savedConfigs: [], onSupersonicUpgrade: () => {},
        provenance: provenanceKeyOf({ physicsKey: d.physicsKey, tree: s.tree, assigned: d.assigned,
          hardwareDeltaKg: hardwareDeltaKgOf(built), launch: s.launch, aero: CLASSIC }),
      });
    };
    const fresh = await fly(false);
    const used = await fly(true);
    expect(comparable(used.run)).toStrictEqual(comparable(fresh.run));
    expect(used.flight.result.summary).toStrictEqual(fresh.flight.result.summary);
  }, 60000);
});


it('flies and stamps Hybrid through the transonic band without an Auto upgrade', async () => {
  const s = await f67Auto();
  const out = await simulateDesign(s, { aero: { ...CLASSIC, aeroMode: 'hybrid' } });
  expect(out.result.summary.maxMachNumber).toBeGreaterThan(0.9);
  expect(out.run.aeroModel).toBe('hybrid');
  expect(out.run.rogersKbf).toBe(true);
  expect(out.autoSupersonic).toBe(false);
  expect(out.flight.usedSupersonic).toBe(false);
  expect(out.provenance.aeroMode).toBe('hybrid');
}, 30000);
