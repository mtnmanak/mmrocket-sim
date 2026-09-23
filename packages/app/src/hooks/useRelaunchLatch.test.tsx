// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRelaunchLatch } from './useRelaunchLatch.js';

/**
 * "Try Auto & re-fly" (audit 2026-09-22, the 8 September still-open list): the
 * request was cleared only when it launched, so a rebuild with nothing to fly
 * left it armed, and a Launch nobody pressed fired the next time the design
 * built with a motor loaded.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

function harness(launch: () => void) {
  const out = { request: () => {} };
  function Probe({ ready }: { ready: boolean }) {
    out.request = useRelaunchLatch(ready, launch);
    return null;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const show = (ready: boolean) => act(() => { root!.render(<Probe ready={ready} />); });
  return { out, show };
}

describe('useRelaunchLatch', () => {
  it('launches once on the render that carries the request when there is something to fly', () => {
    const launch = vi.fn();
    const h = harness(launch);
    h.show(true);
    act(() => h.out.request());
    expect(launch).toHaveBeenCalledTimes(1);
    h.show(true);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('drops a request the rebuild cannot fly, instead of firing it later', () => {
    const launch = vi.fn();
    const h = harness(launch);
    h.show(false);
    act(() => h.out.request());   // no motor, or the design did not build
    expect(launch).not.toHaveBeenCalled();
    h.show(true);                 // minutes later, a motor is loaded
    expect(launch).not.toHaveBeenCalled();
  });
});
