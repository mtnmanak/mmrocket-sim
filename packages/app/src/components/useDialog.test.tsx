// @vitest-environment happy-dom
import { useState } from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useDialog } from './useDialog.js';

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
});

const press = (key: string, shiftKey = false) => {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  });
};

describe('useDialog', () => {
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
