// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { MotorLengthField } from './MotorLengthField.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('mount length field estimates and units', () => {
  it('updates the displayed room without overwriting a saved limit, and disables unavailable estimates', () => {
    localStorage.clear();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const commits: (number | undefined)[] = [];
    const render = (lengthM: number | null) => act(() => root.render(<PrefsProvider>
      <MotorLengthField mountName="Core" value={0.6} onCommit={(v) => commits.push(v)}
        room={lengthM === null ? null : { lengthM, limitedBy: 'the bulkhead' }} />
    </PrefsProvider>));
    try {
      render(0.55);
      expect(host.textContent).toContain('Room for 550 mm');
      expect(host.querySelector('input')!.value).toBe('600');
      render(0.45);
      expect(host.textContent).toContain('Room for 450 mm');
      expect(commits).toEqual([]);
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="Estimate maximum motor length for Core"]')!.click());
      expect(commits).toEqual([0.45]);
      render(null);
      expect(host.textContent).toContain('No positive motor-room estimate');
      expect(host.querySelector<HTMLButtonElement>('[aria-label="Estimate maximum motor length for Core"]')!.disabled).toBe(true);
      // The shared unit selector changes display, never the SI setting.
      act(() => {
        const select = host.querySelector<HTMLSelectElement>('.unit-chip')!;
        select.value = 'in';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(Number(host.querySelector('input')!.value)).toBeCloseTo(0.6 / 0.0254, 2);
      expect(commits).toEqual([0.45]);
    } finally {
      act(() => root.unmount());
      host.remove();
      localStorage.clear();
    }
  });
});
