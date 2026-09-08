import { describe, expect, it } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import {
  catalogueMotorMass, changedMounts, flownSpec, hardwareMass, HARDWARE_MASS_TOLERANCE_KG,
  LARGE_HARDWARE_FRACTION, LEGACY_PAD_MASS_KEY, motorIdentity, motorLoadedMass, motorSetIdentity,
  parseSetIdentity, rekeyUnmatched, shiftMotorMass, type SetEntry,
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
    // Exactly what App passes for a refused primary since 2026-09-08: the
    // value and key from the primary's record (read from `assigned`, not the
    // accepted subset) with the keys equal — 'no-motor', never 'no-pad-mass',
    // so the line under the still-visible number says the kernel refused the
    // curve rather than "Blank".
    const key = '[["b-mmt","AeroTech/J540R",1],["s-mmt","AeroTech/K550W",1]]';
    expect(hardwareMass({
      ...base, padMassKg: 10.574, tree: twoStage(), weighedWith: key, currentSetKey: key,
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

describe('weighed-with identity', () => {
  /**
   * v0.118: the pad mass lives on the primary mount's record, keyed by the
   * identity of the motor SET it was weighed with. A set that differs is
   * refused as 'stale-set' before any arithmetic — the measurement covers
   * every motor in the stack, so a booster swap, an emptied or newly loaded
   * mount, or a cluster-count change makes the catalogue sum a different
   * number from the one on the scale.
   */
  const at = (mountId: string, identity: string, count = 1): SetEntry => [mountId, identity, count];

  it('motorIdentity: EX id wins, else manufacturer/designation, spelled as the run keys always were', () => {
    expect(motorIdentity({ manufacturer: 'AeroTech' }, 'J540R')).toBe('AeroTech/J540R');
    expect(motorIdentity({ exMotorId: 'ex:loki-k1100t', manufacturer: 'EX' }, 'K1100T')).toBe('ex:loki-k1100t');
    // No manufacturer at all: the slash still leads — the exact term App's
    // motorSetKeyOf has always produced, so stored run keys do not move.
    expect(motorIdentity({}, 'J540R')).toBe('/J540R');
  });

  it('motorSetIdentity is order-independent, excludes delay, plugged and ignition, and includes the cluster count', () => {
    const a = motorSetIdentity([at('s-mmt', 'AeroTech/J540R'), at('b-mmt', 'AeroTech/I284W')]);
    const b = motorSetIdentity([at('b-mmt', 'AeroTech/I284W'), at('s-mmt', 'AeroTech/J540R')]);
    expect(a).toBe(b);
    expect(a.startsWith('[')).toBe(true);
    expect(parseSetIdentity(a)).toEqual([['b-mmt', 'AeroTech/I284W', 1], ['s-mmt', 'AeroTech/J540R', 1]]);
    // Two records that differ only in delay, plugged and ignition spell the
    // same entry: the hardware does not change with the delay grain.
    const drilled = {
      spec: { ...J540R(), ejectionDelay: 10 }, meta: { label: 'J540R', manufacturer: 'AeroTech' },
      ignition: { event: 'automatic', delay: 0 },
    };
    const plugged = {
      spec: { ...J540R(), ejectionDelay: Number.POSITIVE_INFINITY }, meta: drilled.meta,
      ignition: { event: 'burnout', delay: 1 },
    };
    const entryOf = (mm: typeof drilled) => at('mmt', motorIdentity(mm.meta, mm.spec.designation));
    expect(motorSetIdentity([entryOf(drilled)])).toBe(motorSetIdentity([entryOf(plugged)]));
    // The cluster count IS part of it: catalogueMotorMass multiplies by it.
    expect(motorSetIdentity([at('mmt', 'AeroTech/J540R', 1)]))
      .not.toBe(motorSetIdentity([at('mmt', 'AeroTech/J540R', 3)]));
    // The caller's array is not reordered.
    const given = [at('s-mmt', 'AeroTech/J540R'), at('b-mmt', 'AeroTech/I284W')];
    motorSetIdentity(given);
    expect(given.map((e) => e[0])).toEqual(['s-mmt', 'b-mmt']);
  });

  it('changedMounts reports changed (with was/now and counts), missing, new and count, sorted by mount', () => {
    const was = motorSetIdentity([
      at('s-mmt', 'AeroTech/J540R'), at('b-mmt', 'AeroTech/I284W'), at('d-mmt', 'CTI/G80'), at('a-mmt', 'Estes/D12', 2),
    ]);
    const now = motorSetIdentity([
      at('s-mmt', 'AeroTech/J540R'), at('b-mmt', 'AeroTech/J350W'), at('c-mmt', 'AeroTech/H128W'), at('a-mmt', 'Estes/D12', 3),
    ]);
    expect(changedMounts(was, now)).toEqual([
      { mountId: 'a-mmt', kind: 'count', was: 'Estes/D12', wasCount: 2, nowCount: 3 },
      { mountId: 'b-mmt', kind: 'changed', was: 'AeroTech/I284W', now: 'AeroTech/J350W', wasCount: 1, nowCount: 1 },
      { mountId: 'c-mmt', kind: 'new', now: 'AeroTech/H128W', nowCount: 1 },
      { mountId: 'd-mmt', kind: 'missing', was: 'CTI/G80', wasCount: 1 },
    ]);
    // The same set: nothing differs.
    expect(changedMounts(was, was)).toEqual([]);
    // Identity AND count both differ: ONE 'changed' entry carrying both counts.
    expect(changedMounts(motorSetIdentity([at('m', 'A/x', 1)]), motorSetIdentity([at('m', 'A/y', 3)]))).toEqual([
      { mountId: 'm', kind: 'changed', was: 'A/x', now: 'A/y', wasCount: 1, nowCount: 3 },
    ]);
  });

  it('an unparsable stored key counts every current mount as new', () => {
    const now = motorSetIdentity([at('s-mmt', 'AeroTech/J540R'), at('b-mmt', 'AeroTech/I284W')]);
    for (const bad of ['', 'not json', '{"a":1}', '[["m","x"]]', '[1,2]', '[["m",1,1]]']) {
      expect(parseSetIdentity(bad), bad).toBeNull();
      expect(changedMounts(bad, now), bad).toEqual([
        { mountId: 'b-mmt', kind: 'new', now: 'AeroTech/I284W', nowCount: 1 },
        { mountId: 's-mmt', kind: 'new', now: 'AeroTech/J540R', nowCount: 1 },
      ]);
    }
  });

  it('rekeyUnmatched rewrites only the named mount’s unmatched: entry and leaves the count', () => {
    // A file whose sustainer K1100T (a 2-cluster) and booster J350W both
    // failed to match: the import keys the pad mass to two sentinels.
    const key = motorSetIdentity([at('s-mmt', 'unmatched:K1100T', 2), at('b-mmt', 'unmatched:J350W')]);
    const re = rekeyUnmatched(key, 's-mmt', 'AeroTech/K1100T');
    expect(parseSetIdentity(re)).toEqual([['b-mmt', 'unmatched:J350W', 1], ['s-mmt', 'AeroTech/K1100T', 2]]);
    // Once it is a real identity the mount is no longer a sentinel: identity return.
    expect(rekeyUnmatched(re, 's-mmt', 'AeroTech/Other')).toBe(re);
    // A mount the key does not have, or a key that is not a set identity: identity return.
    expect(rekeyUnmatched(key, 'x-mmt', 'AeroTech/K1100T')).toBe(key);
    expect(rekeyUnmatched(LEGACY_PAD_MASS_KEY, 's-mmt', 'AeroTech/K1100T')).toBe(LEGACY_PAD_MASS_KEY);
    // Loading both satisfies the whole weighing: the key then EQUALS the live set's.
    const both = rekeyUnmatched(re, 'b-mmt', 'AeroTech/J350W');
    expect(both).toBe(motorSetIdentity([at('s-mmt', 'AeroTech/K1100T', 2), at('b-mmt', 'AeroTech/J350W')]));
  });

  it('stale-set: a stored key that differs from the current set returns stale-set with the changes before any arithmetic', () => {
    // LEM-IV shape: sustainer J540R weighed with an I284W in the booster,
    // which now holds a J350W. A pad mass the arithmetic would REFUSE (7.0 kg
    // is lighter than dry + motors) still comes back stale-set — the set
    // check runs first, because the refusal would be about the wrong rocket.
    const weighedWith = motorSetIdentity([at('s-mmt', 'AeroTech/J540R'), at('b-mmt', 'AeroTech/I284W')]);
    const currentSetKey = motorSetIdentity([at('s-mmt', 'AeroTech/J540R'), at('b-mmt', 'AeroTech/J350W')]);
    const input = {
      padMassKg: 7.0, measuredDryMassKg: 9.308, computedDryMassKg: 9.308, tree: twoStage(),
      motors: [['s-mmt', { spec: J540R() }], ['b-mmt', { spec: spec([0.5, 0.4], 'J350W') }]] as const,
      primaryMountId: 's-mmt', weighedWith, currentSetKey,
    };
    const r = hardwareMass(input);
    expect(r).toEqual({
      state: 'stale-set',
      changes: [{ mountId: 'b-mmt', kind: 'changed', was: 'AeroTech/I284W', now: 'AeroTech/J350W', wasCount: 1, nowCount: 1 }],
    });
    // Nothing is carried: the flown spec is the catalogue spec, same object.
    const catalogue = J540R();
    expect(flownSpec('s-mmt', catalogue, r)).toBe(catalogue);
    // Step 1 still comes first: no pad mass is 'none', whatever the keys say.
    expect(hardwareMass({ ...input, padMassKg: null })).toEqual({ state: 'none', why: 'no-pad-mass' });
    // And the set check precedes 'no-motor' (step 2): stale-set is about the
    // rocket that was weighed, not the kernel's verdict on a curve.
    expect(hardwareMass({ ...input, motors: [], primaryMountId: null }).state).toBe('stale-set');
    // A mount emptied, and a mount newly loaded, read as their own kinds.
    expect(hardwareMass({
      ...input, currentSetKey: motorSetIdentity([at('s-mmt', 'AeroTech/J540R')]),
    })).toEqual({ state: 'stale-set', changes: [{ mountId: 'b-mmt', kind: 'missing', was: 'AeroTech/I284W', wasCount: 1 }] });
    expect(hardwareMass({
      ...input, weighedWith: motorSetIdentity([at('s-mmt', 'AeroTech/J540R')]),
    })).toEqual({ state: 'stale-set', changes: [{ mountId: 'b-mmt', kind: 'new', now: 'AeroTech/J350W', nowCount: 1 }] });
  });

  it('a cluster-count change alone is stale-set kind count', () => {
    // Weighed as a single, edited to a 3-ring on the Design tab: without the
    // count in the identity this would refuse the Mamba's 10,574 g as 'a typo'
    // (3 × 1,084 g of catalogue motor), and the reverse edit would fly 2 × 1,084 g
    // of phantom hardware with the number still live.
    const r = hardwareMass({
      padMassKg: 10.574, measuredDryMassKg: 9.308, computedDryMassKg: 9.308,
      tree: singleStage({ cluster: '3-ring' }), motors: [['mmt', { spec: J540R() }]], primaryMountId: 'mmt',
      weighedWith: motorSetIdentity([at('mmt', 'AeroTech/J540R', 1)]),
      currentSetKey: motorSetIdentity([at('mmt', 'AeroTech/J540R', 3)]),
    });
    expect(r).toEqual({
      state: 'stale-set',
      changes: [{ mountId: 'mmt', kind: 'count', was: 'AeroTech/J540R', wasCount: 1, nowCount: 3 }],
    });
  });

  it('equal keys fall through to the ok arithmetic, and no keys at all behave exactly as v0.116', () => {
    const key = motorSetIdentity([at('mmt', 'AeroTech/J540R')]);
    const base = {
      padMassKg: 10.574, measuredDryMassKg: 9.308, computedDryMassKg: 9.308, tree: singleStage(),
      motors: [['mmt', { spec: J540R() }]] as const, primaryMountId: 'mmt',
    };
    const v116 = hardwareMass(base);
    expect(ok(v116).deltaKg).toBeCloseTo(0.182, 9);
    expect(hardwareMass({ ...base, weighedWith: key, currentSetKey: key })).toEqual(v116);
    // One key without the other is not a comparison: v0.116's behaviour, byte
    // for byte. `weighedWith: undefined` is what App passes for the 'legacy'
    // sentinel, so a v0.116 value gets the arithmetic's verdict, not stale-set.
    expect(hardwareMass({ ...base, weighedWith: key })).toEqual(v116);
    expect(hardwareMass({ ...base, currentSetKey: key })).toEqual(v116);
    expect(hardwareMass({ ...base, weighedWith: undefined, currentSetKey: key })).toEqual(v116);
    // Equal keys do not rescue a refusal.
    expect(hardwareMass({ ...base, padMassKg: 7.0, weighedWith: key, currentSetKey: key }).state).toBe('implausible');
  });

  it('LEGACY_PAD_MASS_KEY is never a valid set identity', () => {
    expect(LEGACY_PAD_MASS_KEY).toBe('legacy');
    // Set identities are JSON arrays and start with '['; the sentinel cannot.
    expect(LEGACY_PAD_MASS_KEY.startsWith('[')).toBe(false);
    expect(parseSetIdentity(LEGACY_PAD_MASS_KEY)).toBeNull();
    expect(motorSetIdentity([])).toBe('[]');
    expect(motorSetIdentity([])).not.toBe(LEGACY_PAD_MASS_KEY);
    // Reaching the comparison by mistake it reads as stale-set, never as a match.
    const cur = motorSetIdentity([at('mmt', 'AeroTech/J540R')]);
    expect(changedMounts(LEGACY_PAD_MASS_KEY, cur))
      .toEqual([{ mountId: 'mmt', kind: 'new', now: 'AeroTech/J540R', nowCount: 1 }]);
  });
});
