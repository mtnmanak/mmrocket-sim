// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App.js';
import { DEFAULT_CONDITIONS } from './components/LaunchPanel.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { loadCatalogueMotor } from './services/motorMatch.js';
import type { MotorPicker } from './components/MotorPicker.js';
import { defaultTree } from './tree/treeModel.js';
import { APP_VERSION } from './version.js';

/**
 * A NOTE'S TIER COMES FROM ITS PRODUCER ON EVERY ROUTE (review of b9-int,
 * finding 11). The RASAero stated-weight reconcile flags a cleared override as
 * Caution (D7 I17); the open, a configuration switch and the open-motor answer
 * kept that tier, but a motor picked on Motors & Configuration, and Ctrl+Z /
 * Ctrl+Y re-running the reconcile, showed the same sentence as plain
 * Information. The harness is App.nozzle.test.tsx's: the real kernel and
 * catalogue, offline, with MotorPicker's props captured to pick a motor.
 */
let pickerProps: ComponentProps<typeof MotorPicker>;
vi.mock('./components/MotorPicker.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./components/MotorPicker.js')>();
  return { ...real, MotorPicker: (props: ComponentProps<typeof MotorPicker>) => {
    pickerProps = props;
    return createElement(real.MotorPicker, props);
  } };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

async function mountApp(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => { root.render(<PrefsProvider><App /></PrefsProvider>); });
  return host;
}

async function openTab(host: HTMLElement, name: string): Promise<void> {
  const b = [...host.querySelectorAll<HTMLButtonElement>('.workspace-tabs button')]
    .find((x) => x.textContent?.trim() === name);
  if (!b) throw new Error(`no tab "${name}"`);
  await act(async () => { b.click(); });
}

/** The reconcile's line on the notice bar, expanded. */
async function reconcileLine(host: HTMLElement): Promise<HTMLElement | undefined> {
  const toggle = host.querySelector<HTMLButtonElement>('.notice-toggle[aria-expanded="false"]');
  if (toggle) await act(async () => { toggle.click(); });
  const bar = host.querySelector('[aria-label="Notices"]');
  // A group's own line first: the group's item holds every line's text.
  const has = (el: HTMLElement) => !!el.textContent?.includes('mass and CG overrides have been cleared');
  return [...(bar?.querySelectorAll<HTMLElement>('.notice-line') ?? [])].find(has)
    ?? [...(bar?.querySelectorAll<HTMLElement>('.notice-item') ?? [])].find(has);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('online-openrocket.workspace.v1', 'design');
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
});

afterEach(async () => {
  window.dispatchEvent(new Event('pagehide'));
  for (const { root, host } of mounted) {
    await act(async () => { root.unmount(); });
    host.remove();
  }
  mounted = [];
  vi.unstubAllGlobals();
});

describe('the RASAero stated-weight reconcile on a motor pick and on Undo', () => {
  it('is Caution through the motor picker, and again when Ctrl+Z re-runs it', async () => {
    const tree = defaultTree();
    // A stage whose stated launch weight still holds a motor the catalogue never matched.
    Object.assign(tree.components[0]!, { overrideIncludesMotor: 'Z999TEST', overrideMass: 0.5,
      overrideSubcomponentsMass: true });
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      tree, mountMotors: {}, launch: DEFAULT_CONDITIONS, appVersion: APP_VERSION, savedAt: Date.now(),
    }));
    const host = await mountApp();
    await settle(50);
    await openTab(host, 'Motors & Configuration');
    const c6 = (await loadCatalogueMotor('Estes', 'C6', 5))!;
    await act(async () => { pickerProps.onSelect(c6.label, c6.spec, c6.meta); });
    await settle(50);
    let line = await reconcileLine(host);
    expect(line, 'the reconcile note on the bar').toBeDefined();
    expect(line!.className).toContain('message-caution');
    expect(line!.textContent).toContain('Caution:');

    // Dismissed, so what follows is Undo's own note and not this one left standing.
    const dismiss = line!.closest('.notice-item')!.querySelector<HTMLButtonElement>('.notice-dismiss')!;
    await act(async () => { dismiss.click(); });
    expect(await reconcileLine(host)).toBeUndefined();
    // Undo puts the marked tree back; the reconcile runs again under the C6.
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true })); });
    await settle(50);
    line = await reconcileLine(host);
    expect(line, 'the reconcile note after Undo').toBeDefined();
    expect(line!.className).toContain('message-caution');
    expect(line!.textContent).toContain('Caution:');
  }, 30000);
});
