import { useEffect, useRef } from 'react';

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

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Open dialogs, innermost last. Only the last one answers Escape. */
const stack: symbol[] = [];

function focusableWithin(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed',
  );
}

export function useDialog<T extends HTMLElement = HTMLDivElement>(onClose: () => void) {
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
