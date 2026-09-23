// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode, IgnitionEvent, MotorSpec, RocketTree } from '@online-openrocket/engine';
import {
  engineTree, hasParallelStage, hasSeparatingParallelStage, isSeparatingParallelStage, motorMounts, stageIndexOf,
  stages,
} from '../tree/treeModel.js';
import { importOrk } from './orkFile.js';
import { importCdx1 } from './rasaeroFile.js';
import {
  motorBurnoutMass, motorPropellantMass, recoveryGroups, recoveryMass, recoveryMassByStage,
  recoveryMassTitle, sustainerScope,
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
async function onKernel(
  tree: RocketTree, motors: Record<string, MotorSpec>, ignition: Record<string, IgnitionEvent> = {},
) {
  const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
  resetEngine();
  const rocket = OrkRocket.buildTree(engineTree(tree));
  for (const [id, spec] of Object.entries(motors)) rocket.setMotorById(id, spec);
  // The kernel and the input are handed the SAME ignition, as App hands both.
  for (const [id, event] of Object.entries(ignition)) rocket.setMotorIgnitionById(id, event);
  const info = rocket.staticInfo();
  const sectionMass = (id: string): number | null => {
    try {
      const v = rocket.componentInfo(id).sectionMass;
      return Number.isFinite(v) ? v : null;
    } catch { return null; }
  };
  const input = {
    tree,
    info,
    motors: Object.keys(motors).map((id) => [id, {
      spec: motors[id]!, ...(ignition[id] ? { ignition: { event: ignition[id] } } : {}),
    }] as const),
    sectionMass,
  };
  const answer = recoveryMass(input);
  const byStage = recoveryMassByStage(input);
  return { rocket, info, sectionMass, answer, byStage };
}

/** The `ok` mass of the group whose top stage has this name, for terse assertions. */
const groupMass = (
  byStage: ReturnType<typeof recoveryMassByStage>, stageName: string,
): number | null => {
  if (byStage.state !== 'ok') return null;
  const g = byStage.groups.find((x) => x.stageNames[0] === stageName);
  return g && g.mass.state === 'ok' ? g.mass.mass : null;
};

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

/**
 * A MOTOR ON NEVER COMES DOWN LOADED (audit 2026-09-22). The motors tuple
 * carried no ignition, so the propellant of a motor set never to light was
 * subtracted anyway — on the "what if the sustainer fails to light" check,
 * exactly the flight where the canopy carries the most. Each case is checked
 * against the mass the kernel's own flight lands with.
 */
describe('recovery weight — a motor that never lights', () => {
  /** The mass the kernel's own flight lands with (kg). */
  const landingMass = async (rocket: Awaited<ReturnType<typeof onKernel>>['rocket']) => {
    const { DEFAULT_CONDITIONS, kernelSimOptions } = await import('../components/LaunchPanel.js');
    const flight = rocket.simulate(kernelSimOptions(DEFAULT_CONDITIONS));
    expect(flight.events.map((e) => e.type)).toContain('GROUND_HIT');
    return flight.series.mass[flight.series.mass.length - 1]!;
  };
  /** `twoStage` with fins on the booster too, so the stack flies to a landing. */
  const flyable = (): RocketTree => {
    const t = twoStage();
    t.components[1]!.children![0]!.children!.unshift({
      type: 'trapezoidfinset', id: 'f2', finCount: 3, rootChord: 0.07, tipChord: 0.04,
      sweep: 0.03, height: 0.04, thickness: 0.003, position: { method: 'bottom', offset: 0 },
    } as ComponentNode);
    return t;
  };

  it('a sustainer on Never is its dry stage plus the LOADED motor — the flight’s own landing mass', async () => {
    const { rocket, sectionMass, answer } = await onKernel(
      flyable(), { m1: C6(), m2: C6() }, { m1: 'never' });
    expect(answer.state).toBe('ok');
    if (answer.state !== 'ok') return;
    expect(answer.mass).toBeCloseTo(sectionMass('s1')! + 0.021, 12);
    expect(answer.mass).toBeCloseTo(await landingMass(rocket), 9);
    // What it used to show: the spent casing, 12 g light.
    expect(answer.mass - (sectionMass('s1')! + BURNOUT)).toBeCloseTo(PROPELLANT, 12);
    // Up to 1.5 s on the deploy runner (v0.138-v0.140): a kernel flight states
    // its budget, as the suite's other slow flights do (AUDIT row 528).
  }, 60000);

  it('the same sustainer lighting still loses its propellant, and lands as shown', async () => {
    const { rocket, sectionMass, answer } = await onKernel(flyable(), { m1: C6(), m2: C6() });
    expect(answer.state === 'ok' && answer.mass).toBeCloseTo(sectionMass('s1')! + BURNOUT, 12);
    expect(answer.state === 'ok' && answer.mass).toBeCloseTo(await landingMass(rocket), 9);
  });

  it('a single-stage mount on Never gives up nothing; the one that lights still does', async () => {
    const tree = singleStage();
    tree.components[0]!.children![1]!.children!.push({
      type: 'innertube', id: 'm2', length: 0.08, outerRadius: 0.0095, thickness: 0.0005,
      motorMount: true, position: { method: 'bottom', offset: 0 },
    } as ComponentNode);
    const { info, answer } = await onKernel(tree, { m1: C6(), m2: C6() }, { m2: 'never' });
    expect(answer.state).toBe('ok');
    if (answer.state !== 'ok') return;
    expect(answer.mass).toBeCloseTo(info.mass - PROPELLANT, 12);
  });

  it('every other ignition lights, and an absent one is the kernel’s Automatic', async () => {
    for (const event of ['automatic', 'launch', 'burnout', 'ejectioncharge'] as const) {
      const { info, answer } = await onKernel(singleStage(), { m1: C6() }, { m1: event });
      expect(answer.state === 'ok' && answer.mass, event).toBeCloseTo(info.mass - PROPELLANT, 12);
    }
  });
});

/**
 * A STRAP-ON ON NEVER IS STRUCTURE (audit 2026-09-22). `hasParallelStage`
 * counted it as separating, so the recovery weight was refused with "strap-on
 * boosters separate" — false for a booster that never leaves. It stays bolted
 * on, the kernel flies no branch for it, and it comes down with the core like
 * a pod set. Every case is checked against the kernel's own landing mass.
 */
describe('recovery weight — a strap-on that never separates', () => {
  const strapOn = (over: Partial<ComponentNode>, withMotor: boolean): ComponentNode => ({
    type: 'parallelstage', id: 'ps1', name: 'Strap-on', instanceCount: 2,
    radiusOffset: 0, radiusMethod: 'relative', angleOffset: 0, position: { method: 'bottom', offset: 0 },
    ...over,
    children: [
      { type: 'nosecone', id: 'pn', length: 0.05, aftRadius: 0.012, thickness: 0.002 } as ComponentNode,
      {
        type: 'bodytube', id: 'pb1', length: 0.25, outerRadius: 0.012, thickness: 0.0005, density: 950,
        children: withMotor ? [{
          type: 'innertube', id: 'pm', length: 0.08, outerRadius: 0.0095, thickness: 0.0005,
          motorMount: true, position: { method: 'bottom', offset: 0 },
        } as ComponentNode] : [],
      } as ComponentNode,
    ],
  } as ComponentNode);
  /** `singleStage` with a ring of strap-ons, and fins big enough to fly three C6s straight. */
  const withRing = (over: Partial<ComponentNode>, withMotor: boolean, pod = false): RocketTree => {
    const t = singleStage();
    const body = t.components[0]!.children![1]!;
    Object.assign(body.children![0]!, { rootChord: 0.1, tipChord: 0.05, sweep: 0.05, height: 0.08 });
    const ring = strapOn(over, withMotor);
    body.children!.push(pod ? ({ ...ring, type: 'podset', name: 'Pods' } as ComponentNode) : ring);
    return t;
  };
  const landing = async (rocket: Awaited<ReturnType<typeof onKernel>>['rocket']) => {
    const { DEFAULT_CONDITIONS, kernelSimOptions } = await import('../components/LaunchPanel.js');
    const flight = rocket.simulate(kernelSimOptions(DEFAULT_CONDITIONS));
    expect(flight.events.map((e) => e.type)).toContain('GROUND_HIT');
    return flight.series.mass[flight.series.mass.length - 1]!;
  };

  it('tells a strap-on on Never from one that leaves', () => {
    const never = withRing({ separationEvent: 'never' }, false);
    expect(hasParallelStage(never)).toBe(true);
    expect(hasSeparatingParallelStage(never)).toBe(false);
    // Absent is the kernel's default, ejection — it separates.
    expect(hasSeparatingParallelStage(withRing({}, false))).toBe(true);
    for (const ev of ['ejection', 'burnout', 'launch', 'apogee', 'altitude']) {
      expect(isSeparatingParallelStage(strapOn({ separationEvent: ev }, false)), ev).toBe(true);
    }
    // Only a parallel stage separates sideways; a pod set never does.
    expect(isSeparatingParallelStage({ type: 'podset' } as ComponentNode)).toBe(false);
  });

  it('weighs a design whose strap-ons never leave — what the flight lands with', async () => {
    const { rocket, info, answer } = await onKernel(withRing({ separationEvent: 'never' }, false), { m1: C6() });
    expect(answer.state).toBe('ok');
    if (answer.state !== 'ok') return;
    expect(answer.mass).toBeCloseTo(info.mass - PROPELLANT, 12);
    expect(answer.mass).toBeCloseTo(await landing(rocket), 9);
  });

  it('subtracts the propellant of EVERY strap-on instance — the count the kernel flies', async () => {
    // One C6 in the core, one in each of two strap-ons: three burn. Counting
    // the strap-on mount by its cluster alone subtracted two, reading 161.5 g
    // for a rocket that lands at 149.5 g.
    const { rocket, info, answer } = await onKernel(
      withRing({ separationEvent: 'never' }, true), { m1: C6(), pm: C6() });
    expect(answer.state).toBe('ok');
    if (answer.state !== 'ok') return;
    expect(info.mass - info.massEmpty).toBeCloseTo(3 * 0.021, 12);
    expect(answer.mass).toBeCloseTo(info.mass - 3 * PROPELLANT, 12);
    expect(answer.mass).toBeCloseTo(await landing(rocket), 9);
  });

  it('counts a pod set’s motors the same way', async () => {
    const { rocket, info, answer } = await onKernel(withRing({}, true, true), { m1: C6(), pm: C6() });
    expect(answer.state === 'ok' && answer.mass).toBeCloseTo(info.mass - 3 * PROPELLANT, 12);
    expect(answer.state === 'ok' && answer.mass).toBeCloseTo(await landing(rocket), 9);
  });

  it('still refuses a strap-on that leaves, whatever its trigger', async () => {
    for (const separationEvent of [undefined, 'burnout']) {
      const over = separationEvent ? { separationEvent } : {};
      const { answer } = await onKernel(withRing(over, false), { m1: C6() });
      expect(answer.state).toBe('unavailable');
      expect(answer.state === 'unavailable' && answer.reason).toMatch(/strap-on boosters separate/);
    }
  });

  /**
   * A RING ON A BOOSTER STAGE (audit 2026-09-22 review). Lifting the refusal
   * for a Never strap-on let it through on a booster too, where `sectionMass`
   * counts the ring ONCE: the booster read 96.1 g for a branch that lands at
   * 108.0 g — 11 % light, the unsafe way for its canopy — and the sustainer,
   * `massEmpty` less that once-counted ring, 93.2 g for 81.3 g. A pod set there
   * did the same before this row. Such a booster is refused, and the sustainer
   * is summed from its own stage instead. Checked against the kernel's branches.
   */
  describe('on a booster stage of a design that separates', () => {
    /** `twoStage`, finned to fly, with a two-instance ring on the booster body and optionally the core. */
    const staged = (type: 'parallelstage' | 'podset', onCore = false): RocketTree => {
      const t = twoStage();
      t.components[1]!.children![0]!.children!.unshift({
        type: 'trapezoidfinset', id: 'f2', finCount: 3, rootChord: 0.1, tipChord: 0.05,
        sweep: 0.05, height: 0.08, thickness: 0.003, position: { method: 'bottom', offset: 0 },
      } as ComponentNode);
      const ring = (suffix: string): ComponentNode => {
        const r = strapOn({ type, separationEvent: 'never' }, false);
        return {
          ...r, id: `ps${suffix}`,
          children: r.children!.map((c) => ({ ...c, id: `${c.id}${suffix}` })),
        } as ComponentNode;
      };
      t.components[1]!.children![0]!.children!.push(ring('B'));
      if (onCore) t.components[0]!.children![1]!.children!.push(ring('S'));
      return t;
    };
    /** Each branch's landing mass, sustainer first (kg). */
    const branchLandings = async (rocket: Awaited<ReturnType<typeof onKernel>>['rocket']) => {
      const { DEFAULT_CONDITIONS, kernelSimOptions } = await import('../components/LaunchPanel.js');
      const flight = rocket.simulate(kernelSimOptions(DEFAULT_CONDITIONS));
      return (flight.branches ?? []).map((b) => b.series.mass[b.series.mass.length - 1]!);
    };

    for (const type of ['parallelstage', 'podset'] as const) {
      it(`refuses the booster and sums the sustainer — a ${type} on the booster`, async () => {
        const { rocket, sectionMass, byStage } = await onKernel(staged(type), { m1: C6(), m2: C6() });
        const [sustainerLands, boosterLands] = await branchLandings(rocket);
        expect(byStage.state).toBe('ok');
        if (byStage.state !== 'ok') return;
        const [sustainer, booster] = byStage.groups;
        expect(sustainer!.mass.state === 'ok' && sustainer!.mass.mass).toBeCloseTo(sectionMass('s1')! + BURNOUT, 12);
        expect(sustainer!.mass.state === 'ok' && sustainer!.mass.mass).toBeCloseTo(sustainerLands!, 9);
        expect(booster!.mass.state).toBe('unavailable');
        expect(booster!.mass.state === 'unavailable' && booster!.mass.reason).toMatch(/counted once, not per pod/);
        // What the booster would have read: its once-counted section, light.
        expect(sectionMass('s2')! + BURNOUT).toBeLessThan(boosterLands! - 0.01);
      });
    }

    it('refuses both when the sustainer holds a ring of its own as well', async () => {
      const { byStage } = await onKernel(staged('podset', true), { m1: C6(), m2: C6() });
      expect(byStage.state).toBe('ok');
      if (byStage.state !== 'ok') return;
      expect(byStage.groups.map((g) => g.mass.state)).toEqual(['unavailable', 'unavailable']);
    });

    it('a ring on the sustainer alone is still weighed, both objects as they land', async () => {
      const t = staged('parallelstage');
      // Move the ring from the booster body to the core's.
      const ring = t.components[1]!.children![0]!.children!.pop()!;
      t.components[0]!.children![1]!.children!.push(ring);
      const { rocket, byStage } = await onKernel(t, { m1: C6(), m2: C6() });
      const lands = await branchLandings(rocket);
      expect(groupMass(byStage, 'Sustainer')).toBeCloseTo(lands[0]!, 9);
      expect(groupMass(byStage, 'Booster')).toBeCloseTo(lands[1]!, 9);
    });
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

/**
 * A two-stage tree whose booster is told never to separate — the case that
 * exists in real files. `LEM-IV.ork` declares `ejection` on the stage node and
 * then overrides SEVEN of its eight flight configurations to `never`; applying
 * one writes the value onto the stage node, which is what this builds.
 */
const twoStageNeverSeparating = (): RocketTree => {
  const t = twoStage();
  const booster = t.components[1] as ComponentNode;
  return {
    ...t,
    components: [t.components[0]!, { ...booster, separationEvent: 'never' } as ComponentNode],
  };
};

describe('what actually comes down — one weight per separating object', () => {
  it('an ordinary two-stage rocket is two objects, and they sum to the whole dry stack', async () => {
    const tree = twoStage();
    const { info, sectionMass, byStage } = await onKernel(tree, { m1: C6(), m2: C6() });
    expect(byStage.state).toBe('ok');
    if (byStage.state !== 'ok') return;

    expect(byStage.groups.map((g) => g.stageNames)).toEqual([['Sustainer'], ['Booster']]);
    expect(byStage.groups.map((g) => g.isSustainer)).toEqual([true, false]);

    const sustainer = groupMass(byStage, 'Sustainer')!;
    const booster = groupMass(byStage, 'Booster')!;

    // The booster is its own dry section plus its own spent casing — the
    // number a flyer buys the booster's canopy against, and the one the app
    // gave no way to see before.
    expect(booster).toBeCloseTo(sectionMass('s2')! + BURNOUT, 9);
    expect(sustainer).toBeCloseTo(info.massEmpty - sectionMass('s2')! + BURNOUT, 9);

    // Nothing is lost or double-counted: the two objects are the whole rocket
    // less the propellant that burned.
    expect(sustainer + booster).toBeCloseTo(info.mass - 2 * PROPELLANT, 9);
  });

  it('the sustainer entry is bit-identical to what recoveryMass has always returned', async () => {
    const { answer, byStage } = await onKernel(twoStage(), { m1: C6(), m2: C6() });
    expect(answer.state).toBe('ok');
    if (answer.state !== 'ok') return;
    // Same object, one number: the tile and the per-stage readout cannot
    // disagree about the same rocket.
    expect(groupMass(byStage, 'Sustainer')).toBe(answer.mass);
  });

  /**
   * THE `never` BUG, pinned. Before 2026-09-07 the multi-stage arm subtracted
   * every booster's sectionMass without ever reading `separationEvent`, so a
   * booster that stays bolted on was reported as gone — a recovery weight
   * LIGHTER than the object under the chute, which is the direction that
   * undersizes a canopy.
   */
  it('a booster set to Never comes down attached, and the weight includes it', async () => {
    const tree = twoStageNeverSeparating();
    const { info, sectionMass, answer, byStage } = await onKernel(tree, { m1: C6(), m2: C6() });

    expect(recoveryGroups(tree).map((g) => g.map((s) => s.name)))
      .toEqual([['Sustainer', 'Booster']]);
    expect(byStage.state).toBe('ok');
    if (byStage.state !== 'ok') return;
    // One object, so one weight to size: there is no second canopy to buy.
    expect(byStage.groups).toHaveLength(1);

    expect(answer.state).toBe('ok');
    if (answer.state !== 'ok') return;
    // The whole stack, less only what burned.
    expect(answer.mass).toBeCloseTo(info.mass - 2 * PROPELLANT, 9);
    expect(answer.mass).toBeGreaterThan(info.massEmpty);
    // ...and it is not the multi-stage wording, because nothing separated.
    expect(answer.multiStage).toBe(false);
    expect(recoveryMassTitle(answer)).toContain('the dry rocket plus the spent motor casing');

    // The size of the old error, stated: the booster's whole dry section.
    const wasReportedBefore = info.massEmpty - sectionMass('s2')! + BURNOUT;
    expect(answer.mass - wasReportedBefore).toBeCloseTo(sectionMass('s2')! + BURNOUT, 9);
    expect(answer.mass - wasReportedBefore).toBeGreaterThan(0);
  });

  it('a three-stage stack cuts only where something separates', () => {
    const base = twoStage();
    const third = {
      type: 'stage', id: 's3', name: 'Booster 2',
      children: [{
        type: 'bodytube', id: 'b3', length: 0.3, outerRadius: 0.025, thickness: 0.0005, density: 950,
      } as ComponentNode],
    } as ComponentNode;

    // Middle stage bolted on, bottom stage separating: the top two land
    // together and the bottom one lands alone.
    const tree: RocketTree = {
      ...base,
      components: [
        base.components[0]!,
        { ...(base.components[1] as ComponentNode), separationEvent: 'never' } as ComponentNode,
        third,
      ],
    };
    expect(recoveryGroups(tree).map((g) => g.map((s) => s.name)))
      .toEqual([['Sustainer', 'Booster'], ['Booster 2']]);
    expect(sustainerScope(tree).map((s) => s.name)).toEqual(['Sustainer', 'Booster']);
  });

  it('a booster whose motor has no mass curve does not blank the sustainer', async () => {
    // The kernel is given real motors — a spec with no mass column makes IT
    // throw while formatting, long before this file is reached — and the
    // curve-less spec is substituted only in the call under test.
    const tree = twoStage();
    const { info, sectionMass } = await onKernel(tree, { m1: C6(), m2: C6() });
    const noCurve: MotorSpec = { ...C6(), designation: 'D12', masses: [] };
    const byStage = recoveryMassByStage({
      tree, info, sectionMass, motors: [['m1', { spec: C6() }], ['m2', { spec: noCurve }]],
    });
    expect(byStage.state).toBe('ok');
    if (byStage.state !== 'ok') return;

    const sustainer = byStage.groups.find((g) => g.isSustainer)!;
    const booster = byStage.groups.find((g) => !g.isSustainer)!;
    // The number most users are reading survives a booster we cannot answer for.
    expect(sustainer.mass.state).toBe('ok');
    expect(booster.mass.state).toBe('unavailable');
    if (booster.mass.state !== 'unavailable') return;
    expect(booster.mass.reason).toContain('no mass curve');
  });

  it('a single-stage design is one group and its scope is the whole rocket', async () => {
    const tree = singleStage();
    expect(recoveryGroups(tree).map((g) => g.map((s) => s.name))).toEqual([['Sustainer']]);
    const { answer, byStage } = await onKernel(tree, { m1: C6() });
    expect(byStage.state).toBe('ok');
    if (byStage.state !== 'ok' || answer.state !== 'ok') return;
    expect(byStage.groups).toHaveLength(1);
    expect(byStage.groups[0]!.mass).toEqual(answer);
  });

  /**
   * The real corpus two-stage, so the per-stage arithmetic is exercised on
   * geometry nobody wrote for it.
   */
  it('Complex.Two-Stage.CDX1 gives the booster its own weight', async () => {
    const imported = importCdx1(readFileSync(
      join(here, '__fixtures__', 'Complex.Two-Stage.CDX1'), 'utf8'));
    const stageList = stages(imported.tree);
    expect(stageList.length).toBeGreaterThan(1);
    const sustainerMount = motorMounts(imported.tree)
      .find((m) => stageIndexOf(imported.tree, m.id!) === 0);

    const { info, sectionMass, byStage } = await onKernel(
      imported.tree, { [sustainerMount!.id!]: C6() });
    expect(byStage.state).toBe('ok');
    if (byStage.state !== 'ok') return;
    expect(byStage.groups.length).toBe(stageList.length);

    const booster = byStage.groups[1]!;
    expect(booster.isSustainer).toBe(false);
    expect(booster.mass.state).toBe('ok');
    if (booster.mass.state !== 'ok') return;
    // No motor in the booster in this configuration, so it is its dry section
    // exactly — and it is real mass the flyer has to hang a canopy under.
    expect(booster.mass.mass).toBeCloseTo(sectionMass(stageList[1]!.id!)!, 9);
    expect(booster.mass.mass).toBeGreaterThan(0);
    expect(booster.mass.mass).toBeLessThan(info.massEmpty);
  });
});
