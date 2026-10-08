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

async function pressActive(key: string, ctrlKey = false): Promise<void> {
  await act(async () => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true }));
  });
}

function selectedRow(host: HTMLElement): HTMLElement {
  return host.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')!;
}

function expectTreeFocus(host: HTMLElement): void {
  expect(document.activeElement === selectedRow(host)).toBe(true);
  expect(selectedRow(host).tabIndex).toBe(0);
  expect(host.querySelectorAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1);
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
    selectedRow(host).focus();
    await pressActive('z', true);
    expect(selectedLabel()).toBe('Body tube');
    expectTreeFocus(host);
    expect(button(host, '+ Add to Body tube')).toBeDefined();

    await pressActive('y', true);
    expect(selectedLabel()).toBe('Rail button');
    expectTreeFocus(host);
    expect(button(host, 'Auto-place rail buttons').disabled).toBe(false);

    await pressActive('z', true);
    expect(selectedLabel()).toBe('Body tube');
    await pressActive('ArrowUp');
    expect(selectedLabel()).toBe('Nose cone');
    expectTreeFocus(host);
  }, 30000);

  it('moves focus from the root to an undeleted part before navigating with arrows', async () => {
    const host = await addRailButton();
    // Keep the deletion separate from the preceding addition's coalescing window.
    await settle(850);
    const remove = host.querySelector<HTMLButtonElement>('[aria-label="Delete Rail button"]')!;
    remove.focus();
    await act(async () => { remove.click(); });
    expect(document.activeElement === host.querySelector('.tree-row-root')).toBe(true);
    await pressActive('z', true);
    expect(selectedRow(host).querySelector('.tree-label')?.textContent).toBe('Rail button');
    expectTreeFocus(host);
    await pressActive('y', true);
    expect(selectedRow(host).querySelector('.tree-label')?.textContent).toBe('Body tube');
    expectTreeFocus(host);
    await pressActive('z', true);
    await pressActive('ArrowUp');
    expect(selectedRow(host).querySelector('.tree-label')?.textContent).toBe('Parachute');
    expectTreeFocus(host);
  }, 30000);

  it('keeps focus on a row action when Undo and Redo keep the same selection', async () => {
    const host = await addRailButton();
    await settle(850);
    const move = host.querySelector<HTMLButtonElement>('[aria-label="Move Rail button up"]')!;
    move.focus();
    await act(async () => { move.click(); });
    await pressActive('z', true);
    expect(selectedRow(host).querySelector('.tree-label')?.textContent).toBe('Rail button');
    expect(document.activeElement === move).toBe(true);
    await pressActive('y', true);
    expect(document.activeElement === move).toBe(true);
  }, 30000);

  it.each(['property checkbox', 'canvas', 'toolbar button'])('preserves focus outside the tree on a %s', async (kind) => {
    const host = await addRailButton();
    const outside = document.createElement(kind === 'canvas' ? 'canvas' : kind === 'toolbar button' ? 'button' : 'input');
    if (outside instanceof HTMLInputElement) outside.type = 'checkbox';
    outside.tabIndex = 0;
    host.appendChild(outside);
    outside.focus();
    await pressActive('z', true);
    expect(selectedRow(host).querySelector('.tree-label')?.textContent).toBe('Body tube');
    expect(document.activeElement === outside).toBe(true);
    await pressActive('y', true);
    expect(selectedRow(host).querySelector('.tree-label')?.textContent).toBe('Rail button');
    expect(document.activeElement === outside).toBe(true);
    outside.remove();
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
