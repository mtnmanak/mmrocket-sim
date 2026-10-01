// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NumField } from './NumField.js';

/**
 * NumField in a decimal-comma locale (de-DE, fr-FR, pt-BR), forced here so the
 * result does not depend on the machine running the suite: `readDecimal`'s
 * locale default is replaced by `locale.decimalComma`, which each block sets.
 *
 * The audit's MED (2026-09-30, `NumField.tsx:146`): the box writes its numbers
 * with a decimal POINT, as the whole app prints them, and in a decimal-comma
 * locale `readDecimal` refuses a point followed by exactly three digits after
 * a 1–999 integer part — "1.625" is how 1625 is written there. So the field
 * refused text it had written itself: focusing 1.625 in (any eighth-inch
 * fraction) turned it red before a key was pressed, and deleting the 5 and
 * typing it back was refused, leaving 1.62 stored.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const locale = vi.hoisted(() => ({ decimalComma: true }));
vi.mock('../prefs/units.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../prefs/units.js')>();
  return {
    ...real,
    readDecimal: (text: string, decimalComma: boolean = locale.decimalComma) => real.readDecimal(text, decimalComma),
  };
});

let host: HTMLDivElement;
let root: Root;
let commits: (number | null)[];

type Props = Parameters<typeof NumField>[0];

let seq = 0;
let current: Partial<Props> = {};

/** Re-rendered with each committed value, the way every real call site is. */
const element = () => (
  <NumField
    key={seq}
    value={undefined}
    onCommit={(v) => {
      commits.push(v);
      if (v !== null) { current = { ...current, value: v }; root.render(element()); }
    }}
    {...current}
  />
);

const render = (props: Partial<Props>) => {
  commits = [];
  seq += 1;
  current = props;
  act(() => { root.render(element()); });
};

/** Same element, new props — a parent re-render (a selection change, an undo). */
const rerender = (props: Partial<Props>) => {
  current = { ...current, ...props };
  act(() => { root.render(element()); });
};

const input = (): HTMLInputElement => host.querySelector('input')!;
const focus = () => act(() => input().focus());
const blur = () => act(() => input().blur());
/** Native setter + input event — how React sees a real keystroke. */
const type = (value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
  input().dispatchEvent(new Event('input', { bubbles: true }));
});
const key = (k: string) => act(() => {
  input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
});
const flagged = () => input().getAttribute('aria-invalid') === 'true' || input().className === 'num-invalid';

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** 1.625 in is 1⅝ in; 1000.5 sits where a thousands group could be read. */
const VALUES = [1.625, 12.5, 0.125, 1000.5, -1.625];

for (const decimalComma of [true, false]) {
  describe(`NumField — its own value, in a decimal-${decimalComma ? 'comma' : 'point'} locale`, () => {
    beforeEach(() => { locale.decimalComma = decimalComma; });

    it.each(VALUES)('focusing %s and leaving flags nothing and stores nothing', (v) => {
      render({ value: v, allowNegative: true });
      const shown = input().value;
      focus();
      expect(flagged(), `focused on ${input().value}`).toBe(false);
      blur();
      expect(commits).toEqual([]);
      expect(input().value).toBe(shown);
    });

    it.each(VALUES)('deleting the last digit of %s and typing it back stores it again', (v) => {
      render({ value: v, allowNegative: true });
      focus();
      const text = input().value;
      type(text.slice(0, -1));
      type(text);
      expect(commits.at(-1), `${text} → ${text.slice(0, -1)} → ${text}`).toBe(v);
      expect(flagged()).toBe(false);
    });

    it('a step that lands on three decimals is not flagged, and the next step works off it', () => {
      render({ value: 1.5, step: 0.125 });
      focus();
      key('ArrowUp');
      expect(input().value).toBe('1.625');
      expect(flagged()).toBe(false);
      type('1.62');
      type('1.625');
      key('ArrowUp');
      expect(commits).toEqual([1.625, 1.62, 1.625, 1.75]);
    });

    it('typing back the figure the box displayed reads it as displayed', () => {
      // 1.62539 in shows as "1.625" and edits as "1.62539".
      render({ value: 1.62539 });
      expect(input().value).toBe('1.625');
      focus();
      expect(input().value).toBe('1.62539');
      type('1.625');
      expect(commits).toEqual([1.625]);
      expect(flagged()).toBe(false);
    });
  });
}

describe('NumField — a number typed from scratch is read as before', () => {
  it('decimal-comma: "2.375" is still refused (it is how 2375 is written), "2,375" is 2.375', () => {
    locale.decimalComma = true;
    render({ value: 1.625 });
    focus();
    type('2.375');
    expect(commits).toEqual([]);
    expect(flagged()).toBe(true);
    type('2,375');
    expect(commits).toEqual([2.375]);
  });

  it('decimal-comma: the box\'s own text is its own only until it loses focus', () => {
    // Focused on 1.625, "1.625" is the box's own figure. Handed 2 (an undo, a
    // new selection) and focused again, a typed "1.625" is a new number, and
    // reads as one would there: ambiguous, refused.
    locale.decimalComma = true;
    render({ value: 1.625 });
    focus();
    blur();
    rerender({ value: 2 });
    focus();
    type('1.625');
    expect(commits).toEqual([]);
    expect(flagged()).toBe(true);
  });

  it('decimal-point: "10,000" is still refused, "1,5" is still 1.5', () => {
    locale.decimalComma = false;
    render({ value: 1.625 });
    focus();
    type('10,000');
    expect(commits).toEqual([]);
    expect(flagged()).toBe(true);
    type('1,5');
    expect(commits).toEqual([1.5]);
  });
});
