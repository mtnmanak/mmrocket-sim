import type { FlightResult, MotorSpec } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { DELAY_POLICY, delayMountsOf, storeDelay, type DelayResolution } from './autoDelaySolver.js';

/** A persisted record fixture, independent of live-kernel integration. */
export function testResolution(assigned: [string, MountMotor][], delays: number[]): DelayResolution {
  return { policy: DELAY_POLICY, probes: 2, elapsedMs: 1, mounts: delayMountsOf(assigned).map((m, i) => ({
    ...m, flownDelay: storeDelay(delays[i]!),
    rawOptimum: m.mode === 'auto' ? delays[i]! : null,
    recommendedDelay: m.mode === 'auto' ? delays[i]! : null,
    burnoutTime: m.mode === 'auto' ? 2 : null, apogeeTime: m.mode === 'auto' ? 2 + delays[i]! : null,
    branchId: m.mode === 'auto' ? 'carrier' : null, branchName: m.mode === 'auto' ? 'Branch' : null,
    status: m.mode === 'auto' ? 'resolved' : 'fixed',
  })) };
}

export const testMotor = (autoDelay = true, delay = 0): MountMotor => ({
  label: 'test', meta: { label: 'test', autoDelay }, ignition: { event: 'automatic', delay: 0 },
  spec: {
    designation: 'test', diameter: 0.029, length: 0.1, cgX: 0.05, ejectionDelay: delay,
    times: [0, 1, 2], thrusts: [0, 100, 0], masses: [0.2, 0.15, 0.1],
  } satisfies MotorSpec,
});

/** Synthetic measured trace: a linear velocity crossing exactly at peakTime. */
export function probeFlight(mounts: string[] = ['a', 'b'], peakTime = 12): FlightResult {
  return {
    summary: { maxMachNumber: 0.3, optimumDelay: 999, maxAltitude: 100 }, events: [], series: {},
    delayProbe: { version: 1, branches: [{
      id: 'carrier', name: 'Duplicate name', mountIds: mounts,
      events: [...mounts.map((id, i) => ({ type: 'BURNOUT', time: 2 + i * 3, motorMountId: id })),
        { type: 'GROUND_HIT', time: 40 }],
      series: { time: [0, peakTime - 1, peakTime + 1, 40], altitude: [0, 99, 99, 0], Vz: [0, 1, -1, -20] },
    }] },
  } as unknown as FlightResult;
}
