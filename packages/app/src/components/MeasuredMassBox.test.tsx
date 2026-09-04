// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { MeasuredMassBox } from './MeasuredMassBox.js';
import type { BallastSolution } from '../services/buildAllowance.js';

/**
 * THE UNIT BOUNDARY between a scale reading and the flight model.
 *
 * `solveBallast` is well covered (services/buildAllowance.test.ts) but it only
 * ever sees SI, so the layer that converts what the user typed — and the layer
 * that reads the answer back out — was unpinned. A slip here inserts a Build
 * allowance of the wrong mass at the wrong station and the app reports
 * success: swap uiToSi for siToUi with the default 'g' and a 1,240 g airframe
 * becomes 1,240,000 kg of ballast; with 'oz' selected the same slip is a
 * plausible-looking 28.35x. The result is a design whose CG and stability
 * margin are wrong in exactly the place the user trusted the app to be right.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PREFS_KEY = 'online-openrocket.prefs.v1';
const OZ = 0.0283495231; // units.ts's own factor
const IN = 0.0254;

let host: HTMLDivElement;
let root: Root;
let changes: { massKg: number | null; cgM: number | null }[];
let applied: Extract<BallastSolution, { kind: 'ok' }>[];

beforeEach(() => {
  localStorage.clear();
  changes = [];
  applied = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

/** Computed airframe: 1.000 kg balancing 500 mm from the nose tip, 1 m long. */
const show = (measured: { massKg: number | null; cgM: number | null }) => act(() => root.render(
  <PrefsProvider>
    <MeasuredMassBox
      bareMassKg={1}
      bareCgM={0.5}
      rocketLengthM={1}
      hasAllowance={false}
      measured={measured}
      onChange={(n) => changes.push(n)}
      onApply={(s) => applied.push(s)}
    />
  </PrefsProvider>,
));

const field = (label: string) =>
  [...host.querySelectorAll('input')].find((i) => i.getAttribute('aria-label')?.startsWith(label))!;
const massBox = () => field('Measured mass');
const cgBox = () => field('Measured balance point');

/** Native setter + input event — how React sees a real keystroke. */
const type = (input: HTMLInputElement, text: string) => act(() => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

describe('MeasuredMassBox — metric (the startup default: g and mm)', () => {
  it('sends grams up as kilograms and millimetres as metres', () => {
    show({ massKg: null, cgM: null });
    type(massBox(), '1240');
    expect(changes.at(-1)!.massKg).toBeCloseTo(1.24, 12);
    type(cgBox(), '512');
    expect(changes.at(-1)!.cgM).toBeCloseTo(0.512, 12);
  });

  it('shows a stored SI value back in the display unit', () => {
    show({ massKg: 1.24, cgM: 0.512 });
    expect(massBox().value).toBe('1240');
    expect(cgBox().value).toBe('512');
  });

  it('clearing a box yields null, not zero', () => {
    // Zero here would be a rocket that weighs nothing, and the verdict below
    // would read "1000 g LIGHTER than the model" for a build nobody weighed.
    show({ massKg: 1.24, cgM: 0.512 });
    type(massBox(), '');
    expect(changes.at(-1)!.massKg).toBeNull();
    expect(changes.at(-1)!.cgM).toBeCloseTo(0.512, 12);
  });

  it('the placeholder is the computed figure in the display unit', () => {
    show({ massKg: null, cgM: null });
    expect(massBox().getAttribute('placeholder')).toBe('1000');
    expect(cgBox().getAttribute('placeholder')).toBe('500');
  });
});

describe('MeasuredMassBox — imperial (oz and in)', () => {
  const imperial = () => localStorage.setItem(
    PREFS_KEY, JSON.stringify({ units: { mass: 'oz', length: 'in' } }));

  it('converts ounces to kilograms and inches to metres', () => {
    imperial();
    show({ massKg: null, cgM: null });
    type(massBox(), '40');
    expect(changes.at(-1)!.massKg).toBeCloseTo(40 * OZ, 12);
    type(cgBox(), '21.5');
    expect(changes.at(-1)!.cgM).toBeCloseTo(21.5 * IN, 12);
  });

  it('round-trips: what it displays, converted back, is what it was given', () => {
    imperial();
    show({ massKg: 40 * OZ, cgM: 21.5 * IN });
    expect(Number(massBox().value)).toBeCloseTo(40, 6);
    expect(Number(cgBox().value)).toBeCloseTo(21.5, 6);
  });
});

describe('MeasuredMassBox — the verdict quotes the same numbers back', () => {
  it('offers the ballast in the display unit and applies SI', () => {
    // 1.100 kg measured against 1.000 kg computed, both balancing at 500 mm:
    // 100 g of ballast, and it must go AT the CG or the balance point moves.
    show({ massKg: 1.1, cgM: 0.5 });
    const verdict = host.querySelector('.measured-verdict')!;
    expect(verdict.textContent).toContain('100 g');
    expect(verdict.textContent).toContain('500 mm');

    const apply = [...host.querySelectorAll('button')]
      .find((b) => /Build allowance/.test(b.textContent ?? ''))!;
    act(() => { apply.click(); });
    expect(applied).toHaveLength(1);
    expect(applied[0]!.massKg).toBeCloseTo(0.1, 9);
    expect(applied[0]!.stationM).toBeCloseTo(0.5, 9);
  });

  it('quotes the SAME solution in ounces and inches when those are selected', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ units: { mass: 'oz', length: 'in' } }));
    show({ massKg: 1.1, cgM: 0.5 });
    const verdict = host.querySelector('.measured-verdict')!.textContent!;
    // 0.1 kg = 3.53 oz, 0.5 m = 19.685 in. The SI handed to onApply is
    // unchanged — only the wording moves.
    expect(verdict).toMatch(/3\.5\d* oz/);
    expect(verdict).toMatch(/19\.68\d* in/);
    const apply = [...host.querySelectorAll('button')]
      .find((b) => /Build allowance/.test(b.textContent ?? ''))!;
    act(() => { apply.click(); });
    expect(applied[0]!.massKg).toBeCloseTo(0.1, 9);
    expect(applied[0]!.stationM).toBeCloseTo(0.5, 9);
  });

  it('says nothing to add when the build matches, and offers no button', () => {
    show({ massKg: 1, cgM: 0.5 });
    expect(host.querySelector('.measured-verdict')!.textContent)
      .toContain('Your build matches the model');
    expect([...host.querySelectorAll('button')]
      .filter((b) => /Build allowance/.test(b.textContent ?? ''))).toHaveLength(0);
  });

  it('shows no verdict at all until BOTH numbers are in', () => {
    show({ massKg: 1.1, cgM: null });
    expect(host.querySelector('.measured-verdict')).toBeNull();
  });
});
