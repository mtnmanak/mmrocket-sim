// @vitest-environment happy-dom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { ChangelogDialog } from './ChangelogDialog.js';
import { GuideDialog } from './GuideDialog.js';
import { PreferencesDialog } from './PreferencesDialog.js';

/**
 * Audit 2026-09-22: a dialog's backdrop closed it on ANY click whose target
 * was the backdrop — and a click's target is the nearest element holding both
 * the press and the release. Select text in the guide, let the drag run off
 * the card's edge, and that element is the backdrop: the dialog closed under
 * the selection. Only a press AND a release on the backdrop itself close it.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let closed: number;

beforeEach(() => {
  localStorage.clear();
  closed = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const pointer = (el: Element, type: string) => act(() => {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true }));
});
/** What the browser sends for a press on `down` released over `up`. */
const gesture = (down: Element, up: Element, clickTarget: Element) => {
  pointer(down, 'pointerdown');
  pointer(up, 'pointerup');
  act(() => { clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};

const DIALOGS: [string, () => ReactElement][] = [
  ['the user guide', () => <GuideDialog onClose={() => { closed++; }} />],
  ['the changelog', () => <ChangelogDialog onClose={() => { closed++; }} />],
  ['preferences', () => <PrefsProvider><PreferencesDialog onClose={() => { closed++; }} /></PrefsProvider>],
];

describe.each(DIALOGS)('the backdrop of %s', (_name, dialog) => {
  const mount = () => act(() => root.render(dialog()));
  const backdrop = () => host.querySelector('.prefs-overlay')!;
  const inside = () => host.querySelector('[role="dialog"] h2')!;

  it('does not close when a text selection is dragged off the card', () => {
    mount();
    // Pressed on the heading, released on the backdrop: the click lands on
    // the backdrop, their nearest common ancestor.
    gesture(inside(), backdrop(), backdrop());
    expect(closed).toBe(0);
  });

  it('does not close when a press on the backdrop is released on the card', () => {
    mount();
    gesture(backdrop(), inside(), backdrop());
    expect(closed).toBe(0);
  });

  it('still closes on a click on the backdrop itself', () => {
    mount();
    gesture(backdrop(), backdrop(), backdrop());
    expect(closed).toBe(1);
  });
});
