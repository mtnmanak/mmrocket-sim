// @vitest-environment happy-dom
import { useState } from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDialog } from './useDialog.js';
import { NumField } from './NumField.js';

/**
 * Pins the modal contract shared by every role="dialog" in the app. Before this
 * hook there was not one Escape handler in the codebase and no .focus() call at
 * all, so dialogs could only be closed with the mouse and a keyboard user's next
 * Tab landed behind the dialog in a page they could not see.
 */

function Dialog({ onClose, label }: { onClose: () => void; label: string }) {
  const ref = useDialog<HTMLDivElement>(onClose);
  return (
    <div ref={ref} role="dialog" aria-label={label} tabIndex={-1}>
      <button>first</button>
      <button>last</button>
    </div>
  );
}

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button id="trigger" onClick={() => setOpen(true)}>open</button>
      {open && <Dialog label="Test dialog" onClose={() => setOpen(false)} />}
    </>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const press = (key: string, shiftKey = false) => {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  });
};

describe('useDialog', () => {
  it('skips controls disabled by an ancestor fieldset at the Tab boundary', () => {
    // happy-dom does not implement fieldset inheritance for :disabled. Adapt
    // that selector for this legend-free fixture; the trap still runs unchanged.
    const query = HTMLElement.prototype.querySelectorAll;
    vi.spyOn(HTMLElement.prototype, 'querySelectorAll').mockImplementation(function (this: HTMLElement, selector: string) {
      const items = query.call(this, selector);
      const branches = selector.split(',');
      return [...items].filter(el => branches.some(branch => el.matches(branch)
        && !(branch.includes(':not(:disabled)') && el.matches('button,input,select,textarea')
          && el.closest('fieldset[disabled]')))) as unknown as NodeListOf<Element>;
    });
    function Pending() {
      const ref = useDialog<HTMLDivElement>(() => {});
      return <div ref={ref} role="dialog" tabIndex={-1}>
        <fieldset disabled><input tabIndex={0} /><button>disabled</button><select /><textarea /></fieldset>
        <summary tabIndex={0}>ZIP preview</summary><button>last</button>
      </div>;
    }
    act(() => root.render(<Pending />));
    container.querySelector('summary')!.focus(); press('Tab', true);
    expect(document.activeElement?.textContent).toBe('last');
  });

  it('returns to the outer dialog when a nested opener becomes disabled', () => {
    function Outer() {
      const ref = useDialog<HTMLDivElement>(() => {});
      const [inner, setInner] = useState(false);
      const [disabled, setDisabled] = useState(false);
      return <div ref={ref} role="dialog" aria-label="outer" tabIndex={-1}>
        <button>Close outer</button>
        <button disabled={disabled} onClick={() => setInner(true)}>Open inner</button>
        {inner && <Dialog label="inner" onClose={() => { setDisabled(true); setInner(false); }} />}
      </div>;
    }
    act(() => root.render(<Outer />));
    const opener = container.querySelectorAll('button')[1]!;
    opener.focus(); act(() => opener.click()); press('Escape');
    expect(document.activeElement?.textContent).toBe('Close outer');
  });

  it('moves focus into the dialog on open and back to the trigger on close', () => {
    act(() => root.render(<Harness />));
    const trigger = container.querySelector<HTMLButtonElement>('#trigger')!;
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    act(() => trigger.click());
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).textContent).toBe('first');

    press('Escape');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on Escape', () => {
    act(() => root.render(<Harness />));
    act(() => container.querySelector<HTMLButtonElement>('#trigger')!.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    press('Escape');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('wraps Tab at the ends so focus cannot escape the dialog', () => {
    act(() => root.render(<Harness />));
    act(() => container.querySelector<HTMLButtonElement>('#trigger')!.click());
    const [first, last] = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'));

    // Forward off the end wraps to the first.
    act(() => last!.focus());
    press('Tab');
    expect(document.activeElement).toBe(first);

    // Backward off the start wraps to the last.
    press('Tab', true);
    expect(document.activeElement).toBe(last);
  });

  /**
   * Audit 2026-09-22: a NumField's ▴/▾ are tabIndex -1 — the browser never
   * tabs to them — but the trap counted them, so a trailing NumField's ▾ was
   * `last`. Tab from the real last control escaped the dialog, and Shift+Tab
   * from the first landed on ▾ (Enter there decremented the Preferences
   * dialog's joint clearance).
   */
  it('skips tabindex="-1" controls, so a trailing NumField spinner is never an end', () => {
    function Trailing({ onClose }: { onClose: () => void }) {
      const ref = useDialog<HTMLDivElement>(onClose);
      return (
        <div ref={ref} role="dialog" aria-label="Trailing" tabIndex={-1}>
          <button>first</button>
          <NumField value={1} onCommit={() => {}} ariaLabel="clearance" />
        </div>
      );
    }
    act(() => root.render(<Trailing onClose={() => {}} />));
    const first = container.querySelector<HTMLButtonElement>('button')!;
    const field = container.querySelector<HTMLInputElement>('input[aria-label="clearance"]')!;

    act(() => field.focus());
    press('Tab');
    expect(document.activeElement, 'Tab from the last real control wraps').toBe(first);

    press('Tab', true);
    expect(document.activeElement, 'Shift+Tab from the first lands on the field, not ▾').toBe(field);
  });

  it.each([
    ['before', false, false, 'before'],
    ['before', true, true, 'last'],
    ['between', false, false, 'between'],
    ['between', true, false, 'between'],
    ['after', false, true, 'first'],
    ['after', true, false, 'after'],
  ] as const)('handles Tab from a programmatic %s target (shift=%s)', (target, shiftKey, prevented, expected) => {
    function Targets() {
      const ref = useDialog<HTMLDivElement>(() => {});
      return (
        <div ref={ref} role="dialog" aria-label="Targets" tabIndex={-1}>
          <p tabIndex={-1}>before</p>
          <button>first</button>
          <p tabIndex={-1}>between</p>
          <button>last</button>
          <p tabIndex={-1}>after</p>
        </div>
      );
    }
    act(() => root.render(<Targets />));
    const destination = [...container.querySelectorAll('p')].find((p) => p.textContent === target)!;
    act(() => destination.focus());
    expect(document.activeElement).toBe(destination);
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    act(() => { destination.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(prevented);
    // happy-dom does not perform native Tab navigation: unhandled keys retain focus.
    expect(document.activeElement?.textContent).toBe(expected);
  });

  it('only the innermost dialog answers Escape', () => {
    function Nested() {
      const [outer, setOuter] = useState(true);
      const [inner, setInner] = useState(true);
      return (
        <>
          {outer && <Dialog label="outer" onClose={() => setOuter(false)} />}
          {inner && <Dialog label="inner" onClose={() => setInner(false)} />}
        </>
      );
    }
    act(() => root.render(<Nested />));
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(2);

    // First Escape closes only the inner one.
    press('Escape');
    let open = Array.from(container.querySelectorAll('[role="dialog"]'));
    expect(open).toHaveLength(1);
    expect(open[0]!.getAttribute('aria-label')).toBe('outer');

    // Second Escape closes the outer one.
    press('Escape');
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  });
});
