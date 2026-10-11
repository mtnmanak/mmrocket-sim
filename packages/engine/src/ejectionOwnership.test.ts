import { describe, expect, it } from 'vitest';
import { OrkRocket, type FlightEvent, type MotorSpec, type RocketTree } from './orkEngine.js';

// OR #2092 / PR #3204 (engine-java/patches/LEDGER.md, tumble release T1). Upstream 24.12 fired an
// EJECTION-deployed recovery device on ANY ejection charge in the same stage NUMBER - a pod
// motor's charge deployed the core airframe's chute and the core charge the pod's - and
// re-deployed an already-deployed device on a later charge (a duplicate deployment event, the
// landing stepper re-initialised, the deployment velocity overwritten by the LAST event). Now a
// charge deploys only the devices of its own motor mount's innermost assembly, and a device
// deploys once.
//
// Its guards were JUnit only (AssemblyRecoveryTest, `gradlew test`), which neither `npm test` nor
// the deploy gate runs. These fly the same fixtures through the shipped bridge.

const CORE_C6: MotorSpec = {
  designation: 'C6', diameter: 0.018, length: 0.07,
  times: [0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0],
  thrusts: [0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0],
  masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132],
  cgX: 0.035, ejectionDelay: 3,
};
const POD_MOTOR: MotorSpec = {
  designation: 'Pod', diameter: 0.013, length: 0.045,
  times: [0, 0.05, 0.15, 0.4, 0.5], thrusts: [0, 3, 2, 1.5, 0],
  masses: [0.006, 0.0058, 0.0054, 0.0045, 0.004],
  cgX: 0.0225, ejectionDelay: 2,
};

const chute = (name: string, diameter: number) =>
  ({ type: 'parachute', name, diameter, deployEvent: 'ejection', deployDelay: 0 });
const mount = (id: string, small: boolean) => ({
  type: 'innertube', id, length: small ? 0.045 : 0.07, outerRadius: small ? 0.0065 : 0.0095,
  thickness: small ? 0.0003 : 0.0005, motorMount: true, position: { method: 'bottom', offset: 0 },
});
const pod = (name: string, children: Record<string, unknown>[]) => ({
  type: 'podset', name, instanceCount: 1, radiusMethod: 'relative', radiusOffset: 0, angleOffset: 0,
  position: { method: 'bottom', offset: 0 },
  children: [
    { type: 'nosecone', shape: 'ogive', length: 0.03, aftRadius: 0.0075, thickness: 0.0003 },
    { type: 'bodytube', name: `${name}Body`, length: 0.06, outerRadius: 0.0075, thickness: 0.0003, children },
  ],
});
const core = (children: Record<string, unknown>[]): RocketTree => ({
  name: 'Assembly recovery',
  components: [
    { type: 'nosecone', shape: 'ogive', length: 0.07, aftRadius: 0.012, thickness: 0.002 },
    {
      type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950,
      children: [
        { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
        mount('coreMount', false),
        chute('CoreChute', 0.3),
        ...children,
      ],
    },
  ],
} as unknown as RocketTree);

const of = (events: FlightEvent[], type: string) => events.filter((e) => e.type === type);
function chargeTime(events: FlightEvent[], mountId: string): number {
  const found = of(events, 'EJECTION_CHARGE').filter((e) => e.motorMountId === mountId);
  expect(found.length, `one charge from ${mountId}`).toBe(1);
  return found[0]!.time;
}

describe('ejection charges deploy only their own assembly\'s devices, once (OR #2092)', () => {
  it('a pod charge deploys only the pod chute, the core charge only the core chute', () => {
    for (const timeStep of [0.05, 0.025]) {
      const r = OrkRocket.buildTree(core([pod('Pod', [mount('podMount', true), chute('PodChute', 0.08)])]));
      r.setMotorById('coreMount', CORE_C6);
      r.setMotorById('podMount', POD_MOTOR);
      const res = r.simulate({ launchRodLength: 1, timeStep, randomSeed: 0x2092 });
      expect(res.branches, 'a pod never separates').toBeUndefined();
      expect(of(res.events, 'SIM_ABORT')).toEqual([]);
      const podCharge = chargeTime(res.events, 'podMount');
      const coreCharge = chargeTime(res.events, 'coreMount');
      expect(podCharge).toBeLessThan(coreCharge);
      const deployed = of(res.events, 'RECOVERY_DEVICE_DEPLOYMENT');
      expect(deployed.map((e) => e.source).sort(), `step ${timeStep}`).toEqual(['CoreChute', 'PodChute']);
      // Each at its OWN charge plus the kernel's 1 ms minimum deployment delay.
      expect(deployed.find((e) => e.source === 'PodChute')!.time).toBeCloseTo(podCharge + 0.001, 9);
      expect(deployed.find((e) => e.source === 'CoreChute')!.time).toBeCloseTo(coreCharge + 0.001, 9);
    }
  }, 60_000);

  it('a nested pod\'s charge reaches neither the outer pod\'s chute nor the core\'s', () => {
    const inner = pod('Inner', [mount('innerMount', true), chute('InnerChute', 0.08)]);
    const r = OrkRocket.buildTree(core([pod('Outer', [chute('OuterChute', 0.08), inner])]));
    r.setMotorById('coreMount', CORE_C6);
    r.setMotorById('innerMount', POD_MOTOR);
    const res = r.simulate({ launchRodLength: 1, randomSeed: 0x2092 });
    const deployed = of(res.events, 'RECOVERY_DEVICE_DEPLOYMENT');
    expect(deployed.map((e) => e.source).sort()).toEqual(['CoreChute', 'InnerChute']);
    expect(deployed.find((e) => e.source === 'InnerChute')!.time)
      .toBeCloseTo(chargeTime(res.events, 'innerMount') + 0.001, 9);
  }, 60_000);

  it('a device deploys once: a second charge in the same assembly does not deploy it again', () => {
    for (const secondDelay of [1, 3]) { // simultaneous, and 2 s later
      const r = OrkRocket.buildTree(core([mount('secondMount', false)]));
      r.setMotorById('coreMount', { ...CORE_C6, ejectionDelay: 1 });
      r.setMotorById('secondMount', { ...CORE_C6, ejectionDelay: secondDelay });
      const res = r.simulate({ launchRodLength: 1, randomSeed: 0x2092 });
      const first = chargeTime(res.events, 'coreMount');
      expect(chargeTime(res.events, 'secondMount') - first).toBeCloseTo(secondDelay - 1, 9);
      const deployed = of(res.events, 'RECOVERY_DEVICE_DEPLOYMENT');
      expect(deployed.length, `second delay ${secondDelay}`).toBe(1);
      expect(deployed[0]!.time).toBeCloseTo(first + 0.001, 9);
      // ...before apogee, so a re-deployment would have had something to overwrite.
      expect(first + 0.001).toBeLessThan(res.summary.timeToApogee);
    }
  }, 60_000);
});
