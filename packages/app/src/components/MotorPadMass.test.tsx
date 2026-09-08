// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { MotorPadMass } from './MotorPadMass.js';
import type { HardwareMassResult } from '../services/hardwareMass.js';

/**
 * The field under the motor (v0.118) and the line beneath it. The arithmetic
 * is pinned in services/hardwareMass.test.ts; this pins the unit boundary on
 * the way IN — a pad weight typed in grams or ounces must reach App in
 * kilograms, or the hardware it derives is off by 1,000x or 28x — and the
 * sentence on the way OUT for every state the arithmetic can return, with the
 * Monster Mamba figures (10,574 g on the pad, 9,308 g airframe, AeroTech J540R
 * at 1,084 g: 182 g of hardware). The stale-set rendering is the one Eric's
 * second screenshot is about: a kept number must never LOOK live.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PREFS_KEY = 'online-openrocket.prefs.v1';
const OZ = 0.0283495231; // units.ts's own factor

let host: HTMLDivElement;
let root: Root;
let changes: (number | null)[];

beforeEach(() => {
  localStorage.clear();
  changes = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

const MAMBA: HardwareMassResult = {
  state: 'ok', deltaKg: 0.182, appliedTo: 'mmt', motorCount: 1, perMotorShiftKg: 0.182,
  motorMassKg: 1.084, mountCount: 1, dryMassKg: 9.308, drySource: 'measured', large: false,
};

const MOUNTS: Record<string, string> = { mmt: 'Sustainer MMT', booster: 'Booster MMT' };
/** What App's describeIdentity does for the two spellings these tests use. */
const describeId = (identity: string) => identity.startsWith('unmatched:')
  ? `${identity.slice('unmatched:'.length)} (named by the file, not loaded)`
  : identity.split('/').pop()!;

type Props = Parameters<typeof MotorPadMass>[0];
/** The Mamba's sustainer mount with the J540R loaded and no pad mass typed. */
const show = (over: Partial<Props> = {}) => act(() => root.render(
  <PrefsProvider>
    <MotorPadMass
      mountId="mmt"
      motorLabel="J540R"
      mountName="75mm MMT"
      multiMotor={false}
      valueKg={null}
      legacyPending={false}
      onChange={(kg) => changes.push(kg)}
      computedPadMassKg={10.392}
      hardware={{ state: 'none', why: 'no-pad-mass' }}
      nameOfMount={(id) => MOUNTS[id] ?? id}
      describeIdentity={describeId}
      identityKey="AeroTech/J540R"
      {...over}
    />
  </PrefsProvider>,
));

const input = () => host.querySelector('input')!;
const line = () => host.querySelector('#pad-mass-mmt-line')!;
const text = () => line().textContent!;
const imperial = () => localStorage.setItem(
  PREFS_KEY, JSON.stringify({ units: { mass: 'oz', length: 'in' } }));

/** Native setter + input event — how React sees a real keystroke. */
const type = (el: HTMLInputElement, s: string) => act(() => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, s);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

const stale = (changes: Extract<HardwareMassResult, { state: 'stale-set' }>['changes']): HardwareMassResult =>
  ({ state: 'stale-set', changes });

describe('MotorPadMass — the unit boundary', () => {
  it('sends the typed value up in kilograms, and null when cleared', () => {
    show();
    type(input(), '10574');
    expect(changes.at(-1)).toBeCloseTo(10.574, 12);
    type(input(), '');
    expect(changes.at(-1)).toBeNull();
    // The label reaches the input, so clicking it focuses the field.
    expect(host.querySelector('label')!.getAttribute('for')).toBe('pad-mass-mmt');
    expect(input().id).toBe('pad-mass-mmt');
  });

  it('converts ounces on the way in and shows the stored SI back in ounces', () => {
    imperial();
    show();
    type(input(), '373');
    expect(changes.at(-1)).toBeCloseTo(373 * OZ, 12);
    show({ valueKg: 373 * OZ });
    expect(Number(input().value)).toBeCloseTo(373, 6);
    // And the placeholder follows the same preference: 10.392 kg = 366.6 oz.
    expect(Number(input().getAttribute('placeholder'))).toBeCloseTo(366.6, 0);
  });

  it('the placeholder is the uncorrected pad mass in the display unit', () => {
    show({ computedPadMassKg: 10.392 });
    expect(input().getAttribute('placeholder')).toBe('10392');
  });

  it('has no placeholder without a motor mass', () => {
    show({ computedPadMassKg: null });
    expect(input().getAttribute('placeholder')).toBeNull();
  });
});

describe('MotorPadMass — the line under the field', () => {
  it('blank: says it is flying at the catalogue weight, what to do, and to re-weigh for each motor', () => {
    show();
    expect(text()).toBe('Blank — flying at the catalogue motor weight, 10392 g on the pad. Weigh the rocket ready to fly, with this motor in, and type it here: it is used at once and carries the adapter, retainer and closure the catalogue weight leaves out. Re-weigh for each motor.');
    // A plain state, not a status: nothing has been refused.
    expect(line().className).toBe('comp-stats');
    expect(line().getAttribute('role')).toBeNull();
    // No motor mass to add to the dry mass: the pad figure is simply omitted.
    show({ computedPadMassKg: null });
    expect(text()).toContain('catalogue motor weight. Weigh the rocket');
    expect(text()).not.toContain('on the pad');
    // The same sentence when the build has not run yet.
    show({ hardware: undefined });
    expect(text()).toContain('Blank — flying at the catalogue motor weight');
  });

  it('legacyPending renders the field blank with the blank-state line even when a value is present', () => {
    // A v0.116 value the reconcile effect has not decided yet: the arithmetic
    // may be about to refuse it, so it must not look live for even one frame.
    show({ valueKg: 10.574, legacyPending: true, hardware: MAMBA });
    expect(input().value).toBe('');
    expect(text()).toContain('Blank — flying at the catalogue motor weight');
    expect(host.querySelector('.measured-delta')).toBeNull();
    expect(host.querySelector('.field-stale')).toBeNull();
  });

  it('names what it carried against which catalogue motor, the motor it was weighed with, and that the next Launch flies it — the Mamba', () => {
    show({ valueKg: 10.574, hardware: MAMBA });
    expect(input().value).toBe('10574');
    expect(text()).toBe('182 g carried as hardware — adapter, retainer, closure: 10574 g weighed − dry 9308 g as you measured it − catalogue J540R 1084 g. Weighed with J540R; re-weigh if you change it. The next Launch flies it.');
    expect(text()).not.toContain('Carried on');
    expect(text()).not.toContain('check the entry');
    // The carried figure is the highlighted one, like the deltas in the box.
    expect(host.querySelector('#pad-mass-mmt-line .measured-delta')!.textContent).toBe('182 g');
    expect(line().className).toBe('comp-stats');
    expect(host.querySelector('.field-stale')).toBeNull();
  });

  it('quotes the same line in ounces', () => {
    imperial();
    show({ valueKg: 10.574, hardware: MAMBA });
    // 0.182 kg = 6.42 oz; 1.084 kg = 38.2 oz; 10.574 kg = 373 oz.
    expect(text()).toMatch(/^6\.4\d* oz carried as hardware/);
    expect(text()).toMatch(/38\.\d+ oz/);
    expect(text()).toMatch(/\b373 oz weighed/);
    expect(host.querySelector('.measured-delta')!.textContent).toMatch(/^6\.4\d* oz$/);
  });

  it('says how the delta is split across a cluster, and cautions a large one', () => {
    show({
      valueKg: 1.5, motorLabel: 'D12', multiMotor: true,
      hardware: {
        state: 'ok', deltaKg: 0.2, appliedTo: 'mmt', motorCount: 3, perMotorShiftKg: 0.2 / 3,
        motorMassKg: 0.3, mountCount: 1, dryMassKg: 1.0, drySource: 'computed', large: true,
      },
    });
    expect(text()).toContain('200 g carried as hardware');
    expect(text()).toContain('as computed');
    expect(text()).toContain('(×3, 66.7 g each)');
    expect(text()).toContain('More than half the motor’s own weight — check the entry.');
    expect(text()).toContain('Weighed with D12;');
  });

  it('with two mounts, words the summed catalogue mass as motors on two mounts and names the mount it is carried on', () => {
    // Sustainer J540R (1,084 g) plus a 500 g booster motor: the 1,584 g total
    // must not read as "catalogue J540R 1584 g".
    show({
      valueKg: 11.158, mountName: 'Sustainer MMT', multiMotor: true,
      hardware: {
        state: 'ok', deltaKg: 0.266, appliedTo: 'mmt', motorCount: 1, perMotorShiftKg: 0.266,
        motorMassKg: 1.584, mountCount: 2, dryMassKg: 9.308, drySource: 'measured', large: false,
      },
    });
    expect(text()).toContain('266 g carried as hardware');
    expect(text()).toContain('11158 g weighed');
    expect(text()).toContain('catalogue motors on 2 mounts 1584 g');
    expect(text()).not.toContain('J540R 1584');
    expect(text()).toContain(' Carried on Sustainer MMT.');
    expect(text()).not.toContain('×');
    // The weighing was of the SET: the closing sentence must not read as the
    // sustainer alone, because a booster swap stops it applying too.
    expect(text()).toContain(' Weighed with J540R and the rest of this motor set; re-weigh if any of them changes. The next Launch flies it.');
    expect(text()).not.toContain('Weighed with J540R;');
  });

  it('a number in the field never sits over "Blank": no build → not applied, says to fix the error', () => {
    // `built` is null on a build error, so App passes hardware undefined —
    // the one moment the user is already confused.
    show({ valueKg: 7.48, hardware: undefined });
    expect(Number(input().value)).toBeCloseTo(7480, 6);
    expect(text()).toBe('Not applied — the design could not be built; fix the error above and the pad mass applies again.');
    expect(text()).not.toContain('Blank');
    expect(line().getAttribute('role')).toBe('status');
    // A build that saw no pad mass under a shown number cannot happen (App
    // reads the record the field does), but it must not say "Blank" either.
    show({ valueKg: 7.48, hardware: { state: 'none', why: 'no-pad-mass' } });
    expect(text()).toBe('Not applied yet — the next build checks it.');
    // No value and no build: the blank-state line, as before.
    show({ valueKg: null, hardware: undefined });
    expect(text()).toMatch(/^Blank — flying at the catalogue motor weight/);
    // The kernel-refused sentence is what a refused PRIMARY gets, with the
    // number still in the field (App passes the record from `assigned`).
    show({ valueKg: 10.574, hardware: { state: 'none', why: 'no-motor' } });
    expect(Number(input().value)).toBeCloseTo(10574, 6);
    expect(text()).toBe('The simulation kernel refused this motor\'s curve, so there is nothing to subtract the pad mass from — nothing is carried.');
  });

  it('stale set: greys the field (field-stale, aria-invalid), names the motor it was weighed with and the one now loaded, as a status not an alert, and applies nothing', () => {
    // The LEM-IV: sustainer weighed with an I284W in the booster, booster
    // then swapped to a J350W. The number is KEPT — swapping back re-applies
    // it — so it must read as not-live without becoming unreadable.
    show({
      valueKg: 10.574,
      hardware: stale([{ mountId: 'booster', kind: 'changed', was: 'AeroTech/I284W', now: 'AeroTech/J350W', wasCount: 1, nowCount: 1 }]),
    });
    expect(host.querySelector('.field')!.classList.contains('field-stale')).toBe(true);
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(input().getAttribute('aria-describedby')).toBe('pad-mass-mmt-line');
    expect(input().value).toBe('10574');
    expect(line().getAttribute('role')).toBe('status');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(line().classList.contains('print-note-warn')).toBe(true);
    expect(text()).toBe('Not applied — weighed with I284W on Booster MMT, which now has J350W. Re-weigh with these motors in and type it again, or clear the field.');
    expect(host.querySelector('.measured-delta')).toBeNull();
    // And a live value carries none of that.
    show({ valueKg: 10.574, hardware: MAMBA });
    expect(host.querySelector('.field-stale')).toBeNull();
    expect(input().getAttribute('aria-invalid')).toBeNull();
    expect(input().getAttribute('aria-describedby')).toBe('pad-mass-mmt-line');
  });

  it('stale set wording for a mount with no motor, a mount that gained one, a cluster count change, and a motor the file could not load', () => {
    show({ valueKg: 10.574, hardware: stale([{ mountId: 'booster', kind: 'missing', was: 'AeroTech/I284W', wasCount: 1 }]) });
    expect(text()).toBe('Not applied — Booster MMT has no motor now; it was weighed with I284W in it. Re-weigh with these motors in and type it again, or clear the field.');

    show({ valueKg: 10.574, hardware: stale([{ mountId: 'booster', kind: 'new', now: 'AeroTech/J350W', nowCount: 1 }]) });
    expect(text()).toBe('Not applied — Booster MMT has gained a motor (J350W) since the weighing. Re-weigh with these motors in and type it again, or clear the field.');

    show({ valueKg: 10.574, hardware: stale([{ mountId: 'mmt', kind: 'count', was: 'AeroTech/J540R', wasCount: 1, nowCount: 3 }]) });
    expect(text()).toBe('Not applied — Sustainer MMT now holds 3 motors; it was weighed with 1. Re-weigh with these motors in and type it again, or clear the field.');
    show({ valueKg: 10.574, hardware: stale([{ mountId: 'mmt', kind: 'count', was: 'AeroTech/J540R', wasCount: 3, nowCount: 1 }]) });
    expect(text()).toContain('Sustainer MMT now holds 1 motor; it was weighed with 3.');

    // The file named a booster motor the app could not load: the pad mass
    // was weighed with it in, so loading it is what satisfies the weighing.
    show({ valueKg: 10.574, hardware: stale([{ mountId: 'booster', kind: 'missing', was: 'unmatched:K550W', wasCount: 1 }]) });
    expect(text()).toBe('Not applied — the motor the file names for Booster MMT (K550W) is not loaded; the pad mass was weighed with it in — load it to use the pad mass. Re-weigh with these motors in and type it again, or clear the field.');

    // Two mounts changed at once: one clause each, joined.
    show({
      valueKg: 10.574,
      hardware: stale([
        { mountId: 'booster', kind: 'missing', was: 'AeroTech/I284W', wasCount: 1 },
        { mountId: 'mmt', kind: 'count', was: 'AeroTech/J540R', wasCount: 1, nowCount: 2 },
      ]),
    });
    expect(text()).toContain('in it; Sustainer MMT now holds 2 motors');
    for (const p of host.querySelectorAll('#pad-mass-mmt-line')) expect(p.getAttribute('role')).toBe('status');
  });

  it('a refused motor curve: says nothing is carried', () => {
    show({ valueKg: 10.574, hardware: { state: 'none', why: 'no-motor' } });
    expect(text()).toBe('The simulation kernel refused this motor\'s curve, so there is nothing to subtract the pad mass from — nothing is carried.');
    expect(line().className).toBe('comp-stats');
  });

  it('no mass curve', () => {
    show({ valueKg: 10.574, hardware: { state: 'none', why: 'no-mass-curve' } });
    expect(text()).toBe('The catalogue motor carries no mass curve, so the hardware cannot be separated from it.');
    expect(line().className).toBe('comp-stats');
  });

  it('refuses a pad weight lighter than dry plus motor', () => {
    // Eric's second screenshot, in its new home: the refusal names the
    // catalogue motor it subtracted, because "a different motor" is the
    // likeliest cause and the user cannot check that against a number they
    // cannot see. A status, not an alert — every keystroke re-renders it.
    show({
      valueKg: 7.0, motorLabel: 'J460T',
      hardware: {
        state: 'implausible', reason: 'negative', deltaKg: -0.351, motorMassKg: 0.801,
        mountCount: 1, dryMassKg: 6.55, drySource: 'computed',
      },
    });
    expect(text()).toBe('Weighed pad mass is 351 g LIGHTER than the dry rocket plus the catalogue J460T (801 g) — a typo or a different motor. Nothing is carried.');
    expect(line().getAttribute('role')).toBe('status');
    expect(line().classList.contains('print-note-warn')).toBe(true);
    expect(host.querySelector('.measured-delta')).toBeNull();
    // Two mounts: the summed catalogue mass is not put beside one motor's name.
    show({
      valueKg: 7.0, motorLabel: 'J460T',
      hardware: {
        state: 'implausible', reason: 'negative', deltaKg: -0.351, motorMassKg: 1.301,
        mountCount: 2, dryMassKg: 6.55, drySource: 'computed',
      },
    });
    expect(text()).toContain('plus the catalogue motors on 2 mounts (1301 g)');
  });

  it('refuses hardware heavier than the airframe', () => {
    show({
      valueKg: 105.74,
      hardware: {
        state: 'implausible', reason: 'heavier-than-airframe', deltaKg: 95.348, motorMassKg: 1.084,
        mountCount: 1, dryMassKg: 9.308, drySource: 'measured',
      },
    });
    expect(text()).toBe('That would carry 95348 g as hardware — more than the airframe itself. A typo or a different motor; nothing is carried.');
    expect(line().getAttribute('role')).toBe('status');
    expect(host.querySelector('.measured-delta')).toBeNull();
  });
});

describe('MotorPadMass — label, help and remounting', () => {
  it('on a multi-motor design the label, help and blank line say every motor in', () => {
    show({ multiMotor: true });
    expect(host.querySelector('label')!.textContent).toContain('Weighed pad mass with every motor in');
    expect(host.querySelector('.field')!.getAttribute('title'))
      .toBe('Weigh the rocket ready to fly, with every motor in. Used at once; it carries the adapter, retainer and closure the catalogue motor weight leaves out. Re-weigh for each motor set.');
    expect(text()).toContain('with every motor in, and type it here');
    expect(text()).toContain('Re-weigh for each motor set.');
    // The aria name is per motor either way — tests and screen readers find
    // it by the same prefix.
    expect(input().getAttribute('aria-label')).toBe('Weighed pad mass with J540R');

    show({ multiMotor: false });
    expect(host.querySelector('label')!.textContent).toContain('Weighed pad mass with this motor');
    expect(host.querySelector('label')!.textContent).not.toContain('every motor');
    expect(host.querySelector('.field')!.getAttribute('title'))
      .toBe('Weigh the rocket ready to fly, with this motor in. Used at once; it carries the adapter, retainer and closure the catalogue motor weight leaves out. Re-weigh for each motor.');
    expect(text()).toContain('Re-weigh for each motor.');
    expect(text()).not.toContain('motor set');
  });

  it('the input remounts on a motor swap (key) but not on a delay edit', () => {
    show();
    const before = input();
    type(before, '105');
    expect(before.value).toBe('105');
    // A delay edit changes nothing the key is built from: same node, and the
    // half-typed draft survives — as it should, it is the same motor.
    show({ hardware: { state: 'none', why: 'no-pad-mass' } });
    expect(input()).toBe(before);
    expect(input().value).toBe('105');
    // A motor swap changes the identity: a fresh input, no draft from the old
    // motor left in it.
    show({ identityKey: 'AeroTech/J350W', motorLabel: 'J350W' });
    expect(input()).not.toBe(before);
    expect(input().value).toBe('');
    // Without an identityKey the delay-stripped label stands in.
    show({ identityKey: undefined, motorLabel: 'J350W' });
    const fallback = input();
    type(fallback, '99');
    show({ identityKey: undefined, motorLabel: 'J350W' });
    expect(input()).toBe(fallback);
    show({ identityKey: undefined, motorLabel: 'K550W' });
    expect(input()).not.toBe(fallback);
  });
});
