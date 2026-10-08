// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MotorPicker } from './MotorPicker.js';
import { MotorStatusNote } from './MotorStatusNote.js';
import * as catalogueHook from './useCatalogue.js';
import { MOTOR_DB } from '../services/motorDb.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

it.each([
  ['5f4294d200023100000002e3', 'discontinued on 2020-01-25'],
  ['63bb643e1d26f30004b4b077', 'certified but, as of 2024-01-30, not released'],
  ['5f4294d20002310000000040', 'only the F25-9W delay/SKU'],
])('shows the note in the loaded-motor summary for %s', (motorId, text) => {
  act(() => root.render(<PrefsProvider><MotorPicker mountDiameterMm={98} maxMotorLengthM={null}
    selectedLabel="Loaded motor" selectedMotorId={motorId} onSelect={() => {}} showQuickPicks={false} />
  </PrefsProvider>));
  const note = host.querySelector('.motor-status-note');
  expect(note?.textContent).toContain(text);
  // The claim reads first; the sources follow it, each named by its forum post.
  expect(note?.querySelector('.motor-status-note-text')?.textContent?.endsWith('ThrustCurve.org still lists it as in production.')).toBe(true);
  const links = [...(note?.querySelectorAll('a') ?? [])];
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toMatch(/^TRF post \d+$/);
  }
  expect(note?.textContent?.indexOf('ThrustCurve.org')).toBeLessThan(note?.textContent?.indexOf('TRF post') ?? -1);
});

it.each([undefined, 'ex:custom', '5f4294d20002310000000034', '__proto__'])('has no note for %s', motorId => {
  act(() => root.render(<MotorStatusNote motorId={motorId} />));
  expect(host.innerHTML).toBe('');
});

it('removes the interim regular-status claim when the live catalogue changes', () => {
  const motorId = '5f4294d200023100000002e3';
  const hook = vi.spyOn(catalogueHook, 'useCatalogue').mockReturnValue(MOTOR_DB);
  act(() => root.render(<MotorStatusNote motorId={motorId} />));
  expect(host.textContent).toContain('Status note:');
  for (const availability of ['OOP', 'occasional']) {
    hook.mockReturnValue(MOTOR_DB.map(m => m.motorId === motorId ? { ...m, availability } : m));
    act(() => root.render(<MotorStatusNote motorId={motorId} />));
    expect(host.innerHTML).toBe('');
  }
});
