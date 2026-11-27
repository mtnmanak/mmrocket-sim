import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { getCatalogue, MOTOR_DB_DATE } from './motorDb.js';
import { defaultDelay, delayOptions } from './thrustcurve.js';
import { chooseLinkDelay, planMotorLink, motorLinkLoadFailure } from './motorLinkOpen.js';
import type { MotorLinkParams } from './motorLink.js';
import { IMPERIAL_UNITS, INITIAL_UNITS, noticeQuantity } from '../prefs/units.js';

import { motorFitWarnings } from './motorFitWarnings.js';
import { testMotor } from './autoDelay.testSupport.js';
import { buildDesign, KERNEL_HANDLES } from './buildDesign.js';
import { defaultTree, motorMounts, updateNode } from '../tree/treeModel.js';

const catalogue = getCatalogue();
const fit = (check: Parameters<typeof planMotorLink>[0]) => {
  const plan = planMotorLink(check);
  expect(plan.notes.filter(n => n.tier === 'caution')).toEqual([]);
  if (plan.kind !== 'fly') throw new Error('Expected a loaded motor');
  const record = testMotor(true, plan.delay);
  return motorFitWarnings(check.tree, [[plan.mountId, { ...record,
    label: plan.motor.designation,
    spec: { ...record.spec, diameter: plan.motor.diameter / 1000, length: plan.motor.length / 1000 },
  }]], check.units);
};
it.each([INITIAL_UNITS, IMPERIAL_UNITS])('distinguishes a motor just above its rounded length limit (%s)', units => {
  const check = input();
  const sample = { ...motor, length: 200 };
  const limit = 0.1999999;
  check.tree = { components: [{ type: 'stage', id: 's', children: [tube('m', 0.029, limit)] }] };
  const plan = planMotorLink({ ...check, catalogue: [sample], units });
  expect(plan.notes).toEqual([]);
  const warnings = fit({ ...check, catalogue: [sample], units });
  expect(warnings.map(w => w.key)).toEqual(['MOTOR_TOO_LONG']);
  const bound = noticeQuantity('motorDimensions', limit, units);
  expect(warnings[0]!.message).toContain(`Motor length just above ${bound}`);
});
it('formats both fit warnings in preferred motor units without conversion noise', () => {
  const check = input();
  check.tree = { components: [{ type: 'stage', id: 's', children: [tube('m', 0.0127, 0.0254)] }] };
  const plan = planMotorLink({ ...check, units: { ...IMPERIAL_UNITS, motorDimensions: 'in' } });
  expect(plan.notes).toEqual([]);
  const warnings = fit({ ...check, units: { ...IMPERIAL_UNITS, motorDimensions: 'in' } });
  expect(warnings.map(w => w.key).sort()).toEqual(['MOTOR_TOO_LONG', 'MOTOR_TOO_WIDE']);
  expect(warnings.map(w => w.message).join(' ')).toContain('0.5 in');
  expect(warnings.map(w => w.message).join(' ')).toContain('1 in');
});
it('uses the motor browser length tolerance at the mount limit', () => {
  const check = input();
  check.tree = { components: [{ type: 'stage', id: 's', children: [tube('m', 0.029, motor.length / 1000 - 5e-10)] }] };
  expect(planMotorLink(check).notes).toEqual([]);
});
// Diameter > 14 mm so the 12.7 mm-bore case never fits within fitsMount's 1 mm allowance, whatever the catalogue order.
const motor = catalogue.find(m => m.diameter > 14 && m.diameter <= 29 && delayOptions(m).filter(Number.isFinite).length >= 2)!;
const tube = (id: string, bore = 0.029, limit = 10): ComponentNode => ({
  type: 'bodytube', id, motorMount: true, outerRadius: bore / 2, thickness: 0,
  length: limit, maxMotorLength: limit, children: [],
});
const tree = { components: [{ type: 'stage', id: 's', name: 'Sustainer', children: [tube('m')] }] as ComponentNode[] };
const input = () => ({ tree, mountIds: ['m'], catalogue, catalogueDate: MOTOR_DB_DATE,
  params: { motorId: motor.motorId, delayHint: null, problems: [] } as MotorLinkParams });

it('r5 motor links warn on estimated room without an explicit limit', () => {
  const mount: ComponentNode = { ...tube('m', 0.029), length: 0.07 };
  delete mount['maxMotorLength'];
  const plan = planMotorLink({ ...input(), tree: { components: [{ type: 'stage', id: 's', children: [mount] }] },
    catalogue: [{ ...motor, length: 124 }] });
  expect(plan.notes).toEqual([]);
  const warnings = fit({ ...input(), tree: { components: [{ type: 'stage', id: 's', children: [mount] }] },
    catalogue: [{ ...motor, length: 124 }] });
  expect(warnings.filter(w => w.key === 'MOTOR_TOO_LONG')).toHaveLength(1);
  expect(warnings[0]!.message).toContain('estimated room');
});

describe('motor link plan', () => {
  it('r2 skips the width Caution for an importer-assumed bore', () => {
    const check = input();
    check.tree = { components: [{ type: 'stage', id: 's', children: [{ ...tube('m', 0.0127), boreAssumed: true }] }] };
    expect(planMotorLink(check)).toMatchObject({ kind: 'fly', notes: [] });
    check.tree.components[0]!.children![0]!['filled'] = true;
    expect(fit(check).filter(w => w.key === 'MOTOR_TOO_WIDE')).toHaveLength(1);
    delete check.tree.components[0]!.children![0]!['filled'];
    delete check.tree.components[0]!.children![0]!['boreAssumed'];
    expect(fit(check).filter(w => w.key === 'MOTOR_TOO_WIDE')).toHaveLength(1);
  });
  it('carries Auto for a shipped motor with no prescribed delays', () => {
    const m = catalogue.find(m => delayOptions(m).length === 0)!;
    expect(planMotorLink({ ...input(), params: { motorId: m.motorId, delayHint: null, problems: [] } }))
      .toMatchObject({ kind: 'fly', delay: 0, autoDelay: true });
  });
  it('names Auto in mismatch and load-failure notes', () => {
    const m = catalogue.find(m => delayOptions(m).length === 0 && m.diameter > 29)!;
    const plan = planMotorLink({ ...input(), params: { motorId: m.motorId, delayHint: null, problems: [] } });
    expect(plan.notes).toEqual([]);
    expect(motorLinkLoadFailure(m, 0, true)).toContain('(auto delay)');
  });
  it('carries a non-default offered hint and a mixed plugged choice', () => {
    const hint = delayOptions(motor).find(d => d !== defaultDelay(motor))!;
    expect(planMotorLink({ ...input(), params: { motorId: motor.motorId, delayHint: hint, problems: [] } }))
      .toMatchObject({ delay: hint, autoDelay: false });
    const mixed = catalogue.find(m => delayOptions(m).includes(Infinity) && delayOptions(m).some(Number.isFinite))!;
    expect(chooseLinkDelay(mixed, 'plugged')).toBe(Infinity);
  });
  it('reports invalid motor parameters once without inventing an unknown ID', () => {
    expect(planMotorLink({ ...input(), params: { motorId: null, delayHint: null, problems: ['was ignored'] } }))
      .toEqual({ kind: 'no-flight', notes: [{ tier: 'information', text: 'was ignored' }] });
  });
  it('counts only the other empty mounts in the current loadout', () => {
    const check = input();
    check.tree = { components: [{ ...tree.components[0]!, children: [tube('m'), tube('loaded'), tube('empty')] }] };
    check.mountIds = ['m', 'loaded', 'empty'];
    expect(planMotorLink({ ...check, loadedMountIds: ['loaded'] })).toMatchObject({ notes: [
      { text: expect.stringContaining('1 other motor mount(s) are empty') },
    ] });
  });
  it('uses an offered hint and otherwise the browser default, including unsupported P', () => {
    expect(motor).toBeDefined();
    expect(chooseLinkDelay(motor, delayOptions(motor)[0]!)).toBe(delayOptions(motor)[0]);
    expect(chooseLinkDelay(motor, 999.99)).toBe(defaultDelay(motor) ?? 0);
    const withoutP = catalogue.find(m => delayOptions(m).length && !delayOptions(m).includes(Infinity))!;
    expect(chooseLinkDelay(withoutP, 'plugged')).toBe(defaultDelay(withoutP));
    const withP = catalogue.find(m => delayOptions(m).includes(Infinity))!;
    expect(chooseLinkDelay(withP, 'plugged')).toBe(Infinity);
    const noDelays = catalogue.find(m => delayOptions(m).length === 0)!;
    expect(chooseLinkDelay(noDelays, 'plugged')).toBe(0);
  });
  it('flies a fitting motor without warnings', () => {
    expect(planMotorLink(input())).toMatchObject({ kind: 'fly', mountId: 'm', motor, notes: [] });
  });
  it('uses the bore rather than the outside diameter for fit', () => {
    const m29 = catalogue.find(m => m.diameter === 29)!;
    const check = input();
    check.params.motorId = m29.motorId;
    check.tree = { components: [{ type: 'stage', id: 's', children: [
      { ...tube('m'), thickness: 0.002 },
    ] }] };
    expect(planMotorLink(check)).toMatchObject({ kind: 'fly', notes: [] });
    expect(fit(check).filter(w => w.key === 'MOTOR_TOO_WIDE')).toHaveLength(1);
  });
  it('loads too-wide and too-long motors with consequence warnings', () => {
    const wide = catalogue.find(m => m.diameter > 29)!;
    const wideInput = input(); wideInput.params.motorId = wide.motorId;
    expect(planMotorLink(wideInput)).toMatchObject({ kind: 'fly', notes: [] });
    expect(fit(wideInput).filter(w => w.key === 'MOTOR_TOO_WIDE')).toHaveLength(1);
    const longInput = input();
    longInput.tree = { components: [{ type: 'stage', id: 's', children: [tube('m', 0.029, motor.length / 2000)] }] };
    expect(planMotorLink(longInput)).toMatchObject({ kind: 'fly', notes: [] });
    expect(fit(longInput).filter(w => w.key === 'MOTOR_TOO_LONG')).toHaveLength(1);
  });
  it('opens without flight for unknown IDs and absent mounts', () => {
    const unknown = input(); unknown.params.motorId = '000000000000000000000000';
    expect(planMotorLink(unknown)).toMatchObject({ kind: 'no-flight', notes: [
      { tier: 'information', text: expect.stringContaining(MOTOR_DB_DATE) },
    ] });
    expect(planMotorLink({ ...input(), mountIds: [] })).toMatchObject({ kind: 'no-flight', notes: [
      { text: 'This design has no motor mount, so the motor in the link could not be loaded.' },
    ] });
  });
  it('uses the booster and notes the other mount; preserves suffix problems safely', () => {
    const staged = input();
    staged.tree = { components: [...tree.components, { type: 'stage', id: 'b', name: 'Booster', children: [tube('bm')] }] };
    staged.mountIds = ['m', 'bm'];
    expect(planMotorLink(staged)).toMatchObject({ kind: 'fly', mountId: 'bm', notes: [
      { text: expect.stringContaining('1 other motor mount(s) are empty') },
    ] });
    const problem = input(); problem.params.problems = ['Ignored motor value.'];
    expect(planMotorLink(problem)).toMatchObject({ notes: [{ text: 'Ignored motor value.' }] });
  });
});

it('J23-L7 the real build keeps exactly one strip warning per motor-fit fact', () => {
  const record = testMotor(true, 4);
  const original = defaultTree();
  const mount = motorMounts(original)[0]!.id!;
  const tree = updateNode(original, mount, { maxMotorLength: record.spec.length / 2 });
  const built = buildDesign({ tree, assigned: [[mount, record]], kbf: true, supersonic: false,
    measuredDryMassKg: null, primaryMountId: mount, currentSetKey: '' }, KERNEL_HANDLES);
  expect(built).not.toHaveProperty('error');
  if ('error' in built) throw new Error(built.error);
  expect(built.info.warningTexts.filter(w => w.includes('[Warning.MOTOR_TOO_LONG]'))).toHaveLength(1);
});
