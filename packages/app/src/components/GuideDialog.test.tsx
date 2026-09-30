// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuideDialog } from './GuideDialog.js';
import { GUIDE_SECTIONS } from '../data/userGuide.js';
import { readFileSync } from 'node:fs';

/**
 * The in-app user guide, for a keyboard (audit 2026-09-22).
 *
 * Its scrolling <article> was not focusable. Nine of the twelve sections
 * contain no link, so nothing inside them could take focus either, and the
 * dialog's Tab trap wrapped from the last contents button straight back to
 * Close. A keyboard user could read only the first screen of each section —
 * of "Designing the Rocket", 58 KB, a fraction. And the contents list did not
 * say which section was showing.
 *
 * Rendered through react-dom's own root API with React's `act` (no
 * @testing-library in this workspace — see SiteBand.test.tsx).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const searchInput = () => host.querySelector<HTMLInputElement>('#guide-search')!;
const status = () => host.querySelector('[role="status"]')!.textContent;
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const typeSearch = (value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(searchInput(), value);
  searchInput().dispatchEvent(new Event('input', { bubbles: true }));
});
const enterSearch = (shiftKey = false, isComposing = false) => act(() => {
  searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey, isComposing, bubbles: true }));
});
const settleSearch = () => act(() => { vi.advanceTimersByTime(200); });

describe('GuideDialog search and glossary navigation', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('debounces case-insensitive whole-guide search without replacing the displayed text while typing', () => {
    open();
    const original = article().querySelector('h2');
    typeSearch('aPOGEE');
    expect(article().querySelector('h2')).toBe(original);
    expect(status()).toBe('Searching…');
    act(() => { vi.advanceTimersByTime(199); });
    expect(article().querySelector('mark')).toBeNull();
    settleSearch();
    const total = Number(status()!.split(' of ')[1]);
    expect(total).toBeGreaterThan(10);
    expect(status()).toBe(`1 of ${total}`);
    expect(article().querySelector('.guide-match-current')!.textContent!.toLowerCase()).toBe('apogee');
    expect(host.querySelector('label')!.htmlFor).toBe(searchInput().id);
    expect(host.querySelector('[role="status"]')!.getAttribute('aria-live')).toBe('polite');
  });

  it('steps, wraps in both directions, opens the matching section and scrolls without stealing input focus', () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    open();
    typeSearch('apogee');
    act(() => { searchInput().focus(); });
    enterSearch();
    const total = Number(status()!.split(' of ')[1]);
    expect(status()).toBe(`1 of ${total}`);
    enterSearch();
    expect(status()).toBe(`2 of ${total}`);
    settleSearch();
    expect(status()).toBe(`2 of ${total}`);
    act(() => { button('Previous match').click(); });
    expect(status()).toBe(`1 of ${total}`);
    enterSearch(true);
    expect(status()).toBe(`${total} of ${total}`);
    expect(article().getAttribute('aria-label')).toBe('Glossary');
    expect(tocButtons().find((b) => b.getAttribute('aria-current'))!.textContent).toBe('Glossary');
    expect(article().querySelector('.guide-match-current')).not.toBeNull();
    act(() => { button('Next match').click(); });
    expect(status()).toBe(`1 of ${total}`);
    expect(scroll).toHaveBeenCalledWith({ block: 'center' });
    expect(document.activeElement).toBe(searchInput());
  });

  it('uses the latest query, clears immediately, cancels pending work and handles zero matches', () => {
    open();
    typeSearch('apogee');
    act(() => { vi.advanceTimersByTime(100); });
    typeSearch('no-such-guide-term-xyz');
    act(() => { vi.advanceTimersByTime(100); });
    expect(article().querySelector('mark')).toBeNull();
    settleSearch();
    expect(status()).toBe('No matches');
    expect(button('Next match').disabled).toBe(true);
    expect(button('Previous match').disabled).toBe(true);
    enterSearch();
    expect(status()).toBe('No matches');
    typeSearch('apogee');
    settleSearch();
    expect(article().querySelector('mark')).not.toBeNull();
    typeSearch('rocket');
    expect(button('Next match').disabled).toBe(true);
    expect(button('Previous match').disabled).toBe(true);
    act(() => { button('Clear guide search').click(); });
    expect(searchInput().value).toBe('');
    expect(article().querySelector('mark')).toBeNull();
    expect(status()).toBe('');
    expect(document.activeElement).toBe(searchInput());
    settleSearch();
    expect(status()).toBe('');
    typeSearch('   ');
    expect(status()).toBe('');
  });

  it('moves the current highlight within a section without rebuilding its text', () => {
    open();
    typeSearch('the');
    enterSearch();
    const first = article().querySelector('.guide-match-current')!;
    const section = article().getAttribute('aria-label');
    enterSearch();
    expect(article().getAttribute('aria-label')).toBe(section);
    expect(first.isConnected).toBe(true);
    expect(first.classList.contains('guide-match-current')).toBe(false);
    expect(article().querySelector('.guide-match-current')).not.toBeNull();
  });

  it('waits for IME composition to end and ignores composing Enter', () => {
    open();
    typeSearch('rocket');
    act(() => { searchInput().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    settleSearch();
    expect(article().querySelector('mark')).toBeNull();
    typeSearch('apogee');
    enterSearch();
    settleSearch();
    expect(article().querySelector('mark')).toBeNull();
    act(() => { searchInput().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
    settleSearch();
    expect(article().querySelector('mark')!.textContent!.toLowerCase()).toBe('apogee');
    const count = status();
    enterSearch(false, true);
    expect(status()).toBe(count);
  });

  it('finds section titles and keeps highlighting after contents navigation', () => {
    open();
    typeSearch('Glossary');
    enterSearch(true);
    expect(article().getAttribute('aria-label')).toBe('Glossary');
    act(() => { tocButtons().find((b) => b.textContent === 'Glossary')!.click(); });
    expect(article().querySelector('h2 mark')!.textContent).toBe('Glossary');
  });

  it('provides A–Z links to the first entry, disabled missing letters, stable unique ids and keyboard focus', () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    open();
    act(() => { tocButtons().find((b) => b.textContent === 'Glossary')!.click(); });
    const nav = article().querySelector('nav[aria-label="Glossary letters"]')!;
    expect([...nav.children].map((el) => el.textContent).join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    const entries = [...article().querySelectorAll<HTMLElement>('p[id^="glossary-"]')];
    const markdown = readFileSync('user-guide.md', 'utf8');
    const terms = [...markdown.split('<a id="glossary"></a>')[1]!.matchAll(/^\*\*([^*]+)\*\* — /gm)].map((m) => m[1]);
    expect(terms.length).toBeGreaterThan(250);
    expect(entries.map((entry) => entry.querySelector('strong')!.textContent)).toEqual(terms);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    for (const item of [...nav.children]) {
      const first = entries.find((entry) => entry.textContent!.toUpperCase().startsWith(item.textContent!));
      if (first) expect(item.getAttribute('href')).toBe(`#${first.id}`);
      else {
        expect(item.tagName).toBe('SPAN');
        expect(item.getAttribute('aria-disabled')).toBe('true');
        expect(item.hasAttribute('href')).toBe(false);
      }
    }
    const f = nav.querySelector<HTMLAnchorElement>('[aria-label="Glossary: F"]')!;
    const destination = article().querySelector(f.getAttribute('href')!)!;
    const hash = location.hash;
    act(() => { f.click(); });
    expect(document.activeElement).toBe(destination);
    expect(scroll).toHaveBeenCalledWith({ block: 'start' });
    expect(location.hash).toBe(hash);
    typeSearch('apogee');
    enterSearch();
    act(() => { tocButtons().find((b) => b.textContent === 'Glossary')!.click(); });
    expect(article().querySelector(f.getAttribute('href')!)).not.toBeNull();
  });

  it('wraps Tab to Close after jumping to the Z glossary entry', () => {
    open();
    act(() => { tocButtons().find((b) => b.textContent === 'Glossary')!.click(); });
    const z = article().querySelector<HTMLAnchorElement>('[aria-label="Glossary: Z"]')!;
    act(() => { z.click(); });
    const destination = article().querySelector(z.getAttribute('href')!)!;
    expect(destination.querySelector('strong')!.textContent).toBe('Zippering');
    expect(destination.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(destination);

    expect(tab(), 'Tab must be prevented before native navigation leaves the modal').toBe(true);
    expect(document.activeElement).toBe(button('Close user guide'));
  });

  it('cancels a queued search on close', () => {
    open();
    typeSearch('rocket');
    act(() => { root.render(null); });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores ordinary keys and non-fragment clicks, and tolerates an absent anchor target', () => {
    open();
    typeSearch('apogee');
    act(() => { searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(article().querySelector('mark')).toBeNull();
    const paragraph = article().querySelector('p')!;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => { paragraph.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(false);
    const missing = document.createElement('a');
    missing.href = '#glossary-missing';
    article().append(missing);
    const absent = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => { missing.dispatchEvent(absent); });
    expect(absent.defaultPrevented).toBe(false);
  });
});

const open = () => act(() => { root.render(<GuideDialog onClose={() => {}} />); });
const article = () => host.querySelector<HTMLElement>('.guide-content')!;
const tocButtons = () => [...host.querySelectorAll<HTMLButtonElement>('.guide-toc-item')];
/** Tab as the document sees it, reporting whether the trap took the key. */
const tab = (): boolean => {
  const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  act(() => { document.dispatchEvent(e); });
  return e.defaultPrevented;
};

describe('GuideDialog — readable from the keyboard', () => {
  it('has sections to read, or these tests prove nothing', () => {
    expect(GUIDE_SECTIONS.length).toBeGreaterThan(1);
  });

  it('makes the section a focusable region named after the section', () => {
    open();
    expect(article().getAttribute('tabindex')).toBe('0');
    expect(article().getAttribute('role')).toBe('region');
    expect(article().getAttribute('aria-label')).toBe(GUIDE_SECTIONS[0]!.title);

    act(() => { tocButtons()[1]!.click(); });
    expect(article().getAttribute('aria-label')).toBe(GUIDE_SECTIONS[1]!.title);
  });

  it('lets Tab go on from the last contents button into the section, then wraps', () => {
    open();
    const last = tocButtons()[tocButtons().length - 1]!;
    act(() => { last.focus(); });
    // The trap used to take this key and wrap to Close; now the section is
    // after it, so the browser's own Tab carries on into the text.
    expect(tab(), 'the trap still wraps past the section').toBe(false);

    // In a section with no link the section itself is the dialog's last
    // stop, so Tab from it wraps to Close.
    const linkless = GUIDE_SECTIONS.findIndex((s) => !/<a\s/i.test(s.html));
    expect(linkless, 'every section has a link now — pick another case').toBeGreaterThan(-1);
    act(() => { tocButtons()[linkless]!.click(); });
    act(() => { article().focus(); });
    expect(document.activeElement).toBe(article());
    expect(tab()).toBe(true);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close user guide');
  });

  it('marks the section on show in the contents with aria-current', () => {
    open();
    const current = () => tocButtons().filter((b) => b.getAttribute('aria-current') === 'page');
    expect(current().map((b) => b.textContent)).toEqual([GUIDE_SECTIONS[0]!.title]);
    act(() => { tocButtons()[2]!.click(); });
    expect(current().map((b) => b.textContent)).toEqual([GUIDE_SECTIONS[2]!.title]);
  });
});
