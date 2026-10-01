import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { clickable } from './clickable.js';

/**
 * Roving tabindex over a table's body rows — the motor and preset pickers.
 *
 * clickable() alone makes EVERY row a tab stop, and in both pickers the rows
 * sit between the filters and the controls after them, so the keyboard paid a
 * Tab per row: up to 400 before MotorBrowser's Load (audit 2026-09-22), up to
 * 300 before PresetPicker's focus trap wrapped back to Close and the CSV
 * buttons (audit 2026-09-30). Here ONE row is tabbable — the one last focused,
 * else `preferred` (MotorBrowser's picked motor), else the first — the arrows
 * (and Home/End) move focus between rows, and Enter/Space activate the row as
 * clickable() does. The arrows move focus WITHOUT activating: a pick resets
 * MotorBrowser's Delay and closes PresetPicker, and passing over a row should
 * do neither.
 *
 * Extracted from MotorBrowser (audit 2026-09-30) rather than copied, so the
 * two pickers cannot drift apart again. ComponentTree's `rove` is a different
 * contract — its arrows SELECT, because selection is what that widget is for.
 *
 * `keys[i]` identifies the i-th shown row, compared with `===`, so the tab stop
 * follows a row across a re-sort or a narrower search — a string id or the row
 * object itself. Put `bodyRef` on the <tbody> whose direct <tr> children are
 * those rows, in that order, and spread `rove(i, activate)` onto row i.
 */
export function useRovingRows<K>(keys: readonly K[], preferred?: K | null) {
  const bodyRef = useRef<HTMLTableSectionElement | null>(null);
  const [cursor, setCursor] = useState<K | null>(null);
  const stopKey = [cursor, preferred].find((k) => k != null && keys.includes(k)) ?? keys[0];
  // By position, so two rows that share a key still make one stop, not two.
  const stop = stopKey === undefined ? -1 : keys.indexOf(stopKey);
  const rove = (i: number, activate: () => void) => {
    // clickable()'s Enter/Space is COMPOSED here, not spread beside another
    // onKeyDown — the second of two spreads silently wins (ComponentTree's note).
    const base = clickable(activate);
    return {
      ...base,
      tabIndex: i === stop ? 0 : -1,
      onFocus: () => setCursor(keys[i] ?? null),
      onKeyDown: (e: ReactKeyboardEvent) => {
        if (e.target !== e.currentTarget) return;
        let next: number | null = null;
        if (e.key === 'ArrowDown') next = Math.min(i + 1, keys.length - 1);
        else if (e.key === 'ArrowUp') next = Math.max(i - 1, 0);
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = keys.length - 1;
        if (next === null) { base.onKeyDown(e); return; }
        e.preventDefault();
        bodyRef.current?.querySelectorAll<HTMLElement>(':scope > tr')[next]?.focus();
      },
    };
  };
  return { bodyRef, rove };
}
