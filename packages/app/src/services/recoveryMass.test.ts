// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import { engineTree, motorMounts, stageIndexOf, stages } from '../tree/treeModel.js';
import { importOrk } from './orkFile.js';
import { importCdx1 } from './rasaeroFile.js';
import {
  motorBurnoutMass, motorPropellantMass, recoveryMass, recoveryMassTitle,
} from './recoveryMass.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): ArrayBuffer => {
  const buf = readFileSync(join(here, '__fixtures__', name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

/**
 * An Estes C6-shaped curve: 21 g on the pad, 9 g of casing and clay left.
 * 12 g of that is propellant, and 12 g is the whole point of this file — it is
 * the difference between the mass on the pad and the mass under the chute.
 */
const C6 = (): MotorSpec => ({
  designation: 'C6',
  diameter: 0.018,
  length: 0.07,
  cgX: 0.035,
  ejectionDelay: 5,
  times: [0, 0.05, 0.1, 0.4, 1.0, 2.0, 2.5],
  thrusts: [0, 3.8, 11.75, 4.0, 3.2, 3.0, 0],
  masses: [0.021, 0.02, 0.019, 0.016, 0.012, 0.01, 0.009],
});

const PROPELLANT = 0.021 - 0.009;
const BURNOUT = 0.009;

const singleStage = (mount: Partial<ComponentNode> = {}): RocketTree => ({
  name: 'single',
  components: [{
    type: 'stage', id: 's1', name: 'Sustainer',
    children: [
      { type: 'nosecone', id: 'n1', length: 0.1, aftRadius: 0.025, thickness: 0.002 } as ComponentNode,
      {
        type: 'bodytube', id: 'b1', length: 0.4, outerRadius: 0.025, thickness: 0.0005, density: 950,
        children: [
          {
            type: 'trapezoidfinset', id: 'f1', finCount: 3, rootChord: 0.07, tipChord: 0.04,
            sweep: 0.03, height: 0.04, thickness: 0.003, position: { method: 'bottom', offset: 0 },
          } as ComponentNode,
          {
            type: 'innertube', id: 'm1', length: 0.08, outerRadius: 0.0095, thickness: 0.0005,
            motorMount: true, position: { method: 'bottom', offset: 0 }, ...mount,
          } as ComponentNode,
          { type: 'parachute', id: 'p1', diameter: 0.45 } as ComponentNode,
        ],
      } as ComponentNode,
    ],
  } as ComponentNode],
});

const twoStage = (): RocketTree => ({
  name: 'two',
  components: [
    singleStage().components[0]!,
    {
      type: 'stage', id: 's2', name: 'Booster',
      children: [{
        type: 'bodytube', id: 'b2', length: 0.5, outerRadius: 0.025, thickness: 0.0005, density: 950,
        children: [{
          type: 'innertube', id: 'm2', length: 0.08, outerRadius: 0.0095, thickness: 0.0005,
          motorMount: true, position: { method: 'bottom', offset: 0 },
        } as ComponentNode],
      } as ComponentNode],
    } as ComponentNode,
  ],
});

/**
 * Build a tree on the REAL kernel and answer through the real componentInfo.
 *
 * Every number in this file comes back through the shipped orkengine.mjs
 * rather than out of hand arithmetic: this repo has been bitten more than once
 * by a test that asserted a node field the kernel then ignored.
 */
async function onKernel(tree: RocketTree, motors: Record<string, MotorSpec>) {
  const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
  resetEngine();
  const rocket = OrkRocket.buildTree(engineTree(tree));
  for (const [id, spec] of Object.entries(motors)) rocket.setMotorById(id, spec);
  const info = rocket.staticInfo();
  const sectionMass = (id: string): number | null => {
    try {
      const v = rocket.componentInfo(id).sectionMass;
      return Number.isFinite(v) ? v : null;
    } catch { return null; }
  };
  const answer = recoveryMass({
    tree,
    info,
    motors: Object.keys(motors).map((id) => [id, { spec: motors[id]! }] as const),
    sectionMass,
  });
  return { rocket, info, sectionMass, answer };
}

describe('recovery weight — the kernel facts it rests on', () => {
  it('a stage carries NO mass of its own, but its sectionMass is its dry subtree', async () => {
    const { info, rocket } = await onKernel(twoStage(), { m1: C6(), m2: C6() });
    // Both of these are load-bearing: recoveryMass() would silently answer 0
    // for every booster if `mass` were used where `sectionMass` is.
    expect(rocket.componentInfo('s1').mass).toBe(0);
    expect(rocket.componentInfo('s2').mass).toBe(0);
    const s1 = rocket.componentInfo('s1').sectionMass;
    const s2 = rocket.componentInfo('s2').sectionMass;
    expect(s1).toBeGreaterThan(0);
    expect(s2).toBeGreaterThan(0);
    // The per-stage section masses sum to massEmpty to the last bit — that is
    // what lets the sustainer be derived as massEmpty − Σ(boosters).
    expect(s1 + s2).toBeCloseTo(info.massEmpty, 12);
    // …and they are DRY: the two C6s are the whole of the loaded/empty gap.
    expect(info.mass - info.massEmpty).toBeCloseTo(2 * 0.021, 12);
  });

  it('staticInfo.mass is cluster-aware, so the propellant subtracted must be too', async () => {
    const { info, answer } = await onKernel(singleStage({ cluster: '4-ring' }), { m1: C6() });
    expect(info.mass - info.massEmpty).toBeCloseTo(4 * 0.021, 12);
    expect(answer.state).toBe('ok');
    if (answer.state !== 'ok') return;
    // Four casings come down, not one.
    expect(answer.mass).toBeCloseTo(info.massEmpty + 4 * BURNOUT, 12);
    expect(answer.mass).toBeCloseTo(info.mass - 4 * PROPELLANT, 12);
  });
});

describe('recovery weight — single stage', () => {
  it('is the dry rocket plus the SPENT casing, strictly between empty and loaded', async () => {
    const { info, answer } = await onKernel(singleStage(), { m1: C6() });
    expect(answer.state).toBe('ok');
    if (answer.state !== 'ok') return;
    expect(answer.multiStage).toBe(false);
    expect(answer.mass).toBeCloseTo(info.mass - PROPELLANT, 12);
    expect(answer.mass).toBeCloseTo(info.massEmpty + BURNOUT, 12);
    // The whole point: neither of the two masses the strip already showed.
    expect(answer.mass).toBeGreaterThan(info.massEmpty);
    expect(answer.mass).toBeLessThan(info.mass);
  });

  it('two mounts in one stage both give up their propellant', async () => {
    const tree = singleStage();
    // A second mount in the same body tube (a side-by-side pair).
    const body = tree.components[0]!.children![1]!;
    body.children!.push({
      type: 'innertube', id: 'm9', length: 0.08, outerRadius: 0.0095, thickness: 0.0005,
      motorMount: true, position: { method: 'bottom', offset: 0.09 },
    } as ComponentNode);
    const { info, answer } = await onKernel(tree, { m1: C6(), m9: C6() });
    expect(answer.state).toBe('ok');
    if (answer.state !== 'ok') return;
    expect(answer.mass).toBeCloseTo(info.mass - 2 * PROPELLANT, 12);
  });

  it('shows nothing at all until a motor is loaded', async () => {
    const { answer } = await onKernel(singleStage(), {});
    expect(answer.state).toBe('no-motor');
    expect(recoveryMassTitle(answer)).toMatch(/Load a motor/);
  });

  it('a design with NO recovery device still answers — that is when you are shopping for one', async () => {
    const tree = singleStage();
    const body = tree.components[0]!.children![1]!;
    body.children = body.children!.filter((c) => c.type !== 'parachute');
    const { info, answer } = await onKernel(tree, { m1: C6() });
    expect(answer.state).toBe('ok');
    if (answer.state !== 'ok') return;
    expect(answer.mass).toBeCloseTo(info.mass - PROPELLANT, 12);
  });
});

describe('recovery weight — serial multi-stage', () => {
  it('is the SUSTAINER alone, not the stack minus propellant', async () => {
    const { info, sectionMass, answer } = await onKernel(twoStage(), { m1: C6(), m2: C6() });
    expect(answer.state).toBe('ok');
    if (answer.state !== 'ok') return;
    expect(answer.multiStage).toBe(true);

    const sustainerDry = sectionMass('s1')!;
    expect(answer.mass).toBeCloseTo(sustainerDry + BURNOUT, 12);

    // The number we deliberately did NOT show: the whole stack less all its
    // propellant is the mass of no object that ever exists in the flight.
    const wholeStackMinusPropellant = info.mass - 2 * PROPELLANT;
    expect(answer.mass).toBeLessThan(wholeStackMinusPropellant - 0.02);
    // …and it is below the dry mass of the whole rocket, which is exactly what
    // "the booster is already on the ground" means.
    expect(answer.mass).toBeLessThan(info.massEmpty);
  });

  it('a booster motor is NOT counted — its casing lands with the booster', async () => {
    const both = await onKernel(twoStage(), { m1: C6(), m2: C6() });
    const sustainerOnly = await onKernel(twoStage(), { m1: C6() });
    expect(both.answer.state).toBe('ok');
    expect(sustainerOnly.answer.state).toBe('ok');
    if (both.answer.state !== 'ok' || sustainerOnly.answer.state !== 'ok') return;
    expect(both.answer.mass).toBeCloseTo(sustainerOnly.answer.mass, 12);
  });

  it('is cluster-aware on the sustainer', async () => {
    const tree = twoStage();
    (tree.components[0]!.children![1]!.children![1] as ComponentNode)['cluster'] = '3-ring';
    const { sectionMass, answer } = await onKernel(tree, { m1: C6(), m2: C6() });
    expect(answer.state).toBe('ok');
    if (answer.state !== 'ok') return;
    expect(answer.mass).toBeCloseTo(sectionMass('s1')! + 3 * BURNOUT, 12);
  });

  it('refuses rather than guessing when a strap-on booster separates', async () => {
    const tree = twoStage();
    tree.components[0]!.children![1]!.children!.push({
      type: 'parallelstage', id: 'ps1', name: 'Strap-on', instanceCount: 2,
      radiusOffset: 0, radiusMethod: 'relative', angleOffset: 0,
      children: [{
        type: 'bodytube', id: 'pb1', length: 0.25, outerRadius: 0.012, thickness: 0.0005,
        density: 950,
      } as ComponentNode],
    } as ComponentNode);
    const { answer } = await onKernel(tree, { m1: C6() });
    expect(answer.state).toBe('unavailable');
    if (answer.state !== 'unavailable') return;
    expect(answer.reason).toMatch(/strap-on/i);
    expect(recoveryMassTitle(answer)).toMatch(/unavailable/i);
  });
});

describe('recovery weight — degenerate motor curves', () => {
  it('a curve with no mass column falls back to the FULL motor (heavy, the safe way)', () => {
    // NOT run through the kernel on purpose: measured here, setMotorById on a
    // masses:[] spec dies inside the TeaVM Long conversion ("The number NaN
    // cannot be converted to a BigInt"), so this shape can never reach the
    // tile through the app. The guard exists so a future motor source that
    // slips one past does not produce a silently light rocket.
    const flat = { masses: [] as number[] };
    expect(motorPropellantMass(flat)).toBe(0);
    expect(motorBurnoutMass(flat)).toBeNull();
    const answer = recoveryMass({
      tree: singleStage(),
      info: { mass: 0.13, massEmpty: 0.109 },
      motors: [['m1', { spec: { ...C6(), masses: [] } }]],
      sectionMass: () => null,
    });
    expect(answer.state).toBe('ok');
    if (answer.state !== 'ok') return;
    // Nothing subtracted: the whole motor is assumed to come down.
    expect(answer.mass).toBeCloseTo(0.13, 12);
  });

  it('a constant mass column burns no propellant', async () => {
    const constant = { ...C6(), masses: C6().masses.map(() => 0.021) };
    expect(motorPropellantMass(constant)).toBe(0);
    expect(motorBurnoutMass(constant)).toBe(0.021);
    const { info, answer } = await onKernel(singleStage(), { m1: constant });
    expect(answer.state).toBe('ok');
    if (answer.state !== 'ok') return;
    expect(answer.mass).toBeCloseTo(info.mass, 12);
  });

  it('a non-finite mass sample is not allowed to poison the answer', () => {
    expect(motorPropellantMass({ masses: [NaN, 0.009] })).toBe(0);
    expect(motorBurnoutMass({ masses: [0.021, Infinity] })).toBeNull();
  });

  it('refuses when componentInfo cannot answer for a booster stage', () => {
    const tree = twoStage();
    const answer = recoveryMass({
      tree,
      info: { mass: 0.2, massEmpty: 0.15 },
      motors: [['m1', { spec: C6() }]],
      sectionMass: () => null, // the kernel handle went away mid-render
    });
    expect(answer.state).toBe('unavailable');
  });

  it('refuses when a loaded motor is missing from the design mass', () => {
    // The shape of App's motorFailures case if it ever reached here: a motor
    // the kernel refused is not in `mass`, so subtracting its propellant would
    // report a rocket LIGHTER than its own dry structure.
    const answer = recoveryMass({
      tree: singleStage(),
      info: { mass: 0.11, massEmpty: 0.11 },
      motors: [['m1', { spec: C6() }]],
      sectionMass: () => null,
    });
    expect(answer.state).toBe('unavailable');
  });
});

/**
 * An M1500G-shaped reload: 5.049 kg on the pad, 2.362 kg of propellant, so
 * 2.687 kg of casing and closures stay in the rocket. The point of using a
 * high-power motor here is that the gap is 2.4 kg — the size of the error the
 * owner's Wildman hit when a drogue was sized against pad weight (11.7 kg)
 * instead of the mass that actually descends (8.786 kg).
 */
const M1500G = (): MotorSpec => ({
  designation: 'M1500G',
  diameter: 0.098,
  length: 0.732,
  cgX: 0.366,
  ejectionDelay: 0,
  times: [0, 0.1, 0.5, 1.0, 2.0, 3.0, 3.5],
  thrusts: [0, 1800, 1700, 1600, 1450, 900, 0],
  masses: [5.049, 4.98, 4.63, 4.24, 3.45, 2.85, 2.687],
});

describe('recovery weight — real corpus designs', () => {
  /**
   * lemiv-motors.ork is a real high-power design (the LEMIV flight the
   * validation work is anchored on), imported straight from the file rather
   * than built for this test.
   */
  it('lemiv-motors.ork on an M1500G loses the propellant and only the propellant', async () => {
    const imported = importOrk(fixture('lemiv-motors.ork'));
    expect(stages(imported.tree)).toHaveLength(1);
    const mountId = Object.keys(imported.motors)[0];
    expect(mountId).toBeTruthy();
    const { info, answer } = await onKernel(imported.tree, { [mountId!]: M1500G() });
    expect(answer.state).toBe('ok');
    if (answer.state !== 'ok') return;

    const propellant = 5.049 - 2.687;
    expect(info.mass - answer.mass).toBeCloseTo(propellant, 9);
    expect(answer.mass).toBeCloseTo(info.massEmpty + 2.687, 9);
    // Sizing a main on pad weight instead of this would be sizing it for a
    // rocket 2.36 kg heavier than the one on the chute.
    expect(info.mass - answer.mass).toBeGreaterThan(2);
  });

  /**
   * Complex.Two-Stage.CDX1 is a RASAero design with real serial staging, so
   * the sustainer-only rule is exercised on geometry nobody wrote for it.
   */
  it('Complex.Two-Stage.CDX1 reports the sustainer, not the stack', async () => {
    const imported = importCdx1(readFileSync(
      join(here, '__fixtures__', 'Complex.Two-Stage.CDX1'), 'utf8'));
    const stageList = stages(imported.tree);
    expect(stageList.length).toBeGreaterThan(1);
    const sustainerMount = motorMounts(imported.tree)
      .find((m) => stageIndexOf(imported.tree, m.id!) === 0);
    expect(sustainerMount).toBeTruthy();

    const { info, sectionMass, answer } = await onKernel(
      imported.tree, { [sustainerMount!.id!]: C6() });
    expect(answer.state).toBe('ok');
    if (answer.state !== 'ok') return;
    expect(answer.multiStage).toBe(true);
    expect(answer.mass).toBeCloseTo(sectionMass(stageList[0]!.id!)! + BURNOUT, 9);
    // The booster's structure is on the ground: this is BELOW the whole
    // rocket's dry mass, which pad weight never is.
    expect(answer.mass).toBeLessThan(info.massEmpty);
  });
});
