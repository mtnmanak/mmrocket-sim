import { useState } from 'react';

/**
 * Numeric input that lets the user TYPE anything mid-edit (including "-",
 * clearing the field, or pasting) without the value snapping back to 0 —
 * the classic failure of a controlled <input type="number">.
 *
 * Behavior:
 * - While focused, keystrokes edit a local draft string. Every draft that
 *   parses to a valid number is committed live; invalid drafts ("e", "abc",
 *   a negative where negatives aren't allowed, out-of-range) show an error
 *   border and commit nothing.
 * - Blur/Enter reformats from the last committed value; an invalid draft is
 *   simply discarded (the previous value survives).
 * - Unfocused display is capped at 3 decimals (display only — the stored
 *   value keeps full precision, which is what you edit on focus).
 * - Clearing the field commits null when `nullable` (blank = auto/calculated
 *   fields); otherwise it's treated as an incomplete draft.
 * - ArrowUp/ArrowDown and the spinner buttons step by `step`.
 */
export function NumField({
  value, onCommit, nullable = false, min, max, allowNegative = false,
  integer = false, step = 1, placeholder, autoValue, ariaLabel, id,
}: {
  value: number | undefined;
  /** Called with each valid typed value; null only when nullable and cleared. */
  onCommit: (v: number | null) => void;
  nullable?: boolean;
  min?: number;
  max?: number;
  allowNegative?: boolean;
  integer?: boolean;
  step?: number;
  placeholder?: string;
  /**
   * The computed/auto value a BLANK field is standing in for, in the same unit
   * as `value`. Only the spinner and the arrow keys use it: they step from it
   * instead of from zero.
   *
   * Why that matters. A blank field here does not mean "zero", it means "use
   * the computed value the placeholder is showing" — a measured mass of 245.3 g,
   * an LV-Haack shape parameter of 0.333, a rail button's kernel default. One
   * click on ▾ used to commit `0 - step` clamped to 0, i.e. a hard zero, and
   * one click on ▴ committed `step` itself: the measured-mass box then reported
   * "245.3 g LIGHTER than the model" for a rocket nobody had weighed, and the
   * nose shape parameter dropped from 0.333 to 0.05, moving the nose's volume,
   * mass and CP. Optional: when it is not given, a number inside `placeholder`
   * is used instead (see `autoBase` below), which covers every caller that
   * already renders the auto value there.
   */
  autoValue?: number;
  ariaLabel?: string;
  /**
   * Put on the real <input>, so a sibling `<label htmlFor>` can focus it.
   * Without this a label pointing at the field reached nothing — the wrapper
   * div is not a labelable element — and clicking the label did nothing while
   * a neighbouring <select>'s label worked, which is the inconsistency a user
   * notices.
   */
  id?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  const lowBound = min !== undefined ? min : (allowNegative ? undefined : 0);

  const parse = (s: string): number | null => {
    const t = s.trim();
    if (t === '') return null;
    const v = Number(t);
    if (!Number.isFinite(v)) return null;
    if (lowBound !== undefined && v < lowBound) return null;
    if (max !== undefined && v > max) return null;
    if (integer && !Number.isInteger(v)) return null;
    return v;
  };

  // "-", ".", "-." are incomplete (no error styling), not invalid.
  const isIncomplete = (t: string) => /^-?\.?$/.test(t);

  const fmtDisplay = (v: number | undefined) =>
    v === undefined ? '' : String(Number(v.toFixed(3)));
  const fmtEdit = (v: number | undefined) =>
    v === undefined ? '' : String(Number(v.toFixed(9)));

  const shown = draft !== null ? draft : fmtDisplay(value);
  const invalid = draft !== null && draft.trim() !== ''
    && !isIncomplete(draft.trim()) && parse(draft) === null;

  const change = (s: string) => {
    setDraft(s);
    if (s.trim() === '') {
      if (nullable) onCommit(null);
      return;
    }
    const v = parse(s);
    if (v !== null) onCommit(v);
  };

  /**
   * The value a blank field is standing in for. `autoValue` wins; failing that
   * we read the number back out of the placeholder, because in every call site
   * in the app a placeholder that CONTAINS a number is the field's own auto
   * value rendered in the field's own unit — "245.3" (MeasuredMassBox),
   * "auto: 12.345" and "default: 0.333" (PropertyPanel), "design: 76.2"
   * (App.tsx's max motor length). Placeholders that name a state rather than a
   * number — "—", "standard", "plugged", "no limit" — contain no digits, so
   * those fields keep the old seed-from-zero behaviour, which is what a blank
   * "none" field should do.
   *
   * If you add a placeholder that contains a number which is NOT the auto value
   * (an "e.g. 25" hint, say), pass `autoValue` explicitly or the spinner will
   * step from your example.
   */
  const autoBase = (): number | undefined => {
    if (autoValue !== undefined && Number.isFinite(autoValue)) return autoValue;
    const m = placeholder?.match(/-?\d+(?:\.\d+)?/);
    if (!m) return undefined;
    const v = Number(m[0]);
    return Number.isFinite(v) ? v : undefined;
  };

  const stepBy = (dir: 1 | -1) => {
    const base = (draft !== null ? parse(draft) : null) ?? value ?? autoBase() ?? 0;
    let next = base + dir * step;
    // Snap float noise (0.30000000000000004) to the step's precision.
    const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
    next = Number(next.toFixed(Math.min(9, decimals + 1)));
    if (lowBound !== undefined && next < lowBound) next = lowBound;
    if (max !== undefined && next > max) next = max;
    if (integer) next = Math.round(next);
    setDraft(String(next));
    onCommit(next);
  };

  return (
    <div className="numfield">
      <input
        id={id}
        type="text"
        inputMode="decimal"
        className={invalid ? 'num-invalid' : undefined}
        value={shown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        onFocus={() => setDraft(fmtEdit(value))}
        onChange={(e) => change(e.target.value)}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') { e.preventDefault(); stepBy(1); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); stepBy(-1); }
          else if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      <span className="numfield-spin">
        <button type="button" tabIndex={-1} aria-label="Increment"
          onMouseDown={(e) => e.preventDefault()} onClick={() => stepBy(1)}>▴</button>
        <button type="button" tabIndex={-1} aria-label="Decrement"
          onMouseDown={(e) => e.preventDefault()} onClick={() => stepBy(-1)}>▾</button>
      </span>
    </div>
  );
}
