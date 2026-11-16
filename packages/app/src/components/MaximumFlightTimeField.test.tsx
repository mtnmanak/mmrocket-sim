// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { DEFAULT_CONDITIONS, type LaunchConditions } from '../services/launchConditions.js';
import { LaunchPanel } from './LaunchPanel.js';
import { MaximumFlightTimeField } from './MaximumFlightTimeField.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('129 exposes default seconds, decimal-aware edits, both clamps and the long-flight caution', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let stored = DEFAULT_CONDITIONS;
  function Panel() {
    const [value, setValue] = useState(DEFAULT_CONDITIONS);
    stored = value;
    return <PrefsProvider><LaunchPanel value={value} onChange={setValue} onLaunch={() => {}} simulating={false} canLaunch /></PrefsProvider>;
  }
  try {
    act(() => root.render(<Panel />));
    const label = [...host.querySelectorAll('label')].find(l => l.textContent?.startsWith('Maximum flight time'));
    expect(label).toBeDefined();
    const box = label!.control as HTMLInputElement;
    expect(box.value).toBe('1200');
    expect(host.textContent).toContain('The simulation stops here even if the rocket is still in the air');
    const type = (text: string) => act(() => {
      box.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    type('3600');
    expect(stored.maxFlightTimeS).toBe(3600);
    expect(host.textContent).not.toContain('Long flights take longer');
    type('3600,5');
    expect(stored.maxFlightTimeS).toBe(3600.5);
    expect(host.textContent).toContain('Long flights take longer to simulate and use more memory.');
    type('50000');
    expect(stored.maxFlightTimeS).toBe(14400);
    expect(host.textContent).toContain('clamped to 14400 s');
    type('0');
    expect(stored.maxFlightTimeS).toBe(1);
    expect(host.textContent).toContain('clamped to 1 s');
    type('-5');
    expect(stored.maxFlightTimeS).toBe(1);
    type('1200');
    expect(host.textContent).not.toContain('clamped');
  } finally { act(() => root.unmount()); host.remove(); }
});

it('129 steps stop at the real bounds and typed clamps settle on blur and refocus', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let stored: LaunchConditions = { ...DEFAULT_CONDITIONS, maxFlightTimeS: 30 };
  let replace!: (limit: number) => void;
  function Field() {
    const [value, setValue] = useState(stored);
    stored = value;
    replace = limit => setValue({ ...DEFAULT_CONDITIONS, maxFlightTimeS: limit });
    return <PrefsProvider><MaximumFlightTimeField value={value} onChange={setValue} /></PrefsProvider>;
  }
  try {
    act(() => root.render(<Field />));
    const box = host.querySelector('input')!;
    const step = (key: string) => {
      act(() => { box.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
    };
    act(() => box.focus());
    step('ArrowDown');
    expect(box.value).toBe('1');
    step('ArrowDown');
    expect(box.value).toBe('1');
    expect(stored.maxFlightTimeS).toBe(1);
    expect(host.textContent).not.toContain('clamped');
    act(() => box.blur());
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Decrement"]')!.click());
    expect(box.value).toBe('1');
    expect(host.textContent).not.toContain('clamped');
    act(() => replace(14400));
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Increment"]')!.click());
    act(() => box.focus());
    step('ArrowUp');
    expect(box.value).toBe('14400');
    expect(host.textContent).not.toContain('clamped');
    for (const [text, expected, wording] of [['50000', 14400, 'from 50000 s'], ['14400.001', 14400, 'just above 14400 s'],
      ['0.9999999', 1, 'just below 1 s'], ['14400.000000000001', 14400, '']] as const) {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, text);
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(box.getAttribute('aria-invalid')).toBe('true');
      if (wording) expect(host.textContent).toContain(wording);
      else expect(host.textContent).not.toContain('clamped');
      expect(stored.maxFlightTimeS).toBe(expected);
      act(() => box.blur());
      expect(Number(box.value)).toBe(expected);
      act(() => box.focus());
      expect(Number(box.value)).toBe(expected);
    }
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, '50000');
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.blur();
    });
    expect(host.textContent).toContain('clamped');
    act(() => replace(14400));
    expect(host.textContent).not.toContain('clamped');
    act(() => replace(3600));
    expect(box.value).toBe('3600');
    expect(host.textContent).not.toContain('clamped');
  } finally { act(() => root.unmount()); host.remove(); }
});
