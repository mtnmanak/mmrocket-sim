import { describe, expect, it } from 'vitest';
import { OrkRocket, type FlightEvent, type MotorSpec, type RocketTree } from './orkEngine.js';

// OR #3375 / PR #3382, narrow port (engine-java/patches/LEDGER.md, tumble release T2). The TUMBLE
// handler decided "tumble" against "abort TUMBLE_UNDER_THRUST" from the thrust RECORDED at the
// start of the last step. A separated booster's branch starts as a copy of its parent's rows, so
// a finless booster - whose bare cylinder has no CP and queues TUMBLE at separation - read the
// parent's powered sample and aborted "under thrust" with its motor burnt out. The handler now
// computes the thrust at the event itself (RK4SimulationStepper.calculateEventThrust).
//
// Its guards were JUnit only (EventThrustTest, `gradlew test`), which neither `npm test` nor the
// deploy gate runs. This is that file's CHAD fixture - a finless motor-tube booster under a
// rounded-fin sustainer - through the shipped bridge.

const T2: MotorSpec = {
  designation: 'T2', diameter: 0.018, length: 0.07,
  times: [0, 0.1, 0.3, 0.5, 1, 1.5, 1.85, 2],
  thrusts: [0, 12, 6, 5.1, 4.9, 4.8, 4.5, 0],
  masses: [0, 0.1, 0.3, 0.5, 1, 1.5, 1.85, 2].map((t) => 0.024 - 0.0108 * t / 2),
  cgX: 0.035, ejectionDelay: 1,
};

const tree: RocketTree = {
  name: 'CHAD',
  components: [
    {
      type: 'stage', name: 'Sustainer',
      children: [
        { type: 'nosecone', shape: 'ogive', length: 0.07, aftRadius: 0.012, thickness: 0.002 },
        {
          type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950,
          children: [
            // Enlarged and swept, as upstream's CHAD fixture, so the stack survives to separation.
            { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.055, sweep: 0.071, height: 0.03,
              thickness: 0.003, crossSection: 'rounded' },
            { type: 'innertube', id: 'smount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005,
              motorMount: true, position: { method: 'bottom', offset: 0 } },
            { type: 'parachute', diameter: 0.3, deployEvent: 'ejection', deployDelay: 0 },
          ],
        },
      ],
    },
    {
      type: 'stage', name: 'CHAD booster', separationEvent: 'burnout', separationDelay: 0,
      // No nose, no fins: an isolated cylinder has zero CP weight, so the kernel queues TUMBLE.
      children: [{ type: 'bodytube', id: 'bmount', length: 0.07, outerRadius: 0.009, thickness: 0, motorMount: true }],
    },
  ],
} as unknown as RocketTree;

const of = (events: FlightEvent[], type: string) => events.filter((e) => e.type === type);

describe('TUMBLE judges thrust at the event (OR #3375)', () => {
  it('a finless booster separated at burnout tumbles; it is not aborted under its parent\'s copied thrust', () => {
    const r = OrkRocket.buildTree(tree);
    r.setMotorById('smount', { ...T2, ejectionDelay: 1 });
    r.setMotorIgnitionById('smount', 'burnout', 0);
    r.setMotorById('bmount', { ...T2, ejectionDelay: 1000 });
    r.setMotorIgnitionById('bmount', 'launch', 0);
    const res = r.simulate({ launchRodLength: 1, randomSeed: 0x3375 });

    expect(res.branches?.length, 'separation made two branches').toBe(2);
    const booster = res.branches!.find((b) => b.name === 'CHAD booster')!;
    const sustainer = res.branches!.find((b) => b.name === 'Sustainer')!;
    const sep = of(booster.events, 'STAGE_SEPARATION')[0]!;
    expect(sep, 'booster separation').toBeDefined();

    // The booster tumbles once, at separation, and is NOT aborted.
    const tumbles = of(booster.events, 'TUMBLE');
    expect(tumbles.length, `booster events: ${booster.events.map((e) => e.type).join(',')}`).toBe(1);
    expect(tumbles[0]!.time).toBeGreaterThanOrEqual(sep.time - 1e-9);
    expect(of(booster.events, 'SIM_ABORT').map((e) => e.cause)).toEqual([]);
    // Precondition: the row the old handler read WAS powered. The branch's rows up to separation
    // are the parent's, and the parent was still burning one step before burnout.
    const powered = booster.series.time.some((t, i) => t < sep.time && t > 1.5 && booster.series.thrust[i]! > 0.01);
    expect(powered, 'copied parent rows carry thrust').toBe(true);

    // The sustainer flies on: lit at separation and never aborted.
    expect(of(sustainer.events, 'SIM_ABORT')).toEqual([]);
    const lit = of(sustainer.events, 'IGNITION').filter((e) => e.motorMountId === 'smount');
    expect(lit.length).toBe(1);
    expect(Math.abs(lit[0]!.time - sep.time)).toBeLessThanOrEqual(0.05 + 1e-9);
  }, 60_000);
});
