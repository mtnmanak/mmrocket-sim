// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FirstRunTour, shouldAutoStartTour } from './FirstRunTour.js';

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
      '<div data-tour="tree"></div>',
      '<div data-tour="canvas"></div>',
      '<button data-tour="motors-tab"></button>',
      '<button data-tour="launch"></button>',
      '<main data-tour="results-panel"></main>',
      '<button data-tour="guide"></button>',
    ].join('');
    document.body.appendChild(anchors);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    anchors.remove();
    localStorage.clear();
  });

  function mount(onSetTab: (t: 'design' | 'motors' | 'results') => void, onClose: () => void) {
    act(() => root.render(<FirstRunTour onSetTab={onSetTab} onClose={onClose} />));
  }

  async function settle() {
    // Let the rAF-deferred anchor measurement land.
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  }

  it('opens on step 1 with the counter, activates its tab, and highlights the anchor', async () => {
    const tabs: string[] = [];
    mount((t) => tabs.push(t), () => {});
    await settle();
    expect(host.querySelector('.tour-title')?.textContent).toBe('Build here');
    expect(host.querySelector('.tour-next')?.textContent).toContain('1 of 6');
    expect(tabs).toContain('design');
    expect(host.querySelector('.tour-ring')).toBeTruthy();
  });

  it('Next walks the steps and switches tabs for tab-bound stops', async () => {
    const tabs: string[] = [];
    mount((t) => tabs.push(t), () => {});
    await settle();
    const next = () => act(() => {
      (host.querySelector('.tour-next') as HTMLButtonElement).click();
    });
    next(); // → 2: canvas
    expect(host.querySelector('.tour-title')?.textContent).toBe('Check the drawing');
    next(); // → 3: motors tab
    expect(tabs).toContain('motors');
    next(); // → 4: launch (no tab)
    next(); // → 5: results
    expect(tabs).toContain('results');
    next(); // → 6: guide
    expect(host.querySelector('.tour-next')?.textContent).toBe('Done');
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
    for (let i = 0; i < 5; i++) {
      act(() => { (host.querySelector('.tour-next') as HTMLButtonElement).click(); });
    }
    act(() => { (host.querySelector('.tour-next') as HTMLButtonElement).click(); }); // Done
    expect(closed).toBe(true);
    expect(localStorage.getItem(TOUR_KEY)).toBe('done');
  });

  it('a missing anchor never loses the tour — the card centers, no ring', async () => {
    anchors.remove(); // no data-tour elements anywhere
    mount(() => {}, () => {});
    await settle();
    expect(host.querySelector('.tour-card')).toBeTruthy();
    expect(host.querySelector('.tour-ring')).toBeFalsy();
  });
});
