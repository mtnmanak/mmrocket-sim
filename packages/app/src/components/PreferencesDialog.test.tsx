// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreferencesDialog } from './PreferencesDialog.js';
import { PrefsProvider, type Preferences } from '../prefs/PrefsContext.js';

/**
 * The 3D-printing section: picking a machine fills the build volume, typing
 * over any of it makes the machine "Custom", and every dimension goes through
 * the app's normal length plumbing — so a build volume typed in inches lands
 * in the store as metres, like every other length.
 *
 * Rendered through react-dom's own root API with React's `act` (no
 * @testing-library in this workspace — see SiteBand.test.tsx).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STORAGE_KEY = 'online-openrocket.prefs.v1';

let host: HTMLDivElement;
let root: Root;

const stored = (): Preferences => JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Preferences;

const printerSelect = (): HTMLSelectElement =>
  [...host.querySelectorAll('select')].find(
    (s) => [...s.options].some((o) => o.value === 'bambu-h2d'),
  ) as HTMLSelectElement;

const axis = (label: string): HTMLInputElement | null =>
  host.querySelector(`input[aria-label="${label}"]`);

const pick = (el: HTMLSelectElement, value: string) => act(() => {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
});

/** React tracks the last value it wrote; go through the native setter or the
 *  synthetic onChange never fires. */
const type = (el: HTMLInputElement, value: string) => act(() => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

const mount = () => act(() => root.render(
  <PrefsProvider><PreferencesDialog onClose={() => {}} /></PrefsProvider>,
));

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

describe('Preferences → 3D printing', () => {
  it('starts with no printer and no dimension fields at all', () => {
    mount();
    expect(printerSelect().value).toBe('');
    expect(axis('Bed X')).toBeNull();
    expect(axis('Maximum Z')).toBeNull();
  });

  it('picking a preset fills X/Y/Z, in millimetres on screen and metres in the store', () => {
    mount();
    pick(printerSelect(), 'prusa-mk4s');
    expect(axis('Bed X')!.value).toBe('250');
    expect(axis('Bed Y')!.value).toBe('210');
    expect(axis('Maximum Z')!.value).toBe('220');
    expect(stored().printer).toEqual({
      preset: 'prusa-mk4s', x: 0.25, y: 0.21, z: 0.22, margin: 0.008, clearance: 0.00015,
    });
  });

  it('editing any dimension switches the machine to Custom', () => {
    mount();
    pick(printerSelect(), 'bambu-h2d');
    expect(printerSelect().value).toBe('bambu-h2d');
    type(axis('Maximum Z')!, '400');
    expect(printerSelect().value).toBe('custom');
    expect(stored().printer!.preset).toBe('custom');
    expect(stored().printer!.z).toBeCloseTo(0.4, 12);
    // ...and the untouched axes keep the machine's numbers.
    expect(stored().printer!.x).toBeCloseTo(0.35, 12);
  });

  it('typing the preset numbers back in restores the machine', () => {
    mount();
    pick(printerSelect(), 'bambu-h2d');
    type(axis('Maximum Z')!, '400');
    type(axis('Maximum Z')!, '325');
    expect(printerSelect().value).toBe('bambu-h2d');
  });

  it('a build volume typed in inches is stored in metres', () => {
    // The whole reason the printer lives in SI: it rides the same siToUi /
    // uiToSi plumbing as every other length, so imperial works for free.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ units: { length: 'in' } }));
    mount();
    pick(printerSelect(), 'bambu-h2d');
    expect(Number(axis('Bed X')!.value)).toBeCloseTo(350 / 25.4, 3);
    type(axis('Bed X')!, '10');
    expect(stored().printer!.x).toBeCloseTo(0.254, 12);
    expect(stored().printer!.preset).toBe('custom');
  });

  it('joint clearance is editable and defaults to 0.15 mm', () => {
    mount();
    pick(printerSelect(), 'bambu-h2d');
    const clearance = host.querySelector('input[aria-label="Joint clearance"]') as HTMLInputElement;
    expect(clearance.value).toBe('0.15');
    type(clearance, '0.05');
    expect(stored().printer!.clearance).toBeCloseTo(0.00005, 12);
    // Tuning the glue gap is not a different machine.
    expect(stored().printer!.preset).toBe('bambu-h2d');
  });

  it('Not set removes the printer and the fields with it', () => {
    mount();
    pick(printerSelect(), 'bambu-h2d');
    pick(printerSelect(), '');
    expect(axis('Bed X')).toBeNull();
    expect(stored().printer).toBeUndefined();
  });
});
