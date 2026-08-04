import { describe, expect, it } from 'vitest';
import { OrkRocket, type MotorSpec, type RocketSpec } from './orkEngine.js';

/**
 * Reference rocket + C6-class motor — the same design as engine-java's
 * golden harness. Expected values are the JVM golden outputs
 * (engine-java difftest); tolerances cover accumulated JS-Math ULP drift.
 */
const REFERENCE_ROCKET: RocketSpec = {
  noseCone: { length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' },
  bodyTube: { length: 0.3, outerRadius: 0.012, thickness: 0.0003, materialDensity: 950 },
  fins: { count: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
  motorMount: { length: 0.07, outerRadius: 0.0095, thickness: 0.0005 },
  parachute: { diameter: 0.3 },
};

const C6_MOTOR: MotorSpec = {
  designation: 'C6',
  diameter: 0.018,
  length: 0.07,
  times: [0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0],
  thrusts: [0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0],
  masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132],
  cgX: 0.035,
  ejectionDelay: 5.0,
};

describe('OrkRocket (real OpenRocket kernel via TeaVM)', () => {
  it('computes static info matching the JVM goldens', () => {
    const rocket = OrkRocket.build(REFERENCE_ROCKET);
    rocket.setMotor(C6_MOTOR);
    const info = rocket.staticInfo();

    expect(info.length).toBeCloseTo(0.37, 12);
    expect(info.mass).toBeCloseTo(0.051335792158092, 9);
    expect(info.cg).toBeCloseTo(0.2594577950655922, 9);
    expect(info.cp).toBeCloseTo(0.29101225022147875, 9);
    expect(info.stabilityCalibers).toBeGreaterThan(1.0); // stable design
    expect(info.warnings).toBe(0);
  });

  it('flies the full C6 flight matching the JVM goldens', () => {
    const rocket = OrkRocket.build(REFERENCE_ROCKET);
    rocket.setMotor(C6_MOTOR);
    const result = rocket.simulate({ launchRodLength: 1.0, timeStep: 0.05 });

    // JVM goldens: 331.76687245462836 m apogee, 116.16566819089638 m/s, etc.
    expect(result.summary.maxAltitude).toBeCloseTo(331.766872454628, 6);
    expect(result.summary.maxVelocity).toBeCloseTo(116.165668190896, 6);
    expect(result.summary.maxAcceleration).toBeCloseTo(227.494097892678, 6);
    expect(result.summary.timeToApogee).toBeCloseTo(6.848273507164, 6);
    expect(result.summary.groundHitVelocity).toBeCloseTo(3.385373780151, 6);

    const types = result.events.map((e) => e.type);
    expect(types).toEqual([
      'LAUNCH', 'IGNITION', 'LIFTOFF', 'LAUNCHROD', 'BURNOUT',
      'APOGEE', 'EJECTION_CHARGE', 'RECOVERY_DEVICE_DEPLOYMENT',
      'GROUND_HIT', 'SIMULATION_END',
    ]);

    expect(result.series.time.length).toBe(721);
    expect(result.series.altitude.length).toBe(721);
    // Monotonic time, sane altitude bounds.
    for (let i = 1; i < result.series.time.length; i++) {
      expect(result.series.time[i]!).toBeGreaterThanOrEqual(result.series.time[i - 1]!);
    }
    expect(Math.max(...result.series.altitude)).toBeCloseTo(result.summary.maxAltitude, 9);
  });

  it('builds arbitrary component trees with identical physics (P2.1)', () => {
    const rocket = OrkRocket.buildTree({
      name: 'Ref',
      components: [
        { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' },
        {
          type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950,
          children: [
            { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
            { type: 'innertube', id: 'mount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005, motorMount: true },
            { type: 'parachute', diameter: 0.3 },
          ],
        },
      ],
    });
    rocket.setMotorById('mount', C6_MOTOR);

    const info = rocket.staticInfo();
    expect(info.mass).toBeCloseTo(0.051335792158092, 9); // same as fixed-shape build
    expect(info.warningTexts).toEqual([]);

    const result = rocket.simulate({});
    expect(result.summary.maxAltitude).toBeCloseTo(331.766872454628, 5);
  });

  it('flies a minimum-diameter rocket: the body tube IS the motor mount', () => {
    // No inner tube — the motor loads directly in the airframe (kernel
    // BodyTube implements MotorMount). Mirrors the mindia golden scenario.
    const rocket = OrkRocket.buildTree({
      name: 'MinDia',
      components: [{
        type: 'stage', name: 'S', nozzleExitDiameter: 0.014,
        children: [
          { type: 'nosecone', length: 0.10, aftRadius: 0.012, thickness: 0.002 },
          {
            type: 'bodytube', id: 'body', length: 0.45, outerRadius: 0.012,
            thickness: 0.0005, density: 950, motorMount: true, motorOverhang: 0.006,
            children: [
              { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.025, thickness: 0.003 },
              { type: 'parachute', diameter: 0.3 },
            ],
          },
        ],
      }],
    });
    rocket.setMotorById('body', C6_MOTOR);

    const info = rocket.staticInfo();
    // Launch mass must include the 24 g motor (a silently-dropped motor
    // config on a body-tube mount would show up right here).
    expect(info.mass).toBeGreaterThan(0.055);
    expect(info.stabilityCalibers).toBeGreaterThan(1);

    // Matches the JVM golden flight.mindia line (incl. the 6 mm overhang).
    const result = rocket.simulate({});
    expect(result.summary.maxAltitude).toBeCloseTo(333.4644714919658, 4);
  });

  it('rejects a motor on a component that is not a mount', () => {
    const rocket = OrkRocket.buildTree({
      components: [
        { type: 'nosecone', id: 'nose', length: 0.07, aftRadius: 0.012, thickness: 0.002 },
        { type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0005 },
      ],
    });
    expect(() => rocket.setMotorById('nose', C6_MOTOR)).toThrow(/not a motor mount/);
  });

  it('supports the extended component set (transition, rings, streamer, ...)', () => {
    const rocket = OrkRocket.buildTree({
      components: [
        { type: 'nosecone', length: 0.1, aftRadius: 0.0125, thickness: 0.002, shape: 'haack' },
        {
          type: 'bodytube', length: 0.35, outerRadius: 0.0125, thickness: 0.0005, density: 950,
          children: [
            { type: 'ellipticalfinset', finCount: 4, rootChord: 0.06, height: 0.04, thickness: 0.003 },
            { type: 'launchlug', length: 0.05, outerRadius: 0.0025, thickness: 0.0004, position: { method: 'middle', offset: 0 } },
            { type: 'innertube', id: 'mount', length: 0.08, outerRadius: 0.012, thickness: 0.0005, motorMount: true },
            { type: 'centeringring', length: 0.002, position: { method: 'bottom', offset: -0.01 } },
            { type: 'streamer', stripLength: 0.6, stripWidth: 0.05, position: { method: 'top', offset: 0.02 } },
            { type: 'shockcord', cordLength: 0.4, position: { method: 'top', offset: 0.01 } },
            { type: 'masscomponent', mass: 0.015, length: 0.02, radius: 0.006, position: { method: 'top', offset: 0.05 } },
          ],
        },
        { type: 'transition', length: 0.04, foreRadius: 0.0125, aftRadius: 0.009, thickness: 0.001, shape: 'conical', density: 680 },
      ],
    });
    const info = rocket.staticInfo();
    expect(info.length).toBeCloseTo(0.49, 9);
    expect(info.mass).toBeGreaterThan(0.05);
    expect(Number.isFinite(info.cp)).toBe(true);
  });

  it('applies override-for-all-subcomponents mass (desktop .ork semantics)', () => {
    const mk = (extra: Record<string, unknown>) => OrkRocket.buildTree({
      components: [
        { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002 },
        {
          type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0005,
          overrideMass: 0.05, ...extra,
          children: [
            { type: 'masscomponent', mass: 0.1, length: 0.02, radius: 0.006, position: { method: 'top', offset: 0.05 } },
          ],
        },
      ],
    });
    const perComponent = mk({}).staticInfo();
    const subtree = mk({ overrideSubcomponentsMass: true }).staticInfo();
    // Subtree override replaces tube + child (0.05 + 0.1) with 0.05 flat.
    expect(perComponent.mass - subtree.mass).toBeCloseTo(0.1, 9);
  });

  it('dragSweep emits CP and CNa aligned with the Mach grid (validation harness)', () => {
    const rocket = OrkRocket.buildTree({
      components: [
        { type: 'nosecone', length: 0.1, aftRadius: 0.0125, thickness: 0.002 },
        {
          type: 'bodytube', length: 0.35, outerRadius: 0.0125, thickness: 0.0005,
          children: [
            {
              type: 'trapezoidfinset', finCount: 4, rootChord: 0.05, tipChord: 0.03,
              sweep: 0.02, height: 0.03, thickness: 0.003,
              position: { method: 'bottom', offset: 0 },
            },
          ],
        },
      ],
    });
    const sweep = rocket.dragSweep({ machMin: 0.1, machMax: 2.0, machStep: 0.1 });
    expect(sweep.cp).toHaveLength(sweep.machs.length);
    expect(sweep.cna).toHaveLength(sweep.machs.length);
    const info = rocket.staticInfo();
    for (let i = 0; i < sweep.machs.length; i++) {
      expect(sweep.cp[i]).toBeGreaterThan(0);
      expect(sweep.cp[i]).toBeLessThan(info.length);
      expect(sweep.cna[i]).toBeGreaterThan(0);
    }
    // staticInfo computes CP at Mach 0.3 — the sweep's M0.3 point must agree.
    const i03 = sweep.machs.findIndex((m) => Math.abs(m - 0.3) < 1e-9);
    expect(sweep.cp[i03]).toBeCloseTo(info.cp, 9);
    expect(sweep.cna[i03]).toBeCloseTo(info.cna, 9);
  });

  it('supersonic aero flag: CP stops collapsing forward; off stays classic', () => {
    const tree = {
      components: [
        { type: 'nosecone' as const, length: 0.1, aftRadius: 0.0125, thickness: 0.002 },
        {
          type: 'bodytube' as const, length: 0.35, outerRadius: 0.0125, thickness: 0.0005,
          children: [
            {
              type: 'trapezoidfinset' as const, finCount: 4, rootChord: 0.05, tipChord: 0.03,
              sweep: 0.02, height: 0.03, thickness: 0.003,
              position: { method: 'bottom' as const, offset: 0 },
            },
          ],
        },
      ],
    };
    const classic = OrkRocket.buildTree(tree);
    const off = classic.dragSweep({ machMin: 0.5, machMax: 4.0, machStep: 0.5 });

    const ss = OrkRocket.buildTree(tree);
    ss.setSupersonicAero(true);
    const on = ss.dragSweep({ machMin: 0.5, machMax: 4.0, machStep: 0.5 });

    const at = (sweep: typeof off, m: number) =>
      sweep.machs.findIndex((x) => Math.abs(x - m) < 1e-9);
    // Supersonic: corrected fin CNa (~2x) keeps the CP from racing forward —
    // flag-on CP must sit AFT of the classic collapse, increasingly with Mach.
    for (const m of [2.0, 3.0, 4.0]) {
      expect(on.cp[at(on, m)]!).toBeGreaterThan(off.cp[at(off, m)]!);
      expect(on.cna[at(on, m)]!).toBeGreaterThan(1.5 * off.cna[at(off, m)]!);
    }
    // Subsonic: NACA-1307 interference (the Rogers-Modified physics) raises fin
    // CNa moderately; CP change stays small.
    const i05on = at(on, 0.5), i05off = at(off, 0.5);
    expect(on.cna[i05on]!).toBeGreaterThan(off.cna[i05off]!);
    expect(on.cna[i05on]!).toBeLessThan(1.5 * off.cna[i05off]!);
    expect(Math.abs(on.cp[i05on]! - off.cp[i05off]!)).toBeLessThan(0.02);
    // Turning the flag back off must reproduce the classic sweep exactly.
    ss.setSupersonicAero(false);
    const offAgain = ss.dragSweep({ machMin: 0.5, machMax: 4.0, machStep: 0.5 });
    expect(offAgain.cp).toEqual(off.cp);
    expect(offAgain.cna).toEqual(off.cna);
  });

  it('fin airfoil sections: blunt-base wedge adds fin base drag, sharp sections do not', () => {
    const mk = (finExtra: Record<string, unknown>) => OrkRocket.buildTree({
      components: [
        { type: 'nosecone', shape: 'conical', length: 0.085, aftRadius: 0.015, thickness: 0.0015 },
        {
          type: 'bodytube', length: 0.215, outerRadius: 0.015, thickness: 0.0015,
          children: [
            {
              type: 'trapezoidfinset', finCount: 4, rootChord: 0.03, tipChord: 0.03,
              sweep: 0, height: 0.03, thickness: 0.0024,
              position: { method: 'bottom' as const, offset: 0 }, ...finExtra,
            },
          ],
        },
      ],
    });
    const at = (s: { machs: number[] }, m: number) =>
      s.machs.findIndex((x) => Math.abs(x - m) < 1e-9);
    const opts = { machMin: 0.5, machMax: 2.5, machStep: 0.5 };

    const classic = mk({}).dragSweep(opts);
    const wedge = mk({ airfoilSection: 'singlewedge' }).dragSweep(opts);
    const biconvex = mk({ airfoilSection: 'biconvex' }).dragSweep(opts);

    // Subsonic there is no wave drag, so the wedge's blunt-TE fin base drag is
    // the only pressure difference vs the sharp biconvex.
    expect(wedge.powerOff.pressure[at(wedge, 0.5)]!)
      .toBeGreaterThan(biconvex.powerOff.pressure[at(biconvex, 0.5)]!);
    // Subsonic (no wave terms): the blunt-base hexagonal carries fin base drag
    // the sharp hexagonal doesn't.
    const hex = mk({ airfoilSection: 'hexagonal' }).dragSweep(opts);
    const hexBase = mk({ airfoilSection: 'hexbluntbase' }).dragSweep(opts);
    expect(hexBase.powerOff.pressure[at(hexBase, 0.5)]!)
      .toBeGreaterThan(hex.powerOff.pressure[at(hex, 0.5)]!);
    // Supersonic wave ordering: hexagonal (1/3 chamfers, factor 6) exceeds
    // biconvex (16/3) for the same thickness.
    expect(hex.powerOff.pressure[at(hex, 2.0)]!)
      .toBeGreaterThan(biconvex.powerOff.pressure[at(biconvex, 2.0)]!);
    // Sections only touch pressure drag: friction and CP stay classic.
    expect(wedge.powerOff.friction).toEqual(classic.powerOff.friction);
    expect(wedge.cp).toEqual(classic.cp);
    // An explicit LE radius adds bluntness drag to a hexagonal section.
    const hexBlunt = mk({ airfoilSection: 'hexagonal', finLeRadius: 0.0005 }).dragSweep(opts);
    expect(hexBlunt.powerOff.pressure[at(hexBlunt, 2.0)]!)
      .toBeGreaterThan(hex.powerOff.pressure[at(hex, 2.0)]!);
  });

  it('applies fin tabs: mass increases and componentInfo reports it', () => {
    const base = {
      components: [
        { type: 'nosecone' as const, length: 0.07, aftRadius: 0.012, thickness: 0.002 },
        {
          type: 'bodytube' as const, length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950,
          children: [
            {
              type: 'trapezoidfinset' as const, id: 'fins', finCount: 3, rootChord: 0.05,
              tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003, density: 680,
              position: { method: 'bottom' as const, offset: 0 },
            },
          ],
        },
      ],
    };
    const plain = OrkRocket.buildTree(base);
    const finsPlain = plain.componentInfo('fins');

    const tabbed = structuredClone(base);
    Object.assign(tabbed.components[1]!.children![0]!, {
      tabHeight: 0.01, tabLength: 0.03, tabOffset: 0, tabOffsetMethod: 'middle',
    });
    const withTab = OrkRocket.buildTree(tabbed);
    const finsTabbed = withTab.componentInfo('fins');

    // 3 tabs × 30 mm × 10 mm × 3 mm × 680 kg/m³ ≈ 1.8 g extra.
    expect(finsTabbed.mass).toBeGreaterThan(finsPlain.mass + 0.0015);
    expect(finsTabbed.mass).toBeLessThan(finsPlain.mass + 0.0025);
    // Tab hangs below the root chord: CG must not move forward.
    expect(finsTabbed.cgX).toBeGreaterThan(0);
    expect(finsPlain.length).toBeCloseTo(0.05, 9);
  });

  it('clamps an over-deep fin tab to the parent tube radius', () => {
    const rocket = OrkRocket.buildTree({
      components: [
        { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002 },
        {
          type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950,
          children: [
            {
              type: 'trapezoidfinset', id: 'fins', finCount: 3, rootChord: 0.05,
              tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003, density: 680,
              tabHeight: 0.5, tabLength: 0.03,
            },
          ],
        },
      ],
    });
    // A 0.5 m tab in a 12 mm-radius tube: kernel clamps, mass stays sane.
    const fins = rocket.componentInfo('fins');
    expect(fins.mass).toBeLessThan(0.05);
  });

  it('reports per-component info (mass, section mass, position)', () => {
    const rocket = OrkRocket.buildTree({
      components: [
        { type: 'nosecone', id: 'nose', length: 0.07, aftRadius: 0.012, thickness: 0.002 },
        {
          type: 'bodytube', id: 'body', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950,
          children: [
            { type: 'masscomponent', id: 'ballast', mass: 0.015, length: 0.02, radius: 0.006, position: { method: 'top', offset: 0.05 } },
          ],
        },
      ],
    });
    const nose = rocket.componentInfo('nose');
    expect(nose.length).toBeCloseTo(0.07, 9);
    expect(nose.positionX).toBeCloseTo(0, 9);
    expect(nose.cgX).toBeGreaterThan(0);
    expect(nose.cgX).toBeLessThan(0.07);

    const body = rocket.componentInfo('body');
    expect(body.positionX).toBeCloseTo(0.07, 9);
    expect(body.sectionMass).toBeCloseTo(body.mass + 0.015, 9);

    expect(() => rocket.componentInfo('nope')).toThrow(/Unknown component id/);
  });

  it('returns the extended flight summary (rod velocity, optimum delay)', () => {
    const rocket = OrkRocket.build(REFERENCE_ROCKET);
    rocket.setMotor(C6_MOTOR);
    const { summary } = rocket.simulate({ launchRodLength: 1.0, timeStep: 0.05 });

    expect(summary.maxMachNumber).toBeGreaterThan(0.3);
    expect(summary.maxMachNumber).toBeLessThan(0.4);
    expect(summary.launchRodVelocity).toBeGreaterThan(5);
    expect(summary.launchRodVelocity).toBeLessThan(30);
    expect(summary.deploymentVelocity).toBeGreaterThan(0);
    // C6-5: burnout 2.0 s, ballistic apogee ≈ 6.9 s → optimum ≈ 4.9 s.
    expect(summary.optimumDelay).toBeGreaterThan(4);
    expect(summary.optimumDelay).toBeLessThan(6);
  });

  it('rejects unknown component types with a clear message', () => {
    expect(() =>
      OrkRocket.buildTree({ components: [{ type: 'warpdrive' as never }] }),
    ).toThrow(/Unknown component type/);
  });

  it('reports unstable designs via warnings/behavior rather than crashing', () => {
    const noFins: RocketSpec = { ...REFERENCE_ROCKET, fins: { ...REFERENCE_ROCKET.fins, count: 3, height: 0.001 } };
    const rocket = OrkRocket.build(noFins);
    rocket.setMotor(C6_MOTOR);
    const info = rocket.staticInfo();
    expect(info.stabilityCalibers).toBeLessThan(1.0);
  });

  it('fires a clustered mount as thrust ×N with N motor masses (P3 clusters)', () => {
    const airframe = (cluster: object) => ({
      components: [
        { type: 'nosecone' as const, length: 0.12, aftRadius: 0.033, thickness: 0.002 },
        {
          type: 'bodytube' as const, length: 0.45, outerRadius: 0.033, thickness: 0.001, density: 950,
          children: [
            { type: 'trapezoidfinset' as const, finCount: 3, rootChord: 0.09, tipChord: 0.05, sweep: 0.04, height: 0.06, thickness: 0.003 },
            {
              type: 'innertube' as const, id: 'mount', length: 0.075, outerRadius: 0.0095,
              thickness: 0.0005, motorMount: true, position: { method: 'bottom' as const, offset: 0 },
              ...cluster,
            },
          ],
        },
      ],
    });

    const single = OrkRocket.buildTree(airframe({}));
    single.setMotorById('mount', C6_MOTOR);
    const ring3 = OrkRocket.buildTree(airframe({ cluster: '3-ring', clusterScale: 1.0, clusterRotation: 0 }));
    ring3.setMotorById('mount', C6_MOTOR);

    // Loaded mass grows by exactly two extra motors (+ their tube copies).
    const dm = ring3.staticInfo().mass - single.staticInfo().mass;
    expect(dm).toBeGreaterThan(2 * 0.024);
    expect(dm).toBeLessThan(2 * 0.024 + 0.01);

    // Thrust ×3 on a same-mass rocket: max acceleration well above single's.
    const one = single.simulate({ launchRodLength: 1.0 });
    const three = ring3.simulate({ launchRodLength: 1.0 });
    expect(three.summary.maxAcceleration).toBeGreaterThan(2 * one.summary.maxAcceleration);
    expect(three.summary.maxAltitude).toBeGreaterThan(2 * one.summary.maxAltitude);
  });

  it('flies a serial two-stage rocket with separate booster branch (P3 staging)', () => {
    const rocket = OrkRocket.buildTree({
      name: 'TwoStage',
      components: [
        {
          type: 'stage', name: 'Sustainer',
          children: [
            { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002 },
            {
              type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950,
              children: [
                { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.025, thickness: 0.003 },
                { type: 'innertube', id: 'smount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005, motorMount: true, position: { method: 'bottom', offset: 0 } },
                { type: 'parachute', name: 'SustainerChute', diameter: 0.35 },
              ],
            },
          ],
        },
        {
          type: 'stage', name: 'Booster', separationEvent: 'burnout',
          children: [
            {
              type: 'bodytube', length: 0.12, outerRadius: 0.012, thickness: 0.0003, density: 950,
              children: [
                { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.025, height: 0.035, thickness: 0.003 },
                { type: 'innertube', id: 'bmount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005, motorMount: true, position: { method: 'bottom', offset: 0 } },
                { type: 'parachute', name: 'BoosterChute', diameter: 0.25 },
              ],
            },
          ],
        },
      ],
    });
    rocket.setMotorById('smount', C6_MOTOR);
    rocket.setMotorById('bmount', { ...C6_MOTOR, ejectionDelay: 0 });
    // The high-power pattern: electronics-timed sustainer, burnout + 1 s.
    rocket.setMotorIgnitionById('smount', 'burnout', 1.0);

    const result = rocket.simulate({ launchRodLength: 1.0 });

    // Two branches: the sustainer stack and the separated booster.
    expect(result.branches).toBeDefined();
    expect(result.branches!.length).toBe(2);
    expect(result.branches![0]!.name).toBe('Sustainer');
    expect(result.branches![1]!.name).toBe('Booster');

    // Sustainer staging event chain, in order.
    const types = result.events.map((e) => e.type);
    expect(types.indexOf('STAGE_SEPARATION')).toBeGreaterThan(types.indexOf('BURNOUT'));
    expect(types.filter((t) => t === 'IGNITION').length).toBe(2);

    // Two-stage apogee far above a single C6 flight (~330 m reference).
    expect(result.summary.maxAltitude).toBeGreaterThan(450);

    // The booster flies its OWN recovery to its own ground hit.
    const booster = result.branches![1]!;
    const bTypes = booster.events.map((e) => e.type);
    expect(bTypes).toContain('STAGE_SEPARATION');
    expect(bTypes).toContain('RECOVERY_DEVICE_DEPLOYMENT');
    expect(bTypes).toContain('GROUND_HIT');
    expect(booster.events.find((e) => e.type === 'RECOVERY_DEVICE_DEPLOYMENT')?.source).toBe('BoosterChute');
    const boosterApogee = Math.max(...booster.series.altitude.filter((v) => v !== null) as number[]);
    expect(boosterApogee).toBeGreaterThan(20);
    expect(boosterApogee).toBeLessThan(result.summary.maxAltitude / 2);
  });

  it('keeps single-stage flights branch-free (back-compat)', () => {
    const rocket = OrkRocket.build(REFERENCE_ROCKET);
    rocket.setMotor(C6_MOTOR);
    const result = rocket.simulate({ launchRodLength: 1.0 });
    expect(result.branches).toBeUndefined();
  });

  it('rejects mixed stage/component top levels with a clear message', () => {
    expect(() =>
      OrkRocket.buildTree({
        components: [
          { type: 'stage', children: [{ type: 'nosecone', length: 0.07, aftRadius: 0.012 }] },
          { type: 'bodytube', length: 0.3, outerRadius: 0.012 },
        ],
      }),
    ).toThrow(/EVERY top-level node must be a stage/);
  });

  it('rejects unknown cluster configurations with a clear message', () => {
    expect(() =>
      OrkRocket.buildTree({
        components: [
          { type: 'bodytube', length: 0.3, outerRadius: 0.033, thickness: 0.001, children: [
            { type: 'innertube', motorMount: true, cluster: '17-mega' },
          ] },
        ],
      }),
    ).toThrow(/Unknown cluster configuration/);
  });
});
