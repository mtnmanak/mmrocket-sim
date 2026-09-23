import { useLayoutEffect, useState } from 'react';

/**
 * Focus for a disclosure whose two halves are DIFFERENT buttons that replace
 * each other — the Design tab's "▤ All stats" chip and the drawer's
 * "▾ Collapse" (review of the audit 2026-09-22 branch, row 462). Each button
 * carried aria-expanded, but pressing one unmounted it, so focus fell to
 * <body> and no element ever changed state while a screen reader was on it:
 * the state was still unannounced, which is what the row was about. A single
 * persistent toggle is not available there, because the drawer is an overlay
 * inside the stage at >= 981px and a block under it below that.
 *
 * So the press hands focus across: `handTo(key)` in the click handler, and
 * `refFor(key)` on each button. The button named last gets focus as it mounts
 * — in the same commit, before paint — and a screen reader reads it with its
 * own aria-expanded ("Collapse, button, expanded"). Only a PRESS hands focus:
 * the drawer also opens and closes by itself (breakpoint, short canvas), and
 * that must never pull focus from wherever the user is. A handoff whose
 * target does not mount in that commit lapses rather than firing later.
 */
export function useFocusHandoff<K extends string>(): {
  handTo: (key: K) => void;
  refFor: (key: K) => (el: HTMLElement | null) => void;
} {
  // Closure state behind a stable object, not a ref: the ref callbacks must
  // keep ONE identity per key (a fresh callback every render would detach and
  // re-attach, and re-offer focus, on every App render).
  const [api] = useState(() => {
    let pending: K | null = null;
    const refs = new Map<K, (el: HTMLElement | null) => void>();
    return {
      handTo: (key: K) => { pending = key; },
      refFor: (key: K) => {
        let fn = refs.get(key);
        if (!fn) {
          fn = (el) => {
            if (el && pending === key) { pending = null; el.focus(); }
          };
          refs.set(key, fn);
        }
        return fn;
      },
      lapse: () => { pending = null; },
    };
  });
  // Runs after this component's own subtree has attached its refs in the same
  // commit, so it clears only a handoff that commit did not take.
  useLayoutEffect(() => { api.lapse(); });
  return { handTo: api.handTo, refFor: api.refFor };
}
