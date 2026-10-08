// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { MotorBrowser } from './MotorBrowser.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

it.each([
  ['D10W', 'AeroTech staff said D10W was discontinued on 2020-01-25.', '1956714'],
  ['K62N', 'certified but, as of 2024-01-30, not released', '2541951'],
  ['F25W', 'only the F25-9W delay/SKU', '2861212'],
  ['I364FJ', 'seasonal-production clause', '2861212'],
  ['H73J', 'names H73J for discontinuation', '2861212'],
])('shows the sourced status note when selecting %s', async (designation, text, post) => {
  await act(async () => root.render(<PrefsProvider>
    <MotorBrowser mountDiameterMm={98} maxMotorLengthM={null} onSelect={() => {}} onClose={() => {}} />
  </PrefsProvider>));
  const search = host.querySelector('input[type="search"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, designation);
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const row = [...host.querySelectorAll<HTMLTableRowElement>('tbody tr')]
    .find((tr) => tr.cells[0]?.textContent === designation && tr.cells[1]?.textContent === 'AeroTech');
  expect(row, designation).toBeTruthy();
  act(() => row!.click());
  const note = host.querySelector('.motor-status-note');
  expect(note?.textContent).toContain(text);
  expect(note?.textContent).toContain('ThrustCurve.org still lists it as in production.');
  expect(note?.querySelector(`a[href="https://www.rocketryforum.com/posts/${post}/"]`)).toBeTruthy();
});
