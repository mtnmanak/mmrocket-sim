import { describe, expect, it } from 'vitest';
import type { FlightResult, IgnitionEvent, MotorSpec } from '@online-openrocket/engine';
import type { MountMotor } from '../App.js';
import { flyLaunch, reflyRun, type FlightHandle, type LaunchInput } from './flightRunner.js';

/**
 * The flight runner, flown — the behavioural replacement for the source-text
 * guards that used to live in flownIgnitionSites.test.ts (audit 2026-09-22).
 * Those counted `setFlownMotorOn(built.rocket, ` in App.tsx and stayed green
 * while "Show charts" re-flew a stored run at a delay a later Launch had left
 * on the shared handle; a count of call sites cannot see what a call writes.
 */

// ---------------------------------------------------------------------------
// The protocol, against a handle that records what it was told.
// ---------------------------------------------------------------------------

type Call =
  | ['motor', string, number]
  | ['ignition', string, IgnitionEvent, number]
  | ['supersonic', boolean]
  | ['kbf', boolean]
  | ['simulate'];

/** A stand-in handle: logs every write; `simulate` answers from `summary`. */
function recordingHandle(summary: Partial<FlightResult['summary']> = {}, opts: { throwOnSimulate?: boolean } = {}) {
  const calls: Call[] = [];
  const handle: FlightHandle = {
    setMotorById: (id: string, spec: MotorSpec) => { calls.push(['motor', id, spec.ejectionDelay]); },
    setMotorIgnitionById: (id: string, event: IgnitionEvent, delay = 0) => { calls.push(['ignition', id, event, delay]); },
    setSupersonicAero: (on: boolean) => { calls.push(['supersonic', on]); },
    setRogersModifiedBarrowman: (on: boolean) => { calls.push(['kbf', on]); },
    simulate: () => {
      calls.push(['simulate']);
      if (opts.throwOnSimulate) throw new Error('kernel threw');
      return {
        summary: { maxMachNumber: 0.3, optimumDelay: 6.85, maxAltitude: 100, ...summary },
        events: [], series: {},
      } as unknown as FlightResult;
    },
  };
  return { handle, calls };
}

const SPEC: MotorSpec = {
  designation: 'H128', diameter: 0.029, length: 0.194,
  times: [0, 0.1, 1.5], thrusts: [0, 150, 0], masses: [0.2, 0.19, 0.1],
  cgX: 0.097, ejectionDelay: 10,
};
const mm = (over: Partial<MountMotor> = {}): MountMotor => ({
  label: 'H128-10', spec: SPEC, meta: { label: 'H128-10' },
  ignition: { event: 'automatic', delay: 0 }, ...over,
});

/**
 * A staged design the way `assignMotor` leaves it: the sustainer (the PRIMARY)
 * electronics-timed at booster burnout + 1 s, the booster on AUTOMATIC.
 */
const staged = (autoDelay: boolean): LaunchInput => ({
  assigned: [
    ['sustainer', mm({ ignition: { event: 'burnout', delay: 1 }, meta: { label: 'H128-10', autoDelay } })],
    ['booster', mm()],
  ],
  hardware: undefined,
  primaryMountId: 'sustainer',
  simOptions: {},
  aeroMode: 'classic',
  supersonic: false,
  isOnLaunchStage: (id) => id === 'booster',
  onSupersonicUpgrade: () => {},
});

describe('flight runner — every motor write keeps its ignition', () => {
  /**
   * The bridge's `setMotorById` installs a FRESH MotorConfiguration, so a write
   * that does not re-apply the ignition silently returns the mount to
   * AUTOMATIC. On a staged design that lights the sustainer off the booster's
   * ejection charge instead of burnout + 1 s — and the auto-delay re-fly is the
   * flight `buildSimRun` stores (2026-09-08 audit).
   */
  const everyWriteKeepsIgnition = (calls: Call[]) => {
    calls.forEach((c, i) => {
      if (c[0] !== 'motor') return;
      if (c[1] === 'sustainer') {
        expect(calls[i + 1], `write #${i} of the sustainer lost its burnout + 1 s ignition`)
          .toEqual(['ignition', 'sustainer', 'burnout', 1]);
      } else {
        // AUTOMATIC with no timer is left exactly as the kernel configured it.
        expect(calls[i + 1]?.[0]).not.toBe('ignition');
      }
    });
  };

  it('on Launch, including the auto-delay write', () => {
    const { handle, calls } = recordingHandle();
    const flight = flyLaunch(handle, staged(true));
    expect(flight.flownDelayS).toBe(7); // 6.85 rounded — the auto delay DID write
    expect(calls.filter((c) => c[0] === 'motor' && c[1] === 'sustainer' && c[2] === 7)).toHaveLength(1);
    everyWriteKeepsIgnition(calls);
  });

  it('on a re-fly, including the delay write and every restore', () => {
    const { handle, calls } = recordingHandle();
    reflyRun(handle, {
      ...staged(false), delayS: 7,
      fly: { supersonic: false, kbf: false }, restore: { supersonic: false, kbf: false },
    });
    expect(calls.some((c) => c[0] === 'motor' && c[1] === 'sustainer' && c[2] === 7)).toBe(true);
    everyWriteKeepsIgnition(calls);
  });
});

describe('flight runner — the shared handle is handed back', () => {
  it('a re-fly that throws still restores the model and the motor', () => {
    const { handle, calls } = recordingHandle({}, { throwOnSimulate: true });
    expect(() => reflyRun(handle, {
      ...staged(false), delayS: 7,
      fly: { supersonic: true, kbf: true }, restore: { supersonic: false, kbf: false },
    })).toThrow('kernel threw');
    const after = calls.slice(calls.findIndex((c) => c[0] === 'simulate') + 1);
    expect(after).toContainEqual(['supersonic', false]);
    expect(after).toContainEqual(['kbf', false]);
    // The last write of the primary puts its OWN delay back, not the run's.
    const lastPrimary = [...after].reverse().find((c) => c[0] === 'motor' && c[1] === 'sustainer');
    expect(lastPrimary).toEqual(['motor', 'sustainer', 10]);
  });
});
