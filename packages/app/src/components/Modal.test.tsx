// @vitest-environment happy-dom
import { useState } from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Modal } from './Modal.js';

/**
 * App's four overlays — Start a new design, Save … first?, Open design from
 * link, Camera shroud detected — were declared inline with `role="dialog"
 * aria-modal="true"` and no ref, no tabIndex and no key handling, while all
 * eight dialogs under components/ went through useDialog. The one that gates
 * data loss is "Save … first?", reached by choosing a file: focus stayed on
 * the file input BEHIND an aria-modal overlay, so a screen reader pruned it and
 * announced nothing, Escape did nothing, and Tab walked the header buttons
 * instead of the modal's three actions.
 *
 * This pins the wrapper that closed that gap. The Escape/Tab/focus mechanics
 * themselves are useDialog's and are tested in useDialog.test.tsx; what is
 * tested here is that Modal actually wires them up, and puts the role on the
 * CARD rather than the full-viewport backdrop.
 */

function Harness({ onClosed }: { onClosed?: () => void } = {}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button id="trigger" onClick={() => setOpen(true)}>open</button>
      {open && (
        <Modal label="Unsaved changes" onClose={() => { setOpen(false); onClosed?.(); }}>
          <h2>Save first?</h2>
          <div className="modal-actions">
            <button>Save .ork, then open</button>
            <button>Open without saving</button>
            <button>Cancel</button>
          </div>
        </Modal>
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

const press = (key: string, shiftKey = false) => {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  });
};

describe('Modal', () => {
  it('puts the dialog role and the accessible name on the card, not the backdrop', () => {
    act(() => root.render(<Harness />));
    act(() => container.querySelector<HTMLButtonElement>('#trigger')!.click());

    const backdrop = container.querySelector('.modal-backdrop')!;
    expect(backdrop.getAttribute('role')).toBeNull();

    const card = container.querySelector('.modal-card')!;
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.getAttribute('aria-modal')).toBe('true');
    expect(card.getAttribute('aria-label')).toBe('Unsaved changes');
    // tabIndex so the card can hold focus even before it has a focusable child.
    expect(card.getAttribute('tabindex')).toBe('-1');
  });

  it('moves focus into the modal on open and back to the opener on close', () => {
    act(() => root.render(<Harness />));
    const trigger = container.querySelector<HTMLButtonElement>('#trigger')!;
    trigger.focus();
    act(() => trigger.click());

    const card = container.querySelector('.modal-card')!;
    expect(card.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).textContent).toBe('Save .ork, then open');

    press('Escape');
    expect(container.querySelector('.modal-card')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Escape takes the non-destructive branch the Cancel button takes', () => {
    let closed = 0;
    act(() => root.render(<Harness onClosed={() => { closed += 1; }} />));
    act(() => container.querySelector<HTMLButtonElement>('#trigger')!.click());
    press('Escape');
    expect(closed).toBe(1);
    expect(container.querySelector('.modal-card')).toBeNull();
  });

  it('traps Tab inside the modal rather than walking the page behind it', () => {
    act(() => root.render(<Harness />));
    act(() => container.querySelector<HTMLButtonElement>('#trigger')!.click());
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.modal-card button'));
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;

    act(() => last.focus());
    press('Tab');
    expect(document.activeElement).toBe(first);

    press('Tab', true);
    expect(document.activeElement).toBe(last);
  });

  it('a backdrop click does NOT close — three of the four are asking about discarding work', () => {
    act(() => root.render(<Harness />));
    act(() => container.querySelector<HTMLButtonElement>('#trigger')!.click());
    act(() => (container.querySelector('.modal-backdrop') as HTMLElement).click());
    expect(container.querySelector('.modal-card')).not.toBeNull();
  });
});
