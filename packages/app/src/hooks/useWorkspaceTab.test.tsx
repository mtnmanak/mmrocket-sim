// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HERO_WIDE_QUERY } from './useHeroDrawer.js';
import { homeTab, PHONE_QUERY, useWorkspaceTab, WORKSPACE_KEY, type WorkspaceTab } from './useWorkspaceTab.js';

/**
 * THE WORKSPACE TAB AND THE PHONE'S HOME SCREEN (audit 2026-09-22, row 501 —
 * the UI hooks of extraction #8). statsDrawerDefault.test.ts held the phone
 * breakpoint as a regex over App.tsx; here the hook is rendered on each side
 * of it.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A window `w` px wide, as matchMedia answers for it. */
const viewport = (w: number) => vi.stubGlobal('matchMedia', (q: string) => {
  const min = /\(min-width:\s*(\d+)px\)/.exec(q);
  const max = /\(max-width:\s*(\d+)px\)/.exec(q);
  return { matches: min ? w >= Number(min[1]) : max ? w <= Number(max[1]) : false } as MediaQueryList;
});

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => { localStorage.clear(); });
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(): { tab: WorkspaceTab; setTab: (t: WorkspaceTab) => void } {
  const h = {} as { tab: WorkspaceTab; setTab: (t: WorkspaceTab) => void };
  function Probe() {
    [h.tab, h.setTab] = useWorkspaceTab();
    return null;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
  return h;
}

describe('useWorkspaceTab', () => {
  it('opens a phone on Fly — 767px is a phone…', () => {
    viewport(767);
    expect(mount().tab).toBe('fly');
  });

  it('…and anything wider on Design', () => {
    viewport(768);
    expect(mount().tab).toBe('design');
  });

  it('keeps the phone rule apart from the desktop drawer\'s: a tablet is neither', () => {
    // 768–980 px: not a phone (Design is home) and not wide enough for the
    // drawer to overlay the canvas. One shared breakpoint would hand a phone
    // the desktop drawer, or a desktop the phone's home screen.
    expect(PHONE_QUERY).toBe('(max-width: 767px)');
    expect(PHONE_QUERY).not.toBe(HERO_WIDE_QUERY);
    viewport(900);
    expect(homeTab()).toBe('design');
    expect(matchMedia(HERO_WIDE_QUERY).matches).toBe(false);
  });

  it('comes back to the tab the user was working in, whatever the device', () => {
    localStorage.setItem(WORKSPACE_KEY, 'results');
    viewport(400);
    expect(mount().tab).toBe('results');
  });

  it('remembers a change of tab', () => {
    viewport(1200);
    const h = mount();
    act(() => h.setTab('motors'));
    expect(h.tab).toBe('motors');
    expect(localStorage.getItem(WORKSPACE_KEY)).toBe('motors');
  });

  it('ignores a stored value that is not a tab, and a storage that throws', () => {
    viewport(400);
    localStorage.setItem(WORKSPACE_KEY, 'cockpit');
    expect(mount().tab).toBe('fly');
    act(() => root!.unmount());
    root = null;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const h = mount();
    expect(h.tab).toBe('fly');
    act(() => h.setTab('design'));
    expect(h.tab).toBe('design');
  });

  it('has a home tab without matchMedia at all (a non-browser host)', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(homeTab()).toBe('design');
  });
});
