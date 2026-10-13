// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrefsProvider, usePrefs, type Preferences } from './PrefsContext.js';
import { printerFromPreset } from './printers.js';
import { INITIAL_UNITS, UNITS, type Quantity } from './units.js';
import { sessionDebugLog } from '../services/sessionDebugLog.js';

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
let seen: ReturnType<typeof usePrefs>;

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

describe('storage hardening: result tiles', () => {
  it.each(['eb', 'kbf', 'auto', 'supersonic', 'hybrid'] as const)('C-H3 exports the provider session aero override %s without persisting it', aeroOverride => {
    const stored = JSON.stringify({ aeroModel: 'supersonic', rogersKbf: false });
    localStorage.setItem(STORAGE_KEY, stored);
    mount();
    act(() => seen.setAeroOverride(aeroOverride));
    expect(sessionDebugLog.text()).toContain(`"aeroOverride":"${aeroOverride}"`);
    expect(sessionDebugLog.text()).toContain('"aeroModel":"supersonic"');
    expect(sessionDebugLog.text()).toContain('"rogersKbf":false');
    expect(localStorage.getItem(STORAGE_KEY)).toBe(stored);
    act(() => seen.setAeroOverride(null));
    expect(sessionDebugLog.text()).toContain('"aeroOverride":null');
    expect(localStorage.getItem(STORAGE_KEY)).toBe(stored);
  });

  it('C-H3 records a provider eb to kbf transition with unchanged stored preferences', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ aeroModel: 'supersonic' }));
    mount();
    act(() => seen.setAeroOverride('eb'));
    expect(sessionDebugLog.text()).toContain('"aeroOverride":"eb"');
    const before = sessionDebugLog.text().match(/preferences-changed/g)!.length;
    act(() => seen.setAeroOverride('kbf'));
    expect(sessionDebugLog.text()).toContain('"aeroOverride":"kbf"');
    expect(sessionDebugLog.text().match(/preferences-changed/g)).toHaveLength(before + 1);
    expect(seen.prefs.aeroModel).toBe('supersonic');
  });

  it('C-H3 follows current validated preferences without capturing unrelated stored fields', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ configurationSort: 'name', theme: 'light', themeExplicit: true,
      weatherSearch: 'Private weather place', latitude: 61.234 }));
    mount();
    expect(sessionDebugLog.text()).toContain('"configurationSort":"name"');
    act(() => seen.setPrefs({ ...seen.prefs, configurationSort: 'motor' }));
    expect(sessionDebugLog.text()).toContain('"configurationSort":"motor"');
    expect(sessionDebugLog.text()).not.toContain('Private');
    expect(sessionDebugLog.text()).not.toContain('61.234');
  });
  it.each(['creation', 'name', 'name-desc', 'motor', 'motor-desc'])('N011 retains configuration sort %s', configurationSort => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ configurationSort }));
    mount();
    expect(seen.prefs.configurationSort).toBe(configurationSort);
  });
  it.each([null, [], {}, 'unknown', 5])('N011 drops malformed configuration sort %j', configurationSort => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ configurationSort }));
    mount();
    expect(seen.prefs.configurationSort).toBeUndefined();
  });
  it('W2-WARN validates flight advice independently of other stored preferences', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ flightAdvisories: { maxMach: 0.8, maxAirspeedMs: 'fast', armingAltitudeM: -1 }, radiusMode: 'radius' }));
    mount();
    expect(seen.prefs.flightAdvisories).toEqual({ maxMach: 0.8 });
    expect(seen.prefs.radiusMode).toBe('radius');
  });
  it('S7d-3 drops unknown preference unions and keeps valid independent choices', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ aeroModel: 'unknown', theme: 'unknown', themeExplicit: true,
      radiusMode: 'unknown', markers3d: 'unknown', stabilityUnit: 'unknown', rogersKbf: false }));
    mount();
    expect(seen.prefs).toMatchObject({ theme: 'dark', radiusMode: 'diameter', rogersKbf: false });
    expect(seen.prefs.aeroModel).toBeUndefined();
    expect(seen.prefs.markers3d).toBeUndefined();
    expect(seen.prefs.stabilityUnit).toBeUndefined();
  });

  it.each(['classic', 'supersonic', 'auto', 'hybrid'])('S7d-3 retains supported aero choice %s', aeroModel => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ aeroModel, theme: 'system', themeExplicit: true,
      radiusMode: 'radius', markers3d: 'axis', stabilityUnit: 'both' }));
    mount();
    expect(seen.prefs).toMatchObject({ aeroModel, theme: 'system', radiusMode: 'radius', markers3d: 'axis', stabilityUnit: 'both' });
  });
  it.each([{}, null, 3, 'apogee', ['apogee', null]].map((v) => [v]))('drops malformed tile choices (%j)', (resultTiles) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ resultTiles, radiusMode: 'radius' }));
    mount();
    expect(seen.prefs.resultTiles).toBeUndefined();
    expect(seen.prefs.radiusMode).toBe('radius');
  });
  it.each([[], ['apogee', 'maxV']].map((v) => [v]))('preserves string tile lists (%j)', (resultTiles) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ resultTiles }));
    mount();
    expect(seen.prefs.resultTiles).toEqual(resultTiles);
  });
});

describe('N015: stored drag analysis inputs', () => {
  it.each([null, 'bad', [], 5].map((v) => [v]))('drops a malformed settings object (%j)', (dragAnalysis) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ dragAnalysis, radiusMode: 'radius' }));
    mount();
    expect(seen.prefs.dragAnalysis).toBeUndefined();
    expect(seen.prefs.radiusMode).toBe('radius');
  });

  it.each([0, -1, 4, 26, '25', null])('rejects an unsupported Mach range (%j), invalid inputs and extra saved data', (machMax) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ dragAnalysis: {
      machMax, conditions: 'unknown', altM: -1, mode: 'unknown', cpView: 'unknown',
      sweep: { machs: [1, 2] }, componentId: 'session-local-id',
    } }));
    mount();
    expect(seen.prefs.dragAnalysis).toEqual({
      machMax: 3, conditions: 'sealevel', altM: 0, mode: 'component', cpView: 'pct',
    });
  });

  it('rejects nonfinite altitude without discarding valid choices', () => {
    localStorage.setItem(STORAGE_KEY, '{"dragAnalysis":{"machMax":10,"altM":1e999,"conditions":"altitude","mode":"type","cpView":"unit"}}');
    mount();
    expect(seen.prefs.dragAnalysis).toEqual({
      machMax: 10, conditions: 'altitude', altM: 0, mode: 'type', cpView: 'unit',
    });
  });
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

describe('stored unit symbols (audit 2026-09-22)', () => {
  // unitDef falls back to a quantity's FIRST unit for a symbol it does not
  // know, while every label prints the stored symbol — so a stale or corrupt
  // one labelled one unit's numbers with another's name ("Max altitude
  // (furlong)" over metres, in the CSV headers among other places).
  it('a symbol the quantity does not know falls back to that quantity\'s default', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      units: { distance: 'furlong', mass: 42, length: 'in', velocity: 'km/h' },
    }));
    mount();
    expect(seen.prefs.units.distance).toBe(INITIAL_UNITS.distance);
    expect(seen.prefs.units.mass).toBe(INITIAL_UNITS.mass);
    // Known symbols are kept, whatever the default is.
    expect(seen.prefs.units.length).toBe('in');
    expect(seen.prefs.units.velocity).toBe('km/h');
  });

  it('every stored symbol is one its quantity can convert', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      units: Object.fromEntries(Object.keys(INITIAL_UNITS).map((q) => [q, 'nonsense'])),
    }));
    mount();
    for (const [q, sym] of Object.entries(seen.prefs.units)) {
      expect(UNITS[q as Quantity].some((u) => u.symbol === sym), `${q}: ${sym}`).toBe(true);
    }
  });
});
