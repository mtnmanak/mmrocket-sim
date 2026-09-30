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

function fly(guides: ComponentNode[] = [], guideAllowance?: boolean) {
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
    guideAllowance, windAverage: 0, windStdDeviation: 0, randomSeed: 42, timeStep: TIME_STEP, maxTime: 1 });
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
  return { effective: result.effectiveLaunchRodLength, reason: result.launchGuideReason,
    ignoredButtons: result.launchGuideIgnoredButtons, liftoff: result.events.find(e => e.type === 'LIFTOFF')!.time, time, velocity, distance: distanceAt(i), previousDistance: distanceAt(i - 1),
    tolerance: velocity * dt };
}

function expectDistance(exit: ReturnType<typeof fly>, distance: number) {
  expect(exit.effective).toBeCloseTo(distance, 10);
  if (distance === 0) {
    expect(exit.time).toBeGreaterThanOrEqual(exit.liftoff);
    expect(exit.time - exit.liftoff).toBeLessThanOrEqual(2 * TIME_STEP);
    expect(exit.velocity).toBeGreaterThan(0);
    expect([exit.time, exit.velocity, exit.distance].every(Number.isFinite)).toBe(true);
    return;
  }
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
    expectDistance(guide, 0);
    expect(guide.reason).toBe('single-button');
  });

  it('moving the same lug up 0.3 m clears earlier and slower after 0.7 m', () => {
    const aft = fly([lug(0)]);
    const forward = fly([lug(0.3)]);
    expect(forward.time).toBeLessThan(aft.time);
    expect(forward.velocity).toBeLessThan(aft.velocity);
    expectDistance(forward, ROD_LENGTH - 0.3);
  });

  it('uses the forward button of two instances and matches separate components', () => {
    const forwardCentre = 0.02;
    const aftGap = 0.2;
    const buttons = fly([{
      type: 'railbutton', outerDiameter: 2 * BUTTON_RADIUS,
      angleOffset: 0, instanceCount: 2, instanceSeparation: BODY_LENGTH - aftGap - BUTTON_RADIUS - forwardCentre,
      position: { method: 'top', offset: forwardCentre }, overrideMass: 0, overrideCD: 0,
    }]);
    const forwardGap = BODY_LENGTH - forwardCentre - BUTTON_RADIUS;
    const equivalentLug = fly([lug(forwardGap)]);
    expectDistance(buttons, ROD_LENGTH - forwardGap);
    expect(buttons.tolerance).toBeLessThan(BUTTON_RADIUS);
    expectDistance(equivalentLug, ROD_LENGTH - forwardGap);
    expect(Math.abs(buttons.distance - equivalentLug.distance))
      .toBeLessThanOrEqual(Math.max(buttons.tolerance, equivalentLug.tolerance));
    const separate = fly([button(forwardGap), button(aftGap)]);
    expectDistance(separate, ROD_LENGTH - forwardGap);
    expect(buttons.time).toBeCloseTo(separate.time, 10);
    expect(buttons.velocity).toBeCloseTo(separate.velocity, 9);
  });
});

function button(gap: number, angleDeg = 0): ComponentNode {
  return { type: 'railbutton', outerDiameter: 2 * BUTTON_RADIUS, instanceCount: 1, angleOffset: angleDeg * Math.PI / 180,
    position: { method: 'top', offset: BODY_LENGTH - gap - BUTTON_RADIUS }, overrideMass: 0, overrideCD: 0 };
}

describe('two-button guidance geometry and bridge/kernel agreement', { timeout: 60_000 }, () => {
  it.each([
    { name: 'two buttons: forward one', guides: [button(0.1), button(0.3)], gap: 0.3, reason: 'buttons' },
    { name: 'three buttons: middle one', guides: [button(0.1), button(0.3), button(0.4)], gap: 0.3, reason: 'buttons' },
    { name: 'lug aft of lone button', guides: [lug(0.1), button(0.3)], gap: 0.1, reason: 'lug' },
    { name: 'lug forward of lone button', guides: [lug(0.3), button(0.1)], gap: 0.3, reason: 'lug' },
    { name: 'lug aft of second button', guides: [lug(0.2), button(0.1), button(0.3)], gap: 0.3, reason: 'mixed-buttons' },
    { name: 'lug forward of second button', guides: [lug(0.4), button(0.1), button(0.3)], gap: 0.4, reason: 'mixed-lug' },
    { name: 'equal mixed travel chooses lug', guides: [lug(0.3), button(0.1), button(0.3)], gap: 0.3, reason: 'mixed-lug' },
    { name: 'coincident buttons are one station', guides: [button(0.2), button(0.2)], gap: 1, reason: 'single-button' },
    { name: 'within 0.5 mm is one station', guides: [button(0.2), button(0.2004)], gap: 1, reason: 'single-button' },
    { name: 'exactly 0.5 mm is one station', guides: [button(0.2), button(0.2005)], gap: 1, reason: 'single-button' },
    { name: 'over 0.5 mm is two stations', guides: [button(0.2), button(0.2006)], gap: 0.2006, reason: 'buttons' },
    { name: 'station uses its aft-most edge', guides: [button(0.1), button(0.3), button(0.3004)], gap: 0.3, reason: 'buttons' },
    { name: 'opposite buttons cannot guide', guides: [button(0.1, 0), button(0.3, 180)], gap: 1, reason: 'single-button' },
    { name: 'one degree tolerance joins a line', guides: [button(0.1, 0), button(0.3, 0.9)], gap: 0.3, reason: 'buttons' },
    { name: 'exactly one degree joins a line', guides: [button(0.1, 0), button(0.3, 1)], gap: 0.3, reason: 'buttons' },
    { name: 'outside one degree separates lines', guides: [button(0.1, 0), button(0.3, 1.1)], gap: 1, reason: 'single-button' },
    // Review finding 2026-09-30: a greedy angle partition split these usable pairs
    // (the neighbour at the forward station took the pair's forward button).
    { name: 'a neighbour below the pair cannot split it', guides: [button(0.3, 0), button(0.1, 0.9), button(0.3, -0.5)], gap: 0.3, reason: 'buttons' },
    { name: 'a neighbour below a rotated pair cannot split it', guides: [button(0.3, 0.5), button(0.1, 1.4), button(0.3, 0)], gap: 0.3, reason: 'buttons' },
    { name: 'azimuth wrap at 180 degrees', guides: [button(0.1, 179.6), button(0.3, -179.6)], gap: 0.3, reason: 'buttons' },
    { name: 'azimuth wrap at zero degrees', guides: [button(0.1, -0.4), button(0.3, 0.4)], gap: 0.3, reason: 'buttons' },
    { name: 'best of two viable lines', guides: [button(0.1), button(0.2), button(0.3, 180), button(0.4, 180)], gap: 0.2, reason: 'buttons' },
    { name: 'core line ignores pod buttons at 120 and 240 degrees', guides: [button(0.3), button(0.4), podButtons(120, [button(0.05, 120)]), podButtons(240, [button(0.1, 240)])], gap: 0.4, reason: 'buttons' },
    { name: 'axis button cannot supplement core line', guides: [button(0.1), axisButtons([button(0.3)])], gap: 1, reason: 'single-button' },
    { name: 'axis buttons form their own guiding line', guides: [button(0.1), axisButtons([button(0.3), button(0.4)])], gap: 0.4, reason: 'buttons' },
    { name: 'lug with unaligned buttons uses rod', guides: [lug(0.3), button(0.1, 0), button(0.2, 180)], gap: 0.3, reason: 'lug' },
    { name: 'carrier cannot be second button', guides: [button(0.2), { ...button(0.1), launchGuide: false }], gap: 1, reason: 'single-button' },
    { name: 'tower', guides: [], gap: 0, reason: 'none' },
    { name: 'only carriers', guides: [{ ...button(0.2), launchGuide: false }], gap: 0, reason: 'none' },
    { name: 'clamp short button guidance', guides: [button(1.2), button(0.1)], gap: 1, reason: 'buttons' },
  ])('$name', ({ guides, gap, reason }) => {
    const exit = fly(guides);
    expectDistance(exit, ROD_LENGTH - gap);
    expect(exit.reason).toBe(reason);
    expect(exit.ignoredButtons).toBe(reason === 'lug' && guides.some(g => g.type === 'railbutton'));
  });
  it.each([[lug(0.3)], [button(0.3)], [button(0.1), button(0.3)]])('allowance off flies full length %#', (...guides) => {
    const exit = fly(guides, false);
    expectDistance(exit, ROD_LENGTH);
    expect(exit.reason).toBe('off');
  });
});

// Deliberately weightless pods keep bounds aligned with the core body.
function podButtons(angleDeg: number, guides: ComponentNode[], radiusOffset = 0.03): ComponentNode {
  return { type: 'podset', instanceCount: 1, radiusMethod: 'free', radiusOffset,
    angleOffset: angleDeg * Math.PI / 180, position: { method: 'top', offset: 0 },
    children: [{ type: 'bodytube', length: BODY_LENGTH, outerRadius: 0.004,
      thickness: 0.0001, overrideMass: 0, overrideCD: 0, children: guides }] };
}
function axisButtons(guides: ComponentNode[]): ComponentNode {
  // Exact cancellation: centre y=-0.004 plus button parent radius y=+0.004.
  return podButtons(0, guides, -0.004);
}
