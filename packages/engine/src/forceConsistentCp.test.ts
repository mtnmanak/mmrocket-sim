import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OrkRocket, type AeroForceSample, type MotorSpec, type RocketTree } from './orkEngine.js';

const load = (name: string): RocketTree => JSON.parse(readFileSync(
  new URL(`../../../validation/fixtures/${name}.json`, import.meta.url), 'utf8')) as RocketTree;
const arcas = load('arcas-short');
const finner = load('basic-finner');
const models = ['classic', 'kbf', 'supersonic', 'hybrid'] as const;
type Model = typeof models[number];
const rad = (deg: number) => deg * Math.PI / 180;

function finite(v: number | null | undefined): number {
  expect(Number.isFinite(v)).toBe(true);
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Expected finite kernel value');
  return v;
}

function near(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-12 + 1e-10 * Math.abs(expected));
}

function rocket(tree: RocketTree, model: Model): OrkRocket {
  const r = OrkRocket.buildTree(tree);
  r.setRogersModifiedBarrowman(model !== 'classic');
  r.setSupersonicAero(model === 'supersonic');
  r.setHybridAero(model === 'hybrid');
  return r;
}

function freeform(section: 'rounded' | 'airfoil'): RocketTree {
  const tree = structuredClone(arcas);
  const fin = tree.components[1]!.children![0]!;
  delete fin['airfoilSection'];
  fin.type = 'freeformfinset';
  fin['crossSection'] = section;
  fin['points'] = [[0, 0], [0.035, 0.055], [0.075, 0.055], [0.12, 0]];
  return tree;
}

describe('force-consistent reported CP above 20 degrees (rebuilt kernel)', () => {
  for (const [name, tree] of [['ARCAS', arcas], ['Basic Finner', finner],
    ['freeform rounded', freeform('rounded')], ['freeform airfoil', freeform('airfoil')]] as const) {
    for (const model of models) {
      // Mutation guards: revert total reported CP, substitute CN for CNa, include damping in CP.
      it(`${name}, ${model}: zero-rate lever arm and rate-independent reported CP`, () => {
        const r = rocket(tree, model);
        const d = r.staticInfo().refDiameter;
        let identities = 0;
        let dampingChanges = 0;
        for (const deg of [25, 30, 45, 60, 90]) {
          const zero = r.forceSamples([0.3, 1, 2], rad(deg));
          const moving = r.forceSamples([0.3, 1, 2], rad(deg), 0.7, 0.4, 0.9);
          zero.forEach((f, i) => {
            const cp = finite(f[0]);
            expect(moving[i]![0]).toBe(cp);
            expect(moving[i]![3]).toBe(f[3]);
            expect(moving[i]![4]).toBe(f[4]);
            // The zero-rate damping clamp is a no-op for positive Cm; negative
            // raw moments can be clamped and are not an independent CP oracle.
            if (f[6] > 0 && Math.abs(f[4]) > 1e-8) {
              near(cp * f[4], f[6] * d);
              identities++;
              expect(moving[i]![6]).not.toBe(f[6]);
              dampingChanges++;
            }
          });
        }
        expect(identities).toBeGreaterThan(0);
        expect(dampingChanges).toBeGreaterThan(0);
      });

      // Control, not a threshold guard: below 20 deg the ratio and the derivative CP
      // agree to roundoff, so the 17.5-deg mutation is caught by ForceConsistentCPTest
      // (bitwise, hasReportedCP), not here. This pins the sweep/force contract.
      it(`${name}, ${model}: preserves low-angle sweep/force CP and derivative weights`, () => {
        const r = rocket(tree, model);
        for (const aoa of [0, 0.04, rad(17.5), 20 * Math.PI / 180]) {
          for (const mach of [0.3, 1, 2]) {
            const f = r.forceSamples([mach], aoa)[0]!;
            const sweep = r.dragSweep({ machMin: mach, machMax: mach, machStep: 0.1, aoaDeg: aoa * 180 / Math.PI });
            finite(f[0]);
            near(finite(sweep.cp[0]), finite(f[0]));
            expect(sweep.cna[0]).toBe(f[3]);
          }
        }
        const sweep = r.dragSweep({ machMin: 0.3, machMax: 2, machStep: 0.1, aoaDeg: 45 });
        const forces = r.forceSamples(sweep.machs, rad(45));
        sweep.cp.forEach((cp, i) => {
          if (sweep.cna[i]! > 0) finite(cp);
          expect(sweep.cna[i]).toBe(forces[i]![3]);
          near(finite(cp), finite(forces[i]![0]));
        });
      });
    }
  }

  // Mutation guard: revert getCP while leaving forceSamples corrected.
  it('reproduces the two TeaVM-measured register values through diagnostics', () => {
    for (const [tree, expected] of [[arcas, 10.4317407349], [finner, 6.4961848984]] as const) {
      const r = rocket(tree, 'kbf');
      expect(finite(r.aeroDiagnostics(0.3, rad(45)).cp[0]) / r.staticInfo().refDiameter).toBeCloseTo(expected, 6);
    }
  });

  // Mutation guard: silently accepting null as numeric zero in bridge consumers.
  it('requires a finite number before using a nullable cpX in arithmetic', () => {
    const row: AeroForceSample = [null, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(row[0]).toBeNull();
    expect(() => finite(row[0])).toThrow();
    for (const model of models) {
      const empty = rocket({ name: 'No aerodynamic parts', components: [] }, model);
      expect(empty.forceSamples([1], rad(45))[0]![0]).toBeNull();
      const diagnostic = empty.aeroDiagnostics(1, rad(45));
      expect(diagnostic.cp[0]).toBeNull();
      expect(diagnostic.worstCP[0]).toBeNull();
      expect(diagnostic.worstCP[3]).toBeNull();
    }
  });

  // Mutation guard: revert CP/stability only in the recorded flight data store.
  it('records high-AOA CP and stability from the same corrected calculator law', () => {
    // Three rounded fins, uncanted, no pods: theta does not change the CP.
    // Clock 0.2 rad away from a single fin's zero-weight normalization cutoff.
    const tree: RocketTree = { name: 'CP crosswind control', components: [
      { type: 'nosecone', shape: 'ogive', length: 0.07, aftRadius: 0.012, thickness: 0.002, overrideMass: 0.03 },
      { type: 'bodytube', length: 0.30, outerRadius: 0.012, thickness: 0.0003, density: 950, children: [
        { type: 'trapezoidfinset', finCount: 3, rotation: 0.2, rootChord: 0.05, tipChord: 0.03, sweep: 0.02,
          height: 0.03, thickness: 0.003, crossSection: 'rounded' },
        { type: 'innertube', id: 'mount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005,
          motorMount: true, position: { method: 'bottom', offset: 0 } },
      ] },
    ] };
    const times = [0, 0.1, 0.3, 0.5, 1, 1.5, 1.85, 2];
    const motor: MotorSpec = { designation: 'CP-test', diameter: 0.018, length: 0.07,
      times, thrusts: [0, 12, 6, 5.1, 4.9, 4.8, 4.5, 0],
      masses: times.map((t) => 0.024 - 0.0108 * t / 2), cgX: 0.035, ejectionDelay: 1000 };
    const r = rocket(tree, 'kbf');
    r.setMotorById('mount', motor);
    const info = r.staticInfo();
    expect(info.cp).toBeGreaterThan(info.cg);
    const result = r.simulate({ launchRodLength: 0.5, guideAllowance: false,
      windAverage: 8, windStdDeviation: 0, randomSeed: 0x66b, timeStep: 0.01,
      maxTime: 0.8, series: 'full' });
    expect(result.events.some((event) => event.type === 'SIM_ABORT')).toBe(false);
    let high = 0;
    result.series.aoa.forEach((aoa, i) => {
      if (aoa == null || aoa <= rad(20.5) || result.series.cpLocation[i] == null) return;
      const cp = finite(result.series.cpLocation[i]);
      const mach = finite(result.series.mach[i]);
      expect(cp).toBeCloseTo(finite(r.aeroDiagnostics(mach, aoa).cp[0]), 6);
      // The recorded CP is the force-consistent lever arm d*Cm/CN of the same
      // zero-rate normal force (positive Cm: the zero-rate damping clamp is a
      // no-op). On the old kernel it was the derivative CP, which differs here.
      const f = r.forceSamples([mach], aoa)[0]!;
      expect(f[6]).toBeGreaterThan(0);
      expect(Math.abs(f[4])).toBeGreaterThan(1e-8);
      expect(cp).toBeCloseTo(info.refDiameter * f[6] / f[4], 6);
      expect(finite(result.series.stability[i])).toBeCloseTo((cp - finite(result.series.cgLocation[i])) / info.refDiameter, 6);
      high++;
    });
    expect(high).toBeGreaterThanOrEqual(3);
  }, 60000);
});
