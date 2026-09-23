import {
  useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
} from 'react';

/**
 * Shared modal behaviour for every `role="dialog"` overlay in the app.
 *
 * Before this hook the dialogs closed ONLY by clicking the backdrop or the ×:
 * Escape did nothing (there was not one `Escape` handler in the whole app), and
 * focus never entered the dialog, so a keyboard user's next Tab landed behind it
 * in the page they could not see. This gives all of them the three behaviours a
 * dialog is expected to have:
 *
 *  - Escape closes — but only the TOPMOST dialog, so a picker opened on top of
 *    another dialog closes just itself (a module-level stack tracks nesting).
 *  - Focus moves into the dialog on open and returns to whatever opened it on
 *    close, so the keyboard never loses its place.
 *  - Tab is trapped inside the dialog while it is open.
 *
 * Usage: attach the returned ref to the dialog element and give it tabIndex={-1}
 * so it can hold focus when it contains nothing focusable yet.
 */

/**
 * What Tab can land on. Every entry excludes `tabindex="-1"`, which takes an
 * element OUT of the tab order however focusable it is (audit 2026-09-22):
 * without that, a trailing NumField's ▾ button — tabIndex -1, so the browser
 * never tabs to it — was taken for the dialog's `last`. Tab from the real
 * last control then was not wrapped and escaped into the page behind the
 * scrim, and Shift+Tab from the first landed on ▾, where Enter decremented
 * the Preferences dialog's joint clearance.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]',
].map((sel) => `${sel}:not([tabindex="-1"])`).join(',');

/** Open dialogs, innermost last. Only the last one answers Escape. */
const stack: symbol[] = [];
/** The open dialogs on that stack that are MODAL — see `openModalCount`. */
const modals = new Set<symbol>();

/**
 * How many MODAL dialogs are open right now.
 *
 * For the design history's Ctrl+Z / Ctrl+Y binding (audit 2026-09-22). The
 * handler below owns Escape and Tab and lets every other key through, so undo
 * reached the design BEHIND a dialog: Ctrl+Z during a Batch sweep rebuilt the
 * rocket the sweep was flying, and behind the Save/Discard modal it undid the
 * design unseen, which Save then wrote. The undo binding refuses while this is
 * above zero.
 *
 * Modal only, not the whole stack: the first-run tour uses this hook for its
 * Escape and focus but leaves the app usable behind its card (its scrim and
 * ring take no pointer events), and it opens by itself on a first visit. A
 * visitor editing the design around it would otherwise find Ctrl+Z silently
 * dead while the header's Undo button still worked.
 */
export function openModalCount(): number {
  return modals.size;
}

function focusableWithin(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed',
  );
}

export function useDialog<T extends HTMLElement = HTMLDivElement>(
  onClose: () => void,
  /**
   * `modal: false` for a dialog that leaves the app usable behind it (the
   * first-run tour): it still owns Escape and Tab, but does not hold the
   * design's undo binding — see `openModalCount`. Read once, at open.
   */
  opts: { modal?: boolean } = {},
) {
  const ref = useRef<T>(null);
  // Kept in a ref so a caller passing a fresh closure every render does not
  // re-run the effect (which would re-steal focus on every parent render).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const modal = useRef(opts.modal !== false);

  useEffect(() => {
    const id = Symbol('dialog');
    stack.push(id);
    if (modal.current) modals.add(id);
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const node = ref.current;
    if (node) {
      const first = focusableWithin(node)[0];
      (first ?? node).focus?.();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return; // an inner dialog owns the key
      const el = ref.current;
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !el) return;
      const items = focusableWithin(el);
      if (items.length === 0) {
        e.preventDefault();
        el.focus?.();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      // Wrap at the ends, and pull focus back in if it escaped the dialog.
      if (!el.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      modals.delete(id);
      // Only restore if focus is still inside (or was lost to) this dialog —
      // never yank it away from something the close handler focused on purpose.
      const active = document.activeElement;
      if (!active || active === document.body || ref.current?.contains(active)) {
        previouslyFocused?.focus?.();
      }
    };
  }, []);

  return ref;
}

/**
 * Props for a dialog's backdrop that close it on a click which STARTS and ENDS
 * on the backdrop itself: `<div className="prefs-overlay" {...backdrop}>`.
 *
 * `onClick={onClose}` on the backdrop closed the dialog for ANY click whose
 * target was the backdrop, and a click's target is the nearest element holding
 * both the press and the release (audit 2026-09-22). Select text in the guide,
 * let the drag run off the card's edge, and that element is the backdrop: the
 * dialog closed under the selection. The card's `stopPropagation` cannot help,
 * because such a click never reaches the card.
 */
export function useBackdropClose(onClose: () => void) {
  const pressed = useRef(false);
  const released = useRef(false);
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => { pressed.current = e.target === e.currentTarget; },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => { released.current = e.target === e.currentTarget; },
    onClick: (e: ReactMouseEvent<HTMLElement>) => {
      const onBackdrop = pressed.current && released.current && e.target === e.currentTarget;
      pressed.current = false;
      released.current = false;
      if (onBackdrop) onClose();
    },
  };
}

/**
 * Escape-to-close and focus-return for a NON-modal popup — the header's
 * "Save As / Export ▾" and "Feedback" panels.
 *
 * Deliberately not `useDialog`: those two are disclosure popups, not dialogs.
 * They must not trap Tab (tabbing out of a menu is how a menu is left), and
 * they must not steal focus on open — a pointer user who clicked the trigger
 * would have the first export button focused under their cursor. What they DID
 * lack is the other half: Escape did nothing anywhere in App (there was not a
 * single key handler in the file), so a keyboard user who opened the export
 * popup had no way to dismiss it, and closing it by any route left focus
 * nowhere.
 *
 * Call it unconditionally and pass `open` — the popup's own JSX is
 * conditionally rendered, so a hook inside it could not be.
 */
export function useMenuPopup(open: boolean, onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    // The trigger, which is what had focus when the click opened this.
    const opener = document.activeElement as HTMLElement | null;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onCloseRef.current();
      opener?.focus?.();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);
}
