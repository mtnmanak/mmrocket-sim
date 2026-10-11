import { describe, expect, it } from 'vitest';
import { OrkRocket, type MotorSpec, type RocketTree } from './orkEngine.js';

// The FLIGHT half of RASAero feature #2, power-on base drag (engine-java/patches/LEDGER.md):
// AbstractSimulationStepper.applyThrustState records, on every RK4 evaluation, which stages
// have a motor producing curve thrust (FlightConditions.thrustingStages), and
// BarrowmanCalculator.calculateBaseCD takes the stage's nozzle-exit area off its aft base
// while that stage thrusts - under Rogers Kbf or Supersonic only.
//
// Every existing guard reads a static drag sweep, and getDragSweep marks every stage thrusting
// itself, so none of them would notice the stepper never recording thrust: the power-on credit
// would silently vanish from every flight while the sweep, the goldens and the drag panel all
// still showed it. This reads the recorded flight instead: on EVERY recorded powered-ascent
// row the base CD must be the kernel's subsonic base law at that row's own Mach, times the
// annulus the nozzle leaves while the motor burns and times 1 when it does not.

const R = 0.012; // airframe radius = reference radius: one base, area ratio 1
const EXIT_D = 0.016;
const ANNULUS = (R * R - (EXIT_D / 2) ** 2) / (R * R);

const C6: MotorSpec = {
  designation: 'C6', diameter: 0.018, length: 0.07,
  times: [0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0],
  thrusts: [0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0],
  masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132],
  cgX: 0.035, ejectionDelay: 5.0,
};

const tree = (nozzleExitDiameter: number): RocketTree => ({
  name: 'Power-on base drag in flight',
  components: [{
    type: 'stage', name: 'S', nozzleExitDiameter,
    children: [
      { type: 'nosecone', length: 0.07, aftRadius: R, thickness: 0.002 },
      {
        type: 'bodytube', length: 0.3, outerRadius: R, thickness: 0.0003, density: 950,
        children: [
          { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
          { type: 'innertube', id: 'mount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005,
            motorMount: true, position: { method: 'bottom', offset: 0 } },
          { type: 'parachute', diameter: 0.3 },
        ],
      },
    ],
  }],
} as unknown as RocketTree);

type Model = 'classic' | 'kbf' | 'ssOnly';

function fly(nozzle: number, model: Model) {
  const r = OrkRocket.buildTree(tree(nozzle));
  r.setMotorById('mount', C6);
  r.setRogersModifiedBarrowman(model === 'kbf');
  r.setSupersonicAero(model === 'ssOnly');
  const res = r.simulate({ launchRodLength: 1, series: 'full', randomSeed: 7 });
  const apogee = res.events.find((e) => e.type === 'APOGEE')!.time;
  const s = res.series;
  const cdb = s['Cdb'];
  expect(cdb, 'full series carries the base drag coefficient').toBeDefined();
  // Ascent rows only: the descent stepper does not run the aerodynamic calculator.
  const rows = s.time.map((_, i) => i).filter((i) => s.time[i]! < apogee && Number.isFinite(cdb![i]));
  return { rows, mach: s.mach, thrust: s.thrust, cdb: cdb as number[] };
}

const baseLaw = (m: number) => 0.12 + 0.13 * m * m; // calculateBaseCD, M <= 1

describe('power-on base drag is credited in FLIGHT while the stage thrusts', () => {
  it('every powered row takes the annulus, every unpowered row the full base, in Kbf and Supersonic', () => {
    for (const model of ['kbf', 'ssOnly'] as const) {
      const f = fly(EXIT_D, model);
      let powered = 0, coasting = 0;
      for (const i of f.rows) {
        const m = f.mach[i]!;
        expect(m, 'subsonic fixture').toBeLessThan(1);
        const burning = f.thrust[i]! > 0;
        if (burning) powered++; else coasting++;
        const want = baseLaw(m) * (burning ? ANNULUS : 1);
        expect(f.cdb[i]! / want - 1, `${model} row ${i} burning=${burning}`).toBeCloseTo(0, 12);
      }
      // Enough of each kind for the oracle to mean something.
      expect(powered).toBeGreaterThan(10);
      expect(coasting).toBeGreaterThan(10);
    }
  }, 60_000);

  it('the parity model, and a stage with no nozzle, fly the full base throughout', () => {
    for (const [nozzle, model] of [[EXIT_D, 'classic'], [0, 'kbf']] as const) {
      const f = fly(nozzle, model);
      expect(f.rows.some((i) => f.thrust[i]! > 0)).toBe(true);
      for (const i of f.rows) {
        expect(f.cdb[i]! / baseLaw(f.mach[i]!) - 1, `${model} nozzle ${nozzle} row ${i}`).toBeCloseTo(0, 12);
      }
    }
  }, 60_000);
});
