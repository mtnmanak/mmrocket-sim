import { expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { testMotor } from './autoDelay.testSupport.js';
import { otherMountMotor, otherMountPlan, otherMountShape, otherMountStageChanges, otherMountStagesHold,
  restoreOtherMounts, restoreOtherMountStages } from './otherMountLoad.js';
import { fitsMount } from './motorDb.js';

const motor = { ...testMotor(false, 5), meta: { ...testMotor(false, 5).meta, availableDelays: [2, 5, 7] },
  spec: { ...testMotor(false, 5).spec, diameter: 0.075, length: 0.405 } };
const mount = (id: string, bore = 0.075, maxMotorLength?: number): ComponentNode => ({
  id, name: id, type: 'innertube', motorMount: true, outerRadius: bore / 2 + 0.001, thickness: 0.001, maxMotorLength,
});
const tree = (others: ComponentNode[]): RocketTree => ({ components: [{
  id: 'stage', type: 'stage', children: [mount('source'), ...others],
}] });

it('126 uses browser diameter fit, source bore class, and the exact mount length boundary', () => {
  const design = tree([mount('exact', 0.075, motor.spec.length), mount('short', 0.075, motor.spec.length - 1e-8),
    mount('narrow', 0.054), mount('other bore', 0.098), mount('zero', 0.075, 0), mount('unlimited')]);
  const plan = otherMountPlan(design, { source: motor }, 'source');
  expect(fitsMount(54, { diameter: 75 })).toBe(false);
  expect(plan.targets.map(t => t.id)).toEqual(['exact', 'unlimited']);
  expect(plan.skipped).toEqual([{ name: 'short', reason: 'short', limit: motor.spec.length - 1e-8 }, { name: 'narrow', reason: 'narrow' },
    { name: 'other bore', reason: 'bore' }, { name: 'zero', reason: 'short', limit: 0 }]);
});

it('126 compares catalogue/EX identity, flown spec and delay, independently of object key order', () => {
  const design = tree([mount('target')]);
  const target = { ...motor, spec: Object.fromEntries(Object.entries(motor.spec).reverse()) as typeof motor.spec };
  expect(otherMountPlan(design, { source: motor, target }, 'source').targets).toEqual([]);
  for (const other of [
    { ...target, meta: { ...target.meta, motorId: 'another catalogue id' } },
    { ...target, meta: { ...target.meta, exMotorId: 'ex:another' } },
    { ...target, spec: { ...target.spec, masses: target.spec.masses.map(m => m + 0.1) } },
  ]) expect(otherMountPlan(design, { source: motor, target: other }, 'source').targets.map(t => t.id)).toEqual(['target']);
  expect(otherMountPlan(design, { source: motor, target: { ...target, spec: { ...target.spec, ejectionDelay: 7 } } }, 'source').targets).toEqual([]);
});

it('126 keeps ignition and Auto, without carrying source weighing or changing the flown curve', () => {
  const old = { ...motor, ignition: { event: 'never' as const, delay: 3 }, meta: { ...motor.meta, autoDelay: true } };
  const fresh = otherMountMotor(motor, old);
  expect(fresh.ignition).toBe(old.ignition);
  expect(fresh.spec).toBe(motor.spec);
  expect(fresh.meta.autoDelay).toBe(true);
  expect(otherMountMotor(motor).ignition).toBe(motor.ignition);
  expect(otherMountMotor({ ...motor, padMassKg: 3, padMassWeighedWith: 'neighbour' }, old)).not.toHaveProperty('padMassKg');
});

it.each([true, false])('round 2 preserves target Auto %s when the source uses the opposite policy', auto => {
  const source = { ...motor, meta: { ...motor.meta, autoDelay: !auto } };
  const target = { ...motor, meta: { ...motor.meta, autoDelay: auto } };
  expect(otherMountMotor(source, target).meta.autoDelay).toBe(auto);
  expect(otherMountMotor(source).meta.autoDelay).toBe(!auto);
  expect(otherMountMotor(source, undefined, { designation: 'old', manufacturer: '', diameter: 0.075,
    length: 0.4, delay: 5, ...(auto ? { autoDelay: true } : {}) }).meta.autoDelay).toBe(auto);
});

it.each([[0.0764, 0.0766], [0.0766, 0.0764]])('round 2 accepts nearby peer bores across the catalogue rounding boundary (%s / %s m)', (source, target) => {
  const design = tree([mount('target', target), mount('outside tolerance', 0.079)]);
  design.components[0]!.children![0] = mount('source', source);
  expect(fitsMount(76, { diameter: motor.spec.diameter * 1000 })).toBe(true);
  expect(fitsMount(77, { diameter: motor.spec.diameter * 1000 })).toBe(true);
  expect(otherMountPlan(design, { source: motor }, 'source')).toMatchObject({
    targets: [{ id: 'target' }], skipped: [{ name: 'outside tolerance', reason: 'bore' }],
  });
});

it('126 scopes peers to the nearest stage, including pods but excluding parallel and serial boosters', () => {
  const design = tree([{ type: 'podset', id: 'pod', children: [mount('pod mount')] },
    { type: 'parallelstage', id: 'parallel', children: [mount('booster')] }]);
  design.components.push({ type: 'stage', id: 'serial', children: [mount('serial mount')] });
  expect(otherMountPlan(design, { source: motor }, 'source').targets.map(t => t.id)).toEqual(['pod mount']);
});

it('126 invalidates a changed fit or stage without invalidating automatic nozzle following', () => {
  const design = tree([mount('target')]);
  const initial = otherMountShape(design, 'source');
  design.components[0]!.nozzleExitDiameter = 0.01;
  expect(otherMountShape(design, 'source')).toBe(initial);
  design.components[0]!.children![1]!.maxMotorLength = 0;
  expect(otherMountShape(design, 'source')).not.toBe(initial);
});

it('126 restores only target entries and deletes newly created ones', () => {
  expect(restoreOtherMounts({ first: 1, second: 2, third: 3 }, { first: 99, second: 8 }, ['second', 'third']))
    .toEqual({ first: 1, second: 8 });
});

it('round 3 keeps plugged picks plugged for occupied, imported and empty targets', () => {
  for (const availableDelays of [[5, Infinity], [Infinity]]) {
    const plugged = { ...motor, spec: { ...motor.spec, ejectionDelay: Infinity }, meta: { ...motor.meta, availableDelays } };
    for (const autoDelay of [true, false]) {
      const old = { ...motor, meta: { ...motor.meta, autoDelay } };
      expect(otherMountMotor(plugged, old)).toMatchObject({ spec: { ejectionDelay: Infinity }, meta: { autoDelay: false } });
      expect(otherMountMotor(plugged, undefined, { designation: 'old', manufacturer: '', diameter: 0.075,
        length: 0.4, delay: 5, ...(autoDelay ? { autoDelay: true } : {}) })).toMatchObject({ spec: { ejectionDelay: Infinity }, meta: { autoDelay: false } });
    }
    expect(otherMountMotor(plugged)).toMatchObject({ spec: { ejectionDelay: Infinity }, meta: { autoDelay: false } });
  }
});

it('round 3 retains offered target fixed delays and otherwise uses the single-pick default', () => {
  const old = { ...motor, spec: { ...motor.spec, ejectionDelay: 7 } };
  for (const autoDelay of [true, false]) {
    for (const [availableDelays, delay, auto] of [
      [[5, 7, 10], 7, false], [[5, 10], 10, false], [[], 0, true], [[Infinity], Infinity, false],
    ] as const) {
      const source = { ...motor, spec: { ...motor.spec, ejectionDelay: autoDelay ? 0 : 5 },
        meta: { ...motor.meta, availableDelays: [...availableDelays], autoDelay } };
      expect(otherMountMotor(source, old)).toMatchObject({ spec: { ejectionDelay: delay }, meta: { autoDelay: auto } });
      expect(otherMountMotor(source, undefined, { designation: 'old', manufacturer: '', diameter: 0.075,
        length: 0.4, delay: 7 })).toMatchObject({ spec: { ejectionDelay: delay }, meta: { autoDelay: auto } });
    }
  }
});

it('round 3 ignores provisional delay differences when the target stays Auto', () => {
  const target = { ...motor, spec: { ...motor.spec, ejectionDelay: 14 }, meta: { ...motor.meta, autoDelay: true } };
  expect(otherMountPlan(tree([mount('target')]), { source: motor, target }, 'source').targets).toEqual([]);
});

it.each([
  { availableDelays: [7, 10, 14], pickedDelay: 14 },
  { availableDelays: [], pickedDelay: 0 },
  { availableDelays: [Infinity], pickedDelay: Infinity },
].flatMap(row => ['loaded target', 'stored reference'].map(policy => ({ ...row, policy }))))(
  'round 5 keeps a plugged $policy plugged with delays $availableDelays', ({ availableDelays, pickedDelay, policy }) => {
  const source = { ...motor, spec: { ...motor.spec, ejectionDelay: pickedDelay },
    meta: { ...motor.meta, availableDelays, autoDelay: pickedDelay !== Infinity } };
  const target = { ...motor, spec: { ...motor.spec, ejectionDelay: Infinity },
    meta: { ...motor.meta, autoDelay: false } };
  // Stored references encode Auto off by omitting autoDelay.
  const ref = { designation: 'old', manufacturer: '', diameter: 0.075,
    length: 0.4, delay: Infinity };
  const next = policy === 'loaded target' ? otherMountMotor(source, target) : otherMountMotor(source, undefined, ref);
  expect(next.spec.ejectionDelay).toBe(Infinity);
  expect(next.meta.autoDelay).toBe(false);
  expect(next.label).toMatch(/-P$/);
  expect(next.meta.label).toBe(next.label);
});

it('round 3 uses the browser length slack and rejects a genuinely longer motor', () => {
  const source = { ...motor, spec: { ...motor.spec, length: 0.4 } };
  const plan = otherMountPlan(tree([mount('fits', 0.075, 0.4 - Number.EPSILON), mount('short', 0.075, 0.4 - 2e-9)]), { source }, 'source');
  expect(plan.targets.map(t => t.id)).toEqual(['fits']);
  expect(plan.skipped).toMatchObject([{ name: 'short', reason: 'short', limit: 0.4 - 2e-9 }]);
});

it('round 3 uses rounded bores consistently for eligibility and offer invalidation', () => {
  const design = tree([mount('target', 0.0773), mount('outside', 0.0776)]);
  design.components[0]!.children![0] = mount('source', 0.0764);
  const initial = otherMountShape(design, 'source');
  expect(otherMountPlan(design, { source: motor }, 'source')).toMatchObject({
    targets: [{ id: 'target' }], skipped: [{ name: 'outside', reason: 'bore' }],
  });
  design.components[0]!.children![1] = mount('target', 0.07749);
  expect(otherMountShape(design, 'source')).toBe(initial);
  expect(otherMountPlan(design, { source: motor }, 'source').targets.map(t => t.id)).toEqual(['target']);
  design.components[0]!.children![1] = mount('target', 0.0776);
  expect(otherMountShape(design, 'source')).not.toBe(initial);
  expect(otherMountPlan(design, { source: motor }, 'source').targets).toEqual([]);
});

it('round 4 restores raw stage reconciliation fields without reverting children or other stages', () => {
  const before = tree([mount('target')]);
  Object.assign(before.components[0]!, { overrideIncludesMotor: 'stale mark',
    statedStageFigures: { motor: 'stale record', launchKg: 10, massKg: 9 } });
  before.components.push({ type: 'stage', id: 'untouched', overrideMass: 3 });
  const after: RocketTree = { ...before, components: [{ ...before.components[0]!,
    overrideMass: 8, overrideCGX: 0.8, overrideSubcomponentsMass: true, overrideSubcomponentsCG: true },
  before.components[1]!] };
  delete after.components[0]!.overrideIncludesMotor;
  delete after.components[0]!.statedStageFigures;
  const changes = otherMountStageChanges(before, after);
  expect(changes.map(c => c.id)).toEqual(['stage']);
  const current = { ...after, components: [{ ...after.components[0]!, nozzleExitDiameter: 0.02,
    children: [mount('new child')] }, { ...after.components[1]!, overrideMass: 4 }] };
  expect(otherMountStagesHold(current, changes)).toBe(true);
  const restored = restoreOtherMountStages(current, changes);
  expect(restored.components[0]).toEqual({ ...before.components[0]!, nozzleExitDiameter: 0.02,
    children: current.components[0]!.children });
  expect(restored.components[1]).toBe(current.components[1]);
  expect(otherMountStagesHold({ ...after, components: [] }, changes)).toBe(false);
});
