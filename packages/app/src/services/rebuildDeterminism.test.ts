// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import type { AeroState, DesignState } from './designDerivation.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { simulateDesign } from './simulateDesign.js';

/**
 * REBUILD DETERMINISM (KD1, 2026-11-25). The same design, built afresh and
 * flown through the app's own Launch path (simulateDesign = buildDesign on the
 * kernel's handles + flyLaunch) several times in one process, must give the
 * same flight to the last bit.
 *
 * Before KD1 it did not, in two places, for one reason: the kernel kept a set
 * in a hash container whose hash comes from random component UUIDs
 * (crypto.randomUUID under TeaVM), so its iteration order changed with every
 * rebuild and float sums taken over it changed in the last bit.
 *  - FlightConfiguration's motors (a HashMap keyed by MotorConfigurationId:
 *    the mount's UUID hash folded with a process-wide configuration-id
 *    counter). Thrust was summed, and IGNITION / BURNOUT / EJECTION_CHARGE
 *    events queued, in that order: three or more separate mounts with motors
 *    that are not all bit-identical moved the apogee (adaptive stepping carries
 *    the last bit into centimetres), and two or more mounts reordered the
 *    same-time motor events.
 *  - SimulationStatus's deployed recovery devices (a HashSet of components):
 *    the descent sums each device's CdA in that order, so three or more devices
 *    out at once moved the ground-hit time.
 * Both containers now iterate in insertion order: the configuration's
 * component walk, and deployment order (engine-java/patches/LEDGER.md, KD1).
 *
 * Synthetic curves, so no shipped motor data is pinned; no kernel float is
 * hard-coded: every assertion compares a build with the first build.
 */

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const CLASSIC: AeroState = { aeroMode: 'classic', effectiveKbf: true, autoSupersonic: false };

const curve = (designation: string, scale: number, length: number, delay: number): MotorSpec => ({
  designation, diameter: 0.024, length,
  times: [0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0],
  thrusts: [0, 48, 24, 20.4, 19.6, 19.2, 18, 0].map(t => t * scale),
  masses: [0.07, 0.068, 0.062, 0.057, 0.047, 0.037, 0.031, 0.03],
  cgX: length / 2, ejectionDelay: delay,
});
const motor = (designation: string, scale: number, length = 0.07, delay = 5): MountMotor => ({
  label: designation, spec: curve(designation, scale, length, delay),
  meta: { label: designation, manufacturer: 'Acme', motorId: designation, autoDelay: false },
  ignition: { event: 'automatic', delay: 0 },
});

const tube = (id: string, extra: Partial<ComponentNode> = {}): ComponentNode => ({
  type: 'innertube', id, name: id, length: 0.2, outerRadius: 0.0125, thickness: 0.0005, motorMount: true, ...extra,
} as ComponentNode);
const chute = (id: string, diameter: number, cd?: number): ComponentNode => ({
  type: 'parachute', id, name: id, diameter, deployEvent: 'apogee', ...(cd === undefined ? {} : { cd }),
} as ComponentNode);

/** One stage, one body tube holding the mounts, finCount fins and the chutes. */
function rocket(mounts: ComponentNode[], chutes: ComponentNode[], finCount: number): RocketTree {
  return {
    name: 'Determinism bird',
    components: [{
      type: 'stage', id: 'st0', name: 'Sustainer',
      children: [
        { type: 'nosecone', id: 'nc', length: 0.3, aftRadius: 0.04, thickness: 0.002, shape: 'ogive' } as ComponentNode,
        {
          type: 'bodytube', id: 'bt', length: 0.9, outerRadius: 0.04, thickness: 0.001,
          children: [
            { type: 'trapezoidfinset', id: 'fins', finCount, rootChord: 0.15, tipChord: 0.07, sweep: 0.08,
              height: 0.1, thickness: 0.004, crossSection: 'airfoil' } as ComponentNode,
            ...mounts,
            ...chutes,
          ],
        } as ComponentNode,
      ],
    }],
  };
}
/** n separate single-tube mounts in a ring. */
const ring = (n: number): ComponentNode[] => Array.from({ length: n }, (_, i) => tube(`ring${i}`, {
  name: `MMT ${i + 1}`, cluster: 'single', radialPosition: 0.023, radialDirection: i * Math.PI * 2 / n,
} as Partial<ComponentNode>));

interface Flown {
  apogee: number; timeToApogee: number; maxVelocity: number; events: string[]; time: number[]; altitude: number[];
}

async function flyFresh(c: Case): Promise<Flown> {
  // A NEW tree and NEW motor objects every time: nothing carries over from the
  // previous build except what the kernel itself keeps between builds.
  const state: DesignState = {
    tree: c.tree(), mountMotors: c.motors(), launch: c.launch, measured: { massKg: null, cgM: null }, savedConfigs: [],
    activeConfigId: null, unmatchedRefs: {},
  };
  const { run, result } = await simulateDesign(state, { aero: CLASSIC, yieldToUi: async () => {} });
  return {
    apogee: run.maxAltitude, timeToApogee: run.timeToApogee, maxVelocity: run.maxVelocity,
    time: [...result.series.time], altitude: [...(result.series.altitude ?? [])],
    events: result.events.map(e => `${e.type}@${e.time}:${e.motorMountId ?? ''}:${e.sourceId ?? ''}`),
  };
}

interface Case {
  name: string;
  builds: number;
  tree: () => RocketTree;
  motors: () => Record<string, MountMotor>;
  launch: DesignState['launch'];
  /** Mounts that must ignite (each its own motor), and devices that must deploy together. */
  ignitions: number;
  deployments: number;
}

const CASES: Case[] = [
  {
    // The case that moved most on v0.217: up to 1.1 cm apogee and 0.025 s time
    // to apogee across rebuilds, and a different event list on nearly every build.
    name: '6 separate tubes, 6 distinct motors (thrust, length and delay mixed), calm vertical',
    builds: 5,
    tree: () => rocket(ring(6), [chute('main', 0.8)], 6),
    motors: () => Object.fromEntries([1, 1.1, 1.2, 1.05, 1.15, 0.95].map((k, i) =>
      [`ring${i}`, motor(`M${i}`, k, [0.07, 0.1, 0.12][i % 3]!, [5, 6, 7][i % 3]!)])),
    launch: DEFAULT_CONDITIONS,
    ignitions: 6,
    deployments: 1,
  },
  {
    name: '4 separate tubes, mixed 1/1.1/1.2/1 thrust, 5 degree rod, 4 m/s wind',
    builds: 5,
    tree: () => rocket(ring(4), [chute('main', 0.8)], 4),
    motors: () => Object.fromEntries([1, 1.1, 1.2, 1].map((k, i) => [`ring${i}`, motor(`M${i}`, k)])),
    launch: { ...DEFAULT_CONDITIONS, launchRodAngleDeg: 5, windAverage: 4 },
    ignitions: 4,
    deployments: 1,
  },
  {
    // Three chutes out together whose CdA terms sum to three different doubles
    // depending on the order they are added in (found by search against the
    // kernel's own expression). On v0.217 eight rebuilds of this design gave
    // three different descents (time and altitude series).
    name: 'one motor, 3 chutes deployed together at apogee',
    builds: 6,
    tree: () => rocket([tube('mount')], [chute('chuteA', 0.531, 0.92), chute('chuteB', 0.61, 0.83),
      chute('chuteC', 0.433, 1.2)], 4),
    motors: () => ({ mount: motor('A', 1) }),
    launch: DEFAULT_CONDITIONS,
    ignitions: 1,
    deployments: 3,
  },
];

describe('rebuilding the same design gives the same flight', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const flights: Flown[] = [];
      for (let i = 0; i < c.builds; i++) flights.push(await flyFresh(c));
      const first = flights[0]!;

      // The fixture really is the case named: every mount ignites as its own
      // motor, and the devices deploy at one instant.
      const ignitions = first.events.filter(e => e.startsWith('IGNITION@'));
      expect(ignitions).toHaveLength(c.ignitions);
      expect(new Set(ignitions.map(e => e.split(':')[1])).size).toBe(c.ignitions);
      const deployments = first.events.filter(e => e.startsWith('RECOVERY_DEVICE_DEPLOYMENT@'));
      expect(deployments).toHaveLength(c.deployments);
      expect(new Set(deployments.map(e => e.split(':')[0])).size).toBe(1);
      expect(first.events.some(e => e.startsWith('GROUND_HIT@'))).toBe(true);
      expect(Number.isFinite(first.apogee) && first.apogee > 0).toBe(true);
      expect(first.altitude.length).toBe(first.time.length);
      expect(first.time.length).toBeGreaterThan(100);

      for (const f of flights.slice(1)) {
        // toBe is Object.is: the same float64, not merely close.
        expect(f.apogee).toBe(first.apogee);
        expect(f.timeToApogee).toBe(first.timeToApogee);
        expect(f.maxVelocity).toBe(first.maxVelocity);
        expect(f.events).toEqual(first.events);
        // The whole trajectory, sample by sample: a descent difference shows here
        // even when the ground-hit time happens to round the same.
        expect(f.time).toEqual(first.time);
        expect(f.altitude).toEqual(first.altitude);
      }
    }, 120_000);
  }
});
