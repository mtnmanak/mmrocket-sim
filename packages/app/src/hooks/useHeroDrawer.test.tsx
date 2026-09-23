// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAWER_CLOSE_BELOW_PX, DRAWER_OPEN_ABOVE_PX } from '../components/heroDrawer.js';
import {
  HERO_CHIP_RESERVE, HERO_WIDE_QUERY, heroStageStyle, useHeroDrawer, type HeroDrawer,
} from './useHeroDrawer.js';

/**
 * THE ALL-STATS DRAWER AND THE HERO CANVAS (audit 2026-09-22, row 501 — the UI
 * hooks of extraction #8). statsDrawerDefault.test.ts held this as a regex
 * over App.tsx for the 981px literal; here the hook is rendered at each side
 * of the breakpoint, the window is dragged across it, and the drawer and the
 * stage are measured. The collapse THRESHOLDS are heroDrawer.test.ts's.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// A window whose width the test sets, and a ResizeObserver it can fire.
// ---------------------------------------------------------------------------

let width = 1200;
const queries = new Map<string, Set<(e: MediaQueryListEvent) => void>>();
const evaluate = (q: string): boolean => {
  const min = /\(min-width:\s*(\d+)px\)/.exec(q);
  const max = /\(max-width:\s*(\d+)px\)/.exec(q);
  if (min) return width >= Number(min[1]);
  if (max) return width <= Number(max[1]);
  return false;
};
const matchMedia = (q: string): MediaQueryList => {
  const listeners = queries.get(q) ?? new Set();
  queries.set(q, listeners);
  return {
    get matches() { return evaluate(q); },
    media: q,
    addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.add(l),
    removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.delete(l),
  } as unknown as MediaQueryList;
};
/** Drag the window to `w`: every query whose answer changed hears about it. */
const dragTo = (w: number) => {
  const before = new Map([...queries.keys()].map((q) => [q, evaluate(q)]));
  width = w;
  act(() => {
    for (const [q, ls] of queries) {
      if (evaluate(q) === before.get(q)) continue;
      for (const l of ls) l({ matches: evaluate(q), media: q } as MediaQueryListEvent);
    }
  });
};

let observers: { cb: () => void; live: boolean }[] = [];
class FiringResizeObserver {
  private entry: { cb: () => void; live: boolean };
  constructor(cb: () => void) { this.entry = { cb, live: true }; observers.push(this.entry); }
  observe() {}
  unobserve() {}
  disconnect() { this.entry.live = false; }
}
/** Every live observer reports a resize. */
const resize = () => act(() => { for (const o of observers) if (o.live) o.cb(); });

// Elements report the height their data-h attribute gives them (happy-dom lays
// nothing out, so offsetHeight and clientHeight are always 0 otherwise).
const saved: [object, string, PropertyDescriptor | undefined][] = [];
beforeAll(() => {
  for (const [proto, prop] of [[HTMLElement.prototype, 'offsetHeight'], [HTMLElement.prototype, 'clientHeight']] as const) {
    saved.push([proto, prop, Object.getOwnPropertyDescriptor(proto, prop)]);
    Object.defineProperty(proto, prop, {
      configurable: true,
      get(this: HTMLElement) { return Number(this.dataset?.['h'] ?? 0); },
    });
  }
});
afterAll(() => {
  for (const [proto, prop, d] of saved) if (d) Object.defineProperty(proto, prop, d);
});

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  width = 1200;
  queries.clear();
  observers = [];
  vi.stubGlobal('matchMedia', matchMedia);
  vi.stubGlobal('ResizeObserver', FiringResizeObserver);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

/**
 * App's shape: a stage the hook measures and, while the drawer is open, the
 * drawer inside it. `stageH` / `drawerH` are the heights they report.
 */
function mount(opts: { stageH?: number; drawerH?: number } = {}): { current: HeroDrawer } {
  const h = { current: undefined as unknown as HeroDrawer };
  function Probe() {
    const hero = useHeroDrawer();
    h.current = hero;
    return (
      <div ref={hero.stageRef} data-h={opts.stageH ?? 600}>
        {hero.open && <div ref={hero.drawerRef} data-h={opts.drawerH ?? 180} />}
      </div>
    );
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
  return h;
}

describe('useHeroDrawer — the breakpoint', () => {
  it('is the hero-canvas layout\'s own: 981px', () => {
    expect(HERO_WIDE_QUERY).toBe('(min-width: 981px)');
  });

  it('opens the drawer by default at 981px, where the canvas has room for it…', () => {
    width = 981;
    const h = mount();
    expect(h.current.wide).toBe(true);
    expect(h.current.open).toBe(true);
  });

  it('never overrules a drawer the user opened or closed themselves', () => {
    const h = mount();
    act(() => h.current.setByUser(false));
    dragTo(800);
    dragTo(1300);
    expect(h.current.open).toBe(false);
    // The layout still follows the window; only the drawer's state is theirs.
    expect(h.current.wide).toBe(true);
  });
});

describe('useHeroDrawer — the drawer lifts the drawing clear of itself', () => {
  it('measures the open drawer plus a 20px gap, and re-measures when it resizes', () => {
    const h = mount({ drawerH: 180 });
    expect(h.current.clearance).toBe(200);
    const drawer = host!.querySelector<HTMLElement>('[data-h="180"]')!;
    drawer.dataset['h'] = '240';
    resize();
    expect(h.current.clearance).toBe(260);
  });

  it('takes nothing while it is shut', () => {
    const h = mount({ drawerH: 180 });
    act(() => h.current.setByUser(false));
    expect(h.current.clearance).toBe(0);
  });

  it('takes nothing below the breakpoint, where it is a block under the canvas', () => {
    const h = mount({ drawerH: 180 });
    act(() => h.current.setByUser(true));
    dragTo(800);
    expect(h.current.open).toBe(true);
    expect(h.current.clearance).toBe(0);
  });
});

describe('useHeroDrawer — a canvas too short for the drawer', () => {
  it('puts the drawer away by itself, and marks the canvas tight', () => {
    const h = mount({ stageH: DRAWER_CLOSE_BELOW_PX - 1 });
    expect(h.current.open).toBe(false);
    expect(h.current.tight).toBe(true);
  });

  it('brings it back once the canvas has grown past the reopen height', () => {
    const h = mount({ stageH: DRAWER_CLOSE_BELOW_PX - 1 });
    const stage = host!.firstElementChild as HTMLElement;
    stage.dataset['h'] = String(DRAWER_OPEN_ABOVE_PX + 1);
    resize();
    expect(h.current.open).toBe(true);
    expect(h.current.tight).toBe(false);
  });

  it('leaves a drawer the user opened on a short canvas open', () => {
    const h = mount({ stageH: DRAWER_CLOSE_BELOW_PX - 1 });
    act(() => h.current.setByUser(true));
    resize();
    expect(h.current.open).toBe(true);
  });

  it('is never tight below the breakpoint, where the drawer costs the drawing nothing', () => {
    width = 800;
    const h = mount({ stageH: 100 });
    expect(h.current.tight).toBe(false);
  });
});

describe('the hero stage sizes to the drawing', () => {
  it('asks for rocket + chip headroom + the drawer, and publishes the drawer on its own', () => {
    const h = mount({ drawerH: 180 });
    expect(h.current.stageStyle).toBeUndefined(); // nothing reported yet: the pure CSS clamp
    act(() => h.current.setNatural(232));
    expect(h.current.stageStyle).toEqual({
      '--hero-natural': `${232 + HERO_CHIP_RESERVE + 200}px`,
      '--drawer-clearance': '200px',
    });
  });

  it('heroStageStyle: no natural height, no sizing', () => {
    expect(heroStageStyle(null, 200)).toBeUndefined();
    expect(heroStageStyle(0, 200)).toBeUndefined();
    expect(heroStageStyle(300, 0)).toEqual({ '--hero-natural': '440px', '--drawer-clearance': '0px' });
  });
});
