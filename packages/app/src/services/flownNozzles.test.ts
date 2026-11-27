import { describe, expect, it } from 'vitest';
import type { IgnitionEvent, RocketTree } from '@online-openrocket/engine';
import { nozzleLoadAffectsFlight, withFlownNozzles } from './flownNozzles.js';
import { stageMotors, type StageMotors } from './nozzleFollow.js';
import { testMotor } from './autoDelay.testSupport.js';

const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [
  { type: 'innertube', id: 'm', motorMount: true },
] }] };
const loadout: StageMotors[] = [{ stageId: 's', stageName: 'Stage', motors: [
  { mountId: 'm', motorId: 'motor', count: 1, label: 'Motor' },
] }];
const exit = (t: RocketTree) => t.components[0]!['nozzleExitDiameter'];

describe('flight-only nozzle exits', () => {
  it('J23N r4 warns about missing data only when the nozzle model could use the complete stage', () => {
    const aero = { aeroMode: 'classic' as const, effectiveKbf: true, autoSupersonic: false };
    expect(nozzleLoadAffectsFlight(tree, loadout, () => null, aero)).toBe(true);
    expect(nozzleLoadAffectsFlight(tree, loadout, () => null, { ...aero, effectiveKbf: false })).toBe(false);
    const mixed = [{ ...loadout[0]!, motors: [...loadout[0]!.motors,
      { mountId: 'ex', motorId: 'ex:missing', count: 1, label: 'EX' }] }];
    expect(nozzleLoadAffectsFlight(tree, mixed, () => null, aero)).toBe(false);
    expect(nozzleLoadAffectsFlight(tree, mixed, id => id.startsWith('ex:') ? 0.008 : null, aero)).toBe(true);
  });
  it('fills only the returned tree, leaving the design blank', () => {
    const result = withFlownNozzles(tree, loadout, () => 0.02);
    expect(exit(result.tree)).toBeCloseTo(0.02, 12);
    expect(exit(tree)).toBeUndefined();
    expect(result.unresolved).toBe(false);
  });
  it.each([0, 0.03])('keeps a stored value of %s, including durable OFF', value => {
    const stored = { components: [{ ...tree.components[0]!, nozzleExitDiameter: value }] };
    expect(withFlownNozzles(stored, loadout, () => undefined)).toEqual({ tree: stored, unresolved: false });
    expect(withFlownNozzles(stored, loadout, () => 0.02).tree).toBe(stored);
  });
  it('keeps identity when there is no motor or no published exit', () => {
    expect(withFlownNozzles(tree, [], () => 0.02).tree).toBe(tree);
    expect(withFlownNozzles(tree, loadout, () => null)).toEqual({ tree, unresolved: false });
  });
  it('never sums a partial loadout, and distinguishes pending from absent data', () => {
    const mixed = [{ ...loadout[0]!, motors: [...loadout[0]!.motors,
      { mountId: 'other', motorId: 'missing', count: 1, label: 'Other' }] }];
    expect(withFlownNozzles(tree, mixed, id => id === 'motor' ? 0.02 : null)).toEqual({ tree, unresolved: false });
    expect(withFlownNozzles(tree, mixed, id => id === 'motor' ? 0.02 : undefined)).toEqual({ tree, unresolved: true });
  });
  it('sums exit areas: four identical motors have twice one diameter', () => {
    const cluster = [{ ...loadout[0]!, motors: [{ ...loadout[0]!.motors[0]!, count: 4 }] }];
    expect(exit(withFlownNozzles(tree, cluster, () => 0.02).tree)).toBeCloseTo(0.04, 12);
  });
  it('resolves one strap-on without multiplying by the number of strap-ons', () => {
    const parallel: RocketTree = { components: [{ type: 'stage', id: 's', children: [
      { type: 'parallelstage', id: 'p', instanceCount: 3, children: [
        { type: 'innertube', id: 'm', motorMount: true, cluster: '4-ring' },
      ] },
    ] }] };
    const motor = testMotor(true, 4);
    const loads = stageMotors(parallel, [['m', { ...motor, meta: { ...motor.meta, motorId: 'motor' } }]]);
    const result = withFlownNozzles(parallel, loads, () => 0.02);
    expect(result.tree.components[0]!.children![0]!['nozzleExitDiameter']).toBeCloseTo(0.04, 12);
    expect(exit(result.tree)).toBeUndefined();
  });
  it.each(['never', 'unknown-event'])('excludes %s ignition before looking up exits', event => {
    const motor = testMotor(true, 4);
    // Unknown values can arrive from a file despite the typed runtime boundary.
    const loads = stageMotors(tree, [['m', { ...motor, ignition: { event: event as IgnitionEvent, delay: 0 } }]]);
    expect(withFlownNozzles(tree, loads, () => undefined)).toEqual({ tree, unresolved: false });
  });
  it('excludes refused mounts from the equivalent exit', () => {
    const motor = testMotor(true, 4);
    expect(withFlownNozzles(tree, stageMotors(tree, [['m', motor]], ['m']), () => 0.02).tree).toBe(tree);
  });
});
