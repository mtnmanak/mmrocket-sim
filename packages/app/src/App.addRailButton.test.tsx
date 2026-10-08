// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ComponentNode } from '@online-openrocket/engine';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import type { SessionState } from './services/session.js';

/**
 * "+ Add to Body tube" → "• Rail button", in the whole App (Eric, 2026-09-30:
 * "make new rail buttons default to an auto-placed pair"). The rule and its
 * fallback are pinned in railButtonPlacement.test.ts and addComponent.test.ts;
 * this is App's wiring: the pair is placed on the design as App builds it —
 * the starter C6 loaded, so the LOADED CG — and the add is one Ctrl+Z.
 * The same harness as App.session.test.tsx: the real TeaVM kernel, the bundled
 * starter motor, fetch stubbed to fail as offline.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ctx2d = new Proxy({}, {
  get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 0 }) : () => undefined),
});
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;

const SESSION_KEY = 'online-openrocket.session.v1';
let mounted: { root: Root; host: HTMLElement }[] = [];

const settle = async (ms = 0) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
async function waitFor(pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await settle(50);
  }
}
function stored(): SessionState {
  window.dispatchEvent(new Event('pagehide')); // flushes the debounced autosave
  return JSON.parse(localStorage.getItem(SESSION_KEY)!) as SessionState;
}
const flatten = (nodes: readonly ComponentNode[]): ComponentNode[] =>
  nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);
const railButtons = () => flatten(stored().tree.components).filter((n) => n.type === 'railbutton');
function button(host: HTMLElement, text: string): HTMLButtonElement {
  const b = [...host.querySelectorAll('button')].find((x) => x.textContent?.includes(text));
  if (!b) throw new Error(`no button "${text}"`);
  return b;
}

/** The starter rocket with its C6 on, and a Rail button added to its Body tube from the Add menu. */
async function addRailButton(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => { root.render(<PrefsProvider><App /></PrefsProvider>); });
  await waitFor(() => Object.keys(stored().mountMotors ?? {}).length > 0, 'the starter motor to be autosaved');
  const row = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    .find((r) => r.querySelector('.tree-label')?.textContent === 'Body tube')!;
  await act(async () => { row.click(); });
  await act(async () => { button(host, '+ Add to Body tube').click(); });
  const item = [...host.querySelectorAll<HTMLButtonElement>('.add-menu-item')]
    .find((b) => b.textContent?.includes('Rail button'))!;
  expect(railButtons()).toHaveLength(0);
  await act(async () => { item.click(); });
  await settle(50);
  return host;
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

describe('a Rail button added from the Add menu', () => {
  it('selects the parent on Undo and the restored part on Redo, with keyboard and properties usable', async () => {
    const host = await addRailButton();
    const selectedLabel = () => host.querySelector('[role="treeitem"][aria-selected="true"] .tree-label')?.textContent;
    expect(selectedLabel()).toBe('Rail button');
    await act(async () => { button(host, 'Undo').click(); });
    expect(selectedLabel()).toBe('Body tube');
    expect(button(host, '+ Add to Body tube')).toBeDefined();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
    });
    expect(selectedLabel()).toBe('Rail button');
    expect(button(host, 'Auto-place rail buttons').disabled).toBe(false);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    });
    expect(selectedLabel()).toBe('Body tube');
    const row = host.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')!;
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(selectedLabel()).toBe('Nose cone');
  }, 30000);

  it('is a pair, where 📍 Auto-place rail buttons puts it on the loaded rocket: pressing it moves nothing', async () => {
    const host = await addRailButton();
    const [added] = railButtons();
    expect(added!['instanceCount']).toBe(2);
    expect(added!['instanceSeparation'] as number).toBeGreaterThan(0.02);

    // The new part is selected; press the panel's own button on it.
    const autoPlace = button(host, 'Auto-place rail buttons');
    expect(autoPlace.disabled).toBe(false); // a disabled button's click would prove nothing
    await act(async () => { autoPlace.click(); });
    await settle(50);
    const [pressed] = railButtons();
    expect(pressed!.id).toBe(added!.id);
    expect(pressed!['instanceCount']).toBe(2);
    expect(pressed!.position!.method).toBe(added!.position!.method);
    expect(Math.abs(pressed!.position!.offset - added!.position!.offset)).toBeLessThan(1e-6);
    expect(Math.abs((pressed!['instanceSeparation'] as number) - (added!['instanceSeparation'] as number)))
      .toBeLessThan(1e-6);
  }, 30000);

  it('goes with one Undo, leaving the tube as it was', async () => {
    const host = await addRailButton();
    expect(railButtons()).toHaveLength(1);
    const tubeWith = flatten(stored().tree.components).find((n) => n.type === 'bodytube')!;
    const undo = button(host, '↩ Undo');
    expect(undo.disabled).toBe(false);
    await act(async () => { undo.click(); });
    await settle(50);
    expect(railButtons()).toHaveLength(0);
    const tube = flatten(stored().tree.components).find((n) => n.type === 'bodytube')!;
    expect(tube.children).toEqual(tubeWith.children!.filter((c) => c.type !== 'railbutton'));
  }, 30000);
});
