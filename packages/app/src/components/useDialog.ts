import {
  useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
} from 'react';
import { FATAL_ERROR_BAR_CHANGE } from '../services/fatalErrorBar.js';

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
].map((sel) => `${sel}:not([tabindex="-1"]):not(:disabled)`).join(',');

/** Open dialogs, innermost last. Only the last one answers Escape. */
const stack: symbol[] = [];
const dialogs = new Map<symbol, HTMLElement>();

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
 * Every caller is modal; the first-run tour owns its separate focus behavior
 * (audit 2026-10-11, S3c-6).
 */
export function openModalCount(): number {
  return stack.length;
}

function focusableWithin(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed',
  );
}

export function useDialog<T extends HTMLElement = HTMLDivElement>(
  onClose: () => void,
) {
  const ref = useRef<T>(null);
  // Kept in a ref so a caller passing a fresh closure every render does not
  // re-run the effect (which would re-steal focus on every parent render).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const id = Symbol('dialog');
    stack.push(id);
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const node = ref.current;
    if (node) dialogs.set(id, node);
    const overlay = node?.closest<HTMLElement>('.prefs-overlay, .modal-backdrop') ?? node;
    let suspended = false;
    let resumeFocus: HTMLElement | null = null;
    let display = '';
    let displayPriority = '';
    let inert: string | null = null;
    const restoreOverlay = () => {
      if (!overlay || !suspended) return;
      suspended = false;
      if (display) overlay.style.setProperty('display', display, displayPriority);
      else overlay.style.removeProperty('display');
      if (inert === null) overlay.removeAttribute('inert');
      else overlay.setAttribute('inert', inert);
    };
    const onFatalErrorBarChange = () => {
      if (!overlay) return;
      if (document.querySelector('.fatal-error-bar')) {
        if (suspended) return; // replacement errors keep the original focus/state
        suspended = true;
        const active = document.activeElement as HTMLElement | null;
        resumeFocus = active && node?.contains(active) ? active : null;
        display = overlay.style.getPropertyValue('display');
        displayPriority = overlay.style.getPropertyPriority('display');
        inert = overlay.getAttribute('inert');
        // W3-DIAG: hide the whole scrim, retaining React state for dismissal.
        overlay.style.setProperty('display', 'none', 'important');
        overlay.setAttribute('inert', '');
      } else if (suspended) {
        restoreOverlay();
        if (node && stack[stack.length - 1] === id) {
          (resumeFocus?.isConnected ? resumeFocus : focusableWithin(node)[0] ?? node).focus();
        }
      }
    };
    document.addEventListener(FATAL_ERROR_BAR_CHANGE, onFatalErrorBarChange);
    onFatalErrorBarChange();
    if (node && !suspended) {
      const first = focusableWithin(node)[0];
      (first ?? node).focus?.();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (suspended) return; // the fatal actions now own keyboard access
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
      const direction = e.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
      // Glossary jumps focus tabindex=-1 entries (guide review 2026-09-30).
      // Wrap when no tab stop remains in this direction, even from those targets.
      if (!active || !el.contains(active)
        || !items.some((item) => active.compareDocumentPosition(item) & direction)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener(FATAL_ERROR_BAR_CHANGE, onFatalErrorBarChange);
      restoreOverlay();
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      dialogs.delete(id);
      // Only restore if focus is still inside (or was lost to) this dialog —
      // never yank it away from something the close handler focused on purpose.
      // `node`, the element captured at open, not `ref.current`: on a real
      // unmount React 18 detaches the ref BEFORE passive cleanups run (probed
      // 2026-09-22), so `ref.current` read here was null on every close and
      // its clause could never fire.
      const active = document.activeElement;
      if (!document.querySelector('.fatal-error-bar')
        && (!active || active === document.body || node?.contains(active))) {
        if (previouslyFocused?.isConnected && !previouslyFocused.matches(':disabled')) {
          previouslyFocused.focus();
        } else {
          const outer = dialogs.get(stack[stack.length - 1]!);
          if (outer) (focusableWithin(outer)[0] ?? outer).focus();
        }
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
 *
 * Closing by ANY route hands focus back to the trigger when it has nowhere
 * else to be (audit 2026-09-22). Choosing an item unmounts the button that
 * held focus, so the keyboard landed on <body>: no visible focus, and the
 * screen reader's place lost. Only then — a pick that focused something on
 * purpose, or an outside click on a field, keeps where it went. The cleanup
 * runs before any effect of the same commit mounts, so a dialog an item
 * opens still takes focus afterwards, and returns it to the trigger in turn.
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
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const active = document.activeElement;
      if ((!active || active === document.body) && opener?.isConnected) opener.focus?.();
    };
  }, [open]);
}
