// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GuideDialog } from './GuideDialog.js';
import { GUIDE_SECTIONS } from '../data/userGuide.js';

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
