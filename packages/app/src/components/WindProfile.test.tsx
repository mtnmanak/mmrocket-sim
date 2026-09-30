// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { DEFAULT_CONDITIONS, LaunchField, type LaunchConditions } from './LaunchPanel.js';
import { WindProfile } from './WindProfile.js';
import { editProfileSurface } from '../services/windProfile.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it.each(['0.5', '0,5'])('keeps the aloft profile while typing %s character by character', (draft) => {
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  let value: LaunchConditions = { ...DEFAULT_CONDITIONS, windAverage: 4, windStdDev: 0.4,
    windLevels: [{ altitude: 10, speed: 4, direction: 0 }, { altitude: 1000, speed: 20, direction: 0.7 }],
    windProfileSource: { kind: 'ork' } };
  const commits: number[] = [];
  const render = () => root.render(<PrefsProvider><LaunchField label="Wind avg" field="windAverage"
    value={value} stepStored={1} min={0} onChange={(next) => { value = next; commits.push(next.windAverage); render(); }} /></PrefsProvider>);
  try {
    act(render);
    const input = host.querySelector<HTMLInputElement>('input')!;
    // LaunchField's unit selector lets the actual NumField commit in m/s.
    const select = host.querySelector<HTMLSelectElement>('select')!;
    act(() => { select.value = 'm/s'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    act(() => input.focus());
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    for (let i = 1; i <= draft.length; i++) {
      act(() => { set.call(input, draft.slice(0, i)); input.dispatchEvent(new Event('input', { bubbles: true })); });
      if (i === 1) expect(value.windLevels!.map((l) => l.speed)).toEqual([0, 0]);
    }
    expect(commits).toContain(0);
    expect(value.windAverage).toBe(0.5);
    expect(value.windLevels!.map((l) => l.speed)).toEqual([0.5, 2.5]);
    expect(value.windLevels![1]!.direction).toBe(0.7);
    expect(value.windProfileSource).toEqual({ kind: 'ork' });
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(value.windLevels!.map((l) => l.speed)).toEqual([0, 0]);
    act(() => input.blur());
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Increment"]')!.click());
    expect(value.windLevels!.map((l) => l.speed)).toEqual([1, 5]);
  } finally {
    act(() => root.unmount()); host.remove(); localStorage.clear();
  }
});

it.each([false, true])('offers a keyboard disclosure and Clear/Undo without an old rocket’s undo (calm: %s)', (calm) => {
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  const original: LaunchConditions = { ...DEFAULT_CONDITIONS, windAverage: 4,
    windLevels: [{ altitude: 10, speed: 4, direction: 0 }, { altitude: 1000, speed: 12, direction: Math.PI / 2 }],
    windProfileSource: { kind: 'open-meteo', place: 'Pad', validUnix: 1, surfaceFromDeg: 350 } };
  const initial = calm ? editProfileSurface(original, { ...original, windAverage: 0 }) : original;
  let value = initial;
  const render = () => root.render(<PrefsProvider><WindProfile value={value} onChange={(next) => { value = next; render(); }} /></PrefsProvider>);
  try {
    act(render);
    expect(host.textContent).toContain('Winds aloft: 2 levels to 3,281 ft');
    expect(host.querySelector('details > summary')!.textContent).toBe('View winds aloft');
    expect(host.querySelector('[role="region"]')!.getAttribute('tabindex')).toBe('0');
    expect(host.querySelectorAll('a')).toHaveLength(2);
    act(() => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(value.windLevels).toBeUndefined();
    expect(value.windProfileSource).toBeUndefined();
    expect(host.textContent).toContain('Undo clear winds aloft');
    act(() => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(value).toEqual(initial);
    if (calm) expect(editProfileSurface(value, { ...value, windAverage: 2 }).windLevels!.map((l) => l.speed)).toEqual([2, 6]);
    act(() => host.querySelector<HTMLButtonElement>('button')!.click());
    act(() => { value = { ...DEFAULT_CONDITIONS }; render(); });
    expect(host.textContent).not.toContain('Undo');
  } finally {
    act(() => root.unmount()); host.remove(); localStorage.clear();
  }
});
