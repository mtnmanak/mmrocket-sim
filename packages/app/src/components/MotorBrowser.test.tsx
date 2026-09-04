// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MotorBrowser } from './MotorBrowser.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

/**
 * The motor database's sortable column headers.
 *
 * They carried `role="button"` alongside `aria-sort`. `aria-sort` is defined
 * only on a columnheader, so the role override made the attribute on that very
 * element inert — a screen reader said "Impulse (Ns), button" and never "sorted
 * descending", and got no feedback at all when the sort changed. Worse, with
 * all six headers no longer columnheaders the 400 data rows below lost their
 * column association, so arrowing through them stopped announcing which column
 * a cell was in.
 *
 * The fix keeps the tab stop and the Enter/Space handler and drops only the
 * role — the rule clickable.ts already states for the rest of the app.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('MotorBrowser — sortable headers stay column headers', () => {
  let host: HTMLDivElement;
  let root: Root;

  const headers = () => Array.from(host.querySelectorAll('thead th'));
  const impulse = () => headers()
    .find((th) => (th.textContent ?? '').includes('Impulse'))!;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(
      <PrefsProvider>
        <MotorBrowser mountDiameterMm={24} maxMotorLengthM={null}
          onSelect={() => {}} onClose={() => {}} />
      </PrefsProvider>,
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
  });

  it('sets no role, so the implicit columnheader survives', () => {
    expect(headers().length).toBe(6);
    for (const th of headers()) expect(th.getAttribute('role')).toBe(null);
  });

  it('keeps the tab stop that made sorting reachable in the first place', () => {
    for (const th of headers()) expect(th.getAttribute('tabindex')).toBe('0');
  });

  it('still sorts on Enter, and aria-sort now means something', () => {
    // Default sort is by impulse; activating its header flips the direction.
    const before = impulse().getAttribute('aria-sort');
    expect(before).not.toBeNull();
    act(() => {
      impulse().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(impulse().getAttribute('aria-sort')).not.toBe(before);
  });

  it('marks exactly one column as sorted', () => {
    expect(headers().filter((th) => th.hasAttribute('aria-sort')).length).toBe(1);
  });
});
