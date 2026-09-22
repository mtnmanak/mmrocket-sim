import { useRef, useState } from 'react';

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
 * - Unfocused, the box always shows `value`. The draft exists only while the
 *   input has focus, so a spinner click — which never focuses it — cannot
 *   leave one behind for the next component, an undo or a unit switch.
 * - Unfocused display is capped at 3 decimals (display only — the stored
 *   value keeps full precision, which is what you edit on focus).
 * - Clearing the field commits null when `nullable` (blank = auto/calculated
 *   fields); otherwise it's treated as an incomplete draft.
 * - ArrowUp/ArrowDown and the spinner buttons step by `step`, from the draft,
 *   the value or the auto value; a blank field with none of those commits
 *   nothing and just takes focus.
 */
export function NumField({
  value, onCommit, nullable = false, min, max, allowNegative = false,
  integer = false, step = 1, placeholder, autoValue, ariaLabel, id, invalid = false, describedBy,
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
   * as `value`. Only the spinner and the arrow keys use it: they step from it,
   * and with no such figure at all they commit nothing (see `stepBy`).
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
  /**
   * The caller's verdict on the COMMITTED value, put on the input as
   * `aria-invalid` (v0.118: the weighed pad mass rendered greyed and not
   * applied because the motor set changed since the weighing). Separate from
   * the draft check above, which is about what is being typed; the error
   * border stays the draft's — the caller styles its own state.
   */
  invalid?: boolean;
  /** `aria-describedby`: the id of the line that explains the field's state. */
  describedBy?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  /**
   * Whether the input itself has focus. The draft is an EDITING state and means
   * nothing once focus is gone, so it is shown, stepped from and validated
   * only while this is true (audit 2026-09-22, HIGH).
   *
   * It used to be `draft !== null` alone, and the spinner broke that: ▴/▾
   * `preventDefault` their mousedown so a click never focuses the input, yet
   * `stepBy` wrote its result into the draft — which only onBlur clears, and
   * onBlur never came. The draft then outlived everything: PropertyPanel is
   * the same element for every selected component, so tube B's blank Mass
   * override showed tube A's 45.1 g, and one ▴ on B committed 45.2 g onto a
   * tube whose computed mass was 120 g. Undo and unit switches kept it too.
   */
  const [focused, setFocused] = useState(false);
  const live = focused ? draft : null;
  const inputRef = useRef<HTMLInputElement>(null);

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

  const shown = live !== null ? live : fmtDisplay(value);
  const draftInvalid = live !== null && live.trim() !== ''
    && !isIncomplete(live.trim()) && parse(live) === null;

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
   * number — "—", "auto", "standard", "plugged", "no limit" — contain no
   * digits, so there is no base and the spinner commits nothing (`stepBy`).
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
    // Unfocused (a spinner click), the committed value is the only truth: a
    // draft is never read here, and none is written below.
    const base = (live !== null ? parse(live) : null) ?? value ?? autoBase();
    // A blank field with no figure behind it: nothing to step FROM, so commit
    // nothing and put the caret in the box for typing instead. This used to
    // seed from 0, and a blank there is rarely "zero" (audit 2026-09-22): ▴ on
    // a blank Cd override ("auto") committed 0.05 and ▾ committed 0, either
    // one replacing the component's whole computed drag; the launch time step
    // ("standard", i.e. 0.05 s) committed its 0.01 s floor, flying 3.7-6.0x
    // slower; ▴ on a plugged motor's delay committed a 1 s ejection; and a
    // mass override with no computed mass to show committed 0.1 g.
    if (base === undefined) {
      if (!focused) inputRef.current?.focus();
      return;
    }
    let next = base + dir * step;
    // Snap float noise (0.30000000000000004) to the step's precision.
    const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
    next = Number(next.toFixed(Math.min(9, decimals + 1)));
    if (lowBound !== undefined && next < lowBound) next = lowBound;
    if (max !== undefined && next > max) next = max;
    if (integer) next = Math.round(next);
    // Focused, the draft follows the step so the box shows it and a second
    // step works off it. Unfocused, the parent's re-render with the committed
    // value is what the box shows — see `focused` above.
    if (focused) setDraft(String(next));
    onCommit(next);
  };

  return (
    <div className="numfield">
      <input
        ref={inputRef}
        id={id}
        type="text"
        inputMode="decimal"
        className={draftInvalid ? 'num-invalid' : undefined}
        value={shown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={draftInvalid || invalid || undefined}
        aria-describedby={describedBy}
        onFocus={() => { setFocused(true); setDraft(fmtEdit(value)); }}
        onChange={(e) => change(e.target.value)}
        onBlur={() => { setFocused(false); setDraft(null); }}
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
