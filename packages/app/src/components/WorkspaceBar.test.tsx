// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceBar } from './WorkspaceBar.js';
import { PrefsProvider, usePrefs } from '../prefs/PrefsContext.js';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let prefs: ReturnType<typeof usePrefs>;
let height: number;
let resize: () => void;
let disconnect: ReturnType<typeof vi.fn>;
let observe: ReturnType<typeof vi.fn>;
let tall: MediaQueryList;
let print: MediaQueryList;
let phone: MediaQueryList;
let unobserve: ReturnType<typeof vi.fn>;

function Probe() {
  prefs = usePrefs();
  return <WorkspaceBar><nav aria-label="Workspace">Design</nav></WorkspaceBar>;
}
function query(media: string, matches: boolean): MediaQueryList {
  return Object.assign(new EventTarget(), { media, matches }) as MediaQueryList;
}
const mount = () => act(() => root.render(<PrefsProvider><Probe /></PrefsProvider>));
const offset = () => document.documentElement.style.getPropertyValue('--workspace-bar-h');
const enable = (value: boolean) => act(() => prefs.setPrefs({ ...prefs.prefs, stickyWorkspaceBar: value }));

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  height = 124;
  tall = query('(min-height: 700px)', true);
  print = query('print', false);
  phone = query('(max-width: 767px)', false);
  vi.stubGlobal('matchMedia', (q: string) => q === tall.media ? tall : q === phone.media ? phone : q === 'print' ? print : query(q, false));
  disconnect = vi.fn();
  observe = vi.fn();
  unobserve = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe = observe;
    unobserve = unobserve;
    disconnect = disconnect;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ height }) as DOMRect);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('row 140: opts in to the class, measures wrapping, and resets the offset when off', () => {
  mount();
  expect(host.querySelector('.workspace-bar-sticky')).toBeNull();
  expect(offset()).toBe('0px');
  enable(true);
  expect(observe).toHaveBeenCalledWith(host.querySelector('.workspace-bar'));
  expect(host.querySelector('.workspace-bar-sticky nav[aria-label="Workspace"]')).not.toBeNull();
  expect(offset()).toBe('124px');
  height = 263;
  resize();
  expect(offset()).toBe('263px');
  enable(false);
  expect(host.querySelector('.workspace-bar-sticky')).toBeNull();
  expect(offset()).toBe('0px');
});

it('round r2: growing contents publish height before a parent scroll effect in the same commit', () => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ stickyWorkspaceBar: true }));
  const readings: string[] = [];
  function Parent({ expanded }: { expanded: boolean }) {
    useLayoutEffect(() => { readings.push(offset()); }, [expanded]);
    return <WorkspaceBar>{expanded && <div>More rocket readings</div>}<nav>Design</nav></WorkspaceBar>;
  }
  act(() => root.render(<PrefsProvider><Parent expanded={false} /></PrefsProvider>));
  height = 263;
  act(() => root.render(<PrefsProvider><Parent expanded /></PrefsProvider>));
  expect(readings).toEqual(['124px', '263px']);
  // No ResizeObserver callback was delivered between commits.
  expect(observe).toHaveBeenCalledTimes(1);
});

it('row 140: short windows and printing use zero, then restore the measured height', () => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ stickyWorkspaceBar: true }));
  Object.assign(tall, { matches: false });
  mount();
  expect(offset()).toBe('0px');
  Object.assign(tall, { matches: true });
  tall.dispatchEvent(new Event('change'));
  expect(offset()).toBe('124px');
  Object.assign(print, { matches: true });
  print.dispatchEvent(new Event('change'));
  expect(offset()).toBe('0px');
  Object.assign(print, { matches: false });
  print.dispatchEvent(new Event('change'));
  expect(offset()).toBe('124px');
  Object.assign(tall, { matches: false });
  tall.dispatchEvent(new Event('change'));
  expect(offset()).toBe('0px');
});

it('row 140: unmount disconnects measurement and media listeners and clears the page offset', () => {
  mount();
  enable(true);
  const tallRemove = vi.spyOn(tall, 'removeEventListener');
  const printRemove = vi.spyOn(print, 'removeEventListener');
  const phoneRemove = vi.spyOn(phone, 'removeEventListener');
  act(() => root.render(null));
  expect(disconnect).toHaveBeenCalled();
  expect(tallRemove).toHaveBeenCalledWith('change', expect.any(Function));
  expect(printRemove).toHaveBeenCalledWith('change', expect.any(Function));
  expect(phoneRemove).toHaveBeenCalledWith('change', expect.any(Function));
  expect(offset()).toBe('');
});

it('round r3: phones measure and observe only vitals, including Fly and width transitions', () => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ stickyWorkspaceBar: true }));
  Object.assign(phone, { matches: true });
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
    return { height: this.classList.contains('vitals-strip') ? height : 999 } as DOMRect;
  });
  const readings: string[] = [];
  function Parent({ fly }: { fly: boolean }) {
    useLayoutEffect(() => { readings.push(offset()); }, [fly]);
    return <WorkspaceBar>{!fly && <div className="vitals-strip">Rocket readings</div>}<nav>Design</nav></WorkspaceBar>;
  }
  const render = (fly: boolean) => act(() => root.render(<PrefsProvider><Parent fly={fly} /></PrefsProvider>));
  render(false);
  const band = host.querySelector('.workspace-bar');
  const vitals = host.querySelector('.vitals-strip');
  expect(offset()).toBe('124px');
  expect(observe).toHaveBeenCalledWith(vitals);
  expect(observe).not.toHaveBeenCalledWith(band);
  height = 263;
  resize();
  expect(offset()).toBe('263px');
  render(true);
  expect(offset()).toBe('0px');
  expect(unobserve).toHaveBeenCalledWith(vitals);
  render(false);
  expect(readings).toEqual(['124px', '0px', '263px']);
  expect(observe).toHaveBeenCalledWith(host.querySelector('.vitals-strip'));
  Object.assign(phone, { matches: false });
  phone.dispatchEvent(new Event('change'));
  expect(offset()).toBe('999px');
  expect(observe).toHaveBeenCalledWith(band);
  Object.assign(phone, { matches: true });
  phone.dispatchEvent(new Event('change'));
  expect(offset()).toBe('263px');
  expect(unobserve).toHaveBeenCalledWith(band);
  Object.assign(tall, { matches: false });
  tall.dispatchEvent(new Event('change'));
  expect(offset()).toBe('0px');
  Object.assign(tall, { matches: true });
  tall.dispatchEvent(new Event('change'));
  expect(offset()).toBe('263px');
  Object.assign(print, { matches: true });
  print.dispatchEvent(new Event('change'));
  expect(offset()).toBe('0px');
});

function mediaRules(media: string, after = 0): string {
  const start = css.indexOf(media, after);
  expect(start).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  let depth = 1;
  let end = open + 1;
  for (; depth && end < css.length; end++) {
    if (css[end] === '{') depth++;
    if (css[end] === '}') depth--;
  }
  return css.slice(open + 1, end - 1);
}

it('row 140: sticky is gated to tall screens, opaque in each theme, and below popovers', () => {
  const rules = mediaRules('@media screen and (min-height: 700px)');
  expect(rules).toMatch(/\.workspace-bar-sticky\s*\{[^}]*position:\s*sticky;/);
  expect(rules).toMatch(/top:\s*0;/);
  expect(rules).toMatch(/background:\s*var\(--surface-0\);/);
  expect(rules).toMatch(/z-index:\s*4;/);
  // No other rule may turn the band sticky, including print or short screens.
  expect(css.replace(rules, '')).not.toMatch(/\.workspace-bar-sticky\s*\{[^}]*position:\s*sticky/);
  const printRules = mediaRules('@media print');
  expect(printRules).toMatch(/\.workspace-bar-sticky\s*\{\s*position:\s*static;/);
  expect(printRules).toMatch(/html\s*\{\s*scroll-padding-top:\s*0;/);
  expect(css).toMatch(/html\s*\{[^}]*scroll-padding-top:\s*var\(--workspace-bar-h\);/);
});

it('round r2: tall phones retain fixed bottom tabs and their existing clearances', () => {
  const phone = mediaRules('@media (max-width: 767px)', css.indexOf('@media (min-width: 768px)'));
  expect(phone).toMatch(/\.workspace-tabs\s*\{[^}]*position:\s*fixed;[^}]*bottom:\s*0;/);
  expect(phone).toMatch(/\.workspace\s*\{[^}]*padding-bottom:\s*calc\(76px/);
  expect(css).not.toMatch(/\.workspace-bar-sticky\s+\.workspace-tabs\s*\{[^}]*position:/);
  expect(css).toMatch(/\.notice-bar\s*\{[^}]*bottom:\s*calc\(76px/);
  expect(css).toMatch(/\.mmr-band-footer\s*\{[^}]*padding-bottom:\s*calc\(76px/);
  expect(phone).toMatch(/\.workspace-bar\s*\{[^}]*margin-bottom:\s*0;/);
});

it('round r3: tall phone tabs escape the band stacking context while only vitals stick', () => {
  const tallRules = mediaRules('@media screen and (min-height: 700px)');
  const phone = mediaRules('@media (max-width: 767px)', css.indexOf('@media screen and (min-height: 700px)'));
  expect(tallRules).toContain(phone);
  expect(phone).toMatch(/\.workspace-bar-sticky\s*\{\s*display:\s*contents;\s*\}/);
  expect(phone).toMatch(/\.workspace-bar-sticky\s*>\s*\.vitals-strip\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*4;[^}]*background:\s*var\(--surface-0\);/);
  const bottomTabs = mediaRules('@media (max-width: 767px)', css.indexOf('@media (min-width: 768px)'));
  expect(bottomTabs).toMatch(/\.workspace-tabs\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*50;/);
});

it('round r2: one desktop tab border and the same content gap with summary or Fly tabs alone', () => {
  expect(css).toMatch(/\.workspace-bar\s*\{\s*margin-bottom:\s*12px;\s*\}/);
  const tabs = /\.workspace-tabs\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  expect(tabs).toMatch(/border-bottom:\s*2px solid var\(--border\);/);
  expect(tabs).not.toMatch(/margin-bottom:/);
  const bandRules = [...css.matchAll(/\.workspace-bar(?:-sticky)?\s*\{([^}]*)\}/g)];
  expect(bandRules.length).toBeGreaterThan(0);
  for (const rule of bandRules) expect(rule[1]).not.toMatch(/border(?:-bottom)?:/);
  // Neither spacing nor the single border depends on having a vitals child.
  expect(css).not.toMatch(/\.workspace-bar[^{}]*:has\(/);
});
