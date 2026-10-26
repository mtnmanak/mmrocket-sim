import { PrefsProvider } from '../prefs/PrefsContext.js';
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { WarningCode, StaticWarning } from './WarningCode.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('explains static geometry codes and leaves uncoded sentences alone', () => {
  act(() => root.render(<><StaticWarning text={'[Warning.ZERO_AREA_FIN]:  "Freeform"'} />
    <StaticWarning text={'"Rail": at 0 degrees'} /></>));
  const code = host.querySelector<HTMLButtonElement>('button')!;
  expect(code.textContent).toBe('ZERO_AREA_FIN');
  expect(host.textContent).toContain('A fin has zero area and is ignored — : "Freeform"');
  expect(host.textContent).toContain('"Rail": at 0 degrees');
  expect(host.querySelectorAll('.warning-code')).toHaveLength(1);
  act(() => code.click());
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('fin outline');
});

it.each(['FutureWarning', 'constructor', '__proto__'])('keeps %s visible with an honest unknown-key explanation', code => {
  act(() => root.render(<WarningCode code={code} />));
  const trigger = host.querySelector<HTMLButtonElement>('button')!;
  trigger.focus();
  act(() => trigger.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain(code);
  expect(dialog.textContent).toContain('No explanation is available for this code');
  expect(dialog.textContent).toContain('original note');
  act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(host.querySelector('button'));
});

it('finds another code, explains it, handles no matches and clears immediately', () => {
  act(() => root.render(<WarningCode code="I03.left-out" />));
  act(() => host.querySelector<HTMLButtonElement>('button')!.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  const input = dialog.querySelector<HTMLInputElement>('input')!;
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  type('ZERO_AREA_FIN');
  expect(dialog.querySelectorAll('.warning-lookup-list button')).toHaveLength(1);
  act(() => dialog.querySelector<HTMLButtonElement>('.warning-lookup-list button')!.click());
  expect(dialog.querySelector('p.warning-lookup-code')!.textContent).toBe('ZERO_AREA_FIN');
  expect(dialog.textContent).toContain('fin outline');
  type('no-such-code');
  expect(dialog.querySelector('[role="status"]')!.textContent).toContain('No matching codes');
  act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="Clear note search"]')!.click());
  expect(input.value).toBe('');
  expect(document.activeElement).toBe(input);
  expect(dialog.querySelectorAll('.warning-lookup-list button').length).toBeGreaterThan(1);
});

it('orders the explanation list as well as the selected explanation by preference', () => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { velocity: 'ft/s' } }));
  try {
    act(() => root.render(<PrefsProvider><WarningCode code="HighSpeedDeployment" /></PrefsProvider>));
    act(() => host.querySelector<HTMLButtonElement>('button')!.click());
    const list = document.querySelector('.warning-lookup-list')!;
    const entry = [...list.querySelectorAll('button')].find(b => b.textContent?.includes('HighSpeedDeployment'))!;
    expect(entry.textContent).toContain('65.6 ft/s (20 m/s)');
  } finally { localStorage.clear(); }
});
