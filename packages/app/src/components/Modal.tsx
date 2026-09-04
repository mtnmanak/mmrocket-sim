import type { ReactNode } from 'react';
import { useDialog } from './useDialog.js';

/**
 * The `.modal-backdrop` / `.modal-card` overlay App declares four times —
 * Start a new design, Save first?, Open design from link, Camera shroud
 * detected — with the behaviour a `role="dialog" aria-modal="true"` element
 * has to have.
 *
 * Those four were written inline in App's JSX with no ref, no `tabIndex` and
 * no key handling, while all eight dialogs under components/ went through
 * {@link useDialog}. The gap was not cosmetic: the "Save … first?" modal is
 * the one that gates data loss, and a keyboard user reached it by choosing a
 * file — leaving focus on the file input, which sits BEHIND an
 * `aria-modal="true"` overlay, so a screen reader prunes it and announces
 * nothing. Escape did nothing, Tab walked the header buttons behind the modal
 * instead of the three actions, and closing left focus on `document.body`.
 *
 * A component rather than a hook call in App, because `useDialog`'s effect
 * must run when the dialog MOUNTS: called at App's top level it would push
 * onto the dialog stack once, at app start, and never again.
 *
 * The ref and the ARIA role go on the CARD, not the backdrop — the same place
 * ScaleDialog and PreferencesDialog put them, so the focus trap wraps the
 * buttons rather than the full-viewport scrim.
 *
 * Backdrop clicks deliberately do NOT close: three of these four are asking
 * whether to discard something, and a stray click outside is not an answer.
 * Escape is enough, and it takes the same non-destructive branch each modal's
 * Cancel / Keep button already takes.
 */
export function Modal({ label, onClose, children }: {
  /** The accessible name — what a screen reader announces on open. */
  label: string;
  /** The modal's non-destructive dismissal, run on Escape. */
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useDialog<HTMLDivElement>(onClose);
  return (
    <div className="modal-backdrop">
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={label}
        ref={ref} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
