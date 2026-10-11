import { describe, expect, it } from 'vitest';
import { OrkRocket, type FlightResult, type MotorSpec, type RocketTree } from './orkEngine.js';

// OR #3183 / PR #3190 (engine-java/patches/LEDGER.md, tumble release T4): tumbling used to be
// decided after every step by an INSTANTANEOUS comparator - recorded AOA above the 17.5 deg stall
// angle AND recorded CG aft of the recorded CP - so a single step was enough, and the rail-exit
// transient of a STABLE rocket in a steady crosswind aborted it (TUMBLE_UNDER_THRUST). It is now a
// sustained-AOA detector: the recorded AOA, low-pass filtered with a time constant from the pitch
// natural frequency, must exceed 60 deg.
//
// tumbleRelease.test.ts pins the natural-frequency series it feeds on and the LOW LargeAOA
// warning; the detector's own effect on a flight was asserted only by JUnit
// (TumbleReleaseIntegrationTest, `gradlew test`), which neither `npm test` nor the deploy gate
// runs. This flies that file's scenario through the shipped bridge.
//
// The old comparator cannot be run here, so its trigger is asserted as a PRECONDITION read off
// the recorded series: a cleared-rail row with AOA > 17.5 deg and CG > CP. On the old kernel that
// row aborted the flight; this flight must complete.

const tree: RocketTree = {
  name: 'Tumble detector',
  components: [
    {
      type: 'nosecone', shape: 'ogive', length: 0.07, aftRadius: 0.012, thickness: 0.002,
      // 10 g of nose ballast: about 2 cal of margin at rail exit in calm air.
      children: [{ type: 'masscomponent', mass: 0.01, length: 0.02, radius: 0.008 }],
    },
    {
      type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950,
      children: [
        { type: 'trapezoidfinset', finCount: 3, rotation: 0.2, rootChord: 0.05, tipChord: 0.03,
          sweep: 0.02, height: 0.03, thickness: 0.003, crossSection: 'rounded' },
        { type: 'innertube', id: 'mount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005,
          motorMount: true, position: { method: 'bottom', offset: 0 } },
      ],
    },
  ],
} as unknown as RocketTree;

const times = [0, 0.1, 0.3, 0.5, 1, 1.5, 1.85, 2];
const motor: MotorSpec = {
  designation: 'T2', diameter: 0.018, length: 0.07, times,
  thrusts: [0, 12, 6, 5.1, 4.9, 4.8, 4.5, 0],
  masses: times.map((t) => 0.024 - 0.0108 * t / 2), cgX: 0.035, ejectionDelay: 1000,
};

const STALL = 17.5 * Math.PI / 180;

// Cut at 12 s: apogee is near 8 s and the calm descent's TUMBLE near 9 s; the rest of an
// unrecovered fall is 40 s of flight nothing here reads.
function fly(wind: number): FlightResult {
  const r = OrkRocket.buildTree(tree);
  r.setMotorById('mount', motor);
  return r.simulate({ launchRodLength: 0.5, windAverage: wind, windStdDeviation: 0, randomSeed: 0x3183,
    timeStep: 0.01, maxTime: 12, series: 'full' });
}

const eventTime = (r: FlightResult, type: string) => r.events.find((e) => e.type === type)?.time;

describe('tumbling is a SUSTAINED high AOA, not one step (OR #3183)', () => {
  it('a stable rocket off a short rail in a steady 8 m/s crosswind weathercocks and flies on', () => {
    const calm = fly(0);
    const windy = fly(8);
    const s = windy.series;
    // The old kernel aborted this flight TUMBLE_UNDER_THRUST at 0.119 s, one step off the rail.
    expect(windy.events.filter((e) => e.type === 'SIM_ABORT').map((e) => e.cause)).toEqual([]);
    const rail = eventTime(windy, 'LAUNCHROD')!;
    expect(rail).toBeDefined();
    // Precondition: the old comparator's trigger is on this flight's recorded ascent rows.
    const oldTrigger = s.time.findIndex((t, i) => t > rail && t < 1.0
      && s.aoa[i]! > STALL && s.cgLocation[i]! > s.cpLocation[i]!);
    expect(oldTrigger, 'old comparator would have fired').toBeGreaterThanOrEqual(0);
    const apogee = eventTime(windy, 'APOGEE');
    expect(apogee, 'reached apogee').toBeDefined();
    const tumble = eventTime(windy, 'TUMBLE');
    if (tumble !== undefined) expect(tumble, 'no tumble on the way up').toBeGreaterThan(apogee!);
    // It recovers rather than departs: ascent AOA stays well short of a tumble.
    const maxAoa = Math.max(...s.time.map((t, i) => (t > rail && t < 1.5 ? s.aoa[i]! : 0)));
    expect(maxAoa).toBeLessThan(45 * Math.PI / 180);
    // A sanity bound only, not an accuracy claim.
    expect(windy.summary.maxAltitude).toBeGreaterThan(0.5 * calm.summary.maxAltitude);
  }, 60_000);

  it('the same rocket with no recovery device, in calm air, tumbles after apogee as it falls', () => {
    const calm = fly(0);
    const apogee = eventTime(calm, 'APOGEE')!;
    const tumble = eventTime(calm, 'TUMBLE');
    // The detector sees the rocket come over at apogee and fall with the AOA held high.
    expect(tumble, `events: ${calm.events.map((e) => e.type).join(',')}`).toBeDefined();
    expect(tumble!).toBeGreaterThan(apogee);
    expect(calm.events.filter((e) => e.type === 'SIM_ABORT')).toEqual([]);
    // ...and it is the DETECTOR's decision: no recorded row before it meets the old comparator
    // (AOA > stall with CG aft of CP). The old kernel tumbled this flight 0.2 s later, at the first
    // such row; this one never sees one.
    const s = calm.series;
    const oldTrigger = s.time.findIndex((t, i) => t <= tumble! && s.aoa[i]! > STALL
      && s.cpLocation[i] !== null && s.cgLocation[i]! > s.cpLocation[i]!);
    expect(oldTrigger, `old-comparator row at t=${s.time[oldTrigger]}`).toBe(-1);
  }, 60_000);
});
