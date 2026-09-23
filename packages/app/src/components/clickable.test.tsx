// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickable } from './clickable.js';

/**
 * clickable() is what makes the motor rows, preset rows, component-tree rows
 * and schematic parts reachable without a mouse. It had no test of its own
 * (audit 2026-09-22, Tests row 481); every user of it relied on the same four
 * rules, pinned here once: a tab stop, click, Enter/Space on the row itself,
 * and hands off a key aimed at a control nested inside the row.
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

function renderRow(onActivate: () => void, onInner = vi.fn()) {
  act(() => root.render(
    <table><tbody>
      <tr data-testid="row" {...clickable(onActivate)}>
        <td>C6-5</td>
        <td><button type="button" onClick={onInner}>Details</button></td>
      </tr>
    </tbody></table>,
  ));
  return {
    row: host.querySelector('tr')!,
    inner: host.querySelector('button')!,
  };
}

/** Dispatch a keydown and report whether the default was prevented. */
function key(el: Element, k: string): boolean {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  act(() => { el.dispatchEvent(e); });
  return e.defaultPrevented;
}

describe('clickable', () => {
  it('gives a non-button element a tab stop and keeps its own role', () => {
    const { row } = renderRow(vi.fn());
    expect(row.tabIndex).toBe(0);
    expect(row.tagName).toBe('TR');
    expect(row.getAttribute('role')).toBeNull();
  });

  it('activates on click', () => {
    const fn = vi.fn();
    const { row } = renderRow(fn);
    act(() => row.click());
    expect(fn).toHaveBeenCalledOnce();
  });

  it('activates on Enter, Space and the legacy "Spacebar", and stops the page scrolling', () => {
    for (const k of ['Enter', ' ', 'Spacebar']) {
      const fn = vi.fn();
      const { row } = renderRow(fn);
      expect(key(row, k), k).toBe(true);
      expect(fn, k).toHaveBeenCalledOnce();
    }
  });

  it('ignores every other key, and leaves its default alone', () => {
    const fn = vi.fn();
    const { row } = renderRow(fn);
    for (const k of ['Tab', 'Escape', 'ArrowDown', 'a']) expect(key(row, k), k).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('leaves a key aimed at a nested control to that control', () => {
    const fn = vi.fn();
    const { inner } = renderRow(fn);
    // Enter on the row's own button bubbles to the row's handler, which must
    // not treat it as the row's activation or swallow the button's default.
    expect(key(inner, 'Enter')).toBe(false);
    expect(key(inner, ' ')).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});
