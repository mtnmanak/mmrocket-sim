// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrefsProvider, usePrefs, type Preferences } from './PrefsContext.js';
import { printerFromPreset } from './printers.js';

/**
 * Loading stored preferences. The one that matters is MIGRATION SAFETY: a
 * blob written before the printer key existed must come back exactly as it
 * went in, with no printer configured — that unset state is what keeps the
 * 🖨 STL export byte-for-byte what it has always been.
 *
 * Rendered through react-dom's own root API with React's `act` — there is no
 * @testing-library in this workspace (see SiteBand.test.tsx).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STORAGE_KEY = 'online-openrocket.prefs.v1';

let host: HTMLDivElement;
let root: Root;
let seen: { prefs: Preferences; setPrefs: (p: Preferences) => void };

function Probe() {
  seen = usePrefs();
  return null;
}

const mount = () => act(() => root.render(<PrefsProvider><Probe /></PrefsProvider>));

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

describe('the printer preference round-trips', () => {
  it('a stored blob from before this feature loads unchanged, with no printer', () => {
    const old = {
      units: { length: 'in', mass: 'oz', distance: 'ft' },
      radiusMode: 'radius',
      theme: 'light',
      themeExplicit: true,
      aeroModel: 'supersonic',
      resultTiles: ['apogee', 'maxV'],
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(old));
    mount();
    expect(seen.prefs.printer).toBeUndefined();
    expect(seen.prefs.units.length).toBe('in');
    expect(seen.prefs.units.mass).toBe('oz');
    // Untouched quantities still fall back to the defaults, as before.
    expect(seen.prefs.units.pressure).toBe('mbar');
    expect(seen.prefs.radiusMode).toBe('radius');
    expect(seen.prefs.theme).toBe('light');
    expect(seen.prefs.aeroModel).toBe('supersonic');
    expect(seen.prefs.resultTiles).toEqual(['apogee', 'maxV']);
  });

  it('stores metres and reads metres back', () => {
    mount();
    act(() => seen.setPrefs({ ...seen.prefs, printer: printerFromPreset('prusa-mk4s')! }));
    // Persisted as metres — the millimetres a slicer quotes exist only in the
    // preset table and in display strings.
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Preferences;
    expect(raw.printer).toEqual({
      preset: 'prusa-mk4s', x: 0.25, y: 0.21, z: 0.22, margin: 0.008, clearance: 0.00015,
    });
    act(() => root.unmount());
    root = createRoot(host);
    mount();
    expect(seen.prefs.printer!.z).toBe(0.22);
  });

  it('clearing the printer leaves nothing behind', () => {
    mount();
    act(() => seen.setPrefs({ ...seen.prefs, printer: printerFromPreset('bambu-h2d')! }));
    act(() => seen.setPrefs({ ...seen.prefs, printer: undefined }));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).printer).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(host);
    mount();
    expect(seen.prefs.printer).toBeUndefined();
  });

  it('a half-parsed stored printer is dropped, not repaired', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      radiusMode: 'diameter',
      printer: { preset: 'bambu-h2d', x: 0.35, y: 0.32 },
    }));
    mount();
    expect(seen.prefs.printer).toBeUndefined();
    expect(seen.prefs.radiusMode).toBe('diameter');
  });

  it('unknown keys inside the printer survive (forward compat)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      printer: { preset: 'bambu-h2d', x: 0.35, y: 0.32, z: 0.325, nozzle: 0.6 },
    }));
    mount();
    expect((seen.prefs.printer as unknown as { nozzle: number }).nozzle).toBe(0.6);
    expect(seen.prefs.printer!.clearance).toBeCloseTo(0.00015, 12);
  });
});
