// @vitest-environment happy-dom
import { useState } from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useMenuPopup } from './useDialog.js';

/**
 * The header's two disclosure popups — "Save As / Export ▾" and "Feedback".
 *
 * They declared `aria-haspopup="menu"` over a `role="menu"` container of plain
 * `<button>` children, which is not a legal menu (assistive tech prunes or
 * misreports non-menuitem children), and App had no key handling of any kind:
 * a keyboard user could open the export popup — the only route to Save .ork —
 * and then had no way to dismiss it, and closing it left focus nowhere.
 *
 * The fix drops the menu roles (they are disclosures) and adds this hook. What
 * it must NOT do is trap Tab or steal focus: tabbing out is how a disclosure is
 * left, and stealing focus would put the first export button under a pointer
 * user's cursor.
 */

function Harness() {
  const [open, setOpen] = useState(false);
  useMenuPopup(open, () => setOpen(false));
  return (
    <>
      <button id="trigger" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Save As / Export
      </button>
      {open && (
        <div className="file-menu" role="group" aria-label="Save As / Export">
          <button>Save .ork</button>
          <button>Save .rkt</button>
        </div>
      )}
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

const press = (key: string) => {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
};

describe('useMenuPopup', () => {
  it('Escape closes the popup and puts focus back on the trigger', () => {
    act(() => root.render(<Harness />));
    const trigger = container.querySelector<HTMLButtonElement>('#trigger')!;
    trigger.focus();
    act(() => trigger.click());
    expect(container.querySelector('.file-menu')).not.toBeNull();

    // Focus has moved into the popup, the way Tab would take it.
    const firstItem = container.querySelector<HTMLButtonElement>('.file-menu button')!;
    act(() => firstItem.focus());

    press('Escape');
    expect(container.querySelector('.file-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('does not steal focus when the popup opens', () => {
    act(() => root.render(<Harness />));
    const trigger = container.querySelector<HTMLButtonElement>('#trigger')!;
    trigger.focus();
    act(() => trigger.click());
    expect(document.activeElement).toBe(trigger);
  });

  it('listens only while open — Escape with the popup shut changes nothing', () => {
    act(() => root.render(<Harness />));
    const trigger = container.querySelector<HTMLButtonElement>('#trigger')!;
    trigger.focus();
    press('Escape');
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector('.file-menu')).toBeNull();

    // And it re-arms on the next open rather than being a one-shot.
    act(() => trigger.click());
    press('Escape');
    expect(container.querySelector('.file-menu')).toBeNull();
  });
});
