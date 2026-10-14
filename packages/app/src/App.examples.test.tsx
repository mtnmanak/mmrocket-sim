// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { DEFAULT_CONDITIONS } from './services/launchConditions.js';
import type { SessionState } from './services/session.js';
import { APP_VERSION } from './version.js';
import { loadExampleFile } from './data/exampleDesigns.js';
import { resolveImportMotors } from './services/importApply.js';

vi.mock('./data/exampleDesigns.js', async original => {
  const real = await original<typeof import('./data/exampleDesigns.js')>();
  return { ...real, loadExampleFile: vi.fn() };
});
vi.mock('./services/importApply.js', async original => {
  const real = await original<typeof import('./services/importApply.js')>();
  return { ...real, resolveImportMotors: vi.fn(real.resolveImportMotors) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const context = new Proxy({}, { get: (_t, prop) => prop === 'measureText' ? () => ({ width: 0 }) : () => undefined });
HTMLCanvasElement.prototype.getContext = (() => context) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;
let host: HTMLDivElement;
let root: Root;
const key = 'online-openrocket.session.v1';
const stored = () => JSON.parse(localStorage.getItem(key)!) as SessionState;
const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim().startsWith(text))!;
const click = async (text: string) => { await act(async () => { button(text).click(); }); };
const flush = () => { act(() => { window.dispatchEvent(new Event('pagehide')); }); };
async function until(predicate: () => boolean) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 8000) throw new Error('Example open did not settle');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  }
}
beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  localStorage.setItem(key, JSON.stringify({ tree: { name: 'Before example', components: [] }, launch: DEFAULT_CONDITIONS, appVersion: APP_VERSION, savedAt: Date.now() }));
  vi.mocked(loadExampleFile).mockResolvedValue(new File([readFileSync(resolve('src/data/examples/cluster.ork'))], 'cluster.ork'));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<PrefsProvider><App /></PrefsProvider>); });
});
afterEach(async () => { flush(); await act(async () => { root.unmount(); }); host.remove(); vi.unstubAllGlobals(); });

async function choose() {
  await click('Examples…');
  await until(() => !!host.querySelector('[aria-label="Example designs"] button') && !!button('Three-motor cluster'));
  await click('Three-motor cluster');
}

it('opens an example through normal motor resolution, with its conditions and comments', async () => {
  await choose();
  if (button('Open without saving')) await click('Open without saving');
  await until(() => !!host.querySelector<HTMLInputElement>('#rocket-name')?.value.includes('Three-motor cluster'));
  flush();
  expect(resolveImportMotors).toHaveBeenCalledOnce();
  expect(Object.values(stored().mountMotors!)).toHaveLength(1);
  expect(stored().launch.windAverage).toBe(0);
  expect(stored().tree.components[0]!['comment']).toContain('Three B6 motors');
  expect(stored().designFile?.name).toBe('cluster.ork');
});

it('protects edits, cancels without importing, and opens only after an explicit discard', async () => {
  const name = host.querySelector<HTMLInputElement>('#rocket-name')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Unsaved work');
    name.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await choose();
  expect(host.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull();
  expect(resolveImportMotors).not.toHaveBeenCalled();
  await click('Cancel');
  flush(); expect(stored().tree.name).toBe('Unsaved work');
  await choose(); await click('Open without saving');
  await until(() => host.querySelector<HTMLInputElement>('#rocket-name')?.value === 'Three-motor cluster');
  expect(resolveImportMotors).toHaveBeenCalledOnce();
});
