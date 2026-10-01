// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { useOnline } from './useOnline.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * hooks/useOnline.ts. The test moved here from services/net.test.ts with the
 * hook (2026-10-01), unchanged.
 */

describe('useOnline', () => {
  it('follows the browser’s offline and online events', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useOnline());
      return null;
    }
    act(() => root.render(createElement(Probe)));
    expect(seen.at(-1)).toBe(true);
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(seen.at(-1)).toBe(false);
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(seen.at(-1)).toBe(true);
    act(() => root.unmount());
    host.remove();
  });
});
