// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFirstRunTour, type FirstRunTourState } from './useFirstRunTour.js';
import type { WorkspaceTab } from './useWorkspaceTab.js';

/**
 * THE FIRST-RUN TOUR'S STATE (audit 2026-09-22, row 501 — the UI hooks of
 * extraction #8). Who gets the auto-start is FirstRunTour.test.tsx's
 * (shouldAutoStartTour); this is the state that rule starts, the preference
 * that stops it, and where it leaves the user.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  window.location.hash = '';
});

interface Props { tourOff: boolean; hasSession: boolean }

function mount(initial: Props): {
  current: FirstRunTourState; tabs: WorkspaceTab[]; rerender: (p: Props) => void;
} {
  const h = { tabs: [] as WorkspaceTab[] } as {
    current: FirstRunTourState; tabs: WorkspaceTab[]; rerender: (p: Props) => void;
  };
  const setTab = (t: WorkspaceTab) => { h.tabs.push(t); };
  function Probe(p: Props) {
    h.current = useFirstRunTour({ ...p, setTab });
    return null;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Probe {...initial} />));
  h.rerender = (p) => act(() => root!.render(<Probe {...p} />));
  return h;
}

describe('useFirstRunTour', () => {
  it('starts by itself for a first visit', () => {
    expect(mount({ tourOff: false, hasSession: false }).current.open).toBe(true);
  });

  it('does not start for a returning session, for someone who turned it off, or for a share link', () => {
    expect(mount({ tourOff: false, hasSession: true }).current.open).toBe(false);
    act(() => root!.unmount());
    expect(mount({ tourOff: true, hasSession: false }).current.open).toBe(false);
    act(() => root!.unmount());
    // That visitor came for a design: do not stand in front of it.
    window.location.hash = '#d=abc';
    expect(mount({ tourOff: false, hasSession: false }).current.open).toBe(false);
  });

  it('decides ONCE, at startup — a later render does not start it', () => {
    const h = mount({ tourOff: false, hasSession: true });
    h.rerender({ tourOff: false, hasSession: false });
    expect(h.current.open).toBe(false);
  });

  it('closes when the tour is turned off while it is on screen', () => {
    const h = mount({ tourOff: false, hasSession: false });
    expect(h.current.open).toBe(true);
    h.rerender({ tourOff: true, hasSession: false });
    expect(h.current.open).toBe(false);
  });

  it('still replays from ⟲ Tour for someone who turned the auto-tour off', () => {
    const h = mount({ tourOff: true, hasSession: true });
    act(() => h.current.start());
    expect(h.current.open).toBe(true);
    // Only the off-TRANSITION closes it; staying off does not.
    h.rerender({ tourOff: true, hasSession: true });
    expect(h.current.open).toBe(true);
  });

  it('lands on the device\'s home screen when it closes — Fly on a phone, Design elsewhere', () => {
    const phone = (w: number) => vi.stubGlobal('matchMedia',
      (q: string) => ({ matches: /max-width:\s*767px/.test(q) && w <= 767 }) as MediaQueryList);
    phone(400);
    const h = mount({ tourOff: false, hasSession: false });
    act(() => h.current.close());
    expect(h.current.open).toBe(false);
    phone(1200);
    act(() => h.current.start());
    act(() => h.current.close());
    expect(h.tabs).toEqual(['fly', 'design']);
  });
});
