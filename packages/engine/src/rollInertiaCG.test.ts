import { describe, expect, it } from 'vitest';
import { OrkRocket, type ComponentNode, type MotorSpec, type RocketTree } from './orkEngine.js';

// All dimensions SI. Independent annulus/solid-cylinder arithmetic, not kernel goldens.
const R = 0.049, RI = R - 0.0012, L = 0.9, RO = 0.0155, RT = 0.015, D = 0.03;
const tubeMass = Math.PI * (RO ** 2 - RT ** 2) * 0.2 * 1000;
const bodyMass = Math.PI * (R ** 2 - RI ** 2) * L * 950;
const motor: MotorSpec = {
  designation: 'CG29', diameter: 0.029, length: 0.2, cgX: 0.1, ejectionDelay: 8,
  times: [0, 0.05, 1.9, 2], thrusts: [0, 160, 160, 0], masses: [0.35, 0.345, 0.155, 0.15],
};
const mount = (id: string, extra: Partial<ComponentNode> = {}): ComponentNode => ({
  type: 'innertube', id, length: 0.2, outerRadius: RO, thickness: RO - RT, density: 1000,
  motorMount: true, position: { method: 'bottom', offset: 0 }, ...extra,
});
const body = (children: ComponentNode[], extra: Partial<ComponentNode> = {}): ComponentNode => ({
  type: 'bodytube', id: 'body', length: L, outerRadius: R, thickness: R - RI, density: 950,
  children, ...extra,
});
const design = (children: ComponentNode[]): RocketTree => ({ components: [body(children)] });
type Piece = { mass: number; own: number; y: number; z: number };
const shell: Piece = { mass: bodyMass, own: bodyMass * (R ** 2 + RI ** 2) / 2, y: 0, z: 0 };
const tube = (y: number, z = 0): Piece => ({ mass: tubeMass, own: tubeMass * (RO ** 2 + RT ** 2) / 2, y, z });
const engine = (mass: number, y: number, z = 0): Piece => ({ mass, own: mass * (motor.diameter / 2) ** 2 / 2, y, z });
const roll = (pieces: Piece[]): number => {
  const mass = pieces.reduce((sum, p) => sum + p.mass, 0);
  const y = pieces.reduce((sum, p) => sum + p.mass * p.y, 0) / mass;
  const z = pieces.reduce((sum, p) => sum + p.mass * p.z, 0) / mass;
  return pieces.reduce((sum, p) => sum + p.own + p.mass * ((p.y - y) ** 2 + (p.z - z) ** 2), 0);
};
// 1e-10 relative admits rounding in analytic geometry vs kernel evaluation; 1e-14
// kg m^2 absolute protects near-zero comparisons without hiding the 1e-7 dry defect.
const near = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(Math.max(1e-14, Math.abs(expected) * 1e-10));
function loaded(tree: RocketTree, ids = ['m'], spec = motor): OrkRocket {
  const rocket = OrkRocket.buildTree(tree);
  for (const id of ids) rocket.setMotorById(id, spec);
  return rocket;
}

describe('roll about the true radial CG', () => {
  it.each([0, Math.PI / 2, 0.73])('matches a complete cylinder calculation at azimuth %s', (angle) => {
    const y = D * Math.cos(angle), z = D * Math.sin(angle);
    const tree = design([mount('m', { radialPosition: D, radialDirection: angle })]);
    const info = loaded(tree).staticInfo();
    near(info.mass, bodyMass + tubeMass + 0.35);
    near(info.rotationalInertiaEmpty, roll([shell, tube(y, z)]));
    near(info.rotationalInertia, roll([shell, tube(y, z), engine(0.35, y, z)]));
    const burnout = loaded(tree, ['m'], { ...motor, masses: motor.masses.map(() => 0.15) }).staticInfo();
    near(burnout.rotationalInertia, roll([shell, tube(y, z), engine(0.15, y, z)]));
    const centred = loaded(design([mount('m')])).staticInfo();
    near(info.longitudinalInertia, centred.longitudinalInertia);
    near(info.longitudinalInertiaEmpty, centred.longitudinalInertiaEmpty);
    near(info.cg, centred.cg);
  });

  it('uses unequal first moments for opposing mounts', () => {
    const tree = design([mount('a', { radialPosition: D }), mount('b', { radialPosition: D, radialDirection: Math.PI })]);
    const r = loaded(tree, ['a']);
    r.setMotorById('b', { ...motor, masses: motor.masses.map(m => m / 2) });
    near(r.staticInfo().rotationalInertia, roll([shell, tube(D), tube(-D), engine(0.35, D), engine(0.175, -D)]));
  });

  it('centres a translated cluster without losing its internal spread', () => {
    const r = loaded(design([mount('m', { cluster: 'double', clusterScale: 1, radialPosition: D })]));
    near(r.staticInfo().rotationalInertia,
      roll([shell, tube(D - RO), tube(D + RO), engine(0.35, D - RO), engine(0.35, D + RO)]));
    near(r.staticInfo().rotationalInertiaEmpty, roll([shell, tube(D - RO), tube(D + RO)]));
  });

  it.each([1, 2])('composes a displaced mount inside %s clocked pods, invariant under whole-design rotation', (count) => {
    for (const angle of [0, 0.61, Math.PI / 2]) {
      // A massless pod shell isolates the tube/motor transform and nested cross term.
      const pod: ComponentNode = { type: 'podset', instanceCount: count, radiusMethod: 'free', radiusOffset: 0.08,
        angleOffset: angle, children: [{ type: 'bodytube', length: 0.3, outerRadius: 0.04, thickness: 0,
          children: [mount('m', { radialPosition: 0.02, radialDirection: 0.4 })] }] };
      const pieces: Piece[] = [shell];
      for (let i = 0; i < count; i++) {
        const phi = angle + 2 * Math.PI * i / count;
        const y = 0.08 * Math.cos(phi) + 0.02 * Math.cos(phi + 0.4);
        const z = 0.08 * Math.sin(phi) + 0.02 * Math.sin(phi + 0.4);
        pieces.push(tube(y, z), engine(0.35, y, z));
      }
      near(loaded(design([pod])).staticInfo().rotationalInertia, roll(pieces));
    }
  });

  it('carries rotation through two levels of displaced pods', () => {
    const alpha = 0.7, beta = 0.4, gamma = -0.3;
    const inner: ComponentNode = { type: 'podset', instanceCount: 1, radiusMethod: 'free', radiusOffset: 0.06,
      angleOffset: beta, children: [{ type: 'bodytube', length: 0.3, outerRadius: 0.04, thickness: 0,
        children: [mount('m', { radialPosition: 0.02, radialDirection: gamma })] }] };
    const outer: ComponentNode = { type: 'podset', instanceCount: 1, radiusMethod: 'free', radiusOffset: 0.08,
      angleOffset: alpha, children: [{ type: 'bodytube', length: 0.4, outerRadius: 0.04, thickness: 0, children: [inner] }] };
    const y = 0.08 * Math.cos(alpha) + 0.06 * Math.cos(alpha + beta) + 0.02 * Math.cos(alpha + beta + gamma);
    const z = 0.08 * Math.sin(alpha) + 0.06 * Math.sin(alpha + beta) + 0.02 * Math.sin(alpha + beta + gamma);
    const actual = loaded(design([outer])).staticInfo();
    // Legacy structure traversal rotated the inner pod displacement; legacy
    // motor traversal did not. Preserve BOTH old references for pitch/yaw.
    const legacy = (motorMass: number) => {
      const parts = [
        { mass: bodyMass, own: bodyMass * (3 * (R ** 2 + RI ** 2) + L ** 2) / 12, x: 0.45, z: 0 },
        { mass: tubeMass, own: tubeMass * (3 * (RO ** 2 + RT ** 2) + 0.2 ** 2) / 12,
          x: 0.8, z: 0.08 * Math.sin(alpha) + 0.06 * Math.sin(alpha + beta) },
        { mass: motorMass, own: motorMass * (3 * (motor.diameter / 2) ** 2 + 0.2 ** 2) / 12,
          x: 0.8, z: 0.08 * Math.sin(alpha) + 0.06 * Math.sin(beta) },
      ];
      const mass = bodyMass + tubeMass + motorMass;
      const xCM = parts.reduce((sum, p) => sum + p.mass * p.x, 0) / mass;
      const zCM = parts.reduce((sum, p) => sum + p.mass * p.z, 0) / mass;
      return parts.reduce((sum, p) => sum + p.own + p.mass * ((p.x - xCM) ** 2 + (p.z - zCM) ** 2), 0);
    };
    near(actual.longitudinalInertia, legacy(0.35));
    near(actual.longitudinalInertiaEmpty, legacy(0));
    near(actual.rotationalInertia, roll([shell, tube(y, z), engine(0.35, y, z)]));
    near(actual.rotationalInertiaEmpty, roll([shell, tube(y, z)]));
  });

  it('retains the legacy transverse reference for clocked pod motors', () => {
    const angle = 0.61, distance = 0.08;
    const pod: ComponentNode = { type: 'podset', instanceCount: 2, radiusMethod: 'free', radiusOffset: distance,
      angleOffset: angle, children: [{ type: 'bodytube', length: 0.3, outerRadius: 0.04, thickness: 0,
        children: [mount('m', { radialPosition: 0.02, radialDirection: 0.4 })] }] };
    const actual = loaded(design([pod])).staticInfo();
    const legacyPitch = (motorMass: number) => {
      const movingMass = 2 * (tubeMass + motorMass);
      const cg = (bodyMass * 0.45 + movingMass * 0.8) / (bodyMass + movingMass);
      const bodyOwnPitch = bodyMass * (3 * (R ** 2 + RI ** 2) + L ** 2) / 12;
      const tubeOwnPitch = tubeMass * (3 * (RO ** 2 + RT ** 2) + 0.2 ** 2) / 12;
      const motorOwnPitch = motorMass * (3 * (motor.diameter / 2) ** 2 + 0.2 ** 2) / 12;
      return bodyOwnPitch + bodyMass * (0.45 - cg) ** 2 + 2 * (tubeOwnPitch + motorOwnPitch)
        + movingMass * ((0.8 - cg) ** 2 + (distance * Math.sin(angle)) ** 2);
    };
    near(actual.longitudinalInertia, legacyPitch(0.35));
    near(actual.longitudinalInertiaEmpty, legacyPitch(0));
  });

  it.each(['stage', 'bodytube'] as const)('scales a %s subtree while preserving its radial centroid', (type) => {
    for (const k of [0.5, 2]) {
      const extra = { overrideMass: (bodyMass + tubeMass) * k, overrideSubcomponentsMass: true, overrideCGX: 0.2 };
      const contents = [mount('m', { radialPosition: D })];
      const tree: RocketTree = { components: type === 'stage'
        ? [{ type, ...extra, children: [body(contents)] }] : [body(contents, extra)] };
      const scaled = [shell, tube(D)].map(p => ({ ...p, mass: p.mass * k, own: p.own * k }));
      const info = loaded(tree).staticInfo();
      near(info.rotationalInertiaEmpty, roll(scaled));
      near(info.rotationalInertia, roll([...scaled, engine(0.35, D)]));
      near(info.massEmpty, (bodyMass + tubeMass) * k);
    }
  });

  it('preserves axial CG override transport in the transverse model', () => {
    const bodyPitch = bodyMass * (3 * (R ** 2 + RI ** 2) + L ** 2) / 12;
    const tubePitch = tubeMass * (3 * (RO ** 2 + RT ** 2) + 0.2 ** 2) / 12;
    const dryMass = bodyMass + tubeMass;
    const contents = [mount('m', { radialPosition: D })];
    const shiftedStage = OrkRocket.buildTree({ components: [{ type: 'stage', overrideCGX: 0.2,
      overrideSubcomponentsCG: true, children: [body(contents)] }] }).staticInfo();
    near(shiftedStage.cg, 0.2);
    near(shiftedStage.longitudinalInertiaEmpty,
      bodyPitch + tubePitch + bodyMass * (0.45 - 0.2) ** 2 + tubeMass * (0.8 - 0.2) ** 2);

    const otherMass = Math.PI * (0.025 ** 2 - 0.024 ** 2) * 0.3 * 1000;
    const otherPitch = otherMass * (3 * (0.025 ** 2 + 0.024 ** 2) + 0.3 ** 2) / 12;
    const originalPitch = bodyPitch + tubePitch + bodyMass * tubeMass / dryMass * (0.8 - 0.45) ** 2;
    const shiftedParent = OrkRocket.buildTree({ components: [
      body(contents, { overrideMass: 2 * dryMass, overrideSubcomponentsMass: true, overrideCGX: 0.2 }),
      { type: 'bodytube', length: 0.3, outerRadius: 0.025, thickness: 0.001, density: 1000 },
    ] }).staticInfo();
    near(shiftedParent.longitudinalInertiaEmpty, 2 * originalPitch + otherPitch
      + 2 * dryMass * otherMass / (2 * dryMass + otherMass) * (1.05 - 0.2) ** 2);
  });

  it('keeps an unflagged assembly override as a point mass at the subtree CG', () => {
    const base = OrkRocket.buildTree(design([mount('m', { radialPosition: D })])).staticInfo();
    const info = OrkRocket.buildTree({ components: [{ type: 'stage', overrideMass: 0.2,
      children: [body([mount('m', { radialPosition: D })])] }] }).staticInfo();
    near(info.rotationalInertiaEmpty, roll([shell, tube(D)]));
    near(info.massEmpty, base.massEmpty + 0.2);
  });

  it('uses geometric cluster centroids when a mass override replaces zero material mass', () => {
    const total = 0.2;
    const tree = design([mount('m', { cluster: 'double', radialPosition: D, thickness: 0, overrideMass: total })]);
    const actual = OrkRocket.buildTree(tree).staticInfo();
    const pieces = [D - RO, D + RO].map(y => ({ mass: total / 2, own: total / 2 * RO ** 2, y, z: 0 }));
    near(actual.rotationalInertiaEmpty, roll([shell, ...pieces]));
    near(actual.massEmpty, bodyMass + total);
  });

  it('keeps a massless overridden subtree finite and does not retain child bodies', () => {
    for (const overrideMass of [0, 0.2]) {
      const info = OrkRocket.buildTree({ components: [{ type: 'stage', overrideMass, overrideSubcomponentsMass: true,
        children: [body([mount('m', { thickness: 0, radialPosition: D })], { thickness: 0 })] }] }).staticInfo();
      near(info.massEmpty, overrideMass);
      expect(info.rotationalInertiaEmpty).toBe(0);
      expect(info.longitudinalInertiaEmpty).toBe(0);
    }
  });

  it('does not subtract the centroid twice from already-correct off-axis ballast', () => {
    const ballast: Piece = { mass: 0.25, own: 0.25 * 0.006 ** 2 / 2, y: D, z: 0 };
    const info = OrkRocket.buildTree(design([{ type: 'masscomponent', mass: 0.25, length: 0.03,
      radius: 0.006, radialPosition: D }])).staticInfo();
    near(info.rotationalInertiaEmpty, roll([shell, ballast]));
  });
});

function flightTree(offset: number, cant: number, crossSection: string): RocketTree {
  return { components: [
    { type: 'nosecone', length: 0.25, aftRadius: R, thickness: 0.002 },
    body([mount('m', { radialPosition: offset }),
      { type: 'freeformfinset', finCount: 4, thickness: 0.003, cant, crossSection,
        points: [[0, 0], [0.07, 0.09], [0.14, 0.09], [0.14, 0]], position: { method: 'bottom', offset: 0 } },
    ]),
  ] };
}
const massAt = (time: number): number => {
  if (time <= 0) return motor.masses[0]!;
  for (let i = 1; i < motor.times.length; i++) {
    if (time <= motor.times[i]!) {
      const f = (time - motor.times[i - 1]!) / (motor.times[i]! - motor.times[i - 1]!);
      return motor.masses[i - 1]! * (1 - f) + motor.masses[i]! * f;
    }
  }
  return motor.masses.at(-1)!;
};

describe('flight composition uses the current motor mass', () => {
  it.each(['rounded', 'airfoil'])('reports analytic Ir(t) with delayed ignition and %s freeform fins', (crossSection) => {
    const r = loaded(flightTree(D, 0.02, crossSection));
    const dry = r.staticInfo();
    r.setMotorIgnitionById('m', 'launch', 0.3);
    const f = r.simulate({ launchRodLength: 1.5, maxTime: 2.8, series: 'full' });
    const ignition = f.events.find(e => e.type === 'IGNITION');
    expect(ignition).toBeDefined();
    near(ignition!.time, 0.3);
    const values = f.series['Ir']!;
    expect(values).toBeDefined();
    let burning = 0, spent = 0;
    for (let i = 0; i < f.series.time.length; i++) {
      const t = f.series.time[i]!;
      if (t == null || values[i] == null) continue;
      const motorTime = t - ignition!.time;
      const m = massAt(motorTime);
      const dryCG = tubeMass * D / dry.massEmpty;
      const expected = dry.rotationalInertiaEmpty + m * (motor.diameter / 2) ** 2 / 2
        + dry.massEmpty * m / (dry.massEmpty + m) * (D - dryCG) ** 2;
      near(values[i]!, expected);
      if (motorTime > 0.1 && motorTime < 1.8) burning++;
      if (motorTime > 2.05) spent++;
    }
    expect(burning).toBeGreaterThan(10);
    expect(spent).toBeGreaterThan(5);
    expect(Math.max(...f.series['dΦ']!.map(v => Math.abs(v ?? 0)))).toBeGreaterThan(1);
  }, 60000);

  it('preserves an uncanted rail-constrained trajectory with zero initial roll and zero roll torque', () => {
    const on = loaded(flightTree(0, 0, 'rounded'));
    const off = loaded(flightTree(D, 0, 'rounded'));
    expect(off.staticInfo().rotationalInertia).toBeGreaterThan(on.staticInfo().rotationalInertia);
    // Keep the entire control on the rail: the free-flight stepper intentionally
    // injects pitch/yaw noise, which can seed roll even without fin cant.
    const opts = { launchRodLength: 100, maxTime: 0.7, series: 'full' as const, windAverage: 0, windStdDeviation: 0 };
    const a = on.simulate(opts), b = off.simulate(opts);
    near(a.summary.maxAltitude, b.summary.maxAltitude);
    near(a.summary.maxVelocity, b.summary.maxVelocity);
    expect(Math.max(...b.series['dΦ']!.map(v => Math.abs(v ?? 0)))).toBeLessThan(1e-12);
  }, 60000);
});
