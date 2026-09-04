import { describe, expect, it } from 'vitest';
import { OrkRocket, type ComponentNode, type MotorSpec, type RocketSpec, type RocketTree } from './orkEngine.js';

/** Index of a Mach in a drag sweep's grid. Float-exact: the grid is generated, not measured. */
const at = (s: { machs: number[] }, m: number) =>
  s.machs.findIndex((x) => Math.abs(x - m) < 1e-9);

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
    // 2026-08-25: 333.4644714919658 -> 329.6097045289919. This design carries a
    // nozzleExitDiameter, and the power-on base-drag reduction it drives is one
    // of ours — desktop OpenRocket 24.12 has no nozzle-exit aerodynamics at all.
    // It used to apply in every model including the desktop-parity one; it is
    // now gated to Rogers Kbf / Supersonic like every other extension, so this
    // flag-free flight keeps its full base drag through boost and lands 3.85 m
    // lower. See validation/scorecard-transition-2026-08-25.md.
    const result = rocket.simulate({});
    expect(result.summary.maxAltitude).toBeCloseTo(329.6097045289919, 4);
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

  it('a sharp AIRFOIL fin with no named section: Kbf drops the blunt LE term, parity keeps it', () => {
    // v0.075, the owner's 2026-08-27 ruling. FinSetCalc's sharp-airfoil pressure
    // branch is gated on (supersonicAero || rogersKbf), so an AIRFOIL fin that
    // names NO airfoilSection — which is what every desktop-authored .ork looks
    // like, since <airfoilsection> is our own extension tag — stops being charged
    // classic Barrowman's swept-cylinder leading-edge plateau.
    //
    // THIS TEST IS THE ONLY AUTOMATED GUARD ON THAT GATE, and it is here because
    // nothing else can see it: every finned validation fixture names a section and
    // short-circuits above the branch (classic/Kbf/supersonic scored 10/17/71 both
    // before and after), and difftest has no stored baseline, so it cannot catch a
    // change that moves the JVM and TeaVM together. Without this, the default
    // model's apogee could move 21 % on a Mach 1.9 design with everything green.
    const COARSE = { machMin: 0.3, machMax: 2.0, machStep: 0.1 };
    const mk = (cross: string, kbf: boolean, supersonic = false, opts = COARSE) => {
      const r = OrkRocket.buildTree({
        components: [
          { type: 'nosecone', shape: 'conical', length: 0.085, aftRadius: 0.015, thickness: 0.0015 },
          {
            type: 'bodytube', length: 0.215, outerRadius: 0.015, thickness: 0.0015,
            children: [{
              type: 'trapezoidfinset', finCount: 4, rootChord: 0.03, tipChord: 0.03,
              sweep: 0, height: 0.03, thickness: 0.0024, crossSection: cross,
              position: { method: 'bottom' as const, offset: 0 },
            }],
          },
        ],
      });
      r.setRogersModifiedBarrowman(kbf);
      r.setSupersonicAero(supersonic);
      return r.dragSweep(opts);
    };

    const airfoilKbf = mk('airfoil', true);
    const airfoilClassic = mk('airfoil', false);

    // The gate fires: Kbf is materially LOWER than parity on the same geometry.
    expect(airfoilKbf.powerOff.pressure[at(airfoilKbf, 2.0)]!)
      .toBeLessThan(0.5 * airfoilClassic.powerOff.pressure[at(airfoilClassic, 2.0)]!);
    expect(airfoilKbf.powerOff.total[at(airfoilKbf, 0.9)]!)
      .toBeLessThan(airfoilClassic.powerOff.total[at(airfoilClassic, 0.9)]!);

    // ...and the OTHER half of the gate. The branch is
    // `(supersonicAero || rogersKbf) && crossSection == AIRFOIL`, so every
    // assertion above — all of them Kbf — leaves the supersonicAero disjunct
    // unexecuted: deleting `supersonicAero ||` would put the swept-cylinder
    // plateau back on every Supersonic-model user with a sharp airfoil fin
    // (measured on this fixture at M2.0: pressure CD 0.214 -> 0.560) and still
    // pass this file. difftest cannot cover it either — it compares a JVM run
    // against a TeaVM run, and both move together.
    const airfoilSs = mk('airfoil', false, true);
    expect(airfoilSs.powerOff.pressure[at(airfoilSs, 2.0)]!)
      .toBeLessThan(0.5 * airfoilClassic.powerOff.pressure[at(airfoilClassic, 2.0)]!);

    // CONTAINMENT — the half that matters most. SQUARE (the FinSet default) and
    // ROUNDED must be bit-identical across the models: the gate is AIRFOIL-only,
    // and rounded is what the classic LE term actually models.
    //
    // Guarded against going vacuous: `crossSection` is a free string and
    // ComponentFactory.crossSectionOf maps anything unrecognised to SQUARE
    // (`case "square": default:`), so a typo in either name would make both
    // sides of the toEqual the same SQUARE rocket and the assertion would pass
    // while ROUNDED went completely unchecked. Pinning rounded != square first
    // means the loop can only pass by actually building the two cross-sections.
    const roundedKbf = mk('rounded', true);
    const squareKbf = mk('square', true);
    expect(roundedKbf.powerOff.pressure).not.toEqual(squareKbf.powerOff.pressure);
    for (const cross of ['square', 'rounded']) {
      expect(mk(cross, true).powerOff.pressure).toEqual(mk(cross, false).powerOff.pressure);
    }

    // Subsonic the sharp treatment is exactly zero fore-drag (thicknessWave is 0
    // at/below Mach 0.90), and it must stay CONTINUOUS through the transonic
    // onset. A subsonic-only gate was measured at a +1.21 CD step between M0.90
    // and M0.91 and rejected for that reason; this pins the coherent form.
    // Same fixture as above, swept finely across the onset — mk() takes the sweep
    // options so the two halves of this test cannot drift apart on geometry.
    const fine = mk('airfoil', true, false, { machMin: 0.85, machMax: 0.95, machStep: 0.01 });
    let biggestStep = 0;
    for (let i = 1; i < fine.machs.length; i++) {
      biggestStep = Math.max(biggestStep,
        Math.abs(fine.powerOff.total[i]! - fine.powerOff.total[i - 1]!));
    }
    expect(biggestStep).toBeLessThan(0.2);
  });

  it('fin airfoil sections: blunt-base wedge adds fin base drag, sharp sections do not', () => {
    // 2026-08-25: the section model is no longer INPUT-gated. Naming an airfoil
    // section used to replace desktop's pressure-drag model in EVERY aero model
    // including "OpenRocket - Extended Barrowman", whose whole claim is
    // bit-identical desktop physics (desktop's FinSet knows only the three-valued
    // CrossSection). It now needs Rogers Kbf or the supersonic model, so this
    // test asks for Kbf — and asserts the parity model ignores it, below.
    const mkRaw = (finExtra: Record<string, unknown>) => OrkRocket.buildTree({
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
    const mk = (finExtra: Record<string, unknown>) => {
      const r = mkRaw(finExtra);
      r.setRogersModifiedBarrowman(true);
      return r;
    };
    const opts = { machMin: 0.5, machMax: 2.5, machStep: 0.5 };

    // The parity model must be blind to the section: same answer with and
    // without one named, because that is what desktop OpenRocket would say.
    expect(mkRaw({ airfoilSection: 'hexbluntbase' }).dragSweep(opts).powerOff.pressure)
      .toEqual(mkRaw({}).dragSweep(opts).powerOff.pressure);

    // ...and the OTHER half of the gate. FinSetCalc.calculatePressureCD reads
    // `airfoilSection != null && (rogersKbf || supersonicAero)`, so every
    // assertion below — all of them Kbf — leaves the supersonicAero disjunct
    // unexecuted: deleting it would move every Supersonic-model user's fin
    // pressure drag and still pass this file. (The golden harness cannot cover
    // that either: engine-java/scripts/difftest.mjs has no stored baseline, it
    // compares a JVM run against a TeaVM run, and both move together.)
    // Supersonic is asserted on its own, NOT against the Kbf numbers: the two
    // legitimately differ, because sectionPressureCD itself branches on the
    // flag (thicknessWave + sweepWaveFactor vs the frozen M0.9-1.2 ramp and
    // cos^2). Measured 2026-08-25 on this fixture at M2.0, Supersonic model:
    // 0.18886509530366818 with a doublewedge section, 0.7397322892928156
    // without one.
    const mkSs = (finExtra: Record<string, unknown>) => {
      const r = mkRaw(finExtra);
      r.setSupersonicAero(true);
      return r;
    };
    const ssPlain = mkSs({}).dragSweep(opts);
    const ssWedge = mkSs({ airfoilSection: 'doublewedge' }).dragSweep(opts);
    expect(ssWedge.powerOff.pressure).not.toEqual(ssPlain.powerOff.pressure);
    expect(ssWedge.powerOff.pressure[at(ssWedge, 2.0)]!)
      .toBeLessThan(0.5 * ssPlain.powerOff.pressure[at(ssPlain, 2.0)]!);

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

  it('nozzle-exit power-on base drag is gated to the non-parity models', () => {
    // BarrowmanCalculator.calculateBaseCD reads
    // `(rogersKbf || supersonicAero) && stage != null` before subtracting the
    // nozzle-exit footprint from the drag-producing base area. Nothing in this
    // package asserted that gate, and engine-java's goldens cannot: difftest
    // compares a JVM run against a TeaVM run with no stored baseline, so an
    // edit that let this extension back into the parity model (or dropped
    // either disjunct) moves both runs the same way and still passes.
    const nozzleTree = (): RocketTree => ({
      name: 'Nozzle',
      components: [{
        type: 'stage', name: 'S', nozzleExitDiameter: 0.016,
        children: [
          { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002 },
          {
            type: 'bodytube', length: 0.30, outerRadius: 0.012, thickness: 0.0005, density: 950,
            children: [
              { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
            ],
          },
        ],
      }],
    });
    const baseCd = (model: 'classic' | 'kbf' | 'supersonic') => {
      const r = OrkRocket.buildTree(nozzleTree());
      if (model === 'kbf') r.setRogersModifiedBarrowman(true);
      if (model === 'supersonic') r.setSupersonicAero(true);
      const s = r.dragSweep({ machMin: 0.9, machMax: 0.9, machStep: 1 });
      return { off: s.powerOff.base[0]!, on: s.powerOn.base[0]! };
    };

    // Parity: desktop OpenRocket 24.12 has no nozzle-exit aerodynamics at all,
    // so power-ON must cost exactly what power-OFF costs. Measured 2026-08-25
    // at M0.90: 0.2253 both ways — the kernel's subsonic base law
    // (0.12 + 0.13*M^2) over the whole 24 mm base.
    const classic = baseCd('classic');
    expect(classic.on).toBe(classic.off);
    expect(classic.off).toBeCloseTo(0.2253, 12);

    // Both non-parity models must get the reduction, asserted SEPARATELY
    // because the gate is a disjunction and a Kbf-only check leaves
    // supersonicAero unexecuted. Equality between the two is well-founded
    // here, not incidental: at M0.90 effectiveBaseCD is model-independent (the
    // supersonic vacuum-limit cap only applies above M1) and the only
    // flag-dependent step is the area subtraction, which is pure geometry.
    // Measured 2026-08-25: 0.12516666666666665 in each — the base law scaled
    // by (12^2 - 8^2)/12^2, the annulus the 16 mm nozzle leaves of the base.
    for (const model of ['kbf', 'supersonic'] as const) {
      const m = baseCd(model);
      expect(m.off).toBeCloseTo(classic.off, 12);
      expect(m.on).toBeLessThan(m.off);
      expect(m.on).toBeCloseTo(0.12516666666666665, 12);
    }
  });

  it('perfectFinish (partial-laminar friction) is engine-API only, and inert in the parity model', () => {
    // The only executor of OrkRocket.setPerfectFinish in the repo. It is wired
    // kernel -> bridge -> wrapper but has no UI control, no preference and no
    // .ork field (desktop OpenRocket 24.12 never writes the property), so the
    // changelog's claim is "reachable through the engine" and this is what
    // makes that true rather than asserted. The gate is
    // BarrowmanCalculator.partialLaminar: `(rogersKbf || supersonicAero) &&
    // rocket.isPerfectFinish()`.
    const tree = (finish?: string): RocketTree => ({
      name: 'Finish',
      components: [{
        type: 'stage', name: 'S',
        children: [
          { type: 'nosecone', shape: 'ogive', length: 0.07, aftRadius: 0.012, thickness: 0.002, finish },
          {
            type: 'bodytube', length: 0.30, outerRadius: 0.012, thickness: 0.0003, density: 950, finish,
            children: [
              { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003, finish },
            ],
          },
        ],
      }],
    });
    const friction = (
      finish: string | undefined,
      model: 'classic' | 'kbf' | 'supersonic',
      perfect: boolean,
    ) => {
      const r = OrkRocket.buildTree(tree(finish));
      if (model === 'kbf') r.setRogersModifiedBarrowman(true);
      if (model === 'supersonic') r.setSupersonicAero(true);
      r.setPerfectFinish(perfect);
      return r.dragSweep({ machMin: 0.3, machMax: 0.3, machStep: 1 }).powerOff.friction[0]!;
    };

    // Parity model: inert, which is the entire point of the gate. Measured
    // 2026-08-25 at M0.30 on a polished airframe: 0.2807709520250913 with the
    // setting off and with it on.
    expect(friction('polished', 'classic', true))
      .toBe(friction('polished', 'classic', false));

    // Kbf and Supersonic honour it — separately, because that gate is a
    // disjunction too. Measured 2026-08-25, polished, M0.30, in both models:
    // 0.3339417009806639 off -> 0.2727276664333965 on, a 18.3 % credit.
    for (const model of ['kbf', 'supersonic'] as const) {
      expect(friction('polished', model, true))
        .toBeLessThan(0.95 * friction('polished', model, false));
    }

    // On the default (regular paint) finish the roughness-limited Cf wins in
    // BOTH branches once Re > 1e6, so the setting is a subsonic no-op — the
    // same behaviour engine-java's transition goldens pin. Measured
    // 2026-08-25 at M0.30, Kbf: 0.5077073958105641 either way.
    expect(friction(undefined, 'kbf', true))
      .toBe(friction(undefined, 'kbf', false));
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

  it('surfaces simulation warnings with stable keys (arms after the engine rebuild)', (ctx) => {
    // No recovery device — the kernel raises Warning.NO_RECOVERY_DEVICE (HIGH).
    const rocket = OrkRocket.build({ ...REFERENCE_ROCKET, parachute: undefined });
    rocket.setMotor(C6_MOTOR);
    const result = rocket.simulate({ launchRodLength: 1.0, timeStep: 0.05 });
    if (result.warnings === undefined) {
      // The committed vendor orkengine.mjs predates the warning export —
      // this arms automatically once the engine-rebuild phase regenerates it
      // (gradlew generateJavaScript + a full differential pass).
      ctx.skip();
      return;
    }
    const noChute = result.warnings.find((w) => w.key === 'NO_RECOVERY_DEVICE');
    expect(noChute).toBeDefined();
    expect(noChute!.priority).toBe('HIGH');
    // warningTexts mirrors the messages, in the same shape staticInfo() uses.
    expect(result.warningTexts).toContain(noChute!.message);
  });

  it('emits the full symbol-keyed series map when series:full is requested', () => {
    const rocket = OrkRocket.build(REFERENCE_ROCKET);
    rocket.setMotor(C6_MOTOR);
    const result = rocket.simulate({ launchRodLength: 1.0, timeStep: 0.05, series: 'full' });
    // Symbol series are index-aligned with time.
    expect(result.series['Vz']).toBeDefined();
    expect(result.series['Vz']!.length).toBe(result.series.time.length);
    // tc (computation time) is wall-clock noise — excluded even from full so
    // the payload stays deterministic between same-seed runs.
    expect(result.series['tc']).toBeUndefined();
    // Symbols duplicating the friendly-named dozen ('t' = time, 'h' =
    // altitude…) are excluded — they'd be pure byte duplication.
    expect(result.series['t']).toBeUndefined();
    // A genuinely extra series: friction drag coefficient, only in full mode.
    expect(result.series['Cdf']).toBeDefined();
    expect(result.series['Cdf']!.length).toBe(result.series.time.length);
    // A series the friendly dozen does not carry: motor mass 'mp' burns from
    // 24 g (C6 loaded) down to the 13.2 g casing.
    const mp = (result.series['mp'] ?? []).filter((v): v is number => v !== null);
    expect(mp.length).toBe(result.series.time.length);
    expect(Math.max(...mp)).toBeCloseTo(0.024, 3);
    expect(mp[mp.length - 1]!).toBeLessThan(0.015);
  });

  it('defaults to summary series: the 6 report symbols and nothing more', () => {
    const rocket = OrkRocket.build(REFERENCE_ROCKET);
    rocket.setMotor(C6_MOTOR);
    const result = rocket.simulate({ launchRodLength: 1.0, timeStep: 0.05 });
    // Exactly the symbol keys the app's flight report consumes every run:
    // lateral drift (Pl, θl, Px, Py), roll rate (dΦ) and VERTICAL VELOCITY (Vz).
    const friendly = [
      'time', 'altitude', 'velocity', 'acceleration', 'mass', 'thrust',
      'drag', 'mach', 'stability', 'cpLocation', 'cgLocation', 'aoa',
    ];
    const symbolKeys = Object.keys(result.series).filter((k) => !friendly.includes(k));
    expect(symbolKeys.sort()).toEqual(['Pl', 'Px', 'Py', 'Vz', 'dΦ', 'θl'].sort());
    expect(result.series['Pl']!.length).toBe(result.series.time.length);
    expect(result.series['Vz']!.length).toBe(result.series.time.length);
    // Summary is still not full: these two stay off the default path (~45% wall clock).
    expect(result.series['Cdf']).toBeUndefined();
    // …and tc is excluded at EVERY mode: it is wall-clock measurement noise and
    // dumping it makes same-seed outputs differ. Never re-add it.
    expect(result.series['tc']).toBeUndefined();
  });

  it('the exported Vz IS the vertical rate the landing verdict is judged on', () => {
    // The point of exporting it: the friendly `velocity` series is
    // TYPE_VELOCITY_TOTAL — speed over the ground, which under canopy carries the
    // whole wind drift — while the safety limit means DESCENT. v0.100 differenced
    // the altitude series as a stand-in; this is the number itself.
    const rocket = OrkRocket.build(REFERENCE_ROCKET);
    rocket.setMotor(C6_MOTOR);
    const result = rocket.simulate({ launchRodLength: 1.0, timeStep: 0.05 });
    const last = result.series.time.length - 1;
    // SIX places, and do NOT tighten it: the two differ at ~3e-9 because the
    // horizontal velocity at touchdown is not exactly zero.
    expect(Math.abs(result.series['Vz']![last]!))
      .toBeCloseTo(result.summary.groundHitVelocity!, 6);
    // Vz is signed and points UP, so a descending rocket's is negative.
    expect(result.series['Vz']![last]!).toBeLessThan(0);
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

/**
 * Stage-level overrides (issue 2026-08-22a). A stage is built directly by
 * OrkEngine.buildTree rather than through the ComponentFactory switch, and for
 * a long time that path never applied the override block: a whole-stage Cd,
 * mass or CG override entered in the UI round-tripped to the .ork and then
 * vanished on the way into the kernel. The forum ask it blocks is "override
 * the Cd for the whole rocket" — that is a stage Cd override with the
 * subcomponents flag set.
 */
describe('stage-level overrides reach the kernel', () => {
  const stageTree = (stage: Record<string, unknown>): RocketTree => ({
    components: [{
      type: 'stage',
      name: 'Sustainer',
      ...stage,
      children: [
        { type: 'nosecone', length: 0.15, aftRadius: 0.025, thickness: 0.002, shape: 'ogive' },
        {
          type: 'bodytube',
          length: 0.5,
          outerRadius: 0.025,
          thickness: 0.001,
          children: [{
            type: 'trapezoidfinset',
            finCount: 3,
            rootChord: 0.08,
            tipChord: 0.04,
            sweep: 0.03,
            height: 0.05,
            thickness: 0.003,
            position: { method: 'bottom', offset: 0 },
          }],
        },
      ],
    }],
  });

  const totalCd = (tree: RocketTree): number =>
    OrkRocket.buildTree(tree).dragSweep({ machMin: 0.3, machMax: 0.3, machStep: 1 })
      .powerOff.total[0]!;

  it('a stage Cd override with the subcomponents flag REPLACES the whole rocket Cd', () => {
    const base = totalCd(stageTree({}));
    expect(base).toBeGreaterThan(0.1);
    expect(base).not.toBeCloseTo(0.45, 6);

    // What a user means by "override the Cd for the whole rocket".
    expect(totalCd(stageTree({ overrideCD: 0.45, overrideSubcomponentsCD: true })))
      .toBeCloseTo(0.45, 9);
  });

  it('without the subcomponents flag a stage Cd override ADDS, per OpenRocket', () => {
    const base = totalCd(stageTree({}));
    expect(totalCd(stageTree({ overrideCD: 2.5 }))).toBeCloseTo(base + 2.5, 9);
  });

  it('applies stage mass and CG overrides', () => {
    const base = OrkRocket.buildTree(stageTree({})).staticInfo();
    expect(base.mass).toBeLessThan(1);

    const added = OrkRocket.buildTree(stageTree({ overrideMass: 5 })).staticInfo();
    expect(added.mass).toBeCloseTo(base.mass + 5, 9);

    const replaced = OrkRocket.buildTree(
      stageTree({ overrideMass: 5, overrideSubcomponentsMass: true }),
    ).staticInfo();
    expect(replaced.mass).toBeCloseTo(5, 9);

    const cg = OrkRocket.buildTree(
      stageTree({ overrideCGX: 0.2, overrideSubcomponentsCG: true }),
    ).staticInfo();
    expect(cg.cg).toBeCloseTo(0.2, 9);
  });

  /**
   * v0.088 — the inertia must follow the mass it belongs to.
   *
   * Before this, a covering mass override scaled the MASS and left the moments
   * of inertia summing the children's geometric masses: the kernel returned a
   * body whose mass, CG and inertia tensor described three different objects.
   * The roll figure was low by exactly the override factor, and nothing on
   * screen disagreed because inertia was not published anywhere.
   *
   * The invariant asserted here is the one that makes the fix checkable rather
   * than merely different: with the shape held fixed and the mass multiplied by
   * k, EVERY inertia scales by exactly k.
   */
  it('scales the inertia tensor with a covering mass override', () => {
    const base = OrkRocket.buildTree(stageTree({})).staticInfo();
    expect(base.rotationalInertiaEmpty).toBeGreaterThan(0);
    expect(base.longitudinalInertiaEmpty).toBeGreaterThan(0);

    for (const k of [2, 5, 0.5]) {
      const pinned = OrkRocket.buildTree(stageTree({
        overrideMass: base.massEmpty * k,
        overrideSubcomponentsMass: true,
      })).staticInfo();

      expect(pinned.massEmpty).toBeCloseTo(base.massEmpty * k, 9);
      // Relative, not absolute: these are ~1e-3 kg·m², where toBeCloseTo's
      // absolute default would pass on any value at all.
      expect(pinned.rotationalInertiaEmpty / base.rotationalInertiaEmpty)
        .toBeCloseTo(k, 9);
      expect(pinned.longitudinalInertiaEmpty / base.longitudinalInertiaEmpty)
        .toBeCloseTo(k, 9);
    }
  });

  /**
   * The scope guard. `overrideMass` WITHOUT the subcomponents flag is a
   * different, self-consistent behaviour — a coherent point mass added at the
   * subtree CG, which upstream computes correctly — and the v0.088 fix must not
   * touch it. A point mass has no inertia of its own, so the ROLL figure is
   * unchanged while the mass goes up; that is correct, and it is exactly the
   * signature the covering-override case wrongly had before the fix.
   */
  it('leaves a NON-covering mass override alone', () => {
    const base = OrkRocket.buildTree(stageTree({})).staticInfo();
    const added = OrkRocket.buildTree(stageTree({ overrideMass: 5 })).staticInfo();

    expect(added.massEmpty).toBeCloseTo(base.massEmpty + 5, 9);
    expect(added.rotationalInertiaEmpty).toBeCloseTo(base.rotationalInertiaEmpty, 12);
  });
});

/**
 * Override semantics up and down the stack (issue 2026-08-22b). The project
 * owner asked for these to be pinned and documented, because "it could cause
 * confusion quickly with multiple overrides occurring up and down the
 * hierarchical stack". Everything asserted here was MEASURED against the
 * kernel, and the app's user-facing copy is written from it — an earlier
 * description of an unticked override as "adds to what the component computes"
 * was wrong for anything with geometry of its own.
 */
describe('override semantics through the component hierarchy', () => {
  const nested = (
    stage: Record<string, unknown>,
    tube: Record<string, unknown>,
    fins: Record<string, unknown> = {},
  ): RocketTree => ({
    components: [{
      type: 'stage', name: 'S', ...stage,
      children: [
        { type: 'nosecone', length: 0.15, aftRadius: 0.025, thickness: 0.002, shape: 'ogive' },
        {
          type: 'bodytube', length: 0.5, outerRadius: 0.025, thickness: 0.001, ...tube,
          children: [{
            type: 'trapezoidfinset', finCount: 3, rootChord: 0.08, tipChord: 0.04,
            sweep: 0.03, height: 0.05, thickness: 0.003,
            position: { method: 'bottom', offset: 0 }, ...fins,
          }],
        },
      ],
    }],
  });

  const cd = (t: RocketTree): number =>
    OrkRocket.buildTree(t).dragSweep({ machMin: 0.3, machMax: 0.3, machStep: 1 })
      .powerOff.total[0]!;
  const mass = (t: RocketTree): number => OrkRocket.buildTree(t).staticInfo().mass;

  it('an override REPLACES the component’s own value, it does not add to it', () => {
    const base = cd(nested({}, {}));
    // If it added, this would be base + 1.0. It is less, because the tube's own
    // computed drag steps aside for the override.
    const withTube = cd(nested({}, { overrideCD: 1.0 }));
    expect(withTube).toBeLessThan(base + 1.0);
    expect(withTube).toBeGreaterThan(1.0);
  });

  it('unticked, everything inside still counts on its own', () => {
    const tubeOnly = cd(nested({}, { overrideCD: 1.0 }));
    const tubeAndFins = cd(nested({}, { overrideCD: 1.0 }, { overrideCD: 0.5 }));
    expect(tubeAndFins).toBeGreaterThan(tubeOnly);
  });

  it('ticked, nothing below contributes — including its own override', () => {
    const replaced = cd(nested({}, { overrideCD: 1.0, overrideSubcomponentsCD: true }));
    const alsoFins = cd(nested({},
      { overrideCD: 1.0, overrideSubcomponentsCD: true }, { overrideCD: 0.5 }));
    expect(alsoFins).toBeCloseTo(replaced, 12);
  });

  it('the NEAREST ticked ancestor wins, whatever is set below it', () => {
    const a = cd(nested({ overrideCD: 2.0, overrideSubcomponentsCD: true },
      { overrideCD: 1.0 }, { overrideCD: 0.5 }));
    const b = cd(nested({ overrideCD: 2.0, overrideSubcomponentsCD: true },
      { overrideCD: 1.0, overrideSubcomponentsCD: true }, { overrideCD: 0.5 }));
    expect(a).toBeCloseTo(2.0, 9);
    expect(b).toBeCloseTo(2.0, 9);

    const m = mass(nested({ overrideMass: 3, overrideSubcomponentsMass: true },
      { overrideMass: 1, overrideSubcomponentsMass: true }, { overrideMass: 0.4 }));
    expect(m).toBeCloseTo(3, 9);
  });

  it('a CONTAINER has nothing of its own to replace, so unticked behaves differently', () => {
    // A stage / pod set / booster is a ComponentAssembly: no mass, no CG, no
    // drag of its own. Unticked, a mass override therefore ADDS instead of
    // setting, and a CG override does nothing whatsoever — which is why the
    // panel and the guide tell you to tick the box on these.
    const base = OrkRocket.buildTree(nested({}, {})).staticInfo();

    const cgUnticked = OrkRocket.buildTree(nested({ overrideCGX: 0.1 }, {})).staticInfo();
    expect(cgUnticked.cg).toBeCloseTo(base.cg, 12);          // no-op

    const cgTicked = OrkRocket.buildTree(
      nested({ overrideCGX: 0.1, overrideSubcomponentsCG: true }, {})).staticInfo();
    expect(cgTicked.cg).toBeCloseTo(0.1, 9);                 // sets it

    const massUnticked = OrkRocket.buildTree(nested({ overrideMass: 1 }, {})).staticInfo();
    expect(massUnticked.mass).toBeCloseTo(base.mass + 1, 9); // adds

    // On a part that HAS geometry, the same unticked CG override does work.
    const onTube = OrkRocket.buildTree(nested({}, { overrideCGX: 0.1 })).staticInfo();
    expect(onTube.cg).not.toBeCloseTo(base.cg, 6);
  });

  it('a CONTAINER’s unticked Cd override ADDS exactly, like its mass', () => {
    // The third row of the container truth table, measured 2026-08-23 — the one
    // the panel copy used to leave out. A stage is not aerodynamic, so there is
    // no drag of its own to step aside, and unticked it does not suppress its
    // contents either: the figure lands on top of the whole rocket's computed
    // drag, exactly, however big it is.
    const base = cd(nested({}, {}));

    expect(cd(nested({ overrideCD: 1.0 }, {}))).toBeCloseTo(base + 1.0, 9);
    expect(cd(nested({ overrideCD: 2.5 }, {}))).toBeCloseTo(base + 2.5, 9);
  });

  it('an unticked override on a CONTAINER is a phantom POINT MASS, which is why CG alone does nothing', () => {
    // The owner reported the stage CG override "still not doing anything"
    // unticked (2026-08-23b). It is not a blanket no-op — it is a no-op only
    // while the container has no mass of its own to position.
    //
    // An unticked override on a stage/pod/booster describes a point mass the
    // container contributes: the MASS override gives that point its weight and
    // the CG override gives it its station. Position nothing and nothing moves;
    // give it a mass and the CG bites immediately. That single rule explains
    // all three quantities and replaces the arbitrary-sounding "mass adds, Cd
    // adds, CG does nothing".
    const base = OrkRocket.buildTree(nested({}, {})).staticInfo();

    // CG alone, any value: nothing, because it is positioning zero kilograms.
    for (const cg of [0.1, 0.6]) {
      expect(OrkRocket.buildTree(nested({ overrideCGX: cg }, {})).staticInfo().cg)
        .toBeCloseTo(base.cg, 12);
    }

    // Add an unticked mass and the SAME CG override takes effect exactly as a
    // point mass of that mass at that station.
    const both = OrkRocket.buildTree(
      nested({ overrideMass: 1, overrideCGX: 0.1 }, {})).staticInfo();
    const asPointMass = (base.mass * base.cg + 1 * 0.1) / (base.mass + 1);
    expect(both.mass).toBeCloseTo(base.mass + 1, 9);
    expect(both.cg).toBeCloseTo(asPointMass, 12);

    // Without the CG override that added kilogram lands somewhere else, so the
    // CG override is demonstrably doing the positioning.
    const massOnly = OrkRocket.buildTree(nested({ overrideMass: 1 }, {})).staticInfo();
    expect(massOnly.cg).not.toBeCloseTo(both.cg, 6);
  });

  it('a fin set’s Cd override is PER FIN, while its mass override is the whole set', () => {
    const finned = (n: number, extra: Record<string, unknown>): RocketTree => ({
      components: [{
        type: 'stage',
        children: [
          { type: 'nosecone', length: 0.15, aftRadius: 0.025, thickness: 0.002, shape: 'ogive' },
          {
            type: 'bodytube', length: 0.5, outerRadius: 0.025, thickness: 0.001,
            children: [{
              type: 'trapezoidfinset', finCount: n, rootChord: 0.08, tipChord: 0.04,
              sweep: 0.03, height: 0.05, thickness: 0.003,
              position: { method: 'bottom', offset: 0 }, ...extra,
            }],
          },
        ],
      }],
    });

    // Cd scales with the fin count: each extra fin adds another 0.5.
    const three = cd(finned(3, { overrideCD: 0.5 }));
    const four = cd(finned(4, { overrideCD: 0.5 }));
    const six = cd(finned(6, { overrideCD: 0.5 }));
    expect(four - three).toBeCloseTo(0.5, 9);
    expect(six - four).toBeCloseTo(1.0, 9);

    // Mass does not: 0.4 kg is 0.4 kg however many fins there are.
    for (const n of [3, 4, 6]) {
      expect(mass(finned(n, { overrideMass: 0.4 }))).toBeCloseTo(
        mass(finned(3, { overrideMass: 0.4 })), 12);
    }
  });
});

/**
 * A CD OVERRIDE MAY BE A FRACTION OF THE BODY'S OWN CD, RE-EVALUATED AT EVERY MACH
 * (`overrideCDBodyRatio`; kernel patch in engine-java/patches, ledgered).
 *
 * WHY THE KERNEL HAS TO DO IT. The app has no protuberance calculator: a protuberance
 * is lowered at the engine boundary to a `railbutton` carrying an `overrideCD`, and
 * BarrowmanCalculator.calculateOverrideCD added that scalar unchanged at every Mach.
 * For the two STREAMLINED protuberance classes that is the wrong shape outright —
 * they implement Chuck Rogers' Streamlined Protuberance Method, which sets the bump's
 * drag per unit frontal area equal to the ROCKET BODY's own "for all Mach Numbers"
 * (TRF 197641 #1), and a scalar cannot express a fraction of a curve. The app could
 * not fix it on its side: getAerodynamicForces is the flight hot path and passes a
 * null force map, so no per-component decomposition exists during a simulation, and
 * the app hands the kernel ONE static tree per flight.
 *
 * WHAT THE BODY REFERENCE IS. The SymmetricComponent-only half of friction + pressure
 * (+ base, for the with-base class), accumulated in place by the three drag methods
 * that already run immediately before calculateOverrideCD at both of its call sites.
 * Rogers' own instruction to OpenRocket users is to measure it by deleting the fins
 * ("running the rocket with No Fins (Rocket Body Only)"), which is exactly what
 * `bodyOnly` below builds — and MEASURED against the committed kernel, the in-place
 * sum and that separate stripped rocket agree to 5.6e-17 absolute (0-1 ulp) at all 20
 * Mach points 0.10-2.00 on this airframe, so the two are the same quantity and the
 * assertions below can use the cheap one. (They part company only when stripping the
 * fins shortens getLengthAerodynamic() and moves Re; here it is 0.65 m either way.)
 *
 * THE NUMBERS THIS PINS, measured on the airframe below (nose 0.15 m ogive + 0.5 m
 * 50 mm tube, ratio 0.08): body CD with base drag runs 0.267830153 (M2.00) to
 * 0.503845206 (M1.10), a span of 1.88x, so the honest increment runs 0.021426412 to
 * 0.040307616 where the frozen scalar sat at 0.030077691 — the M0.3 value — for the
 * whole flight.
 */
describe('a body-proportional CD override tracks the body CD at every Mach', () => {
  const RATIO = 0.08;
  const OPTS = { machMin: 0.1, machMax: 2.0, machStep: 0.1, aoaDeg: 0 };

  const FINS = {
    type: 'trapezoidfinset', name: 'Fins', finCount: 3, rootChord: 0.08, tipChord: 0.04,
    sweep: 0.03, height: 0.05, thickness: 0.003, density: 680,
    // Bottom-referenced with offset 0, so the fin trailing edge lands exactly on the
    // tube bottom and getLengthAerodynamic() is the same with the fins and without —
    // which is what lets `bodyOnly` stand in for the kernel's in-place reference.
    position: { method: 'bottom', offset: 0 },
  } as unknown as ComponentNode;

  /** nose + tube, plus whatever is hung inside the tube. */
  const airframe = (inside: ComponentNode[]): RocketTree => ({
    name: 'RatioProbe',
    components: [{
      type: 'stage', name: 'S',
      children: [
        {
          type: 'nosecone', name: 'Nose', length: 0.15, aftRadius: 0.025,
          thickness: 0.002, shape: 'ogive', density: 680,
        },
        {
          type: 'bodytube', name: 'Tube', length: 0.5, outerRadius: 0.025,
          thickness: 0.001, density: 680, children: inside,
        },
      ],
    } as unknown as ComponentNode],
  });

  /** The carrier the app's protuberance lowering emits: a RailButton, drag only. */
  const carrier = (over: Record<string, unknown>): ComponentNode => ({
    type: 'railbutton', name: 'Bump', outerDiameter: 0.014,
    position: { method: 'middle', offset: 0 }, overrideMass: 0, ...over,
  } as unknown as ComponentNode);

  const sweep = (t: RocketTree) => OrkRocket.buildTree(t).dragSweep(OPTS);

  it('delivers ratio x body CD(M), not a frozen scalar', () => {
    const bodyOnly = sweep(airframe([]));           // Rogers' "Rocket Body Only"
    const finned = sweep(airframe([FINS]));         // the same rocket, carrier removed
    const machs = finned.machs;

    // The frozen scalar the app used to hand over: the M0.3 reading, held for the
    // whole flight. It stays on the node as the fallback, so this is also the proof
    // that the ratio WINS over it when both are present.
    const i03 = machs.findIndex((m) => Math.abs(m - 0.3) < 1e-9);
    const frozen = RATIO * bodyOnly.powerOff.total[i03]!;
    expect(frozen).toBeCloseTo(0.030077691, 9);

    const withRatio = sweep(airframe([FINS, carrier({
      overrideCD: frozen, overrideCDBodyRatio: RATIO, overrideCDBodyIncludesBase: true,
    })]));
    const delivered = machs.map((_, i) => withRatio.powerOff.total[i]! - finned.powerOff.total[i]!);

    // (a) IT IS NOT CONSTANT. This is the whole defect in one assertion: before the
    // kernel change every one of these 20 points read 0.030077691.
    const lo = Math.min(...delivered), hi = Math.max(...delivered);
    expect(hi / lo).toBeGreaterThan(1.5);
    expect(lo).toBeCloseTo(0.021426412, 9);   // M2.00
    expect(hi).toBeCloseTo(0.040307616, 9);   // M1.10, the transonic peak

    // (b) IT IS THE METHOD, at every Mach: ratio x this body's own CD including base
    // drag, measured from the stripped rocket.
    machs.forEach((_, i) => {
      expect(delivered[i]!).toBeCloseTo(RATIO * bodyOnly.powerOff.total[i]!, 9);
    });
    for (const m of [0.3, 1.1, 2.0]) {
      const i = machs.findIndex((x) => Math.abs(x - m) < 1e-9);
      expect(delivered[i]!).toBeCloseTo(RATIO * bodyOnly.powerOff.total[i]!, 12);
    }
    // At the quoting Mach it still delivers exactly what the panel prints.
    expect(delivered[i03]!).toBeCloseTo(frozen, 12);

    // …and it is ALL override: a CD-overridden component is skipped by the friction,
    // pressure and base loops, so none of the three computed buckets moves.
    machs.forEach((_, i) => {
      expect(withRatio.powerOff.friction[i]!).toBeCloseTo(finned.powerOff.friction[i]!, 12);
      expect(withRatio.powerOff.pressure[i]!).toBeCloseTo(finned.powerOff.pressure[i]!, 12);
      expect(withRatio.powerOff.base[i]!).toBeCloseTo(finned.powerOff.base[i]!, 12);
    });
  }, 60000);

  it('the no-base class references body CD EXCLUDING base drag', () => {
    // Rogers' two streamlined classes differ in exactly this: "Streamlined with No
    // Base Drag" is a fraction of the body CD NOT including body base drag, "with Base
    // Drag" of the body CD including it.
    const bodyOnly = sweep(airframe([]));
    const finned = sweep(airframe([FINS]));
    const noBase = sweep(airframe([FINS, carrier({
      overrideCD: 0.01, overrideCDBodyRatio: RATIO, overrideCDBodyIncludesBase: false,
    })]));

    finned.machs.forEach((_, i) => {
      const ref = bodyOnly.powerOff.total[i]! - bodyOnly.powerOff.base[i]!;
      expect(noBase.powerOff.total[i]! - finned.powerOff.total[i]!).toBeCloseTo(RATIO * ref, 9);
    });
    // Strictly less than the with-base class, everywhere, by exactly the base term.
    const withBase = sweep(airframe([FINS, carrier({
      overrideCD: 0.01, overrideCDBodyRatio: RATIO, overrideCDBodyIncludesBase: true,
    })]));
    finned.machs.forEach((_, i) => {
      expect(withBase.powerOff.total[i]! - noBase.powerOff.total[i]!)
        .toBeCloseTo(RATIO * bodyOnly.powerOff.base[i]!, 9);
    });
  }, 60000);

  it('a plain overrideCD with NO ratio key is still flat, to the last bit', () => {
    // THE SCOPE GUARD. Every `.ork` <overridecd>, every user-typed Cd override, every
    // stage-level override and every plate-class protuberance reaches the kernel with
    // no ratio key at all, leaves the new field at its NaN default, and must take the
    // untouched `instanceCount * getOverrideCD()` branch. If this ever moves, the
    // change has leaked out of its own branch and desktop parity is gone.
    const finned = sweep(airframe([FINS]));
    const scalar = sweep(airframe([FINS, carrier({ overrideCD: 0.05 })]));
    scalar.machs.forEach((_, i) => {
      expect(scalar.powerOff.total[i]! - finned.powerOff.total[i]!).toBeCloseTo(0.05, 12);
    });
  }, 60000);
});

describe('surface finish maps every level OpenRocket defines', () => {
  /**
   * ExternalComponent.Finish has NINE constants. The bridge had cases for seven;
   * "optimum" (5 um) and "mirror" (0 um) fell through to the NORMAL default
   * (60 um), a 12x roughness error that also made the ladder non-monotonic —
   * "Optimum paint" came out rougher than "Smooth paint".
   */
  const finished = (finish: string): RocketTree => ({
    name: 'F',
    components: [{
      type: 'stage', name: 'S', children: [
        { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive', finish },
        { type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950, finish },
      ],
    }],
  } as unknown as RocketTree);
  const frictionAt = (finish: string): number => {
    const sweep = OrkRocket.buildTree(finished(finish)).dragSweep({ machMin: 0.3, machMax: 0.3, machStep: 0.1 });
    const c = (sweep as unknown as { powerOff?: { friction: number[] }; friction?: number[] });
    return (c.powerOff?.friction ?? c.friction!)[0]!;
  };

  it('is monotonic: rougher finishes never produce less skin friction', () => {
    const ladder = ['mirror', 'finishpolished', 'polished', 'optimum', 'smooth', 'normal',
      'unfinished', 'roughunfinished', 'rough'];
    const cf = ladder.map(frictionAt);
    for (let i = 1; i < cf.length; i++) {
      expect(cf[i]!, `${ladder[i]} must not be smoother than ${ladder[i - 1]}`)
        .toBeGreaterThanOrEqual(cf[i - 1]! - 1e-12);
    }
  });

  it('optimum is NOT regular paint — the bug this pins', () => {
    expect(frictionAt('optimum')).toBeLessThan(frictionAt('smooth'));
    expect(frictionAt('optimum')).toBeLessThan(frictionAt('normal'));
    expect(frictionAt('mirror')).toBeLessThan(frictionAt('normal'));
  });
});

describe('fin fillet epoxy counts toward mass and CG', () => {
  /**
   * The .ork reader always kept <filletradius>/<filletmaterial>; nothing bridged
   * them to the kernel, so filleted designs flew light against desktop, which
   * counts the fillet volume (FinSet.calculateFilletVolume). 9.525 mm of epoxy
   * on three fins against a 40.64 mm body is 24.923 g sitting at the tail.
   */
  const withFillet = (filletRadius: number): RocketTree => ({
    name: 'Fillet',
    components: [{
      type: 'stage', name: 'S', children: [
        { type: 'nosecone', length: 0.217424, aftRadius: 0.02032, thickness: 0.001524, shape: 'ogive', density: 1850 },
        {
          type: 'bodytube', length: 0.7366, outerRadius: 0.02032, thickness: 0.001016, density: 1954.89,
          children: [{
            type: 'freeformfinset', finCount: 3, thickness: 0.00254, crossSection: 'rounded', density: 1556.99,
            points: [[0, 0], [0.1397, 0.0508], [0.1905, 0.0508], [0.2159, 0]],
            ...(filletRadius > 0 ? { filletRadius, filletDensity: 1729.99404, filletMaterialName: 'Epoxy' } : {}),
          }],
        },
      ],
    }],
  } as unknown as RocketTree);

  it('adds the fillet volume as mass, at the fin root', () => {
    const bare = OrkRocket.buildTree(withFillet(0)).staticInfo();
    const filleted = OrkRocket.buildTree(withFillet(0.009525)).staticInfo();
    expect((filleted.massEmpty - bare.massEmpty) * 1000).toBeCloseTo(24.923, 2);
    // Epoxy at the tail moves the empty CG aft, it does not just add a number.
    expect(filleted.cgEmpty).toBeGreaterThan(bare.cgEmpty);
  });

  it('a zero fillet radius adds nothing', () => {
    expect(OrkRocket.buildTree(withFillet(0)).staticInfo().massEmpty)
      .toBeCloseTo(OrkRocket.buildTree(withFillet(0)).staticInfo().massEmpty, 12);
  });
});

/**
 * v0.089 — rail-button / launch-lug LINE INSTANCES reach the kernel.
 *
 * The kernel's RailButton has always been LineInstanceable, and desktop .ork
 * files carry <instancecount>/<instanceseparation> — but the bridge never read
 * them, so an imported pair of buttons flew as ONE button's mass and drag (the
 * import note even said so). These pin the bridge: mass scales exactly with
 * the count, and the un-instanced case is untouched.
 */
describe('rail button line instances', () => {
  const withButton = (extra: Record<string, unknown>): RocketTree => ({
    components: [{
      type: 'stage',
      children: [
        { type: 'nosecone', length: 0.1, aftRadius: 0.025, thickness: 0.002, shape: 'ogive' },
        {
          type: 'bodytube', length: 0.6, outerRadius: 0.025, thickness: 0.001,
          children: [
            { type: 'trapezoidfinset', finCount: 3, rootChord: 0.08, tipChord: 0.04,
              sweep: 0.03, height: 0.05, thickness: 0.003, position: { method: 'bottom', offset: 0 } },
            { type: 'railbutton', outerDiameter: 0.0097, ...extra,
              position: { method: 'middle', offset: 0 } },
          ],
        },
      ],
    }],
  } as unknown as RocketTree);

  it('N buttons weigh N times one button, exactly', () => {
    const m1 = OrkRocket.buildTree(withButton({})).staticInfo().massEmpty;
    const m2 = OrkRocket.buildTree(withButton({ instanceCount: 2, instanceSeparation: 0.3 }))
      .staticInfo().massEmpty;
    const m3 = OrkRocket.buildTree(withButton({ instanceCount: 3, instanceSeparation: 0.15 }))
      .staticInfo().massEmpty;
    const perButton = m2 - m1;
    expect(perButton).toBeGreaterThan(1e-5);
    expect(m3 - m2).toBeCloseTo(perButton, 12);
  });

  it('more buttons, more drag — and the un-instanced node is bit-identical to before', () => {
    const cd = (extra: Record<string, unknown>) =>
      OrkRocket.buildTree(withButton(extra)).dragSweep({ machMin: 0.3, machMax: 0.3, machStep: 1 })
        .powerOff.total[0]!;
    const one = cd({});
    expect(cd({ instanceCount: 2, instanceSeparation: 0.3 })).toBeGreaterThan(one);
    // Key-absence gate: no instance keys -> the kernel's own defaults, which
    // is the pre-v0.089 behaviour. instanceCount 0 clamps to 1 rather than
    // poisoning the kernel (setInstanceCount silently ignores <= 0).
    expect(cd({ instanceCount: 0 })).toBe(one);
  });

  it('the CG moves aft as instances march aft', () => {
    const cg1 = OrkRocket.buildTree(withButton({})).staticInfo().cgEmpty;
    const cg2 = OrkRocket.buildTree(withButton({ instanceCount: 2, instanceSeparation: 0.3 }))
      .staticInfo().cgEmpty;
    expect(cg2).toBeGreaterThan(cg1);
  });
});

/**
 * A3 — automatic-radius rings used to weigh EXACTLY NOTHING.
 *
 * ComponentFactory.create() built a component fully and only then attached it,
 * so a tube coupler / engine block / centering ring with an AUTOMATIC outer
 * radius met its setThickness/setInnerRadius while it was still parentless.
 * ThicknessRingComponent.getOuterRadius (:40-51) only resolves the automatic
 * radius when getParent() instanceof RadialParent, so parentless it returned
 * the raw 0 field, setThickness (:82-100) clamped the wall to clamp(t,0,0)=0,
 * and — because getThickness() was also 0 — the setter early-returned and the
 * wall stayed 0 forever. A zero-volume ring: 0 g. Desktop never hits it,
 * because importt/ComponentHandler.java:51 addChild's on element OPEN, before
 * ComponentParameterHandler applies any setter.
 *
 * These pin the BRIDGE ORDERING, not the arithmetic: pure buildTree +
 * componentInfo, no importer and no fixture. Measured against the shipped
 * kernel before the fix, every mass asserted below read exactly 0.
 */
describe('automatic-radius rings carry their wall thickness (A3)', () => {
  /**
   * One body tube, one of everything inside it, and NOT ONE explicit outer
   * radius — which is what the app's own UI produces, since schema.ts offers a
   * tube coupler and an engine block no radius field at all.
   *
   * The bulkhead is nested INSIDE the coupler on purpose: TubeCoupler is itself
   * a RadialParent (TubeCoupler.java:8, :50-52), so the bulkhead's automatic
   * radius is the coupler's INNER radius — which only exists once the coupler's
   * own wall has been set. It is the ordering guard.
   */
  const rings = (bodyOuterRadius: number): RocketTree => ({
    components: [{
      type: 'stage',
      children: [
        { type: 'nosecone', length: 0.07, aftRadius: bodyOuterRadius, thickness: 0.002,
          shape: 'ogive', density: 680 },
        {
          type: 'bodytube', length: 0.3, outerRadius: bodyOuterRadius, thickness: 0.0015,
          density: 680,
          children: [
            {
              type: 'tubecoupler', id: 'tc', length: 0.05, thickness: 0.0015, density: 680,
              children: [{ type: 'bulkhead', id: 'bh', length: 0.003, density: 680 }],
            },
            { type: 'centeringring', id: 'cr', length: 0.003, innerRadius: 0.0095, density: 680,
              position: { method: 'bottom', offset: 0 } },
            {
              type: 'innertube', id: 'it', length: 0.07, outerRadius: 0.0095, thickness: 0.0005,
              density: 680, position: { method: 'bottom', offset: 0 },
              children: [{ type: 'engineblock', id: 'eb', length: 0.005, thickness: 0.005,
                density: 680 }],
            },
          ],
        },
      ],
    }],
  });

  it('a tube coupler with no stated radius weighs its wall, not zero', () => {
    const r = OrkRocket.buildTree(rings(0.0245));
    // pi*(0.023^2 - 0.0215^2)*0.05*680 — the parent's inner radius, less the
    // 1.5 mm wall the node states. Read exactly 0 before the fix.
    expect(r.componentInfo('tc').mass).toBeCloseTo(0.007129844527322, 12);
  });

  it('an engine block with no stated radius weighs its wall, not zero', () => {
    const r = OrkRocket.buildTree(rings(0.0245));
    // Sized off the InnerTube it sits in (9.5 mm OR, 0.5 mm wall -> 9.0 mm
    // bore); the 5 mm wall clamps to that radius, leaving a 4 mm bore.
    // pi*(0.009^2 - 0.004^2)*0.005*680. Read exactly 0 before the fix, and
    // EVERY engine block the app or a .rkt import can produce is this case.
    expect(r.componentInfo('eb').mass).toBeCloseTo(0.000694291976443, 12);
  });

  it('a centering ring with no stated outer radius weighs its ring, not zero', () => {
    const r = OrkRocket.buildTree(rings(0.0245));
    // The second instance of the same trap, on the other setter:
    // RadiusRingComponent.setInnerRadius:95 froze the automatic outer radius AT
    // the 9.5 mm inner radius while the ring was parentless, so the ring had no
    // area. pi*(0.023^2 - 0.0095^2)*0.003*680.
    expect(r.componentInfo('cr').mass).toBeCloseTo(0.002811882504596, 12);
  });

  it('the automatic radius stays AUTOMATIC — a wider airframe grows the coupler', () => {
    const narrow = OrkRocket.buildTree(rings(0.0245)).componentInfo('tc').mass;
    const wide = OrkRocket.buildTree(rings(0.0345)).componentInfo('tc').mass;
    // A fix that froze the radius at build time would give the identical
    // number twice. pi*(0.033^2 - 0.0315^2)*0.05*680 on the 69 mm airframe.
    expect(wide).toBeCloseTo(0.010334269033984, 12);
    expect(wide).toBeGreaterThan(narrow);
  });

  it('a ring nested inside the coupler reads the coupler BORE, not its tube', () => {
    // The ordering guard, and the only assertion in the suite that would catch
    // the post-attach hook being moved after the recursive attachChildren.
    // The coupler's bore is 23 - 1.5 = 21.5 mm, so pi*0.0215^2*0.003*680.
    // Before the fix the coupler's wall was 0, so its bore read the full
    // 23 mm and this bulkhead measured 3.3903e-3 kg — a bulkhead 14 % too
    // heavy because its neighbour was 100 % too light.
    const r = OrkRocket.buildTree(rings(0.0245));
    expect(r.componentInfo('bh').mass).toBeCloseTo(0.002962490456409, 12);
  });

  it('an EXPLICIT outer radius is unchanged by the pre- to post-attach move', () => {
    // The regression guard. With a real radius in hand the clamps produce the
    // identical value on either side of parent.addChild, so these three numbers
    // are the same before and after the fix — and they are the same three the
    // automatic cases above resolve to.
    const tree = rings(0.0245);
    const tube = tree.components[0]!.children![1]!;
    tube.children![0]!.outerRadius = 0.023;
    tube.children![1]!.outerRadius = 0.023;
    tube.children![2]!.children![0]!.outerRadius = 0.009;
    const r = OrkRocket.buildTree(tree);
    expect(r.componentInfo('tc').mass).toBeCloseTo(0.007129844527322, 12);
    expect(r.componentInfo('cr').mass).toBeCloseTo(0.002811882504596, 12);
    expect(r.componentInfo('eb').mass).toBeCloseTo(0.000694291976443, 12);
    // The inner tube never had a way to be automatic, so its own wall — the one
    // call in this group whose move is behaviour-neutral by construction — must
    // still read pi*(0.0095^2 - 0.009^2)*0.07*680.
    expect(r.componentInfo('it').mass).toBeCloseTo(0.001383243245376, 12);
  });
});

/**
 * A5 — a tube fin set's WALL THICKNESS never reached the kernel.
 *
 * The "tubefinset" case set fin count, length, outer radius and rotation and
 * nothing else, so TubeFinSet.thickness stayed at its NaN default
 * (TubeFinSet.java:27) and BodyTube.addChild (:584-592) inherited the AIRFRAME's
 * wall into it. The box in the property panel, the number in the saved file and
 * the tube drawn in 2D/3D were three descriptions of a rocket the kernel was
 * not flying.
 *
 * The wall drives mass (getComponentVolume :285-293), both inertia terms
 * (:318, :336) AND normal force — TubeFinSetCalc.java:67 reads getInnerRadius()
 * into the aspect ratio at :82 and the CNa constant at :135 — so CP and static
 * margin move with it even where a mass override pins the mass.
 */
describe('tube fin wall thickness reaches the kernel (A5)', () => {
  const tubeFins = (bodyWall: number, fins: Record<string, unknown>): RocketTree => ({
    components: [{
      type: 'stage',
      children: [
        { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive',
          density: 680 },
        {
          type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: bodyWall, density: 950,
          children: [Object.assign(
            { type: 'tubefinset' as const, id: 'tf', finCount: 3, length: 0.1, density: 680,
              position: { method: 'bottom' as const, offset: 0 } },
            fins,
          )],
        },
      ],
    }],
  });

  it('a tube fin set own wall drives its mass, not the parent tube', () => {
    // 3 x 25 mm tubes, 100 mm long, 1 mm wall:
    // pi*(0.0125^2 - 0.0115^2)*0.1*3*680.
    const thin = OrkRocket.buildTree(tubeFins(0.0005, { outerRadius: 0.0125, thickness: 0.001 }));
    expect(thin.componentInfo('tf').mass).toBeCloseTo(0.015381237631976, 12);

    // THE WHOLE DEFECT IN ONE ASSERTION: quadruple the AIRFRAME's wall and the
    // tube fins must not move. Before the fix they read 0.0078508 kg on the
    // 0.5 mm airframe and 0.0294807 kg on the 2 mm one — a 3.75x spread from a
    // number the user never typed into this component.
    const thick = OrkRocket.buildTree(tubeFins(0.002, { outerRadius: 0.0125, thickness: 0.001 }));
    expect(thick.componentInfo('tf').mass).toBeCloseTo(thin.componentInfo('tf').mass, 12);
  });

  it('an AUTO-radius tube fin set gets its wall, not zero', () => {
    // The regression guard for the ordering trap, and the reason
    // applyTubeFinThickness exists instead of a line in create(). With no
    // outerRadius key the set is auto-radius (TubeFinSet.java:25) — which is
    // the app's OWN default, since schema.ts defaultsFor('tubefinset') supplies
    // no radius — so getOuterRadius() walks the parent for a touching radius
    // and returns 0 while parentless. A setThickness called there would clamp
    // the wall to 0 PERMANENTLY, and BodyTube.addChild's NaN rescue would not
    // fire either: strictly worse than the bug. The touching radius on a 12 mm
    // body with 3 tubes is 77.5692 mm, so this is
    // pi*(0.0775692^2 - 0.0765692^2)*0.1*3*680.
    const r = OrkRocket.buildTree(tubeFins(0.002, { thickness: 0.001 }));
    const mass = r.componentInfo('tf').mass;
    expect(mass).toBeCloseTo(0.098784998118339, 11);
    expect(mass).toBeGreaterThan(0);                 // a pre-attach setThickness gives exactly 0
    expect(mass).not.toBeCloseTo(0.19628822643, 6);  // the airframe's 2 mm wall, i.e. the old bug
  });

  it('a tube fin set with no wall stated still inherits the parent tube', () => {
    // Desktop parity, and the guard against the helper writing a default of its
    // own: with no "thickness" key BodyTube.addChild's inherit (:584-592) must
    // stand, exactly as it does for a desktop set that was never given one.
    // pi*(0.0125^2 - 0.0117^2)*0.1*3*680 off the 0.8 mm airframe. This one
    // reads the same before and after the fix.
    const r = OrkRocket.buildTree(tubeFins(0.0008, { outerRadius: 0.0125 }));
    expect(r.componentInfo('tf').mass).toBeCloseTo(0.012407531689794, 12);
  });

  it('the wall changes the tube fins NORMAL FORCE too, not just their mass', () => {
    // Mass alone does not pin TubeFinSetCalc: CNa is driven by the INNER radius
    // (:67 -> :82, :135), so a future refactor could fix the mass by another
    // route and leave the aerodynamics reading the airframe's wall. On the
    // auto-radius set above the wall moves CNa 487.0655 -> 496.7775 and CP
    // 0.293922 -> 0.293943 m.
    const info = OrkRocket.buildTree(tubeFins(0.002, { thickness: 0.001 })).staticInfo();
    expect(info.cna).toBeCloseTo(496.777534, 4);
    expect(info.cna).not.toBeCloseTo(487.065515, 2);
    expect(info.cp).toBeCloseTo(0.293942608, 8);
  });
});

/**
 * C7 — a stubby non-conical nose is no longer charged ZERO subsonic pressure drag.
 *
 * Upstream 24.12 routes ELLIPSOID / POWER / PARABOLIC / HAACK to stored fineness-3
 * tables whose non-blunt entries all START at their drag-divergence Mach with the
 * value 0. The fineness extrapolation is multiplicative so it maps 0 to 0, and the
 * subsonic fit is then skipped outright by `if (minValue < 0.001) return;` — after
 * which LinearInterpolator clamps flat to the leading zero. Net effect: shortening
 * a Von Karman, Haack, parabolic or power nose made the app's drag go DOWN, because
 * the only thing shortening changed was wetted area.
 *
 * The floor is calibrated on Centuri TIR-100 section 8 (Mercer's 12-shape Javelin
 * series, L/D 4.0 to 0) corroborated by DeMar NARAM-37, and tapers to nothing by
 * L/D 1.8 where that tunnel measures no shape effect at all. See
 * SymmetricComponentCalc.applyStubbyNoseFloor for the derivation and the caveats.
 */
describe('stubby non-conical noses carry subsonic pressure drag (C7)', () => {
  /** A nose of the given shape and fineness on a plain body tube. */
  const rocket = (shape: string, fineness: number, shapeParameter?: number): RocketTree => {
    const r = 0.0285750;
    return {
      name: 'nose',
      components: [{
        type: 'stage', id: 's', children: [
          {
            id: 'n', type: 'nosecone', shape, length: fineness * 2 * r,
            aftRadius: r, thickness: 0.002,
            ...(shapeParameter === undefined ? {} : { shapeParameter }),
          },
          { id: 'b', type: 'bodytube', length: 0.6, outerRadius: r, thickness: 0.001 },
        ],
      }],
    } as unknown as RocketTree;
  };

  /**
   * Isolated-nose pressure Cd at M0.3. A body tube contributes no pressure drag and
   * for a nose frontalArea == refArea, so powerOff.pressure IS the nose term.
   */
  const nosePressure = (shape: string, fineness: number, kbf: boolean, param?: number) => {
    const built = OrkRocket.buildTree(rocket(shape, fineness, param));
    built.setRogersModifiedBarrowman(kbf);
    return built.dragSweep({ machMin: 0.3, machMax: 0.3, machStep: 1 }).powerOff.pressure[0]!;
  };

  it('charges a stubby Von Karman, Haack, parabolic and power nose instead of zero', () => {
    // Every one of these reads EXACTLY 0.000000 before the fix, at every fineness.
    for (const [shape, param] of [
      ['haack', 0], ['haack', 1 / 3], ['parabolic', 1], ['power', 0.5],
    ] as const) {
      const cd = nosePressure(shape, 0.5, true, param);
      expect(cd, `${shape} ${param} at L/D 0.5`).toBeGreaterThan(0.05);
      expect(cd, `${shape} ${param} at L/D 0.5`).toBeLessThan(0.2);
    }
  });

  it('is ZERO above L/D 1.8, so no ordinary nose moves at all', () => {
    // TIR-100 measures no shape or fineness effect above ~L/D 1.8 and says so.
    // A 3:1 Von Karman is the commonest high-power nose there is; it must not move.
    for (const f of [1.8, 2.0, 3.0, 5.0]) {
      expect(nosePressure('haack', f, true, 0), `VK at L/D ${f}`).toBeCloseTo(0, 9);
    }
  });

  it('never charges a table shape more than a CONE of the same fineness', () => {
    // The floor is 1/3 of the conical value by construction, so the ellipsoid-above-
    // a-cone inversion the Newtonian candidate produced cannot happen here.
    for (const f of [0.5, 0.75, 1.0, 1.5]) {
      const cone = nosePressure('conical', f, true);
      for (const [shape, param] of [['haack', 0], ['ellipsoid', undefined]] as const) {
        expect(nosePressure(shape, f, true, param), `${shape} vs cone at L/D ${f}`)
          .toBeLessThan(cone);
      }
    }
  });

  it('rises as the nose gets stubbier, and the rocket gets DRAGGIER not lighter', () => {
    // The symptom this item is about: shortening a VK used to REDUCE total drag.
    const long = nosePressure('haack', 3, true, 0);
    const mid = nosePressure('haack', 1, true, 0);
    const stub = nosePressure('haack', 0.5, true, 0);
    expect(long).toBeCloseTo(0, 9);
    expect(mid).toBeGreaterThan(long);
    expect(stub).toBeGreaterThan(mid);
  });

  it('leaves the CLASSIC model bit-identical to desktop 24.12', () => {
    // Gated rogersKbf || supersonicAero, the 2026-08-27 ruling. Classic is the
    // parity model and must not move.
    for (const f of [0.5, 1.0]) {
      expect(nosePressure('haack', f, false, 0), `classic VK at L/D ${f}`).toBeCloseTo(0, 9);
    }
  });

  it('lands where the measurement says: ~0.12 at L/D 0.5', () => {
    // (1/3) x 0.8/(1+4*0.25) x (1 - (0.5/1.8)^2) = 0.12305.
    // Bracketed by TIR-100 + DeMar (a hemisphere at that fineness measures +0.02 to
    // +0.10 whole-rocket, plus an unquantified friction credit) and @Buckeye's CFD
    // (~27 % of a CD-0.5 rocket). The rejected Newtonian floor gave 0.270-0.421.
    expect(nosePressure('haack', 0.5, true, 0)).toBeCloseTo(0.12305, 4);
  });
});
