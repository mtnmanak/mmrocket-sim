import { describe, expect, it } from 'vitest';
import { OrkRocket, type ComponentNode, type MotorSpec, type RocketTree } from './orkEngine.js';

/**
 * OFF-AXIS ROLL INERTIA — code review E1 (2026-09-19), ruled and fixed 2026-09-22.
 *
 * An inner tube placed off the centreline (`radialPosition` ≠ 0), and the motor
 * inside it, contributed NO parallel-axis term to roll inertia: OpenRocket 24.12
 * charged the motor's transport term only for a multi-motor cluster
 * (`MassCalculation.calculateMountData`, `if( 1 < instanceCount )`) and never
 * charged a ring's own (`RingComponent.getRotationalUnitInertia`). So the desktop
 * "split cluster" — one tube per motor, each moved off the axis — flew with the
 * roll inertia of the same tubes stacked on the centreline, while the identical
 * geometry built as a 'double' cluster got its motors' term. The fix lives in the
 * two kernel patches and is documented in engine-java/patches/LEDGER.md,
 * "Correctness fixes".
 *
 * These are the BEHAVIOURAL guards. The goldens (`inertia.offaxis.*`) cannot be:
 * difftest compares a JVM run against a TeaVM run with no stored baseline, so a
 * formula error that moves both runtimes together passes it (LEDGER 2026-08-25b).
 * Every expectation below is the parallel-axis arithmetic, computed from masses the
 * kernel itself reports — not a number copied off a run.
 */

const D = 0.03;       // the split's offset from the axis, m
const RO = 0.0155;    // mount outer radius, m

/** 0.35 kg loaded, 0.15 kg burnt out. Mass at t = 0 is what staticInfo loads. */
const MOTOR: MotorSpec = {
  designation: 'M29', diameter: 0.029, length: 0.2,
  times: [0, 0.05, 1.9, 2.0], thrusts: [0, 160, 160, 0],
  masses: [0.35, 0.345, 0.155, 0.15], cgX: 0.1, ejectionDelay: 8,
};

const mount = (id: string, extra: Record<string, unknown>): ComponentNode => ({
  type: 'innertube', id, length: 0.2, outerRadius: RO, thickness: 0.0005, density: 1000,
  motorMount: true, position: { method: 'bottom', offset: 0 }, ...extra,
} as unknown as ComponentNode);

/** A 98 mm airframe; the same JSON as the `inertia.offaxis.*` goldens. */
const airframe = (mounts: ComponentNode[], cant = 0): RocketTree => ({
  name: 'OffAxis',
  components: [
    { type: 'nosecone', length: 0.25, aftRadius: 0.049, thickness: 0.002 },
    {
      type: 'bodytube', length: 0.9, outerRadius: 0.049, thickness: 0.0012, density: 950,
      children: [
        { type: 'trapezoidfinset', finCount: 4, rootChord: 0.14, tipChord: 0.07, sweep: 0.07, height: 0.09, thickness: 0.003, cant },
        ...mounts,
        { type: 'parachute', diameter: 0.9 },
      ],
    } as unknown as ComponentNode,
  ],
} as unknown as RocketTree);

const CENTRE = [mount('m1', { radialPosition: 0 }), mount('m2', { radialPosition: 0 })];
const SPLIT = [
  mount('m1', { radialPosition: D, radialDirection: 0 }),
  mount('m2', { radialPosition: D, radialDirection: Math.PI }),
];
const DOUBLE = [mount('m1', { cluster: 'double', clusterScale: D / RO, clusterRotation: 0 })];

function build(mounts: ComponentNode[], cant = 0): OrkRocket {
  const r = OrkRocket.buildTree(airframe(mounts, cant));
  for (const m of mounts) r.setMotorById(m.id!, MOTOR);
  return r;
}

/** Tubes (and motors) one mount node stands for: a 'double' cluster is two. */
const instancesOf = (m: ComponentNode) => ((m as { cluster?: string }).cluster === 'double' ? 2 : 1);

/** Static info plus the per-tube and per-motor masses the kernel reports. */
function measure(mounts: ComponentNode[]) {
  const r = build(mounts);
  const s = r.staticInfo();
  const motors = mounts.reduce((n, m) => n + instancesOf(m), 0);
  return {
    s,
    // componentInfo.mass covers ALL of a component's instances (a cluster's too).
    tubeMass: r.componentInfo('m1').mass / instancesOf(mounts[0]!),
    motorMass: (s.mass - s.massEmpty) / motors,
  };
}

/** |a - b| within `rel` of |b|. */
const near = (a: number, b: number, rel = 1e-12) =>
  expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(Math.abs(b) * rel);

describe('off-axis mounts carry their parallel-axis roll inertia (review E1)', () => {
  it('charges a split cluster 2 (m_tube + m_motor) d^2, and changes nothing else', () => {
    const centre = measure(CENTRE);
    const split = measure(SPLIT);
    expect(split.tubeMass).toBeGreaterThan(0.009);   // a real tube, ~9.6 g
    near(split.motorMass, 0.35);                     // the curve's mass at t = 0

    // Loaded: tubes AND motors. Dry: the tubes alone (the motor half cannot hide
    // behind the tube half or the other way round).
    near(split.s.rotationalInertia - centre.s.rotationalInertia,
      2 * (split.tubeMass + split.motorMass) * D * D);
    near(split.s.rotationalInertiaEmpty - centre.s.rotationalInertiaEmpty,
      2 * split.tubeMass * D * D);

    // Confinement: the fix is roll inertia and nothing else. No CG moves and no
    // pitch/yaw term appears, bit for bit.
    expect(split.s.mass).toBe(centre.s.mass);
    expect(split.s.massEmpty).toBe(centre.s.massEmpty);
    expect(split.s.cg).toBe(centre.s.cg);
    expect(split.s.longitudinalInertia).toBe(centre.s.longitudinalInertia);
    expect(split.s.longitudinalInertiaEmpty).toBe(centre.s.longitudinalInertiaEmpty);
  });

  it('gives a split cluster the same roll inertia as the same tubes built as a double cluster', () => {
    // Two ways of building ONE rocket. Before the fix the split read 29 % low
    // loaded (1.558e-3 against 2.205e-3 kg·m²) and the double 1.2 % low dry.
    const split = measure(SPLIT).s;
    const double = measure(DOUBLE).s;
    near(split.rotationalInertia, double.rotationalInertia);
    near(split.rotationalInertiaEmpty, double.rotationalInertiaEmpty);
    near(split.longitudinalInertia, double.longitudinalInertia);
    expect(split.mass).toBe(double.mass);
  });

  it('charges a single off-axis mount its own (m_tube + m_motor) d^2', () => {
    const one = measure([mount('m1', { radialPosition: D, radialDirection: 0 })]);
    const onAxis = measure([mount('m1', { radialPosition: 0 })]);
    near(one.s.rotationalInertia - onAxis.s.rotationalInertia,
      (one.tubeMass + one.motorMass) * D * D);
    near(one.s.rotationalInertiaEmpty - onAxis.s.rotationalInertiaEmpty, one.tubeMass * D * D);
    expect(one.s.cg).toBe(onAxis.s.cg);
    expect(one.s.longitudinalInertia).toBe(onAxis.s.longitudinalInertia);
  });

  it("charges a cluster's TUBES their spread, the half upstream never had", () => {
    // A '3-ring' at its natural spacing against the same cluster collapsed onto
    // the axis (clusterScale 0). The motors' term was always there for a cluster;
    // the tubes' was not, so the DRY difference was exactly 0 before this fix.
    const ring = (clusterScale: number) => {
      const r = OrkRocket.buildTree(airframe([mount('m1', { cluster: '3-ring', clusterScale, clusterRotation: 0 })]));
      r.setMotorById('m1', MOTOR);
      return { s: r.staticInfo(), tubeMass: r.componentInfo('m1').mass / 3 };
    };
    const spread = ring(1.0);
    const stacked = ring(0);
    // Tube centres sit on a circle of radius separation / sqrt(3), separation = 2 ro.
    const r2 = (2 * RO) ** 2 / 3;
    near(spread.s.rotationalInertiaEmpty - stacked.s.rotationalInertiaEmpty,
      3 * spread.tubeMass * r2, 1e-10);
    near(spread.s.rotationalInertia - stacked.s.rotationalInertia,
      3 * (spread.tubeMass + 0.35) * r2, 1e-10);
  });

  it('leaves a centreline design bit-identical to OpenRocket 24.12', () => {
    // The values the unpatched kernel produced for this airframe (goldens
    // inertia.offaxis.centre before and after the fix): on the axis every added
    // term is m * 0^2, and the ring patch returns its old value without adding it.
    // Bit-identity is proven where it is exact, in the JVM goldenJvm diff. HERE
    // the compiled kernel runs on whatever Node the machine has, and Node 22 (the
    // deploy runner) and Node 24 (the desktop) differ in the last bits of this
    // sum: 0.0015575839731625768 against ...798, 2e-15 relative — which failed
    // the v0.138 deploy gate. So this asserts the golden to 1e-12 relative,
    // far below any physical change (the smallest E1 move is 5e-3 relative).
    const s = measure(CENTRE).s;
    near(s.rotationalInertia, 0.0015575839731625798);
    near(s.rotationalInertiaEmpty, 0.0014839964731625797);
    near(s.longitudinalInertia, 0.1127979342598729);
  });

  it('flies a split cluster exactly as it flies the double cluster', () => {
    // The roll equation is Ixx's one consumer. With 0.5 degrees of fin cant the
    // two builds must roll the same, sample for sample.
    const fly = (mounts: ComponentNode[]) => {
      const f = build(mounts, 0.5 * Math.PI / 180).simulate({ launchRodLength: 1.5, series: 'full' });
      const roll = (f.series as unknown as Record<string, (number | null)[]>)['dΦ']!;
      return { apogee: f.summary.maxAltitude, maxRoll: Math.max(...roll.map((v) => Math.abs(v ?? 0))) };
    };
    const split = fly(SPLIT);
    const double = fly(DOUBLE);
    expect(split.maxRoll).toBeGreaterThan(5);           // it really rolls
    near(split.maxRoll, double.maxRoll, 1e-9);
    near(split.apogee, double.apogee, 1e-9);
    // Up to 8.2 s on the deploy runner (v0.138-v0.140). Vitest 2 never timed out
    // a synchronous test; vitest 3.1 and later fail one past 5 s (AUDIT row 528).
  }, 60000);
});
