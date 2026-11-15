// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { OtherMountOffer } from './OtherMountOffer.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { INITIAL_UNITS, IMPERIAL_UNITS, noticeQuantity } from '../prefs/units.js';
import { testMotor } from '../services/autoDelay.testSupport.js';
import { noteField } from '../services/noteField.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => localStorage.clear());

it.each([INITIAL_UNITS, IMPERIAL_UNITS])('126 formats skipped motor dimensions in selected units (%j)', units => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units }));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const motor = { ...testMotor(), label: 'Motor\n\u202eName', spec: { ...testMotor().spec, diameter: 0.054, length: 0.405 } };
  const onLoad = vi.fn(), onUndo = vi.fn(), onDismiss = vi.fn();
  const plan = { targets: [{ id: '2', name: 'Mount\n\u202e2', replaces: 'Other\n\u202eMotor' }],
    skipped: [{ name: 'Narrow\n\u202e', reason: 'narrow' as const }, { name: 'Short\n\u202e', reason: 'short' as const, limit: 0.405 - 2e-9 }] };
  act(() => root.render(<PrefsProvider><OtherMountOffer motor={motor} plan={plan} loaded={false}
    onLoad={onLoad} onUndo={onUndo} onDismiss={onDismiss} /></PrefsProvider>));
  expect(host.textContent).toContain(`too narrow for ⌀${noticeQuantity('motorDimensions', 0.054, units)}`);
  expect(host.textContent).toContain(`too short for ${noticeQuantity('motorDimensions', 0.405, units, { against: plan.skipped[1]!.limit })}`);
  for (const t of plan.skipped) expect(host.textContent).toContain(noteField(t.name));
  expect(host.textContent).toContain(noteField(motor.label));
  expect(host.textContent).toContain(`${noteField(plan.targets[0]!.name)} (replaces ${noteField(plan.targets[0]!.replaces)})`);
  act(() => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(onLoad).toHaveBeenCalledOnce();
  act(() => root.render(<PrefsProvider><OtherMountOffer motor={motor} plan={plan} loaded={true}
    onLoad={onLoad} onUndo={onUndo} onDismiss={onDismiss} /></PrefsProvider>));
  expect(host.textContent).toContain(`Loaded ${noteField(motor.label)} into`);
  expect(host.textContent).not.toMatch(/[\n\u202e]/);
  act(() => root.unmount()); host.remove();
});

it('round 3 discloses each target delay policy in both the offer and receipt', () => {
  const host = document.createElement('div'); const root = createRoot(host);
  const motor = { ...testMotor(false, 10), label: 'K550W-10' };
  const plan = { targets: [{ id: '2', name: 'MMT 2', replaces: 'Previous', loadLabel: 'K550W (auto delay)' },
    { id: '3', name: 'MMT 3', loadLabel: 'K550W-7' }], skipped: [] };
  for (const loaded of [false, true]) {
    act(() => root.render(<PrefsProvider><OtherMountOffer motor={motor} plan={plan} loaded={loaded}
      onLoad={() => {}} onUndo={() => {}} onDismiss={() => {}} /></PrefsProvider>));
    expect(host.querySelector('p')!.textContent).not.toContain('-10');
    expect(host.textContent).toContain('K550W (auto delay)');
    expect(host.textContent).toContain('K550W-7');
  }
  act(() => root.unmount());
});
