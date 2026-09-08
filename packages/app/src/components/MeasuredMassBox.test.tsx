// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { MeasuredMassBox } from './MeasuredMassBox.js';
import type { BallastSolution } from '../services/buildAllowance.js';
import type { HardwareMassResult } from '../services/hardwareMass.js';
import type { MeasuredFigures } from '../services/orkFile.js';

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
let changes: MeasuredFigures[];
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

/**
 * Computed airframe: 1.000 kg balancing 500 mm from the nose tip, 1 m long.
 * `extra` is the pad-weight side (2026-09-07); its default is the state every
 * pre-field test ran under — no pad mass entered, so the line under the box
 * asks for one and nothing else changes.
 */
const show = (measured: MeasuredFigures, extra: {
  hardware?: HardwareMassResult;
  computedPadMassKg?: number | null;
  motorLabel?: string;
  mountName?: string;
} = {}) => act(() => root.render(
  <PrefsProvider>
    <MeasuredMassBox
      bareMassKg={1}
      bareCgM={0.5}
      rocketLengthM={1}
      hasAllowance={false}
      measured={measured}
      onChange={(n) => changes.push(n)}
      onApply={(s) => applied.push(s)}
      hardware={extra.hardware ?? { state: 'none', why: 'no-pad-mass' }}
      computedPadMassKg={extra.computedPadMassKg}
      motorLabel={extra.motorLabel}
      mountName={extra.mountName}
    />
  </PrefsProvider>,
));

const field = (label: string) =>
  [...host.querySelectorAll('input')].find((i) => i.getAttribute('aria-label')?.startsWith(label))!;
const massBox = () => field('Measured mass');
const cgBox = () => field('Measured balance point');
const padBox = () => field('Weighed pad mass');

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

/**
 * The third field and the line under the box (2026-09-07). The arithmetic is
 * pinned in services/hardwareMass.test.ts; this pins the unit boundary on the
 * way IN — a pad weight typed in grams or ounces must reach App in kilograms,
 * or the hardware it derives is off by 1,000x or 28x — and the sentence on
 * the way OUT, with the Monster Mamba figures (10,574 g on the pad, 9,308 g
 * airframe, AeroTech J540R at 1,084 g: 182 g of hardware).
 */
describe('MeasuredMassBox — pad weight and the hardware line', () => {
  const MAMBA: HardwareMassResult = {
    state: 'ok', deltaKg: 0.182, appliedTo: 'mmt', motorCount: 1, perMotorShiftKg: 0.182,
    motorMassKg: 1.084, mountCount: 1, dryMassKg: 9.308, drySource: 'measured', large: false,
  };
  const line = () => host.querySelector('.measured-hardware')!.textContent!;

  it('sends the pad weight up in kilograms and leaves the other two figures alone', () => {
    show({ massKg: 9.308, cgM: 0.9 });
    type(padBox(), '10574');
    expect(changes.at(-1)!.padMassKg).toBeCloseTo(10.574, 12);
    expect(changes.at(-1)!.massKg).toBe(9.308);
    expect(changes.at(-1)!.cgM).toBe(0.9);
  });

  it('clearing the pad weight yields null, not zero', () => {
    show({ massKg: 9.308, cgM: 0.9, padMassKg: 10.574 });
    expect(padBox().value).toBe('10574');
    type(padBox(), '');
    expect(changes.at(-1)!.padMassKg).toBeNull();
    expect(changes.at(-1)!.massKg).toBe(9.308);
  });

  it('converts ounces on the way in and shows the stored SI back in ounces', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ units: { mass: 'oz', length: 'in' } }));
    show({ massKg: null, cgM: null });
    type(padBox(), '373');
    expect(changes.at(-1)!.padMassKg).toBeCloseTo(373 * OZ, 12);
    show({ massKg: null, cgM: null, padMassKg: 373 * OZ });
    expect(Number(padBox().value)).toBeCloseTo(373, 6);
  });

  it('the placeholder is the uncorrected pad mass in the display unit', () => {
    show({ massKg: null, cgM: null }, { computedPadMassKg: 10.392 });
    expect(padBox().getAttribute('placeholder')).toBe('10392');
  });

  it('has no placeholder when there is no motor to add to the dry mass', () => {
    show({ massKg: null, cgM: null }, { computedPadMassKg: null });
    expect(padBox().getAttribute('placeholder')).toBeNull();
  });

  it('names what it carried, on which mount, against which catalogue motor — the Mamba', () => {
    show({ massKg: 9.308, cgM: 0.9, padMassKg: 10.574 },
      { hardware: MAMBA, motorLabel: 'AeroTech J540R', mountName: '75mm MMT' });
    const text = line();
    expect(text).toContain('1266 g');
    expect(text).toContain('AeroTech J540R');
    expect(text).toContain('1084 g');
    expect(text).toContain('182 g');
    expect(text).toContain('75mm MMT');
    expect(text).toContain('as you measured it');
    expect(text).not.toContain('check the entry');
    // The carried figure is the highlighted one, like the deltas above it.
    expect(host.querySelector('.measured-hardware .measured-delta')!.textContent).toBe('182 g');
  });

  it('quotes the same line in ounces when those are selected', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ units: { mass: 'oz', length: 'in' } }));
    show({ massKg: 9.308, cgM: 0.9, padMassKg: 10.574 },
      { hardware: MAMBA, motorLabel: 'AeroTech J540R', mountName: '75mm MMT' });
    // 0.182 kg = 6.42 oz; 1.084 kg = 38.2 oz.
    expect(line()).toMatch(/6\.4\d* oz/);
    expect(line()).toMatch(/38\.\d+ oz/);
  });

  it('says how the delta is split across a cluster, and cautions a large one', () => {
    show({ massKg: null, cgM: null, padMassKg: 1.36 }, {
      hardware: {
        state: 'ok', deltaKg: 0.2, appliedTo: 'mmt', motorCount: 3, perMotorShiftKg: 0.2 / 3,
        motorMassKg: 0.3, mountCount: 1, dryMassKg: 1.0, drySource: 'computed', large: true,
      },
      motorLabel: 'Estes D12', mountName: 'Cluster',
    });
    expect(line()).toContain('×3');
    expect(line()).toContain('as computed');
    expect(line()).toContain('check the entry');
  });

  it('with two mounts, words the summed catalogue mass as motors on two mounts, not as the primary', () => {
    // Sustainer J540R (1,084 g) plus a 500 g booster motor: the 1,584 g total
    // must not read as "catalogue AeroTech J540R 1584 g".
    show({ massKg: 9.308, cgM: 0.9, padMassKg: 11.158 }, {
      hardware: {
        state: 'ok', deltaKg: 0.266, appliedTo: 's-mmt', motorCount: 1, perMotorShiftKg: 0.266,
        motorMassKg: 1.584, mountCount: 2, dryMassKg: 9.308, drySource: 'measured', large: false,
      },
      motorLabel: 'AeroTech J540R', mountName: 'Sustainer MMT',
    });
    expect(line()).toContain('Motors and hardware: 1850 g');
    expect(line()).toContain('catalogue motors on 2 mounts 1584 g');
    expect(line()).not.toContain('AeroTech J540R 1584');
    expect(line()).toContain('266 g');
    expect(line()).toContain('Sustainer MMT');
  });

  it('asks for the pad weight when none is entered', () => {
    show({ massKg: null, cgM: null });
    expect(line()).toContain('Enter the weighed pad mass');
  });

  it('asks for a motor when there is a pad weight and nothing to subtract it from', () => {
    show({ massKg: null, cgM: null, padMassKg: 10.574 }, { hardware: { state: 'none', why: 'no-motor' } });
    expect(line()).toContain('Assign a motor');
  });

  it('refuses a pad weight lighter than dry plus motor, and carries nothing', () => {
    show({ massKg: null, cgM: null, padMassKg: 7.0 }, {
      hardware: {
        state: 'implausible', reason: 'negative', deltaKg: -0.351, motorMassKg: 0.801,
        mountCount: 1, dryMassKg: 6.55, drySource: 'computed',
      },
      motorLabel: 'AeroTech J460T',
    });
    expect(line()).toContain('351 g');
    expect(line()).toContain('LIGHTER');
    expect(line()).toContain('AeroTech J460T');
    expect(line()).toContain('Nothing is carried');
  });

  it('refuses hardware heavier than the airframe', () => {
    show({ massKg: null, cgM: null, padMassKg: 105.74 }, {
      hardware: {
        state: 'implausible', reason: 'heavier-than-airframe', deltaKg: 95.348, motorMassKg: 1.084,
        mountCount: 1, dryMassKg: 9.308, drySource: 'measured',
      },
    });
    expect(line()).toContain('more than the airframe itself');
    expect(line()).toContain('nothing is carried');
  });
});
