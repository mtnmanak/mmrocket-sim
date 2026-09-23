import { describe, expect, it } from 'vitest';
import { OrkRocket, type ComponentNode, type RocketTree } from './orkEngine.js';

/**
 * POWER-ON BASE DRAG IS CREDITED ON THE BASE THE MOTORS EXHAUST THROUGH, once per
 * stage instance (kernel pass 2, 2026-09-22 audit).
 *
 * `BarrowmanCalculator.calculateBaseCD` (RASAero feature #2) removes the stage's
 * equivalent nozzle-exit area from the drag-producing base area while that stage
 * thrusts. It used to do that for EVERY SymmetricComponent base whose `getStage()`
 * was the thrusting stage — a pod's body tube included, since a pod's stage is the
 * enclosing one, and an intermediate step-down too — so a stage with k bases
 * recovered k nozzle areas while the pressure-thrust half
 * (`RK4SimulationStepper.calculatePressureThrust`) charged exactly one per stage
 * instance. Measured before the fix at M0.3, Rogers Kbf, 29 mm airframe, 20 mm
 * exit: reduction 0.062640 without pods, 0.187919 with two 24 mm pods — exactly
 * three areas. The credit now lands on the stage's aft-most base only (the last
 * body component of the stage's own line, never a pod's), and the instance count
 * multiplies it exactly as it always did, so an N-strap-on parallel stage still
 * recovers N areas.
 *
 * These are the BEHAVIOURAL guards: engine-java's difftest compares a JVM run
 * against a TeaVM run with no stored baseline, so a change that moves both
 * runtimes together passes it (LEDGER 2026-08-25b). The before/after goldenJvm
 * diff is in the LEDGER entry.
 */

/** The kernel's subsonic base law, `BarrowmanCalculator.calculateBaseCD(m)` for m <= 1. */
const subsonicBaseCd = (m: number) => 0.12 + 0.13 * m * m;

/** 29 mm airframe (outer radius 14.5 mm) — the reference diameter in every tree below. */
const CORE_R = 0.0145;
const POD_R = 0.012;
const EXIT_D = 0.02;

/** One nozzle area's worth of base CD at subsonic Mach `m`, on the 29 mm reference. */
const oneArea = (m: number) => subsonicBaseCd(m) * (EXIT_D / 2) ** 2 / CORE_R ** 2;

const fins: ComponentNode = {
  type: 'trapezoidfinset', finCount: 3, rootChord: 0.07, tipChord: 0.035, sweep: 0.04,
  height: 0.05, thickness: 0.003,
};

/** Two 24 mm pods (nose + tube each) on the core's aft end. */
const pods: ComponentNode = {
  type: 'podset', id: 'pods', instanceCount: 2, radiusMethod: 'relative', radiusOffset: 0,
  angleOffset: 0, position: { method: 'bottom', offset: 0 },
  children: [
    { type: 'nosecone', length: 0.06, aftRadius: POD_R, thickness: 0.002 },
    { type: 'bodytube', id: 'pod-tube', length: 0.25, outerRadius: POD_R, thickness: 0.0005, density: 950 },
  ],
};

/** A 29 mm single-stage design, with or without the two pods. */
const podDesign = (withPods: boolean, nozzleExitDiameter = EXIT_D): RocketTree => ({
  name: withPods ? 'Pods' : 'NoPods',
  components: [{
    type: 'stage', name: 'S', nozzleExitDiameter,
    children: [
      { type: 'nosecone', length: 0.12, aftRadius: CORE_R, thickness: 0.002 },
      {
        type: 'bodytube', length: 0.6, outerRadius: CORE_R, thickness: 0.0005, density: 950,
        children: withPods ? [fins, pods] : [fins],
      },
    ],
  }],
});

/**
 * A 40 mm forward tube stepping straight down to the 29 mm aft tube, with no
 * transition: the step is a base of its own (next fore radius < this aft radius),
 * and it is not where the motor exhausts. The reference is the 40 mm tube here.
 */
const STEP_R = 0.02;
const stepDesign = (): RocketTree => ({
  name: 'Step',
  components: [{
    type: 'stage', name: 'S', nozzleExitDiameter: EXIT_D,
    children: [
      { type: 'nosecone', length: 0.15, aftRadius: STEP_R, thickness: 0.002 },
      { type: 'bodytube', length: 0.3, outerRadius: STEP_R, thickness: 0.0005, density: 950 },
      {
        type: 'bodytube', length: 0.4, outerRadius: CORE_R, thickness: 0.0005, density: 950,
        children: [fins],
      },
    ],
  }],
});

type Model = 'classic' | 'kbf' | 'supersonic';

/** Power-off and power-on base CD at each Mach of `machs`. */
function baseCd(tree: RocketTree, model: Model, machs: number[]) {
  const r = OrkRocket.buildTree(tree);
  if (model === 'kbf') r.setRogersModifiedBarrowman(true);
  if (model === 'supersonic') r.setSupersonicAero(true);
  return machs.map((m) => {
    const s = r.dragSweep({ machMin: m, machMax: m, machStep: 1 });
    return { off: s.powerOff.base[0]!, on: s.powerOn.base[0]! };
  });
}

const MACHS = [0.3, 0.9];

describe('power-on base drag: one nozzle area per stage instance, on the aft base', () => {
  it('credits a pod-set design ONE nozzle area, not one per pod base', () => {
    for (const model of ['kbf', 'supersonic'] as const) {
      const bare = baseCd(podDesign(false), model, MACHS);
      const podded = baseCd(podDesign(true), model, MACHS);
      MACHS.forEach((m, i) => {
        const bareCut = bare[i]!.off - bare[i]!.on;
        const podCut = podded[i]!.off - podded[i]!.on;
        // The reference design recovers one area: the kernel's own arithmetic,
        // `base * max(0, A_base - A_exit) / A_ref`, differenced back out.
        expect(bareCut).toBeCloseTo(oneArea(m), 12);
        // The pods add base drag in BOTH power states (their bases are real), and
        // recover nothing: the reduction is the same single area. Before the fix
        // it was 3x (core + two pods) — 0.187919 against 0.062640 at M0.3.
        expect(podCut).toBeCloseTo(bareCut, 12);
        expect(podCut).not.toBeCloseTo(3 * bareCut, 3);
        // The pods' power-OFF base drag is untouched by the fix: two full 24 mm
        // bases on the 29 mm reference.
        expect(podded[i]!.off - bare[i]!.off)
          .toBeCloseTo(2 * subsonicBaseCd(m) * POD_R ** 2 / CORE_R ** 2, 12);
      });
    }
  });

  it('credits a stepped airframe once, on its aft base and not on the step', () => {
    for (const model of ['kbf', 'supersonic'] as const) {
      const [s] = baseCd(stepDesign(), model, [0.3]);
      // Both bases exceed the 20 mm exit's area, so the pre-fix kernel took the
      // area off each of them: two areas. On the 40 mm reference, one area is
      // base * (10/20)^2.
      expect(s!.off - s!.on).toBeCloseTo(subsonicBaseCd(0.3) * (EXIT_D / 2) ** 2 / STEP_R ** 2, 12);
    }
  });

  it('still credits a parallel stage one area per strap-on', () => {
    // The consistency the pressure-thrust half was aligned to in code review E2:
    // N instances of a strap-on whose ONE base is its aft end recover N areas.
    const strapOns = (instanceCount: number): RocketTree => ({
      name: 'StrapOns',
      components: [{
        type: 'stage', name: 'Core',
        children: [
          { type: 'nosecone', length: 0.12, aftRadius: CORE_R, thickness: 0.002 },
          {
            type: 'bodytube', length: 0.6, outerRadius: CORE_R, thickness: 0.0005, density: 950,
            children: [fins, {
              type: 'parallelstage', id: 'boost', instanceCount, nozzleExitDiameter: 0.010,
              radiusMethod: 'relative', radiusOffset: 0, angleOffset: 0, angleMethod: 'relative',
              separationEvent: 'burnout', separationDelay: 0, position: { method: 'bottom', offset: 0 },
              children: [
                { type: 'nosecone', length: 0.05, aftRadius: POD_R, thickness: 0.002 },
                { type: 'bodytube', length: 0.2, outerRadius: POD_R, thickness: 0.0005, density: 950 },
              ],
            }],
          },
        ],
      }],
    } as unknown as RocketTree);
    const one = subsonicBaseCd(0.3) * 0.005 ** 2 / CORE_R ** 2;
    for (const n of [1, 2, 3]) {
      const [s] = baseCd(strapOns(n), 'kbf', [0.3]);
      expect(s!.off - s!.on).toBeCloseTo(n * one, 12);
    }
  });

  it('stays inert in the desktop-parity model, pods and all', () => {
    // Classic Extended Barrowman has no nozzle-exit aerodynamics (desktop
    // OpenRocket 24.12 has none), so power-on must cost exactly what power-off
    // costs, bit for bit, on every design above.
    for (const tree of [podDesign(true), podDesign(false), stepDesign()]) {
      for (const s of baseCd(tree, 'classic', MACHS)) {
        expect(s.on).toBe(s.off);
      }
    }
    // And the pod design with no nozzle named is untouched under Kbf as well.
    for (const s of baseCd(podDesign(true, 0), 'kbf', MACHS)) {
      expect(s.on).toBe(s.off);
    }
  });
});
