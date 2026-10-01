// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App.js';
import { DEFAULT_CONDITIONS } from './components/LaunchPanel.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { loadCatalogueMotor } from './services/motorMatch.js';
import { addChild, defaultTree, motorMounts } from './tree/treeModel.js';
import { APP_VERSION } from './version.js';

/**
 * LAUNCH AND RE-FLY STATE, rendered (audit 2026-09-30, Step 2): what App hands
 * the flight runner when it flies and re-flies a design, and what it does with
 * what comes back. services/flightRunner.test.ts flies the protocol itself;
 * this is App's half — the build's refusals passed on, the gates on its buttons.
 *
 * The harness is App.render.test.tsx's: the real TeaVM kernel, the bundled
 * catalogue and curves, fetch stubbed to fail as offline.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no canvas, and a Launch lands on the Results tab's uPlot
// charts (the same stand-in App.session.test.tsx uses).
const ctx2d = new Proxy({}, {
  get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 0 }) : () => undefined),
});
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;

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
