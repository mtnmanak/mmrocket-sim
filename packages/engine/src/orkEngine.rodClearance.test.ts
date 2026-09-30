import { describe, expect, it } from 'vitest';
import { OrkRocket, type ComponentNode, type MotorSpec } from './orkEngine.js';

// Reference C6 curve used by orkEngine.test.ts and rodDirection.test.ts.
const C6: MotorSpec = {
  designation: 'C6', diameter: 0.018, length: 0.07,
  times: [0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0],
  thrusts: [0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0],
  masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132],
  cgX: 0.035, ejectionDelay: 5.0,
};
const ROD_LENGTH = 1;
const TIME_STEP = 0.001;
const BODY_LENGTH = 0.5;
const LUG_LENGTH = 0.02;
const BUTTON_RADIUS = 0.01;

// K9 (docs/open-items.md): isolate guide geometry from its added mass and drag,
// otherwise an aft lug cannot have the tower's identical exit time and speed.
const lug = (aftGap: number): ComponentNode => ({
  type: 'launchlug', length: LUG_LENGTH, outerRadius: 0.003, thickness: 0.0005,
  instanceCount: 1, overrideMass: 0, overrideCD: 0,
  position: { method: 'top', offset: BODY_LENGTH - aftGap - LUG_LENGTH },
});

function fly(guides: ComponentNode[] = []) {
  const rocket = OrkRocket.buildTree({ name: 'K9', components: [
    { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' },
    { type: 'bodytube', length: BODY_LENGTH, outerRadius: 0.012, thickness: 0.0003, density: 950,
      children: [
        { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03,
          sweep: 0.02, height: 0.03, thickness: 0.003 },
        { type: 'innertube', id: 'mount', length: 0.07, outerRadius: 0.0095,
          thickness: 0.0005, motorMount: true },
        { type: 'parachute', diameter: 0.3 },
        ...guides,
      ] },
  ] });
  rocket.setMotorById('mount', C6);
  const result = rocket.simulate({ launchRodLength: ROD_LENGTH, launchRodAngle: 5 * Math.PI / 180,
    windAverage: 0, windStdDeviation: 0, randomSeed: 42, timeStep: TIME_STEP, maxTime: 1 });
  const events = result.events.filter((e) => e.type === 'LAUNCHROD');
  expect(events).toHaveLength(1);
  const time = events[0]!.time;
  const { series, summary } = result;
  const i = series.time.findIndex((t) => t === time);
  expect(i).toBeGreaterThan(0);
  const distanceAt = (j: number) => Math.hypot(series.altitude[j]!, series['Pl']![j]!);
  const velocity = summary.launchRodVelocity;
  expect(velocity).toBeGreaterThan(0);
  expect(velocity).toBe(series.velocity[i]);
  const dt = series.time[i]! - series.time[i - 1]!;
  expect(dt).toBeGreaterThan(0);
  expect(dt).toBeLessThanOrEqual(TIME_STEP);
  // Clearance is recorded at a step's end. During this accelerating ascent,
  // end speed * the actual straddling dt bounds that single step's travel.
  return { time, velocity, distance: distanceAt(i), previousDistance: distanceAt(i - 1),
    tolerance: velocity * dt };
}

function expectDistance(exit: ReturnType<typeof fly>, distance: number) {
  expect(exit.previousDistance).toBeLessThanOrEqual(distance);
  expect(exit.distance).toBeGreaterThan(distance);
  expect(exit.distance - distance).toBeLessThanOrEqual(exit.tolerance);
}

// Each case flies the kernel several times; on CI's slower runner the first one also
// pays the engine's warm-up and ran 5.47 s against vitest's 5 s default (v0.143's first push).
describe('K9 launch guide clearance', { timeout: 60_000 }, () => {
  it('keeps the full rod length and identical exit when no guide has been added', () => {
    const before = fly();
    const noGuide = fly([]);
    expect(noGuide.time).toBe(before.time);
    expect(noGuide.velocity).toBe(before.velocity);
    expectDistance(noGuide, ROD_LENGTH);
  });

  it('an aft-end lug clears at the tower time and speed within 1e-9 relative', () => {
    const tower = fly();
    const aft = fly([lug(0)]);
    for (const key of ['time', 'velocity'] as const) {
      expect(Math.abs(aft[key] - tower[key]) / tower[key]).toBeLessThanOrEqual(1e-9);
    }
    expectDistance(aft, ROD_LENGTH);
  });

  it('keeps a non-guide railbutton carrier on the full rod, but an unmarked button guides', () => {
    const aftGap = 0.3;
    const button: ComponentNode = {
      type: 'railbutton', outerDiameter: 2 * BUTTON_RADIUS, instanceCount: 1,
      position: { method: 'top', offset: BODY_LENGTH - aftGap - BUTTON_RADIUS },
      overrideMass: 0, overrideCD: 0,
    };
    const tower = fly();
    const carrier = fly([{ ...button, launchGuide: false }]);
    expect(carrier.time).toBe(tower.time);
    expect(carrier.velocity).toBe(tower.velocity);
    expect(carrier.distance).toBe(tower.distance);
    expectDistance(carrier, ROD_LENGTH);

    const guide = fly([button]);
    expect(guide.time).toBeLessThan(carrier.time);
    expect(guide.velocity).toBeLessThan(carrier.velocity);
    expectDistance(guide, ROD_LENGTH - aftGap);
  });

  it('moving the same lug up 0.3 m clears earlier and slower after 0.7 m', () => {
    const aft = fly([lug(0)]);
    const forward = fly([lug(0.3)]);
    expect(forward.time).toBeLessThan(aft.time);
    expect(forward.velocity).toBeLessThan(aft.velocity);
    expectDistance(forward, ROD_LENGTH - 0.3);
  });

  it('uses the aft edge of the second rail-button instance, just as for a lug', () => {
    const forwardCentre = 0.02;
    const aftGap = 0.2;
    const buttons = fly([{
      type: 'railbutton', outerDiameter: 2 * BUTTON_RADIUS,
      instanceCount: 2, instanceSeparation: BODY_LENGTH - aftGap - BUTTON_RADIUS - forwardCentre,
      position: { method: 'top', offset: forwardCentre }, overrideMass: 0, overrideCD: 0,
    }]);
    const equivalentLug = fly([lug(aftGap)]);
    expectDistance(buttons, ROD_LENGTH - aftGap);
    expect(buttons.tolerance).toBeLessThan(BUTTON_RADIUS);
    expectDistance(equivalentLug, ROD_LENGTH - aftGap);
    expect(Math.abs(buttons.distance - equivalentLug.distance))
      .toBeLessThanOrEqual(Math.max(buttons.tolerance, equivalentLug.tolerance));
    // Searching only instance [0] would shorten travel by the button separation,
    // far outside one step; ignoring buttons would instead use the full metre.
    const firstOnlyDistance = ROD_LENGTH - (BODY_LENGTH - forwardCentre - BUTTON_RADIUS);
    expect(buttons.previousDistance).toBeGreaterThan(firstOnlyDistance + buttons.tolerance);
  });
});
