import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { getCatalogue, MOTOR_DB_DATE } from './motorDb.js';
import { defaultDelay, delayOptions } from './thrustcurve.js';
import { chooseLinkDelay, planMotorLink } from './motorLinkOpen.js';
import type { MotorLinkParams } from './motorLink.js';

const catalogue = getCatalogue();
const motor = catalogue.find(m => m.diameter <= 29 && delayOptions(m).filter(Number.isFinite).length >= 2)!;
const tube = (id: string, bore = 0.029, limit = 10): ComponentNode => ({
  type: 'bodytube', id, motorMount: true, outerRadius: bore / 2, thickness: 0,
  length: limit, maxMotorLength: limit, children: [],
});
const tree = { components: [{ type: 'stage', id: 's', name: 'Sustainer', children: [tube('m')] }] as ComponentNode[] };
const input = () => ({ tree, mountIds: ['m'], catalogue, catalogueDate: MOTOR_DB_DATE,
  params: { motorId: motor.motorId, delayHint: null, problems: [] } as MotorLinkParams });

describe('motor link plan', () => {
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
    expect(planMotorLink(check)).toMatchObject({ kind: 'fly', notes: [
      { tier: 'caution', text: expect.stringContaining('real rocket could not be built this way') },
    ] });
  });
  it('loads too-wide and too-long motors with consequence warnings', () => {
    const wide = catalogue.find(m => m.diameter > 29)!;
    const wideInput = input(); wideInput.params.motorId = wide.motorId;
    expect(planMotorLink(wideInput)).toMatchObject({ kind: 'fly', notes: [
      { tier: 'caution', text: expect.stringContaining('real rocket could not be built this way') },
    ] });
    const longInput = input();
    longInput.tree = { components: [{ type: 'stage', id: 's', children: [tube('m', 0.029, motor.length / 2000)] }] };
    expect(planMotorLink(longInput)).toMatchObject({ kind: 'fly', notes: [
      { tier: 'caution', text: expect.stringContaining('may hit parts inside the rocket') },
    ] });
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
