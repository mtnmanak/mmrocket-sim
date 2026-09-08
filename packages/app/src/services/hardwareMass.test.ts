import { describe, expect, it } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import {
  catalogueMotorMass, flownSpec, hardwareMass, HARDWARE_MASS_TOLERANCE_KG, LARGE_HARDWARE_FRACTION,
  motorLoadedMass, shiftMotorMass,
} from './hardwareMass.js';

/**
 * The two flights this feature exists for, as fixtures (Eric, METRA, 2026-09-07):
 *
 *   Monster Mamba, AeroTech J540R: pad 10,574 g, airframe 9,308 g, catalogue
 *   1,084 g → 182 g of hardware (17 % of the motor).
 *   WM 4" Extreme, AeroTech J460T: pad 7,480 g, app's dry 6,550 g, catalogue
 *   801 g → 129 g (16 %).
 *
 * Both are asserted to the gram here; a slip in the arithmetic is a slip in
 * the pad mass every user flies from the moment they type the field.
 */

/** A J540R-shaped mass curve: 1,084 g loaded, 600 g at burnout. */
const J540R = (): MotorSpec => ({
  designation: 'J540R',
  diameter: 0.054,
  length: 0.41,
  cgX: 0.2,
  ejectionDelay: 10,
  times: [0, 0.1, 1.0, 2.0, 2.3],
  thrusts: [0, 600, 550, 300, 0],
  masses: [1.084, 1.05, 0.85, 0.65, 0.6],
});

/** A J460T-shaped one: 801 g loaded. */
const J460T = (): MotorSpec => ({
  ...J540R(),
  designation: 'J460T',
  masses: [0.801, 0.78, 0.65, 0.5, 0.44],
});

const spec = (masses: number[], designation = 'M'): MotorSpec => ({ ...J540R(), designation, masses });

/** Single stage with one mount, 'mmt', optionally clustered. */
const singleStage = (mount: Partial<ComponentNode> = {}): RocketTree => ({
  name: 'single',
  components: [{
    type: 'stage', id: 's1', name: 'Sustainer',
    children: [{
      type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.025, thickness: 0.0005,
      children: [{
        type: 'innertube', id: 'mmt', name: '75mm MMT', length: 0.4, outerRadius: 0.038,
        thickness: 0.0005, motorMount: true, ...mount,
      } as ComponentNode],
    } as ComponentNode],
  } as ComponentNode],
});

/** Two stages: sustainer mount 's-mmt' (stage 0), booster mount 'b-mmt' (stage 1). */
const twoStage = (): RocketTree => ({
  name: 'two',
  components: [
    {
      type: 'stage', id: 's1', name: 'Sustainer',
      children: [{
        type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.025, thickness: 0.0005,
        children: [{
          type: 'innertube', id: 's-mmt', length: 0.4, outerRadius: 0.038, thickness: 0.0005,
          motorMount: true,
        } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode,
    {
      type: 'stage', id: 's2', name: 'Booster',
      children: [{
        type: 'bodytube', id: 'b2', length: 0.5, outerRadius: 0.025, thickness: 0.0005,
        children: [{
          type: 'innertube', id: 'b-mmt', length: 0.4, outerRadius: 0.038, thickness: 0.0005,
          motorMount: true,
        } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode,
  ],
});

const ok = (r: ReturnType<typeof hardwareMass>) => {
  expect(r.state).toBe('ok');
  return r as Extract<typeof r, { state: 'ok' }>;
};
const implausible = (r: ReturnType<typeof hardwareMass>) => {
  expect(r.state).toBe('implausible');
  return r as Extract<typeof r, { state: 'implausible' }>;
};

describe('hardwareMass — the two flights it was built from', () => {
  it('Monster Mamba: 10.574 − 9.308 − 1.084 = 0.182 kg, measured dry mass wins over computed', () => {
    const r = ok(hardwareMass({
      padMassKg: 10.574,
      measuredDryMassKg: 9.308,
      computedDryMassKg: 9.25, // deliberately different: proves the measured figure is the one used
      tree: singleStage(),
      motors: [['mmt', { spec: J540R() }]],
      primaryMountId: 'mmt',
    }));
    expect(r.deltaKg).toBeCloseTo(0.182, 9);
    expect(r.drySource).toBe('measured');
    expect(r.dryMassKg).toBe(9.308);
    expect(r.motorMassKg).toBeCloseTo(1.084, 12);
    expect(r.appliedTo).toBe('mmt');
    expect(r.motorCount).toBe(1);
    expect(r.mountCount).toBe(1);
    expect(r.perMotorShiftKg).toBeCloseTo(0.182, 9);
    expect(r.large).toBe(false);
  });

  it('WM 4" Extreme: 7.480 − 6.550 − 0.801 = 0.129 kg from the computed dry mass', () => {
    const r = ok(hardwareMass({
      padMassKg: 7.48,
      measuredDryMassKg: null,
      computedDryMassKg: 6.55,
      tree: singleStage(),
      motors: [['mmt', { spec: J460T() }]],
      primaryMountId: 'mmt',
    }));
    expect(r.deltaKg).toBeCloseTo(0.129, 9);
    expect(r.drySource).toBe('computed');
    expect(r.dryMassKg).toBe(6.55);
    expect(r.large).toBe(false);
  });

  it('the shifted spec puts the pad mass on the first sample and keeps the hardware at burnout', () => {
    const r = ok(hardwareMass({
      padMassKg: 10.574, measuredDryMassKg: 9.308, computedDryMassKg: 9.308,
      tree: singleStage(), motors: [['mmt', { spec: J540R() }]], primaryMountId: 'mmt',
    }));
    const flown = flownSpec('mmt', J540R(), r);
    // 9.308 + 1.266 = 10.574: exact on the pad.
    expect(9.308 + flown.masses[0]!).toBeCloseTo(10.574, 9);
    // Burnout keeps the adapter: 0.6 + 0.182.
    expect(flown.masses.at(-1)).toBeCloseTo(0.782, 9);
    // Propellant burned is unchanged — the hardware does not burn.
    expect(flown.masses[0]! - flown.masses.at(-1)!).toBeCloseTo(1.084 - 0.6, 9);
  });
});

describe('hardwareMass — refusals', () => {
  it('refuses a pad mass LIGHTER than dry + catalogue motor, with the numbers', () => {
    // WM4's numbers with 7.0 kg on the pad: −351 g of "hardware".
    const r = implausible(hardwareMass({
      padMassKg: 7.0, measuredDryMassKg: null, computedDryMassKg: 6.55,
      tree: singleStage(), motors: [['mmt', { spec: J460T() }]], primaryMountId: 'mmt',
    }));
    expect(r.reason).toBe('negative');
    expect(r.deltaKg).toBeCloseTo(-0.351, 9);
    expect(r.motorMassKg).toBeCloseTo(0.801, 12);
    expect(r.mountCount).toBe(1);
    expect(r.dryMassKg).toBe(6.55);
    expect(r.drySource).toBe('computed');
    // And nothing is carried: the flown spec is the catalogue spec, same object.
    const catalogue = J460T();
    expect(flownSpec('mmt', catalogue, r)).toBe(catalogue);
  });

  it('refuses hardware heavier than the airframe (10,574 typed as 105,740)', () => {
    const r = implausible(hardwareMass({
      padMassKg: 105.74, measuredDryMassKg: 9.308, computedDryMassKg: 9.308,
      tree: singleStage(), motors: [['mmt', { spec: J540R() }]], primaryMountId: 'mmt',
    }));
    expect(r.reason).toBe('heavier-than-airframe');
    expect(r.deltaKg).toBeCloseTo(105.74 - 9.308 - 1.084, 9);
    expect(r.deltaKg).toBeGreaterThan(r.dryMassKg);
  });

  it('a hair under dry + motor is rounding: ok with a zero delta and an identity spec', () => {
    const catalogue = J540R();
    const r = ok(hardwareMass({
      padMassKg: 9.308 + 1.084 - HARDWARE_MASS_TOLERANCE_KG / 2,
      measuredDryMassKg: 9.308, computedDryMassKg: 9.308,
      tree: singleStage(), motors: [['mmt', { spec: catalogue }]], primaryMountId: 'mmt',
    }));
    expect(r.deltaKg).toBe(0);
    expect(r.perMotorShiftKg).toBe(0);
    expect(shiftMotorMass(catalogue, r.perMotorShiftKg)).toBe(catalogue);
    expect(flownSpec('mmt', catalogue, r)).toBe(catalogue);
  });

  it('just past the tolerance is a refusal, not a rounding', () => {
    const r = hardwareMass({
      padMassKg: 9.308 + 1.084 - HARDWARE_MASS_TOLERANCE_KG * 2,
      measuredDryMassKg: 9.308, computedDryMassKg: 9.308,
      tree: singleStage(), motors: [['mmt', { spec: J540R() }]], primaryMountId: 'mmt',
    });
    expect(r.state).toBe('implausible');
  });

  it('flags more than half the motor mass as large but still applies it', () => {
    // A small motor behind a big adapter: 120 g motor, 200 g of hardware.
    const r = ok(hardwareMass({
      padMassKg: 1.0 + 0.12 + 0.2, measuredDryMassKg: null, computedDryMassKg: 1.0,
      tree: singleStage(), motors: [['mmt', { spec: spec([0.12, 0.08, 0.06]) }]], primaryMountId: 'mmt',
    }));
    expect(r.large).toBe(true);
    expect(r.deltaKg).toBeCloseTo(0.2, 9);
    expect(0.2).toBeGreaterThan(LARGE_HARDWARE_FRACTION * 0.12);
    expect(flownSpec('mmt', spec([0.12, 0.08, 0.06]), r).masses[0]).toBeCloseTo(0.32, 9);
  });

  it('exactly at the fraction is not large', () => {
    const r = ok(hardwareMass({
      padMassKg: 1.0 + 1.0 + 0.5, measuredDryMassKg: null, computedDryMassKg: 1.0,
      tree: singleStage(), motors: [['mmt', { spec: spec([1.0, 0.5]) }]], primaryMountId: 'mmt',
    }));
    expect(r.deltaKg).toBeCloseTo(0.5, 9);
    expect(r.large).toBe(false);
  });
});

describe('hardwareMass — clusters and multiple mounts', () => {
  it('divides the shift by the cluster count so the kernel carries the delta once, not N times', () => {
    // 3-ring of 100 g motors, 1 kg dry, 1.36 kg on the pad: 60 g of hardware.
    const tree = singleStage({ cluster: '3-ring' });
    const motor = spec([0.1, 0.08, 0.05]);
    const r = ok(hardwareMass({
      padMassKg: 1.36, measuredDryMassKg: null, computedDryMassKg: 1.0,
      tree, motors: [['mmt', { spec: motor }]], primaryMountId: 'mmt',
    }));
    expect(r.motorMassKg).toBeCloseTo(0.3, 12);
    expect(r.deltaKg).toBeCloseTo(0.06, 9);
    expect(r.motorCount).toBe(3);
    expect(r.perMotorShiftKg).toBeCloseTo(0.02, 9);
    // Three copies of the shifted spec — what the kernel effectively flies —
    // sum to the whole delta.
    const flown = flownSpec('mmt', motor, r);
    const threeUp = 3 * (flown.masses[0]! - motor.masses[0]!);
    expect(threeUp).toBeCloseTo(0.06, 9);
  });

  it('sums every mount’s catalogue mass but carries the whole delta on the PRIMARY', () => {
    // Sustainer J540R (1.084) + booster 0.5 kg motor; 9.308 dry; 11.158 on the
    // pad → 11.158 − 9.308 − 1.584 = 0.266 kg, all of it on 's-mmt'.
    const sustainer = J540R();
    const booster = spec([0.5, 0.4, 0.3], 'booster');
    const r = ok(hardwareMass({
      padMassKg: 11.158, measuredDryMassKg: 9.308, computedDryMassKg: 9.308,
      tree: twoStage(),
      motors: [['b-mmt', { spec: booster }], ['s-mmt', { spec: sustainer }]],
      primaryMountId: 's-mmt',
    }));
    expect(r.motorMassKg).toBeCloseTo(1.584, 12);
    // Two mounts summed — what tells the derived line not to put the
    // two-motor total beside the sustainer motor's name.
    expect(r.mountCount).toBe(2);
    expect(r.deltaKg).toBeCloseTo(0.266, 9);
    expect(r.appliedTo).toBe('s-mmt');
    expect(r.perMotorShiftKg).toBeCloseTo(0.266, 9);
    // flownSpec shifts only the primary; the booster's spec is the same object.
    expect(flownSpec('s-mmt', sustainer, r).masses[0]).toBeCloseTo(1.35, 9);
    expect(flownSpec('b-mmt', booster, r)).toBe(booster);
  });

  it('catalogueMotorMass is cluster-aware and null when any curve lacks a mass column', () => {
    expect(catalogueMotorMass(singleStage({ cluster: '4-ring' }), [['mmt', { spec: spec([0.25]) }]]))
      .toBeCloseTo(1.0, 12);
    expect(catalogueMotorMass(twoStage(), [
      ['s-mmt', { spec: J540R() }], ['b-mmt', { spec: spec([]) }],
    ])).toBeNull();
    expect(catalogueMotorMass(singleStage(), [])).toBe(0);
  });
});

describe('hardwareMass — the none states', () => {
  const base = {
    measuredDryMassKg: 9.308, computedDryMassKg: 9.308, tree: singleStage(),
    motors: [['mmt', { spec: J540R() }]] as const, primaryMountId: 'mmt',
  };

  it('no pad mass: null, undefined, zero, negative, NaN', () => {
    for (const padMassKg of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(hardwareMass({ ...base, padMassKg })).toEqual({ state: 'none', why: 'no-pad-mass' });
    }
  });

  it('no motor: no mounts, no primary, or a primary the kernel refused', () => {
    expect(hardwareMass({ ...base, padMassKg: 10.574, motors: [] }))
      .toEqual({ state: 'none', why: 'no-motor' });
    expect(hardwareMass({ ...base, padMassKg: 10.574, primaryMountId: null }))
      .toEqual({ state: 'none', why: 'no-motor' });
    // The primary's motor failed at build and was filtered out of `motors`.
    expect(hardwareMass({
      ...base, padMassKg: 10.574, tree: twoStage(),
      motors: [['b-mmt', { spec: J540R() }]], primaryMountId: 's-mmt',
    })).toEqual({ state: 'none', why: 'no-motor' });
  });

  it('no mass curve: a motor with an empty or non-finite mass column', () => {
    expect(hardwareMass({ ...base, padMassKg: 10.574, motors: [['mmt', { spec: spec([]) }]] }))
      .toEqual({ state: 'none', why: 'no-mass-curve' });
    expect(hardwareMass({ ...base, padMassKg: 10.574, motors: [['mmt', { spec: spec([Number.NaN, 0.5]) }]] }))
      .toEqual({ state: 'none', why: 'no-mass-curve' });
  });

  it('flownSpec with no result, or a none result, is the catalogue spec itself', () => {
    const catalogue = J540R();
    expect(flownSpec('mmt', catalogue, undefined)).toBe(catalogue);
    expect(flownSpec('mmt', catalogue, { state: 'none', why: 'no-pad-mass' })).toBe(catalogue);
  });
});

describe('shiftMotorMass and motorLoadedMass', () => {
  it('shifts every mass sample and nothing else — the other arrays are the same references', () => {
    const catalogue = J540R();
    const shifted = shiftMotorMass(catalogue, 0.182);
    expect(shifted).not.toBe(catalogue);
    expect(shifted.masses).toEqual(catalogue.masses.map((m) => m + 0.182));
    expect(shifted.times).toBe(catalogue.times);
    expect(shifted.thrusts).toBe(catalogue.thrusts);
    expect(shifted.cgX).toBe(catalogue.cgX);
    expect(shifted.ejectionDelay).toBe(catalogue.ejectionDelay);
    expect(shifted.designation).toBe(catalogue.designation);
    expect(shifted.diameter).toBe(catalogue.diameter);
    expect(shifted.length).toBe(catalogue.length);
    // The catalogue spec itself is untouched.
    expect(catalogue.masses[0]).toBe(1.084);
  });

  it('is the identity on a zero shift', () => {
    const catalogue = J540R();
    expect(shiftMotorMass(catalogue, 0)).toBe(catalogue);
  });

  it('motorLoadedMass is the first sample, or null', () => {
    expect(motorLoadedMass(J540R())).toBe(1.084);
    expect(motorLoadedMass({ masses: [] })).toBeNull();
    expect(motorLoadedMass({ masses: [Number.NaN] })).toBeNull();
  });
});
