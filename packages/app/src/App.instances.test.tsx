// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import type { TreeHistory } from './hooks/useTreeHistory.js';
import * as treeModel from './tree/treeModel.js';
import * as files from './services/saveFile.js';
import { discardSession } from './services/session.js';
import { exportOrk } from './services/orkFile.js';
import { encodeShareFragment } from './services/shareLink.js';

let history: TreeHistory;
vi.mock('./hooks/useTreeHistory.js', async importOriginal => {
  const real = await importOriginal<typeof import('./hooks/useTreeHistory.js')>();
  return { ...real, useTreeHistory: (...args: Parameters<typeof real.useTreeHistory>) => {
    history = real.useTreeHistory(...args);
    return history;
  } };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const context = new Proxy({}, { get: (_t, key) => key === 'measureText' ? () => ({ width: 0 }) : () => undefined });
let host: HTMLDivElement;
let root: Root;

function excessiveTree(): RocketTree {
  let body: ComponentNode = { type: 'bodytube', id: 'deep' };
  for (let i = 0; i < 4; i++) body = { type: 'bodytube', children: [
    { type: 'podset', instanceCount: 32, children: [body] },
  ] };
  return { name: 'Oversized design', components: [{ type: 'stage', children: [body] }] };
}

beforeEach(() => {
  window.history.replaceState(null, '', window.location.pathname);
  localStorage.clear();
  localStorage.setItem('online-openrocket.workspace.v1', 'design');
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => context) as unknown as HTMLCanvasElement['getContext']);
  host = document.createElement('div'); document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  discardSession();
  window.history.replaceState(null, '', window.location.pathname);
  host.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear();
});
const mount = async () => { await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>)); };

const waitFor = async (check: () => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  }
  expect(check()).toBe(true);
};

it('S4a-1 shows the refused edit as a caution while keeping the rendered design', async () => {
  await mount();
  const before = history.tree;
  await act(async () => history.setTree(excessiveTree()));
  expect(history.tree).toBe(before);
  expect(host.querySelector('.notice-bar')?.textContent).toMatch(/expanded component instances.*10,000/);
  expect(host.querySelector('.notice-bar')?.textContent).toContain('That change was not applied: it would give the design');
  expect(host.querySelector('.notice-bar .message-caution')).not.toBeNull();
}, 30_000);

it('keeps a refused autosave intact, downloads the original and resumes only on New', async () => {
  const key = 'online-openrocket.session.v1';
  const original = JSON.stringify({ tree: excessiveTree(), savedAt: Date.now() });
  localStorage.setItem(key, original);
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: false }));
  const save = vi.spyOn(files, 'saveFile').mockResolvedValue({ kind: 'cancelled' });
  await mount();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)); });
  expect(localStorage.getItem(key)).toBe(original);
  expect(host.querySelector('.tour-card')).toBeNull();
  const button = [...host.querySelectorAll('button')].find(b => b.textContent === 'Download the autosaved design (.ork)')!;
  expect(button).toBeDefined();
  await act(async () => button.click());
  expect(save).toHaveBeenCalledWith(expect.stringContaining('Oversized design'), expect.objectContaining({ extensions: ['.ork'] }));
  expect(localStorage.getItem(key)).toBe(original);
  const newButton = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === '✕ New')!;
  await act(async () => newButton.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)); });
  expect(localStorage.getItem(key)).not.toBe(original);
  expect(host.textContent).not.toContain('Autosave is paused');
}, 30_000);

it.each(['duplicate', 'paste'] as const)('keeps selection after a refused %s', async operation => {
  await mount();
  const body = history.tree.components[0]!.children!.find(n => n.type === 'bodytube')!;
  await act(async () => history.setSelectedId(body.id!));
  const before = history.tree;
  const click = async (label: string) => {
    const button = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    expect(button).not.toBeNull();
    await act(async () => button.click());
  };
  if (operation === 'duplicate') {
    vi.spyOn(treeModel, 'duplicateNode').mockReturnValue({ tree: excessiveTree(), newId: 'deep' });
    await click(`Duplicate ${body.name}`);
  } else {
    await click(`Copy ${body.name}`);
    const copy = excessiveTree().components[0]!.children![0]!;
    copy.id = 'refused-copy';
    vi.spyOn(treeModel, 'cloneSubtree').mockReturnValue(copy);
    const paste = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Paste into'))!;
    expect(paste).toBeDefined();
    await act(async () => paste.click());
  }
  expect(history.tree).toBe(before);
  expect(history.selectedId).toBe(body.id);
  expect(host.querySelector('.notice-bar')?.textContent).toContain('That change was not applied');
}, 30_000);

it('S4a-1 refuses an autosave before initializing its old file identity', async () => {
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ tree: excessiveTree(),
    designFile: { name: 'OldOversized.ork', via: 'opened', format: 'ork' }, savedAt: Date.now() }));
  await mount();
  expect(history.tree.name).not.toBe('Oversized design');
  const expand = host.querySelector<HTMLButtonElement>('.notice-bar button[aria-expanded="false"]');
  if (expand) await act(async () => expand.click());
  expect(host.querySelector('.notice-bar')?.textContent).toMatch(/not restored.*10,000.*starter design/);
  expect(host.textContent).not.toContain('OldOversized.ork');
  expect(document.title).not.toContain('OldOversized');
}, 30_000);

it('holds a refused autosave until the startup share offer is accepted', async () => {
  const key = 'online-openrocket.session.v1';
  const original = JSON.stringify({ tree: excessiveTree(), savedAt: Date.now() });
  localStorage.setItem(key, original);
  const tree = { ...treeModel.defaultTree(), name: 'Startup linked design' };
  window.location.hash = await encodeShareFragment(exportOrk({ name: tree.name, tree }));
  await mount();
  await waitFor(() => host.textContent?.includes('This link opens') === true || history.tree.name === tree.name);
  // Wait beyond the autosave debounce so an unoffered link cannot silently win.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 650)); });
  expect(localStorage.getItem(key)).toBe(original);
  expect(host.querySelector('[role="dialog"][aria-label="Open design from link"]')).not.toBeNull();
  expect(history.tree.name).not.toBe(tree.name);
  expect(host.textContent).toContain('Download the autosaved design (.ork)');
  const open = [...host.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find(b => b.textContent?.includes(`Open “${tree.name}”`));
  expect(open).toBeDefined();
  await act(async () => open!.click());
  await waitFor(() => history.tree.name === tree.name && localStorage.getItem(key) !== original);
  expect(host.textContent).not.toContain('Autosave is paused');
}, 30_000);

it('prompts before leaving dirty starter edits while autosave is paused', async () => {
  const key = 'online-openrocket.session.v1';
  const original = JSON.stringify({ tree: excessiveTree(), savedAt: Date.now() });
  localStorage.setItem(key, original);
  await mount();
  const before = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(before);
  expect(before.defaultPrevented).toBe(false);
  await act(async () => history.setTree({ ...history.tree, name: 'Unsaved starter edits' }));
  const dirty = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(dirty);
  expect(dirty.defaultPrevented).toBe(true);
  expect(localStorage.getItem(key)).toBe(original);
  await act(async () => history.undo());
  const undone = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(undone);
  expect(undone.defaultPrevented).toBe(false);
}, 30_000);
