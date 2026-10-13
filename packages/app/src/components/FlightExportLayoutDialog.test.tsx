// @vitest-environment happy-dom
import { act } from 'react';
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
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); });
const click = (name: string) => act(() => Array.from(host.querySelectorAll('button')).find(b => b.textContent === name)!.click());

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
