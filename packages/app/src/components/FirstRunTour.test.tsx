// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { clearTourDone, FirstRunTour, shouldAutoStartTour } from './FirstRunTour.js';
import { WorkspaceBar } from './WorkspaceBar.js';
import { PrefsProvider, usePrefs } from '../prefs/PrefsContext.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOUR_KEY = 'online-openrocket.tour.v1';

describe('shouldAutoStartTour', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  const base = { tourOff: false, hasShare: false, hasSession: false };

  it('starts on a genuine first run', () => {
    expect(shouldAutoStartTour(base)).toBe(true);
  });

  it('never starts twice — the flag wins', () => {
    localStorage.setItem(TOUR_KEY, 'done');
    expect(shouldAutoStartTour(base)).toBe(false);
  });

  it('is suppressed by the Preferences opt-out', () => {
    expect(shouldAutoStartTour({ ...base, tourOff: true })).toBe(false);
  });

  it('is suppressed by an incoming share link', () => {
    expect(shouldAutoStartTour({ ...base, hasShare: true })).toBe(false);
  });

  it('clearTourDone re-arms it — what Preferences → On now does', () => {
    localStorage.setItem(TOUR_KEY, 'done');
    expect(shouldAutoStartTour(base)).toBe(false);
    clearTourDone();
    expect(shouldAutoStartTour(base)).toBe(true);
  });

  it('a re-arm outranks the restored-session check, or "On" is a dead option', () => {
    // By the time anyone can reach Preferences, a session exists — the
    // autosave writes one ~400 ms into the first visit. If hasSession still
    // won, asking for the tour back could never produce it.
    clearTourDone();
    expect(shouldAutoStartTour({ ...base, hasSession: true })).toBe(true);
    // But it does NOT outrank the two explicit refusals.
    expect(shouldAutoStartTour({ ...base, hasSession: true, tourOff: true })).toBe(false);
    expect(shouldAutoStartTour({ ...base, hasSession: true, hasShare: true })).toBe(false);
  });

  it('is suppressed by a restored session (not a new visitor)', () => {
    expect(shouldAutoStartTour({ ...base, hasSession: true })).toBe(false);
  });
});

describe('FirstRunTour', () => {
  let host: HTMLDivElement;
  let anchors: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    // Stand-ins for the app's data-tour anchors.
    anchors = document.createElement('div');
    anchors.innerHTML = [
      '<div data-tour="screen-mode"></div>',
      '<div data-tour="tree"></div>',
      '<div data-tour="canvas"></div>',
      '<button data-tour="motors-tab"></button>',
      '<button data-tour="launch"></button>',
      '<main data-tour="results-panel"></main>',
      '<button data-tour="guide"></button>',
    ].join('');
    document.body.appendChild(anchors);
    // happy-dom has no layout; visible anchors need a nonempty browser-like box.
    for (const anchor of anchors.children) {
      anchor.getBoundingClientRect = () => new DOMRect(40, 60, 80, 24);
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    anchors.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  function mount(onSetTab: (t: 'design' | 'motors' | 'results') => void, onClose: () => void) {
    act(() => root.render(<PrefsProvider><FirstRunTour onSetTab={onSetTab} onClose={onClose} /></PrefsProvider>));
  }

  async function settle() {
    // Let the rAF-deferred anchor measurement land.
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  }

  it('opens on screen mode with seven steps, leaves the home tab alone, and highlights the switch', async () => {
    const tabs: string[] = [];
    mount((t) => tabs.push(t), () => {});
    await settle();
    expect(host.querySelector('.tour-title')?.textContent).toBe('Light or dark?');
    expect(host.querySelector('.tour-next')?.textContent).toContain('1 of 7');
    expect(tabs).toEqual([]);
    expect(host.querySelector('.tour-ring')).toBeTruthy();
    expect(host.querySelectorAll('.tour-card [role="radio"]')).toHaveLength(3);
  });

  it('changes the screen immediately from step 1 and keeps the card open', () => {
    function Screen() {
      const { resolvedTheme, daylight } = usePrefs();
      return <div className="viz-root" data-theme={daylight ? 'light' : resolvedTheme}>
        <FirstRunTour onSetTab={() => {}} onClose={() => {}} />
      </div>;
    }
    act(() => root.render(<PrefsProvider><Screen /></PrefsProvider>));
    expect(host.querySelector('.viz-root')?.getAttribute('data-theme')).toBe('dark');
    act(() => host.querySelector<HTMLButtonElement>('.tour-card [role="radio"][aria-label="Light"]')!.click());
    expect(host.querySelector('.viz-root')?.getAttribute('data-theme')).toBe('light');
    expect(JSON.parse(localStorage.getItem('online-openrocket.prefs.v1')!)).toMatchObject({ theme: 'light', themeExplicit: true });
    expect(host.querySelector('.tour-card')?.getAttribute('aria-label')).toBe('Tour step 1 of 7: Light or dark?');
    act(() => host.querySelector<HTMLButtonElement>('.tour-next')!.click());
    expect(host.querySelector('.tour-title')?.textContent).toBe('Build here');
  });

  it('Next walks the steps and switches tabs for tab-bound stops', async () => {
    const tabs: string[] = [];
    mount((t) => tabs.push(t), () => {});
    await settle();
    const next = () => act(() => {
      (host.querySelector('.tour-next') as HTMLButtonElement).click();
    });
    expect(host.querySelector('.tour-card [role="radiogroup"]')?.getAttribute('aria-label')).toBe('Choose a screen mode');
    next(); // → 2: tree
    expect(host.querySelector('.tour-title')?.textContent).toBe('Build here');
    // F6: the choices belong to step 1 only.
    expect(host.querySelector('.tour-card [role="radiogroup"]')).toBeNull();
    expect(tabs).toContain('design');
    next(); // → 3: canvas
    expect(host.querySelector('.tour-title')?.textContent).toBe('Check the drawing');
    next(); // → 4: motors tab
    expect(tabs).toContain('motors');
    expect(host.textContent).toContain('Motors & Configuration');
    expect(host.textContent).toContain('shared by every configuration');
    // CFG-3: recovery and staging are set there too (ruling D2a).
    expect(host.textContent).toContain('when the chutes open and the stages separate');
    next(); // → 5: launch (no tab)
    expect(host.textContent).toContain('any tab');
    next(); // → 6: results
    expect(tabs).toContain('results');
    next(); // → 7: guide
    expect(host.querySelector('.tour-next')?.textContent).toBe('Done');
  });

  it('SHOWING it is what marks it seen — an ignored tour still counts', async () => {
    // The spotlight and scrim are pointer-events:none, so the app stays fully
    // usable behind the card: a visitor can ignore it and close the tab. When
    // the flag was written only by ×/Skip/Done/Escape, that visitor got the
    // tour again on every single visit.
    mount(() => {}, () => {});
    await settle();
    expect(localStorage.getItem(TOUR_KEY)).toBe('done');
  });

  it('Skip closes and sets the seen flag so it never auto-shows again', async () => {
    let closed = false;
    mount(() => {}, () => { closed = true; });
    await settle();
    act(() => { (host.querySelector('.tour-skip') as HTMLButtonElement).click(); });
    expect(closed).toBe(true);
    expect(localStorage.getItem(TOUR_KEY)).toBe('done');
  });

  it('finishing with Done sets the same flag', async () => {
    let closed = false;
    mount(() => {}, () => { closed = true; });
    await settle();
    for (let i = 0; i < 6; i++) {
      act(() => { (host.querySelector('.tour-next') as HTMLButtonElement).click(); });
    }
    act(() => { (host.querySelector('.tour-next') as HTMLButtonElement).click(); }); // Done
    expect(closed).toBe(true);
    expect(localStorage.getItem(TOUR_KEY)).toBe('done');
  });

  /**
   * Audit 2026-09-22: the tour declared itself aria-modal and trapped Tab while
   * the whole app stayed live behind it (spotlight and scrim are
   * pointer-events:none, on purpose), its step text was never announced, and it
   * painted over any dialog opened mid-tour.
   */
  describe('a NON-modal card', () => {
    const card = () => host.querySelector<HTMLElement>('.tour-card')!;
    const key = (k: string): boolean => {
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      act(() => { (document.activeElement ?? document).dispatchEvent(e); });
      return e.defaultPrevented;
    };

    it('is a dialog without aria-modal, described by its step text', async () => {
      mount(() => {}, () => {});
      await settle();
      expect(card().getAttribute('role')).toBe('dialog');
      expect(card().getAttribute('aria-modal')).toBeNull();
      const described = document.getElementById(card().getAttribute('aria-describedby') ?? '');
      expect(described?.textContent).toContain('Pick how the app looks.');
    });

    it('starts with focus in the card, and does not trap Tab', async () => {
      mount(() => {}, () => {});
      await settle();
      expect(card().contains(document.activeElement)).toBe(true);
      expect(document.activeElement).toBe(card().querySelector('.tour-close'));
      // The last button in the card: a trap would take Tab and wrap.
      const buttons = card().querySelectorAll<HTMLButtonElement>('button');
      act(() => { buttons[buttons.length - 1]!.focus(); });
      expect(key('Tab'), 'Tab was trapped in the card').toBe(false);
    });

    it('still closes on Escape', async () => {
      let closed = false;
      mount(() => {}, () => { closed = true; });
      await settle();
      expect(key('Escape')).toBe(true);
      expect(closed).toBe(true);
    });

    it('announces each new step', async () => {
      mount(() => {}, () => {});
      await settle();
      const region = () => host.querySelector('.tour-announce')!;
      expect(region().getAttribute('aria-live')).toBe('polite');
      act(() => { (host.querySelector('.tour-next') as HTMLButtonElement).click(); });
      expect(region().textContent).toBe(
        'Step 2 of 7: Build here. Every part of the rocket lives in this tree.'
        + ' Add and nest components — the drawing updates live.');
      act(() => { (host.querySelectorAll('.tour-skip')[1] as HTMLButtonElement).click(); }); // Back
      expect(region().textContent).toMatch(/^Step 1 of 7: Light or dark\?\. /);
    });

    it('steps aside under a dialog opened mid-tour, and comes back where it was', async () => {
      let closed = false;
      mount(() => {}, () => { closed = true; });
      await settle();
      act(() => { (host.querySelector('.tour-next') as HTMLButtonElement).click(); });
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.innerHTML = '<button id="in-dialog">OK</button>';
      await act(async () => { document.body.appendChild(dialog); await Promise.resolve(); });
      expect(card().hidden, 'the card painted over the dialog').toBe(true);
      expect(host.querySelector('.tour-ring')).toBeNull();
      // Escape belongs to the dialog, not to the tour hiding under it.
      act(() => { dialog.querySelector<HTMLButtonElement>('#in-dialog')!.focus(); });
      key('Escape');
      expect(closed).toBe(false);

      await act(async () => { dialog.remove(); await Promise.resolve(); });
      expect(card().hidden).toBe(false);
      expect(host.querySelector('.tour-title')?.textContent).toBe('Build here');
    });
  });

  it('a missing anchor never loses the tour — the card centers, no ring', async () => {
    anchors.remove(); // no data-tour elements anywhere
    mount(() => {}, () => {});
    await settle();
    expect(host.querySelector('.tour-card')).toBeTruthy();
    expect(host.querySelector('.tour-ring')).toBeFalsy();
  });

  it('F150 r3 follows Details/Less without a resize or scroll event', async () => {
    anchors.querySelector('[data-tour="launch"]')!.remove();
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ stickyWorkspaceBar: true, compactWorkspaceBar: true }));
    const observers: { notify: () => void; targets: Set<Element>; disconnect: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      entry = { notify: () => {}, targets: new Set<Element>(), disconnect: vi.fn() };
      constructor(notify: () => void) {
        this.entry.notify = notify;
        observers.push(this.entry);
      }
      observe = (target: Element) => { this.entry.targets.add(target); };
      unobserve = (target: Element) => { this.entry.targets.delete(target); };
      disconnect = () => { this.entry.disconnect(); this.entry.targets.clear(); };
    });
    act(() => root.render(<PrefsProvider><WorkspaceBar><div className="vitals-strip">
      <button data-tour="launch">Launch</button>
    </div></WorkspaceBar><FirstRunTour onSetTab={() => {}} onClose={() => {}} /></PrefsProvider>));
    const launch = host.querySelector<HTMLElement>('[data-tour="launch"]')!;
    const band = host.querySelector('.workspace-bar')!;
    const strip = host.querySelector('.vitals-strip')!;
    launch.getBoundingClientRect = () => band.classList.contains('workspace-bar-expanded')
      ? new DOMRect(40, 60, 80, 24) : new DOMRect(0, 0, 0, 0);
    for (let i = 0; i < 4; i++) act(() => { (host.querySelector('.tour-next') as HTMLButtonElement).click(); });
    await settle();
    expect(host.querySelector('.tour-ring')).toBeNull();
    // happy-dom has no layout notifications: deliver the browser's ResizeObserver
    // notification only to observers of the target or the changing summary strip.
    const notify = () => {
      for (const observer of observers) {
        if (observer.targets.has(launch) || observer.targets.has(strip)) observer.notify();
      }
    };
    const toggle = host.querySelector<HTMLButtonElement>('.workspace-summary-toggle')!;
    act(() => { toggle.click(); });
    act(notify);
    expect(host.querySelector<HTMLElement>('.tour-ring')?.style.width).toBe('90px');
    act(() => { toggle.click(); });
    act(notify);
    expect(host.querySelector('.tour-ring')).toBeNull();
    expect(host.querySelector('.tour-scrim')).not.toBeNull();
    const targetObserver = observers.find(observer => observer.targets.has(launch));
    expect(targetObserver?.targets.has(strip)).toBe(true);
    act(() => { (host.querySelector('.tour-next') as HTMLButtonElement).click(); });
    expect(targetObserver?.disconnect).toHaveBeenCalledOnce();
    // The next step's target lies outside the band (the strip still moves it when Details/Less toggles at scroll 0):
    // its observer watches the strip too.
    await settle();
    expect(observers.at(-1)?.targets.has(strip)).toBe(true);
  });

  it.each([
    ['screen-mode', 0], ['tree', 1], ['canvas', 2], ['motors-tab', 3], ['launch', 4], ['results-panel', 5], ['guide', 6],
  ] as const)('F150 r2 centers the card for an empty %s anchor and reanchors when shown', async (target, step) => {
    const anchor = anchors.querySelector(`[data-tour="${target}"]`)!;
    let rect = new DOMRect(0, 0, 0, 0);
    anchor.getBoundingClientRect = () => rect;
    mount(() => {}, () => {});
    for (let i = 0; i < step; i++) act(() => (host.querySelector('.tour-next') as HTMLButtonElement).click());
    await settle();
    const card = host.querySelector<HTMLElement>('.tour-card')!;
    for (const [width, height] of [[0, 0], [0, 24], [80, 0]]) {
      rect = new DOMRect(0, 0, width, height);
      act(() => { window.dispatchEvent(new Event('resize')); });
      expect(host.querySelector('.tour-ring')).toBeNull();
      expect(host.querySelector('.tour-scrim')).not.toBeNull();
      expect(card.style.left).toBe(`${Math.max(8, (document.documentElement.clientWidth - 300) / 2)}px`);
      const vh = document.documentElement.clientHeight;
      const cardH = target === 'screen-mode' ? 260 : 170;
      expect(card.style.top).toBe(`${Math.min(Math.max(8, vh * 0.3), Math.max(8, vh - cardH - 8))}px`);
    }
    rect = new DOMRect(40, 60, 80, 24);
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(host.querySelector<HTMLElement>('.tour-ring')?.style.width).toBe('90px');
    expect(host.querySelector('.tour-scrim')).toBeNull();
  });

  /**
   * Audit 2026-09-22: the card's LEFT was clamped to the viewport and its
   * vertical position was not. An anchor taller than the room above it (the
   * tree panel on a short window), or one scrolled out of view, put the card
   * — Next button and all — past the top or bottom edge.
   */
  describe.each([['screen-mode', 0, 260], ['tree', 1, 170]] as const)('keeps the %s card on screen vertically', (target, step, CARD_H) => {
    const VH = 600;
    // An own property over the prototype's getter; deleting it restores that.
    beforeEach(() => {
      Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: VH });
    });
    afterEach(() => {
      delete (document.documentElement as unknown as Record<string, unknown>)['clientHeight'];
    });

    const anchorAt = (top: number, bottom: number) => {
      const tree = anchors.querySelector(`[data-tour="${target}"]`) as HTMLElement;
      tree.getBoundingClientRect = () =>
        ({ top, bottom, left: 10, right: 210, width: 200, height: bottom - top, x: 10, y: top }) as DOMRect;
    };
    const card = () => host.querySelector('.tour-card') as HTMLElement;
    const px = (v: string) => Number.parseFloat(v);
    const mountStep = () => {
      mount(() => {}, () => {});
      for (let i = 0; i < step; i++) act(() => host.querySelector<HTMLButtonElement>('.tour-next')!.click());
    };

    it('an anchor too tall to fit the card above it', async () => {
      anchorAt(20, 590); // placed above: bottom = 600 − 20 + 10 = 590, top edge at −160
      mountStep();
      await settle();
      expect(px(card().style.bottom)).toBeLessThanOrEqual(VH - CARD_H - 8);
      expect(px(card().style.bottom)).toBeGreaterThanOrEqual(8);
    });

    it('an anchor scrolled below the window', async () => {
      anchorAt(900, 950); // placed above: bottom = 600 − 900 + 10 = −290
      mountStep();
      await settle();
      expect(px(card().style.bottom)).toBeGreaterThanOrEqual(8);
    });

    it('an anchor scrolled above the window', async () => {
      anchorAt(-300, -200); // placed below: top = −200 + 10 = −190
      mountStep();
      await settle();
      expect(px(card().style.top)).toBeGreaterThanOrEqual(8);
      expect(px(card().style.top)).toBeLessThanOrEqual(VH - CARD_H - 8);
    });

    it('an anchor with room below still gets the card right under it', async () => {
      anchorAt(40, 80);
      mountStep();
      await settle();
      expect(px(card().style.top)).toBe(90);
    });
  });
});
