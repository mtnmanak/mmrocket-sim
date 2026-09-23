// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ComponentNode } from '@online-openrocket/engine';
import type { SessionState } from './services/session.js';
import { exportOrk } from './services/orkFile.js';
import { padMassSetKey } from './services/configSync.js';
import { designFingerprint, type DesignSnapshot } from './services/dirtyState.js';

const here = dirname(fileURLToPath(import.meta.url));

// The real writer, passed through; one test makes a single save throw.
vi.mock('./services/orkFile.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./services/orkFile.js')>();
  return { ...real, exportOrk: vi.fn(real.exportOrk) };
});
// The real report, unless a test sets `reportThrows` (the boundary test).
let reportThrows = false;
vi.mock('./components/SimResults.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./components/SimResults.js')>();
  return {
    ...real,
    SimRunDetails: (props: Parameters<typeof real.SimRunDetails>[0]) => {
      if (reportThrows) throw new Error('a stored run the report cannot read');
      return <real.SimRunDetails {...props} />;
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no canvas, and the Results tab a Launch lands on draws uPlot
// charts on a rAF tick. The same no-op 2D context FlightCharts.test.tsx uses:
// nothing here is about pixels.
const ctx2d = new Proxy({}, {
  get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 0 }) : () => undefined),
});
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;

/**
 * The whole App, mounted — for the session, saved-mark and autosave behaviour
 * that lives in App's own effects and cannot be reached through a service.
 * About 2.5 s a mount under happy-dom; the kernel is the real TeaVM artifact
 * and the starter motor comes from the bundled curves, so nothing here needs
 * the network (fetch is stubbed to fail, as it would offline).
 */

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

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const b = [...host.querySelectorAll('button')].find((x) => x.textContent?.includes(text));
  if (!b) throw new Error(`no button "${text}"`);
  return b;
}

/** Starter motor present in the stored session — the async C6 has landed and been autosaved. */
const starterStored = () => Object.keys(storedSession()?.mountMotors ?? {}).length > 0;

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

beforeEach(() => {
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

describe('a first visit is clean once the starter motor lands (audit 2026-09-22)', () => {
  it('✕ New on the untouched starter rocket does not ask "Start a new design?"', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await act(async () => { button(host, '✕ New').click(); });
    expect(host.textContent).not.toContain('Start a new design?');
  }, 30000);

  it('and stays clean across a reload', async () => {
    await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await unmountAll();
    const host = await mountApp();
    await settle(600);
    await act(async () => { button(host, '✕ New').click(); });
    expect(host.textContent).not.toContain('Start a new design?');
  }, 30000);

  it('an edit after it lands still asks — the re-seed does not bless work', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await type(input(host, 'Measured mass'), '31');
    await act(async () => { button(host, '✕ New').click(); });
    expect(host.textContent).toContain('Start a new design?');
  }, 30000);
});

describe('✕ New forgets the previous rocket\'s measured mass & CG (audit 2026-09-22)', () => {
  it('clears the box, and the fresh design is saved-clean with it cleared', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await type(input(host, 'Measured mass'), '2000');
    await type(input(host, 'Measured CG'), '250');
    await act(async () => { button(host, '✕ New').click(); });
    // Undo covers the tree only, so the question says the weighing is not
    // coming back with it (from review; ScaleDialog says the same).
    expect(host.textContent).toContain(
      'Ctrl+Z brings the components back, but not the motors, the flight configurations,'
      + ' the Measured mass & CG or the flight.');
    await act(async () => { button(host, 'Discard & start new').click(); });
    await settle(600);
    window.dispatchEvent(new Event('pagehide'));
    // The rocket that was weighed is gone, so is its weighing: the hardware
    // term (services/hardwareMass.ts) would otherwise take 2000 g as the NEW
    // rocket's dry mass.
    expect(storedSession()?.measured).toEqual({ massKg: null, cgM: null });
    // ...and the mark New takes is over THAT, so a second ✕ New does not ask.
    await act(async () => { button(host, '✕ New').click(); });
    expect(host.textContent).not.toContain('Start a new design?');
  }, 30000);
});

describe('the 500-run cap is reported (audit 2026-09-22)', () => {
  it('a Launch with 500 runs saved says one old run was removed', async () => {
    const old = Array.from({ length: 500 }, (_, i) => ({ id: `old${i}`, when: i, rocket: 'Old', motor: 'A8-3' }));
    localStorage.setItem('online-openrocket.sim-runs.v1', JSON.stringify(old));
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await act(async () => {
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Launch')!.click();
    });
    await waitFor(() => (JSON.parse(localStorage.getItem('online-openrocket.sim-runs.v1')!) as { id: string }[])
      .some((r) => !r.id.startsWith('old')), 'the flight to be saved');
    await settle(50);
    expect(document.body.textContent).toContain(
      'Saved simulations keeps the newest 500 runs, so the oldest 1 was removed to make room.');
  }, 30000);
});

describe('another tab\'s autosave is not overwritten (audit 2026-09-22)', () => {
  const CONFLICT = 'changed in another tab';

  it('one tab editing, reloading and editing again never raises the conflict', async () => {
    let host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await type(input(host, 'Measured mass'), '31');
    await settle(600);
    await unmountAll();
    host = await mountApp();
    await type(input(host, 'Measured mass'), '32');
    await settle(600);
    expect(host.textContent).not.toContain(CONFLICT);
    expect(storedSession()?.measured?.massKg).toBeCloseTo(0.032, 9);
  }, 30000);

  it('an edit here after another tab wrote holds back, says so, and "Keep" takes the slot', async () => {
    const host = await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await settle(600);
    // Another tab of the same origin writes its own design into the slot.
    const other = { ...storedSession()!, stamp: 'othertab' };
    other.tree = { ...other.tree, name: 'The other tab\'s rocket' };
    localStorage.setItem(SESSION_KEY, JSON.stringify(other));

    await type(input(host, 'Measured mass'), '33');
    await settle(600);
    expect(host.textContent).toContain(CONFLICT);
    expect(storedSession()?.tree.name).toBe('The other tab\'s rocket');
    window.dispatchEvent(new Event('pagehide')); // closing the tab flushes — and still holds back
    expect(storedSession()?.tree.name).toBe('The other tab\'s rocket');

    await act(async () => { button(host, 'Keep this tab').click(); });
    expect(storedSession()?.tree.name).toBe('My Rocket');
    expect(storedSession()?.measured?.massKg).toBeCloseTo(0.033, 9);
    expect(host.textContent).not.toContain(CONFLICT);
  }, 30000);
});

describe('Save .ork that throws (audit 2026-09-22)', () => {
  it('says the save failed, leaves the design unsaved, and rejects nothing', async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => { rejections.push(e); };
    process.on('unhandledRejection', onRejection);
    try {
      const host = await mountApp();
      await waitFor(starterStored, 'the starter motor to be autosaved');
      await type(input(host, 'Measured mass'), '34'); // work worth asking about
      vi.mocked(exportOrk).mockImplementationOnce(() => { throw new Error('writer gave up'); });
      await act(async () => { button(host, 'Save As / Export').click(); });
      await act(async () => { button(host, 'Save .ork — OpenRocket design').click(); });
      await settle(50);
      expect(document.body.textContent).toContain('Save .ork failed — nothing was written: writer gave up');
      expect(rejections).toEqual([]);
      // Not marked saved: ✕ New still asks.
      await act(async () => { button(host, '✕ New').click(); });
      expect(host.textContent).toContain('Start a new design?');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  }, 30000);
});

describe('a Results panel that throws stays in its panel (audit 2026-09-22)', () => {
  it('the report says it could not be drawn; the app, the plots and the run table carry on', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportThrows = true;
    try {
      const host = await mountApp();
      await waitFor(starterStored, 'the starter motor to be autosaved');
      await act(async () => {
        [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Launch')!.click();
      });
      await waitFor(() => (host.textContent ?? '').includes('Saved simulations (1)'), 'the flight to be listed');
      expect(host.textContent).toContain('This flight\'s report could not be drawn.');
      expect(host.textContent).toContain('a stored run the report cannot read');
      // Not the whole app: the workspace tabs and the rest of the tab are still there.
      expect(host.textContent).not.toContain('Something went wrong');
      expect(host.querySelector('nav.workspace-tabs button[aria-current="page"]')).toBeTruthy();
      expect(button(host, 'Clear all')).toBeTruthy();
    } finally {
      reportThrows = false;
      errors.mockRestore();
    }
  }, 30000);
});

/**
 * AUTO DELAY THROUGH A SAVE .ork (seam review of audit 2026-09-22). A .ork has
 * no "Auto (optimal)", and a Save wrote the motor's provisional first-flight
 * delay, so the file reopened flying that, not what Auto flew. It now names
 * the delay the primary's newest flight of the design flew, and says when no
 * flight says what that is. A flight at a FIXED delay, flown before Auto was
 * ticked, still matches the design (the motor-set key has no Auto flag), and
 * was taken for Auto's until the review of the seam fixes: the file said 3 s,
 * "the delay its last flight here flew", where Auto flies 5 s.
 */
describe('an Auto-delay motor saved as .ork', () => {
  it('is written at the delay its last flight flew, or said to be provisional', async () => {
    const made = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    try {
      await mountApp();
      await waitFor(starterStored, 'the starter motor to be autosaved');
      await unmountAll();
      // The starter's C6 put on Auto, as ticking "auto (optimal)" on its card
      // does, over a 3 s delay — which Auto re-flies at 5 s on this rocket
      // (the audit's own measurement), so the two delays can be told apart.
      const s = storedSession()!;
      const [mountId, starter] = Object.entries(s.mountMotors!)[0]!;
      const fixed = { ...starter, spec: { ...starter.spec, ejectionDelay: 3 } };
      const rec = { ...fixed, meta: { ...starter.meta, autoDelay: true } };
      const runs = () => JSON.parse(localStorage.getItem('online-openrocket.sim-runs.v1') ?? '[]') as
        { delayS: number; recommendedDelayS: number | null }[];
      const launch = async (host: HTMLElement) => {
        await act(async () => {
          [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Launch')!.click();
        });
      };
      // First a flight at the fixed 3 s, before Auto is ticked.
      s.mountMotors = { [mountId]: fixed };
      localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      await launch(await mountApp());
      await waitFor(() => runs().length === 1, 'the fixed-delay flight to be saved');
      expect([runs()[0]!.delayS, runs()[0]!.recommendedDelayS]).toEqual([3, 5]);
      await unmountAll();
      s.mountMotors = { [mountId]: rec };
      localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      const host = await mountApp();
      await settle(600);
      const saveOrk = async () => {
        vi.mocked(exportOrk).mockClear();
        await act(async () => { button(host, 'Save As / Export').click(); });
        await act(async () => { button(host, 'Save .ork — OpenRocket design').click(); });
        await settle(50);
        const motors = vi.mocked(exportOrk).mock.calls.at(-1)![0].motors!;
        return motors[mountId]!;
      };
      // No flight ON AUTO yet — the 3 s one flew another delay — so the
      // provisional delay, and the Save says so.
      const before = await saveOrk();
      expect(before.delay).toBe(rec.spec.ejectionDelay);
      expect(before.autoDelayFrom).toBe('provisional');
      expect(document.body.textContent).toContain(`it is saved at its provisional ${rec.spec.ejectionDelay} s`);
      // Launch: Auto re-flies at the rounded optimum, and the run records it.
      await launch(host);
      await waitFor(() => runs().length === 2, 'the flight to be saved');
      const [run] = runs();
      expect([run!.delayS, run!.recommendedDelayS]).toEqual([5, 5]);
      const after = await saveOrk();
      expect(after.delay).toBe(run!.delayS);
      expect(after.autoDelayFrom).toBe('flown');
      expect(document.body.textContent).toContain(`it is saved at ${run!.delayS} s, the rounded optimum it flies on Auto`);
    } finally {
      made.mockRestore();
      revoked.mockRestore();
    }
  }, 30000);
});

/**
 * A PAD MASS THE RESTORE MOVES (seam review of audit 2026-09-22). A session
 * saved with a pod's motor picked before the core's carries its weighed pad
 * mass on the pod's record; the core-first ranking moves it onto the core's
 * at restore (treeModel.padMassOntoRankedPrimary). The saved mark, stored over
 * the design before the move, then no longer matched, so a design the user
 * had saved read as unsaved — ✕ New asked, on every reload. And the notice
 * saying where the value went stayed up over ✕ New and over an opened file,
 * describing a rocket no longer on screen.
 */
describe('a pad mass the restore moves onto the core', () => {
  /** A session with a core mount and a two-pod set, both on the starter's C6, 0.3 kg weighed on `padOn`. */
  async function seedPodSession(padOn: 'pod' | 'core', inConfig = false): Promise<void> {
    localStorage.removeItem(SESSION_KEY);
    await mountApp();
    await waitFor(starterStored, 'the starter motor to be autosaved');
    await unmountAll();
    const s = storedSession()!;
    const [core, c6] = Object.entries(s.mountMotors!)[0]!;
    const stage = s.tree.components[0]!;
    const body = stage.children!.find((n) => n.type === 'bodytube')!;
    const pods = {
      type: 'podset', id: 'pods', name: 'Pods', instanceCount: 2, radiusOffset: 0.03,
      children: [{
        type: 'bodytube', id: 'podtube', name: 'Pod tube', length: 0.2, outerRadius: 0.012, thickness: 0.0004,
        children: [{ type: 'innertube', id: 'podmount', name: 'Pod MMT', length: 0.07, outerRadius: 0.0095, thickness: 0.0005, motorMount: true }],
      }],
    } as ComponentNode;
    const tree = { ...s.tree, components: [{ ...stage, children: stage.children!.map((n) => (n === body ? { ...body, children: [...body.children!, pods] } : n)) }] };
    // Pod picked first: its key comes first, which the old ranking made primary.
    const bare = { podmount: c6, [core]: c6 };
    const key = padMassSetKey(tree, bare);
    const onPod = { podmount: { ...c6, padMassKg: 0.3, padMassWeighedWith: key }, [core]: c6 };
    const onCore = { podmount: c6, [core]: { ...c6, padMassKg: 0.3, padMassWeighedWith: key } };
    // `inConfig`: the working set is the core-weighed one, and only a SECOND,
    // non-active flight configuration — as an opened .ork carries — holds `padOn`.
    const mountMotors = inConfig || padOn === 'core' ? onCore : onPod;
    const savedConfigs = inConfig
      ? [{ id: 'A', name: 'A', isDefault: true, motors: onCore }, { id: 'B', name: 'B', isDefault: false, motors: padOn === 'pod' ? onPod : onCore }]
      : s.savedConfigs ?? [];
    const activeConfigId = inConfig ? 'A' : s.activeConfigId ?? null;
    const saved = { ...s, tree, mountMotors, savedConfigs, activeConfigId };
    // Saved as the file on disk has it: the mark over exactly this design.
    const snapshot: DesignSnapshot = {
      tree, mountMotors, launch: s.launch, maxMotorLengthByStage: s.maxMotorLengthByStage ?? {},
      savedConfigs, activeConfigId, measured: s.measured!,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify({ ...saved, savedMark: designFingerprint(snapshot), flownSinceSave: false }));
  }
  const MOVED = 'now sits under';
  /** Every notice in the bar — expanded, since the collapsed bar shows the lead one and a "+N". */
  const notices = async (host: HTMLElement): Promise<string> => {
    const toggle = host.querySelector<HTMLButtonElement>('.notice-toggle[aria-expanded="false"]');
    if (toggle) await act(async () => { toggle.click(); });
    return host.querySelector('[aria-label="Notices"]')?.textContent ?? '';
  };

  it('keeps a saved design saved, and the notice goes with ✕ New', async () => {
    // Control: nothing moves, nothing asks — the harness's mark is the App's own.
    await seedPodSession('core');
    let host = await mountApp();
    await settle(600);
    expect(host.textContent).not.toContain(MOVED);
    await act(async () => { button(host, '✕ New').click(); });
    expect(host.textContent).not.toContain('Start a new design?');
    await unmountAll();

    await seedPodSession('pod');
    host = await mountApp();
    await settle(600);
    expect(await notices(host)).toContain(MOVED);
    await act(async () => { button(host, '✕ New').click(); });
    expect(host.textContent).not.toContain('Start a new design?');
    // New replaced the design: the notice about the old one went with it.
    expect(await notices(host)).not.toContain(MOVED);
  }, 30000);

  it('keeps it saved when only another flight configuration had its pad mass moved', async () => {
    await seedPodSession('core', true);
    let host = await mountApp();
    await settle(600);
    await act(async () => { button(host, '✕ New').click(); });
    expect(host.textContent).not.toContain('Start a new design?');
    await unmountAll();
    await seedPodSession('pod', true);
    host = await mountApp();
    await settle(600);
    await act(async () => { button(host, '✕ New').click(); });
    expect(host.textContent).not.toContain('Start a new design?');
  }, 30000);

  it('the notice goes when a file is opened over it', async () => {
    await seedPodSession('pod');
    const host = await mountApp();
    await settle(600);
    expect(await notices(host)).toContain(MOVED);
    const file = new File([readFileSync(join(here, 'services/__fixtures__/rocksimTestRocket1.rkt'), 'utf8')], 'rocksimTestRocket1.rkt');
    const picker = input(host, 'Open a design file');
    Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
    await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })); });
    // Whether or not the design reads as saved (the case above), the file opens.
    const past = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Open without saving'));
    if (past) await act(async () => { past.click(); });
    await waitFor(() => (document.body.textContent ?? '').includes('FooBar Test'), 'the file to open');
    expect(await notices(host)).not.toContain(MOVED);
  }, 30000);
});
