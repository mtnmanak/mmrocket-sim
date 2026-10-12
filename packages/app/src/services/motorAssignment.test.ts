import { describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import type { SavedConfig } from '../model/design.js';
import type { OrkMotorRef } from './orkFile.js';
import { testMotor } from './autoDelay.testSupport.js';
import { assignMotorRecords, planMotorAssignment, retireLoadoutNote } from './motorAssignment.js';
import { padMassSetKey } from './configSync.js';

const tree: RocketTree = { components: [
  { type: 'stage', id: 'upper', children: [{ type: 'innertube', id: 'a', motorMount: true }] },
  { type: 'stage', id: 'lower', children: [{ type: 'innertube', id: 'b', motorMount: true }] },
] };
const picked = testMotor(false, 5);
const ref: OrkMotorRef = { mountId: 'a', designation: 'test', manufacturer: 'Test',
  diameter: 0.029, length: 0.1, delay: 5, padMassKg: 2 };
const configs: SavedConfig[] = [{ id: 'A', name: 'Imported', isDefault: true, motors: {}, motorLoadoutRefusal: 'ambiguous' }];
const input = () => ({ tree, targetMountId: 'a', label: picked.label, spec: picked.spec,
  meta: { ...picked.meta, propellant: 'APCP' }, refs: { a: ref }, savedConfigs: configs, activeConfigId: 'A',
  massText: (kg: number) => `${kg} kg`, statedWeightText: { mass: (kg: number) => `${kg} kg`, length: (m: number) => `${m} m` } });

describe('motor assignment plan (S2-8)', () => {
  it('plans propellant ignition, reference adoption and the exact repair notice without changing inputs', () => {
    const state = input();
    const before = structuredClone({ tree, configs, ref });
    const plan = planMotorAssignment(state);
    expect(plan.fresh.ignition).toEqual({ event: 'burnout', delay: 1 });
    expect(plan.remainingRefs).toEqual({});
    expect(plan.droppedRef).toBe(ref);
    expect(plan.repairNotice).toEqual({ id: 'motor-loadout-repaired:A', severity: 'warn',
      text: 'Your motor assignment replaces the ambiguous imported loadout for “Imported”. Check all motor assignments before launching.' });
    expect(plan.padMassNote).toBe("The file's weighed pad mass (2 kg) was weighed with test, which is loaded now — it sits under test on this mount, and the line there says what it carries.");
    // A receipt: the weighing is carried (review of b9-int, finding 11).
    expect(plan.padMassTier).toBe('information');
    const next = assignMotorRecords({}, tree, 'a', plan);
    expect(next.a).toMatchObject({ padMassKg: 2, padMassWeighedWith: padMassSetKey(tree, next, {}) });
    expect({ tree, configs, ref }).toEqual(before);
  });

  it('names the original weighing when a different motor is selected and leaves unrelated notes intact', () => {
    const plan = planMotorAssignment({ ...input(), spec: { ...picked.spec, designation: 'different' } });
    expect(plan.padMassNote).toBe('The weighed pad mass in the file was weighed with test, which is not the motor now loaded — re-weigh with test in.');
    // The file's weighing is no longer carried: I16 Caution, as on the open (review of b9-int, finding 11).
    expect(plan.padMassTier).toBe('caution');
    expect(assignMotorRecords({}, tree, 'a', plan).a).not.toHaveProperty('padMassKg');
    expect(retireLoadoutNote({ text: 'before\nambiguous\nafter', severity: 'warn', expand: true }, plan.repairedConfig!))
      .toEqual({ text: 'before\nafter', severity: 'warn', expand: true });
    expect(retireLoadoutNote({ text: 'ambiguous', severity: 'warn' }, plan.repairedConfig!)).toBeNull();
    expect(retireLoadoutNote(null, plan.repairedConfig!)).toBeNull();
  });

  it('derives the primary from the updater records, preserving same-motor weighing and satisfying a later reference', () => {
    const a = planMotorAssignment({ ...input(), refs: { a: ref, b: { ...ref, mountId: 'b', padMassKg: undefined } } });
    const first = assignMotorRecords({}, tree, 'a', a);
    const b = planMotorAssignment({ ...input(), targetMountId: 'b', refs: { b: { ...ref, mountId: 'b', padMassKg: undefined } } });
    const both = assignMotorRecords(first, tree, 'b', b);
    expect(both.a!.padMassWeighedWith).toBe(padMassSetKey(tree, both, {}));
    const repick = planMotorAssignment({ ...input(), refs: {}, spec: { ...picked.spec, ejectionDelay: 8 } });
    expect(assignMotorRecords(both, tree, 'a', repick).a!.padMassKg).toBe(2);
    expect(first).not.toHaveProperty('b');
    expect(b.fresh.ignition).toEqual({ event: 'automatic', delay: 0 });
  });

  it('returns a stale RASAero mark as a bookkeeping-only repair, and no repair for ordinary designs', () => {
    expect(planMotorAssignment(input()).reconciliation).toBeNull();
    const stale = { ...tree, components: [{ ...tree.components[0]!, overrideIncludesMotor: 'test' }, tree.components[1]!] };
    const result = planMotorAssignment({ ...input(), tree: stale }).reconciliation;
    expect(result).not.toBeNull();
    expect(result!.note).toBeNull();
    // A bookkeeping-only repair says nothing, and would say it as Information.
    expect(planMotorAssignment({ ...input(), tree: stale }).reconciliationTier).toBe('information');
    // A stated weight that still holds a DIFFERENT motor is cleared: I17 Caution.
    const held = { ...tree, components: [{ ...tree.components[0]!, overrideIncludesMotor: 'Z999TEST', overrideMass: 0.5,
      overrideSubcomponentsMass: true }, tree.components[1]!] };
    const cleared = planMotorAssignment({ ...input(), tree: held });
    expect(cleared.reconciliation!.severity).toBe('warn');
    expect(cleared.reconciliationTier).toBe('caution');
    expect(result!.tree.components[0]).not.toHaveProperty('overrideIncludesMotor');
    expect(stale.components[0]).toHaveProperty('overrideIncludesMotor', 'test');
  });
});
