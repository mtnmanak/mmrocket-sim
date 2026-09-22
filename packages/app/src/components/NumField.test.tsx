// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NumField } from './NumField.js';
import { LOCALE_DECIMAL_COMMA } from '../prefs/units.js';

/**
 * NumField is the single numeric input every dimension in the app passes
 * through — 23 call sites, including the generic renderer that draws every
 * field in the property panel. It had no test file at all, so nothing caught a
 * regression on the path from a keystroke to a physical dimension, and `npm
 * test` is the deploy gate.
 *
 * Rendered through react-dom's own root API with React's `act` — no
 * @testing-library in this workspace (see SiteBand.test.tsx).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let commits: (number | null)[];

type Props = Parameters<typeof NumField>[0];

/**
 * A fresh `key` per `render()`: every case starts from a newly mounted field,
 * so one case's focus cannot leak into the next. `rerender()` keeps the SAME
 * element, which is what the parent panel does when the selection, an undo or
 * a unit switch hands the field a new value — the case the draft used to
 * survive (audit 2026-09-22), pinned in "a spinner click leaves no draft".
 */
let seq = 0;
let current: Partial<Props> = {};
/** Re-render with each committed value, the way every real call site does. */
let controlled = false;

const element = () => (
  <NumField
    key={seq}
    value={undefined}
    onCommit={(v) => {
      commits.push(v);
      // Already inside the act() that dispatched the event.
      if (controlled && v !== null) { current = { ...current, value: v }; root.render(element()); }
    }}
    {...current}
  />
);

const mount = () => act(() => { root.render(element()); });

const render = (props: Partial<Props> = {}, opts: { controlled?: boolean } = {}) => {
  commits = [];
  seq += 1;
  controlled = opts.controlled ?? false;
  current = props;
  mount();
};

/** Same element, new props — as a parent re-render. */
const rerender = (props: Partial<Props>) => {
  current = { ...current, ...props };
  mount();
};

const input = (): HTMLInputElement => host.querySelector('input')!;
const spinners = (): HTMLButtonElement[] => [...host.querySelectorAll('button')];

const focus = () => act(() => input().focus());
const blur = () => act(() => input().blur());
const focused = () => document.activeElement === input();

/**
 * Native setter + input event — how React sees a real keystroke. A keystroke
 * only reaches a focused input, so it focuses first when nothing has.
 */
const type = (value: string) => {
  if (!focused()) focus();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
};

/** A key press, which likewise only reaches a focused input. */
const key = (k: string) => {
  if (!focused()) focus();
  act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
};
/** A spinner click. ▴/▾ preventDefault their mousedown, so this never focuses. */
const click = (btn: HTMLButtonElement) => act(() => {
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('NumField — typing', () => {
  it('shows a committed value capped at 3 decimals, full precision on focus', () => {
    render({ value: 12.3456789 });
    expect(input().value).toBe('12.346');
    focus();
    expect(input().value).toBe('12.3456789');
  });

  it('keeps three significant figures where three decimals would round a value away', () => {
    // Audit 2026-09-22: in metres a 0.4 mm wall is 0.0004, and at a flat three
    // decimals the unfocused box showed "0" for a wall that is there.
    render({ value: 0.0004 });
    expect(input().value).toBe('0.0004');
    render({ value: 0.0123456 });
    expect(input().value).toBe('0.0123');
    // 0.1 and up read exactly as the three-decimal cap always did.
    render({ value: 0.1234567 });
    expect(input().value).toBe('0.123');
    render({ value: 1219.25 });
    expect(input().value).toBe('1219.25');
    render({ value: 0 });
    expect(input().value).toBe('0');
  });

  it('commits every draft that parses', () => {
    render({ value: 1 });
    type('2.5');
    expect(commits).toEqual([2.5]);
  });

  it('treats "-", "." and "-." as incomplete: no commit, no error styling', () => {
    render({ value: 1, allowNegative: true });
    for (const t of ['-', '.', '-.']) {
      type(t);
      expect(input().className).not.toBe('num-invalid');
    }
    expect(commits).toEqual([]);
  });

  it('refuses non-finite drafts — "1e400", "Infinity", "NaN"', () => {
    // Number('1e400') is Infinity and Number('NaN') is NaN; either one reaching
    // a dimension NaNs the whole rocket's mass and CG, so they must not commit.
    for (const t of ['1e400', 'Infinity', 'NaN']) {
      render({ value: 1 });
      type(t);
      expect(commits, t).toEqual([]);
      expect(input().className, t).toBe('num-invalid');
      expect(input().getAttribute('aria-invalid'), t).toBe('true');
    }
  });

  it('refuses a negative unless allowNegative, and refuses out-of-range', () => {
    render({ value: 1 });
    type('-3');
    expect(commits).toEqual([]);

    render({ value: 1, allowNegative: true });
    type('-3');
    expect(commits).toEqual([-3]);

    render({ value: 5, min: 2, max: 8 });
    type('1');
    type('9');
    expect(commits).toEqual([]);
    type('8');
    expect(commits).toEqual([8]);
  });

  it('refuses a fraction when integer', () => {
    render({ value: 3, integer: true });
    type('3.5');
    expect(commits).toEqual([]);
    type('4');
    expect(commits).toEqual([4]);
  });

  it('reads a decimal comma, and refuses a thousands group instead of misreading it', () => {
    // Audit 2026-09-22: "1,5" was NaN, so a comma-decimal iPhone user could
    // type no fraction at all. "10,000" must not become 10 in the process.
    render({ value: 1 });
    type('1,5');
    expect(commits).toEqual([1.5]);
    type('10,000');
    if (LOCALE_DECIMAL_COMMA) {
      expect(commits).toEqual([1.5, 10]); // "10,000" IS ten, where 1,5 is 1.5
    } else {
      expect(commits).toEqual([1.5]);
      expect(input().className).toBe('num-invalid');
    }
    // Mid-typing "-," is as incomplete as "-.", not an error.
    render({ value: 1, allowNegative: true });
    type('-,');
    expect(input().className).not.toBe('num-invalid');
  });

  it('clearing commits null when nullable, nothing otherwise', () => {
    render({ value: 4, nullable: true });
    type('');
    expect(commits).toEqual([null]);

    render({ value: 4 });
    type('');
    expect(commits).toEqual([]);
  });

  it('blur discards an invalid draft and redisplays the committed value', () => {
    render({ value: 7 });
    focus();
    type('abc');
    expect(input().value).toBe('abc');
    blur();
    expect(input().value).toBe('7');
    expect(commits).toEqual([]);
  });
});

describe('NumField — stepping', () => {
  it('steps from the current value and snaps float noise', () => {
    render({ value: 0.2, step: 0.1 });
    key('ArrowUp');
    expect(commits).toEqual([0.3]); // not 0.30000000000000004
    // A second step works off the draft the first one left, so it comes back
    // to 0.2 — again snapped, not 0.19999999999999998.
    key('ArrowDown');
    expect(commits).toEqual([0.3, 0.2]);
  });

  it('clamps a step to min/max and rounds when integer', () => {
    render({ value: 0.5, step: 1 });
    key('ArrowDown');
    expect(commits).toEqual([0]); // lowBound is 0 without allowNegative

    render({ value: 9, step: 5, max: 10 });
    key('ArrowUp');
    expect(commits).toEqual([10]);

    render({ value: 3, step: 0.5, integer: true });
    key('ArrowUp');
    expect(commits).toEqual([4]); // 3.5 rounded, not refused
  });

  /**
   * The measured-mass regression. A blank field is not zero — it means "use the
   * computed value the placeholder is showing". One click on ▾ used to commit a
   * hard 0, and solveBallast then reported "245.3 g LIGHTER than the model" for
   * a rocket nobody had weighed.
   */
  it('steps a blank field from the auto value its placeholder shows', () => {
    render({ value: undefined, nullable: true, step: 5, placeholder: '245.3' }, { controlled: true });
    click(spinners()[1]!); // ▾
    expect(commits).toEqual([240.3]);
    // The field is no longer blank after that first commit, so the second click
    // steps from what it now holds — the auto value is only the SEED.
    click(spinners()[0]!); // ▴
    expect(commits).toEqual([240.3, 245.3]);
  });

  /**
   * Audit 2026-09-22 (HIGH), measured through the real panel: the spinner never
   * focuses the input, but it wrote its result into the draft, which only a
   * blur clears. PropertyPanel is one element for every selected component, so
   * tube B's blank Mass override showed tube A's figure and one ▴ committed A's
   * mass plus a step onto B. The same element here, handed a new value the way
   * a selection change, an undo or a unit switch hands it one.
   */
  it('a spinner click leaves no draft: the display and the next step follow a new value', () => {
    render({ value: 45.1, step: 0.1, nullable: true });
    click(spinners()[0]!); // ▴ on "tube A", unfocused
    expect(commits).toEqual([45.2]);

    // "Tube B": a different committed value.
    rerender({ value: 7 });
    expect(input().value, 'the display follows the new value').toBe('7');
    click(spinners()[0]!);
    expect(commits, 'the next step works off 7, not off 45.2').toEqual([45.2, 7.1]);

    // "Tube C": blank, with its own computed mass in the placeholder.
    rerender({ value: undefined, placeholder: '120' });
    expect(input().value, 'a blank field stays blank').toBe('');
    click(spinners()[0]!);
    expect(commits, 'seeded from 120, not from any earlier figure').toEqual([45.2, 7.1, 120.1]);
  });

  it('a focused field keeps its draft across a parent re-render', () => {
    // The other half of the contract: while the user is typing, the draft is
    // theirs, and a re-render with the (just committed) value must not snap it.
    render({ value: 1, allowNegative: true });
    type('-');
    rerender({ value: 1 });
    expect(input().value).toBe('-');
  });

  it('reads the auto value out of a labelled placeholder', () => {
    // PropertyPanel writes "default: 0.333" (Haack shape parameter) and
    // "auto: 12.345" (tube-fin outer radius); App.tsx writes "design: 76.2".
    render({ value: undefined, nullable: true, step: 0.05, placeholder: 'default: 0.333' });
    click(spinners()[1]!);
    expect(commits).toEqual([0.283]);

    render({ value: undefined, nullable: true, step: 1, placeholder: 'design: 76.2' });
    click(spinners()[0]!);
    expect(commits).toEqual([77.2]);
  });

  it('prefers an explicit autoValue over the placeholder text', () => {
    // The placeholder is rounded for display; autoValue carries full precision.
    render({ value: undefined, nullable: true, step: 5, placeholder: '245.3', autoValue: 245.34 });
    click(spinners()[0]!);
    expect(commits).toEqual([250.34]);
  });

  /**
   * Audit 2026-09-22: a blank field whose placeholder names a state — "auto",
   * "standard", "plugged", "no limit", "—" — or shows nothing has no number to
   * step from. It used to seed from 0: ▴ on a blank Cd override committed 0.05
   * and ▾ committed 0, replacing the component's whole drag, and the time step
   * ("standard") committed its 0.01 s floor. Now it commits nothing and puts
   * the caret in the box.
   */
  it('a blank field with no number behind it commits nothing, and takes focus instead', () => {
    for (const placeholder of ['auto', 'standard', 'plugged', '—', undefined]) {
      render({ value: undefined, nullable: true, step: 0.05, placeholder });
      click(spinners()[0]!);
      click(spinners()[1]!);
      expect(commits, String(placeholder)).toEqual([]);
      expect(document.activeElement, String(placeholder)).toBe(input());
    }
    // And from the keyboard, where the field already has focus.
    render({ value: undefined, nullable: true, step: 0.05, placeholder: 'auto' });
    key('ArrowUp');
    key('ArrowDown');
    expect(commits).toEqual([]);
    expect(input().value).toBe('');
  });

  it('a typed draft still wins over value and autoValue', () => {
    render({ value: 2, step: 1, autoValue: 99 });
    focus();
    type('40');
    key('ArrowUp');
    expect(commits).toEqual([40, 41]);
  });
});

describe('NumField — the on-screen keyboard', () => {
  it('a field that takes a negative asks for the full keyboard; the rest keep the decimal pad', () => {
    // iOS's decimal pad has no minus key (audit 2026-09-22): no negative cant,
    // offset or CG could be typed on an iPhone.
    render({ value: 1, allowNegative: true });
    expect(input().inputMode).toBe('text');
    render({ value: 1, min: -90, max: 90 });
    expect(input().inputMode).toBe('text');
    render({ value: 1 });
    expect(input().inputMode).toBe('decimal');
    render({ value: 1, min: 0.01 });
    expect(input().inputMode).toBe('decimal');
  });
});

describe('NumField — labelling', () => {
  it('puts id and aria-label on the real input, so a sibling label reaches it', () => {
    render({ value: 1, id: 'measured-mass', ariaLabel: 'Measured mass' });
    expect(input().id).toBe('measured-mass');
    expect(input().getAttribute('aria-label')).toBe('Measured mass');
  });

  it('invalid sets aria-invalid and describedBy sets aria-describedby on the input', () => {
    // v0.118: a weighed pad mass whose motor set changed since the weighing is
    // rendered greyed and NOT applied; the caller says so through these two,
    // and the line that explains it is what aria-describedby points at.
    render({ value: 10574, invalid: true, describedBy: 'pad-mass-mmt-line' });
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(input().getAttribute('aria-describedby')).toBe('pad-mass-mmt-line');
    // Neither is the draft's error border: a committed value the caller calls
    // stale is not a typo, so the caller styles that state itself.
    expect(input().className).not.toBe('num-invalid');
    // Without them nothing changes for the existing call sites.
    render({ value: 1 });
    expect(input().hasAttribute('aria-invalid')).toBe(false);
    expect(input().hasAttribute('aria-describedby')).toBe(false);
  });
});
