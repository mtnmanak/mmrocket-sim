// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRovingRows } from './useRovingRows.js';

/**
 * useRovingRows is what makes the motor and preset tables ONE tab stop each
 * (audits 2026-09-22 and 2026-09-30). Pinned here once, through a bare table,
 * so neither picker's own tests have to carry the whole contract: one stop,
 * where it sits, the arrows move it without activating, Enter/Space and a
 * click still activate, and a key aimed at a control inside a row is that
 * control's business.
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
  act(() => root.unmount());
  host.remove();
});

function Table({ keys, preferred, onActivate }: {
  keys: readonly string[];
  preferred?: string | null;
  onActivate: (k: string) => void;
}) {
  const { bodyRef, rove } = useRovingRows(keys, preferred);
  return (
    <table><tbody ref={bodyRef}>
      {keys.map((k, i) => (
        <tr key={`${k}|${i}`} data-key={k} {...rove(i, () => onActivate(k))}>
          <td>{k}</td>
          <td><button type="button">Details</button></td>
        </tr>
      ))}
    </tbody></table>
  );
}

const render = (keys: readonly string[], preferred?: string | null, onActivate = vi.fn()) => {
  act(() => root.render(<Table keys={keys} preferred={preferred} onActivate={onActivate} />));
  return onActivate;
};
const rows = () => [...host.querySelectorAll<HTMLTableRowElement>('tbody > tr')];
const stops = () => rows().filter((tr) => tr.tabIndex >= 0).map((tr) => tr.dataset['key']);
/** Dispatch a keydown and report whether its default was prevented. */
const key = (el: Element, k: string) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  act(() => { el.dispatchEvent(e); });
  return e.defaultPrevented;
};
const focus = (el: HTMLElement) => act(() => el.focus());

describe('useRovingRows — where the one tab stop sits', () => {
  it('makes the first row the only tab stop when nothing is preferred or focused', () => {
    render(['a', 'b', 'c']);
    expect(stops()).toEqual(['a']);
    expect(rows().slice(1).every((tr) => tr.tabIndex === -1)).toBe(true);
  });

  it('puts it on the preferred row (MotorBrowser’s picked motor), and on the first when that is not shown', () => {
    render(['a', 'b', 'c'], 'c');
    expect(stops()).toEqual(['c']);
    render(['a', 'b'], 'c');
    expect(stops()).toEqual(['a']);
  });

  it('follows the row last focused, over the preferred one, across a re-sort', () => {
    render(['a', 'b', 'c'], 'c');
    focus(rows()[1]!);
    expect(stops()).toEqual(['b']);
    render(['c', 'a', 'b'], 'c'); // the same rows, re-sorted
    expect(stops()).toEqual(['b']);
  });

  it('falls back when the focused row is filtered out', () => {
    render(['a', 'b', 'c'], 'c');
    focus(rows()[1]!);
    render(['a', 'c'], 'c');
    expect(stops()).toEqual(['c']);
    render(['a'], 'c');
    expect(stops()).toEqual(['a']);
  });

  it('makes one stop, not two, when two rows share a key', () => {
    render(['a', 'b', 'b']);
    focus(rows()[1]!);
    expect(rows().map((tr) => tr.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('renders an empty table without a stop or an error', () => {
    render([]);
    expect(rows()).toEqual([]);
  });
});

describe('useRovingRows — keys', () => {
  it('moves focus and the stop with ArrowDown/Up, Home and End, clamped at the ends, without activating', () => {
    const onActivate = render(['a', 'b', 'c', 'd']);
    focus(rows()[0]!);
    expect(key(rows()[0]!, 'ArrowDown'), 'the arrow does not scroll the table too').toBe(true);
    expect(document.activeElement).toBe(rows()[1]);
    expect(stops()).toEqual(['b']);
    key(rows()[1]!, 'End');
    expect(document.activeElement).toBe(rows()[3]);
    key(rows()[3]!, 'ArrowDown');
    expect(document.activeElement).toBe(rows()[3]);
    key(rows()[3]!, 'ArrowUp');
    expect(document.activeElement).toBe(rows()[2]);
    key(rows()[2]!, 'Home');
    expect(document.activeElement).toBe(rows()[0]);
    key(rows()[0]!, 'ArrowUp');
    expect(document.activeElement).toBe(rows()[0]);
    expect(stops()).toEqual(['a']);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('activates on Enter, Space and a click, as clickable() does', () => {
    const onActivate = render(['a', 'b']);
    expect(key(rows()[1]!, 'Enter')).toBe(true);
    expect(key(rows()[0]!, ' ')).toBe(true);
    act(() => rows()[1]!.click());
    expect(onActivate.mock.calls).toEqual([['b'], ['a'], ['b']]);
  });

  it('leaves every other key, Tab included, to the browser', () => {
    const onActivate = render(['a', 'b']);
    focus(rows()[0]!);
    for (const k of ['Tab', 'Escape', 'ArrowLeft', 'a']) expect(key(rows()[0]!, k), k).toBe(false);
    expect(document.activeElement).toBe(rows()[0]);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('leaves a key aimed at a control inside a row to that control', () => {
    const onActivate = render(['a', 'b']);
    const inner = rows()[0]!.querySelector('button')!;
    focus(inner);
    for (const k of ['ArrowDown', 'End', 'Enter', ' ']) expect(key(inner, k), k).toBe(false);
    expect(document.activeElement).toBe(inner);
    expect(onActivate).not.toHaveBeenCalled();
  });
});
