// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NumField } from './NumField.js';

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
 * A fresh `key` each time: NumField keeps the in-progress draft in its own
 * state, so re-rendering the same element position inside one test would carry
 * the previous case's draft into the next one.
 */
let seq = 0;

const render = (props: Partial<Props> = {}) => {
  commits = [];
  seq += 1;
  act(() => {
    root.render(
      <NumField
        key={seq}
        value={undefined}
        onCommit={(v) => commits.push(v)}
        {...props}
      />,
    );
  });
};

const input = (): HTMLInputElement => host.querySelector('input')!;
const spinners = (): HTMLButtonElement[] => [...host.querySelectorAll('button')];

/** Native setter + input event — how React sees a real keystroke. */
const type = (value: string) => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const focus = () => act(() => { input().dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
const blur = () => act(() => { input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
const key = (k: string) => act(() => {
  input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
});
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
    render({ value: undefined, nullable: true, step: 5, placeholder: '245.3' });
    click(spinners()[1]!); // ▾
    expect(commits).toEqual([240.3]);
    // The field is no longer blank after that first commit, so the second click
    // steps from what it now holds — the auto value is only the SEED.
    click(spinners()[0]!); // ▴
    expect(commits).toEqual([240.3, 245.3]);
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

  it('still seeds from zero when the placeholder names a state, not a number', () => {
    // "—", "standard", "plugged", "no limit": blank means "none" there, so
    // stepping up to one `step` is the right seed and stays as it was.
    render({ value: undefined, nullable: true, step: 10, placeholder: '—' });
    click(spinners()[0]!);
    expect(commits).toEqual([10]);
  });

  it('a typed draft still wins over value and autoValue', () => {
    render({ value: 2, step: 1, autoValue: 99 });
    focus();
    type('40');
    key('ArrowUp');
    expect(commits).toEqual([40, 41]);
  });
});

describe('NumField — labelling', () => {
  it('puts id and aria-label on the real input, so a sibling label reaches it', () => {
    render({ value: 1, id: 'measured-mass', ariaLabel: 'Measured mass' });
    expect(input().id).toBe('measured-mass');
    expect(input().getAttribute('aria-label')).toBe('Measured mass');
  });
});
