// @vitest-environment happy-dom
import { act, useState } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Window as HappyWindow } from 'happy-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PrefsProvider, usePrefs, type Preferences } from '../prefs/PrefsContext.js';
import { FlightExportLayoutDialog } from './FlightExportLayoutDialog.js';

const styles = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8');
const dom = (window as unknown as HappyWindow).happyDOM;
const originalViewport = { width: window.innerWidth, height: window.innerHeight };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let prefs: Preferences;
let stylesheet: HTMLStyleElement;
function Probe() { prefs = usePrefs().prefs; return null; }
beforeEach(() => { localStorage.clear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  stylesheet = document.createElement('style'); document.head.append(stylesheet); });
afterEach(() => { act(() => root.unmount()); host.remove(); stylesheet.remove(); dom.setWindowSize(originalViewport);
  localStorage.clear(); vi.unstubAllGlobals(); });
const click = (name: string) => act(() => Array.from(host.querySelectorAll('button')).find(b => b.textContent === name)!.click());

it.each([false, true])('N038 bounds the whole editor with scrolling when dvh support is %s', supportsDvh => {
  // happy-dom has no layout engine; exercise the cascade with unsupported declarations discarded.
  dom.setWindowSize({ width: 360, height: 320 });
  stylesheet.textContent = supportsDvh ? styles : styles.replace(/max-height:[^;]*dvh[^;]*;/g, '');
  act(() => root.render(<PrefsProvider><FlightExportLayoutDialog onClose={() => {}} /></PrefsProvider>));
  const editor = host.querySelector<HTMLInputElement>('input[aria-label="Layout name"]')!.closest('[role="dialog"]')!.firstElementChild as HTMLElement;
  if (!supportsDvh && editor.style.maxHeight.includes('dvh')) editor.style.removeProperty('max-height');
  const computed = getComputedStyle(editor);
  expect(computed.maxHeight).toBe(supportsDvh ? 'calc(100dvh - 76px)' : `calc(${window.innerHeight}px - 76px)`);
  expect(computed.overflowY).toBe('auto');
  expect(computed.overflowX).toBe('hidden');
  expect(editor.querySelector('input[aria-label="Layout name"]')).not.toBeNull();
  expect(editor.querySelectorAll('.comparison-controls select').length).toBeGreaterThanOrEqual(2);
  expect(editor.querySelector('.modal-actions')!.textContent).toContain('Save layout');
  expect(editor.querySelector('.modal-actions')!.textContent).toContain('Cancel');
});

it('N038 saves and closes a new layout without crypto.randomUUID on supported older clients', () => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
  function CreateLayout() {
    const [open, setOpen] = useState(true);
    return open ? <FlightExportLayoutDialog onClose={() => setOpen(false)} /> : null;
  }
  act(() => root.render(<PrefsProvider><Probe /><CreateLayout /></PrefsProvider>));
  const name = host.querySelector<HTMLInputElement>('input[aria-label="Layout name"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Ascent altitude');
    name.dispatchEvent(new Event('input', { bubbles: true }));
  });
  click('Clear columns');
  act(() => host.querySelector<HTMLInputElement>('input[aria-label="Export Altitude"]')!.click());
  click('Save layout');
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  const saved = JSON.parse(localStorage.getItem('online-openrocket.prefs.v1')!);
  expect(saved.flightExportLayouts).toHaveLength(1);
  expect(saved.flightExportLayouts[0]).toMatchObject({ name: 'Ascent altitude', columns: [{ key: 'altitude', unit: 'm' }] });
  expect(saved.flightExportLayouts[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(saved.flightExportLayoutId).toBe(saved.flightExportLayouts[0].id);
  act(() => root.unmount());
  root = createRoot(host);
  act(() => root.render(<PrefsProvider><Probe /></PrefsProvider>));
  expect(prefs.flightExportLayouts).toEqual(saved.flightExportLayouts);
  expect(prefs.flightExportLayoutId).toBe(saved.flightExportLayoutId);
});

it('N038 validates empty selections, preserves column order and units when editing, and saves event bounds', () => {
  const layout = { id: 'saved', name: 'Saved', columns: [{ key: 'time', unit: 's' }, { key: 'altitude', unit: 'ft' }], events: {} };
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ flightExportLayouts: [layout], flightExportLayoutId: 'saved' }));
  const close = vi.fn();
  act(() => root.render(<PrefsProvider><Probe /><FlightExportLayoutDialog layout={layout} onClose={close} /></PrefsProvider>));
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Move Altitude up"]')!.click());
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Move Altitude up"]')!.disabled).toBe(true);
  const select = Array.from(host.querySelectorAll('select')).find(s => s.parentElement!.textContent!.startsWith('End event'))!;
  act(() => { select.value = 'APOGEE'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  click('Save layout');
  expect(prefs.flightExportLayouts).toEqual([{ ...layout, columns: [...layout.columns].reverse(), events: { to: 'APOGEE' } }]);
  expect(close).toHaveBeenCalledTimes(1);
  click('Clear columns');
  click('Save layout');
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('select at least one column');
  expect(close).toHaveBeenCalledTimes(1);
  click('Cancel');
  expect(close).toHaveBeenCalledTimes(2);
});
