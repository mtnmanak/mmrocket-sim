import type { KeyboardEvent } from 'react';

/**
 * Keyboard activation for elements that are clickable but are not <button>.
 *
 * Several lists here are rows, not buttons, for good reasons — a <tr> must stay
 * a <tr> to keep its table semantics, and the component tree's rows carry their
 * own action buttons. But they were bare `onClick` divs and rows, so picking a
 * motor, applying a component preset and selecting a component were all
 * impossible without a mouse. Spreading `clickable(fn)` onto such an element
 * gives it a tab stop and Enter/Space activation while leaving its role alone.
 *
 * Use a real <button> instead wherever the element genuinely is one.
 */
export function clickable(onActivate: () => void) {
  return {
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent) => {
      // Ignore keys aimed at a control nested inside the row (its own buttons,
      // an inline input) — those handle their own activation.
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        onActivate();
      }
    },
  };
}
