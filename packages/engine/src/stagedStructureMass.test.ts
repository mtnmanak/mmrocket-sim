import { describe, expect, it } from 'vitest';
import { OrkRocket, type ComponentNode, type MotorSpec, type RocketTree } from './orkEngine.js';

// The structure-mass memo (engine-java/patches/LEDGER.md, "Performance patches":
// masscalc/MassCalculator.java + rocketcomponent/FlightConfiguration.java). Upstream recomputes
// the dry structure mass four times per RK4 step; the patch caches it on the FlightConfiguration,
// keyed on that configuration's modID and the rocket's massModID, and clears it from the
// stage-flag mutators that bypass fireChangeEvent(). A performance patch must change NOTHING,
// so its risk is purely invalidation: a memo served across a stage change would fly the
// sustainer with the booster's mass after separation (or the booster with the whole stack's).
//
// Nothing asserted a staged flight's MASS: orkEngine.test.ts's two-stage test checks events,
// branches and apogee bounds. This pins every recorded mass after separation to the dry mass of
// each stage built on its own - a different rocket, so no memo is shared with the flight.

const C6: MotorSpec = {
  designation: 'C6', diameter: 0.018, length: 0.07,
  times: [0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0],
  thrusts: [0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0],
  masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132],
  cgX: 0.035, ejectionDelay: 1000,
};
const SPENT = 0.0132;

const sustainerParts = (): ComponentNode[] => [
  { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002 },
  {
    type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950,
    children: [
      { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.025, thickness: 0.003 },
      { type: 'masscomponent', mass: 0.015, length: 0.02, radius: 0.008 },
    ],
  },
] as unknown as ComponentNode[];
const boosterParts = (): ComponentNode[] => [{
  type: 'bodytube', length: 0.12, outerRadius: 0.012, thickness: 0.0003, density: 950,
  children: [
    { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.025, height: 0.035, thickness: 0.003 },
    { type: 'innertube', id: 'bmount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005,
      motorMount: true, position: { method: 'bottom', offset: 0 } },
  ],
}] as unknown as ComponentNode[];

const twoStage = (): RocketTree => ({
  name: 'Staged mass',
  components: [
    { type: 'stage', name: 'Sustainer', children: sustainerParts() },
    { type: 'stage', name: 'Booster', separationEvent: 'burnout', children: boosterParts() },
  ],
} as unknown as RocketTree);

const alone = (parts: ComponentNode[]) =>
  OrkRocket.buildTree({ name: 'alone', components: [{ type: 'stage', name: 'S', children: parts }] } as unknown as RocketTree);

describe('staged flight: each branch carries only its own structure mass', () => {
  it('after separation the sustainer weighs its own dry mass and the booster its dry mass plus the spent motor', () => {
    const sustainerDry = alone(sustainerParts()).staticInfo().massEmpty;
    const boosterDry = alone(boosterParts()).staticInfo().massEmpty;
    const r = OrkRocket.buildTree(twoStage());
    r.setMotorById('bmount', C6);
    const info = r.staticInfo();
    // The stack is the sum of its stages (the stage-alone builds are a fair reference).
    expect(info.massEmpty / (sustainerDry + boosterDry) - 1).toBeCloseTo(0, 12);

    const res = r.simulate({ launchRodLength: 1 });
    expect(res.branches?.length).toBe(2);
    const sep = res.events.find((e) => e.type === 'STAGE_SEPARATION')!.time;
    const sus = res.branches!.find((b) => b.name === 'Sustainer')!.series;
    const boo = res.branches!.find((b) => b.name === 'Booster')!.series;

    // At launch: the whole loaded stack.
    expect(sus.mass[0]! / info.mass - 1).toBeCloseTo(0, 12);
    let after = 0;
    sus.time.forEach((t, i) => {
      if (t <= sep + 1e-6 || sus.mass[i] === null) return;
      after++;
      expect(sus.mass[i]! / sustainerDry - 1, `sustainer t=${t}`).toBeCloseTo(0, 12);
    });
    expect(after, 'sustainer rows after separation').toBeGreaterThan(20);
    let boosterRows = 0;
    boo.time.forEach((t, i) => {
      if (t <= sep + 1e-6 || boo.mass[i] === null) return;
      boosterRows++;
      expect(boo.mass[i]! / (boosterDry + SPENT) - 1, `booster t=${t}`).toBeCloseTo(0, 12);
    });
    expect(boosterRows, 'booster rows after separation').toBeGreaterThan(5);
  }, 60_000);
});
