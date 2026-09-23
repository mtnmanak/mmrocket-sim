// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useFocusHandoff } from './useFocusHandoff.js';

/**
 * The Design tab's All-stats disclosure is two buttons that replace each
 * other: "▤ All stats" while the drawer is shut, "▾ Collapse" inside it while
 * it is open. Review of the audit 2026-09-22 branch, row 462: both carried
 * aria-expanded, but a press unmounted the button pressed, focus fell to
 * <body>, and no state change was ever heard. The harness has App's shape —
 * the chip and the drawer are never mounted together, and something other
 * than a press (the breakpoint, a short canvas) can open or close it too.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let setOpenFromOutside: (v: boolean) => void = () => {};
let rerender: () => void = () => {};
let handTo: (key: 'chip' | 'collapse') => void = () => {};

function Drawer() {
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  setOpenFromOutside = setOpen;
  rerender = () => setTick((t) => t + 1);
  const focus = useFocusHandoff<'chip' | 'collapse'>();
  handTo = focus.handTo;
  return (
    <>
      <input id="elsewhere" />
      {open ? (
        <div className="stats-drawer">
          <button id="collapse" ref={focus.refFor('collapse')} aria-expanded={true}
            onClick={() => { focus.handTo('chip'); setOpen(false); }}>▾ Collapse</button>
        </div>
      ) : (
        <button id="chip" ref={focus.refFor('chip')} aria-expanded={false}
          onClick={() => { focus.handTo('collapse'); setOpen(true); }}>▤ All stats</button>
      )}
    </>
  );
}

let host: HTMLDivElement;
let root: Root;
const byId = (id: string) => host.querySelector<HTMLElement>(`#${id}`);

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root.render(<Drawer />); });
});

afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
});

describe('useFocusHandoff — a disclosure whose halves replace each other', () => {
  it('lands focus on the half that replaced the one pressed, which says its state', () => {
    byId('chip')!.focus();
    act(() => { byId('chip')!.click(); });
    expect(document.activeElement, 'focus fell to <body> as the chip unmounted').toBe(byId('collapse'));
    expect(document.activeElement!.getAttribute('aria-expanded')).toBe('true');

    act(() => { byId('collapse')!.click(); });
    expect(document.activeElement).toBe(byId('chip'));
    expect(document.activeElement!.getAttribute('aria-expanded')).toBe('false');
  });

  it('never takes focus when the drawer opens or closes by itself', () => {
    byId('elsewhere')!.focus();
    act(() => { setOpenFromOutside(true); });
    expect(document.activeElement).toBe(byId('elsewhere'));
    act(() => { setOpenFromOutside(false); });
    expect(document.activeElement).toBe(byId('elsewhere'));
  });

  it('lets a handoff lapse when its target does not mount in that commit', () => {
    // Asked for the Collapse button, but the drawer stayed shut (the shape of
    // a press that changes nothing): the request must not fire at the NEXT,
    // automatic open and pull focus out of the user's field.
    act(() => { handTo('collapse'); rerender(); });
    expect(byId('collapse')).toBeNull();
    byId('elsewhere')!.focus();
    act(() => { setOpenFromOutside(true); });
    expect(document.activeElement).toBe(byId('elsewhere'));
  });
});
