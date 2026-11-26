// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrefsProvider, usePrefs } from '../prefs/PrefsContext.js';
import { DEFAULT_PREFS, type Preferences } from '../prefs/preferences.js';
import { ScreenModeSwitch } from './ScreenModeSwitch.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const KEY = 'online-openrocket.prefs.v1';
let root: Root;
let host: HTMLDivElement;
let seen: Preferences;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Probe() {
  seen = usePrefs().prefs;
  return <ScreenModeSwitch />;
}
function mount(prefs: Partial<Preferences> = {}, systemDark = false) {
  localStorage.setItem(KEY, JSON.stringify(prefs));
  vi.stubGlobal('matchMedia', () => ({ matches: systemDark, addEventListener() {}, removeEventListener() {} }));
  act(() => root.render(<PrefsProvider><Probe /></PrefsProvider>));
}
const radio = (name: string) => host.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="${name}"]`)!;

describe('ScreenModeSwitch', () => {
  it.each([
    ['dark', false, false, 'Dark'], ['light', false, false, 'Light'],
    ['system', true, false, 'Dark'], ['system', false, false, 'Light'],
    ['dark', false, true, 'Daylight'], ['light', false, true, 'Daylight'],
    ['system', true, true, 'Daylight'],
  ] as const)('selects %s, system dark=%s, daylight=%s', (theme, systemDark, daylight, selected) => {
    mount({ theme, themeExplicit: true, daylight }, systemDark);
    expect(host.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Screen mode');
    // F5: every segment carries its own icon (two of them show nothing else).
    const svgs = [...host.querySelectorAll('[role="radio"]')].map((el) => el.querySelector('svg')?.innerHTML ?? '');
    expect(svgs.every(Boolean)).toBe(true);
    expect(new Set(svgs).size).toBe(3);
    const radios = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios.map(el => el.getAttribute('aria-label'))).toEqual(['Dark', 'Light', 'Daylight']);
    expect(radios.filter(el => el.getAttribute('aria-checked') === 'true')).toEqual([radio(selected)]);
    expect(radios.filter(el => el.tabIndex === 0)).toEqual([radio(selected)]);
    for (const el of radios) {
      expect(el.textContent).toBe(el === radio(selected) ? selected : '');
      expect(el.title).toContain(el.getAttribute('aria-label'));
    }
    expect(radio('Daylight').title).toContain('black on white at maximum contrast');
    expect(radio('Daylight').title).toContain('bright sunlight');
    if (theme === 'system' && !daylight) expect(radio(selected).title).toContain('Following your system setting');
  });

  it('leaves modified arrow and Home/End keys to the browser', () => {
    mount({ theme: 'dark', themeExplicit: true });
    const writes = vi.spyOn(localStorage, 'setItem');
    for (const [key, mod] of [['ArrowLeft', 'altKey'], ['ArrowRight', 'metaKey'], ['Home', 'ctrlKey'], ['End', 'ctrlKey']] as const) {
      const ev = new KeyboardEvent('keydown', { key, [mod]: true, bubbles: true, cancelable: true });
      act(() => { radio('Dark').dispatchEvent(ev); });
      expect(ev.defaultPrevented, `${mod}+${key}`).toBe(false);
    }
    expect(writes.mock.calls.filter(([key]) => key === KEY)).toEqual([]);
    expect(radio('Dark').getAttribute('aria-checked')).toBe('true');
  });

  it('takes a different group name when asked (the tour card\'s copy)', () => {
    localStorage.setItem(KEY, '{}');
    act(() => root.render(<PrefsProvider><ScreenModeSwitch tourAnchor /><ScreenModeSwitch label="Choose a screen mode" /></PrefsProvider>));
    expect([...host.querySelectorAll('[role="radiogroup"]')].map((g) => g.getAttribute('aria-label'))).toEqual(['Screen mode', 'Choose a screen mode']);
    expect(host.querySelectorAll('[data-tour="screen-mode"]')).toHaveLength(1);
  });

  it('keeps Dark as the first-run default', () => {
    mount();
    expect(radio('Dark').getAttribute('aria-checked')).toBe('true');
  });

  it.each(['Dark', 'Light', 'Daylight'])('writes exactly one preference update for %s', name => {
    mount({ theme: 'system', themeExplicit: true, daylight: name !== 'Daylight' }, name === 'Light');
    const before = seen;
    const writes = vi.spyOn(localStorage, 'setItem');
    act(() => radio(name).click());
    const expected = name === 'Daylight' ? { ...before, daylight: true }
      : { ...before, theme: name.toLowerCase(), themeExplicit: true, daylight: false };
    expect(writes.mock.calls.filter(([key]) => key === KEY)).toEqual([[KEY, JSON.stringify(expected)]]);
    expect(seen).toEqual(expected);
  });

  it.each(['Dark', 'Light', 'Daylight'])('does nothing when %s is already selected', name => {
    mount({ theme: name === 'Light' ? 'light' : 'dark', themeExplicit: true, daylight: name === 'Daylight' });
    const writes = vi.spyOn(localStorage, 'setItem');
    act(() => radio(name).click());
    expect(writes.mock.calls.filter(([key]) => key === KEY)).toEqual([]);
  });

  it('leaves system-following Daylight with an explicit fixed theme', () => {
    mount({ theme: 'system', themeExplicit: true });
    act(() => radio('Daylight').click());
    expect(seen.theme).toBe('system');
    act(() => radio('Light').click());
    expect(seen).toMatchObject({ theme: 'light', themeExplicit: true, daylight: false });
  });

  it.each([false, true])('leaves an already-selected system theme following the system (dark=%s)', systemDark => {
    mount({ theme: 'system', themeExplicit: true }, systemDark);
    const writes = vi.spyOn(localStorage, 'setItem');
    act(() => radio(systemDark ? 'Dark' : 'Light').click());
    expect(seen.theme).toBe('system');
    expect(writes.mock.calls.filter(([key]) => key === KEY)).toEqual([]);
  });

  it('does not create an explicit theme when choosing Daylight', () => {
    mount();
    act(() => radio('Daylight').click());
    expect(seen.theme).toBe('dark');
    expect(seen.themeExplicit).toBeUndefined();
    expect(seen.daylight).toBe(true);
  });

  it('persists Light through a fresh provider load', () => {
    mount();
    act(() => radio('Light').click());
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<PrefsProvider><Probe /></PrefsProvider>));
    expect(seen).toEqual({ ...DEFAULT_PREFS, theme: 'light', themeExplicit: true, daylight: false });
    expect(radio('Light').getAttribute('aria-checked')).toBe('true');
  });

  it('selects and focuses with arrows, wraps, supports Home/End, and has one Tab stop', () => {
    mount();
    const press = (key: string, expected: string) => {
      act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
      expect(document.activeElement).toBe(radio(expected));
      expect(radio(expected).getAttribute('aria-checked')).toBe('true');
      expect([...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].filter(el => el.tabIndex === 0)).toEqual([radio(expected)]);
    };
    act(() => radio('Dark').focus());
    press('ArrowRight', 'Light');
    press('ArrowDown', 'Daylight');
    press('ArrowRight', 'Dark');
    press('ArrowLeft', 'Daylight');
    press('ArrowUp', 'Light');
    press('Home', 'Dark');
    press('End', 'Daylight');
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => { radio('Daylight').dispatchEvent(tab); });
    expect(tab.defaultPrevented).toBe(false);
  });

  it('tracks system changes until a fixed mode is chosen', () => {
    let change: (event: { matches: boolean }) => void = () => {};
    vi.stubGlobal('matchMedia', () => ({ matches: false,
      addEventListener: (_: string, listener: typeof change) => { change = listener; }, removeEventListener() {} }));
    localStorage.setItem(KEY, JSON.stringify({ theme: 'system', themeExplicit: true }));
    act(() => root.render(<PrefsProvider><Probe /></PrefsProvider>));
    expect(radio('Light').getAttribute('aria-checked')).toBe('true');
    act(() => change({ matches: true }));
    expect(radio('Dark').getAttribute('aria-checked')).toBe('true');
    act(() => radio('Light').click());
    act(() => change({ matches: true }));
    expect(radio('Light').getAttribute('aria-checked')).toBe('true');
  });
});
