// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PrefsProvider, usePrefs, type Preferences } from '../prefs/PrefsContext.js';
import { FlightExportLayoutDialog } from './FlightExportLayoutDialog.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let prefs: Preferences;
function Probe() { prefs = usePrefs().prefs; return null; }
beforeEach(() => { localStorage.clear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); });
const click = (name: string) => act(() => Array.from(host.querySelectorAll('button')).find(b => b.textContent === name)!.click());

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
