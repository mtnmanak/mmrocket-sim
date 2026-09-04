// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { exportOrk, importOrk } from './orkFile.js';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';

/**
 * v0.087 — the round-trip data loss the 2026-08-30 clock-angle audit found.
 *
 * `radialposition` / `radialdirection` were WRITTEN fourteen times and READ
 * ZERO times, and a launch lug's or rail button's `angleoffset` was discarded
 * on import and hard-written as 180 degrees on export. So opening a desktop
 * OpenRocket design here and saving it MOVED PARTS: a lug clocked at 45° came
 * back at 180° (on a four-fin rocket, exactly on a fin root line), and a
 * split cluster's motor tubes all collapsed onto the centreline — in the
 * user's own file, permanently.
 *
 * These tests are the guard. They assert the values SURVIVE, which is the
 * only property that matters to someone whose file it is.
 */

/** Import mints fresh ids, so components are matched by NAME here. */
const find = (nodes: ComponentNode[], name: string): ComponentNode | undefined => {
  for (const n of nodes) {
    if (n.name === name) return n;
    const hit = find(n.children ?? [], name);
    if (hit) return hit;
  }
  return undefined;
};

const D = (deg: number) => (deg * Math.PI) / 180;

describe('.ork round-trip preserves every clock angle and radial offset', () => {
  const tree: RocketTree = {
    name: 'Radial',
    components: [{
      type: 'stage', id: 's1', name: 's1',
      children: [{
        type: 'bodytube', id: 'b1', name: 'b1', length: 0.5, outerRadius: 0.05, thickness: 0.001,
        children: [
          // A camera shroud clocked away from the fins so the fins are not in
          // shot — the owner's stated reason for wanting this field at all.
          { type: 'fairing', id: 'shroud', name: 'shroud', length: 0.1, width: 0.04, height: 0.035, angleOffset: D(60) },
          { type: 'protuberance', id: 'bump', name: 'bump', length: 0.05, width: 0.02, height: 0.01, angleOffset: D(-30) },
          { type: 'launchlug', id: 'lug', name: 'lug', length: 0.04, outerRadius: 0.003, thickness: 0.0005, angleOffset: D(45) },
          { type: 'railbutton', id: 'btn', name: 'btn', outerDiameter: 0.0097, angleOffset: D(90) },
          // A split cluster: three single tubes, each off-axis at its own angle.
          { type: 'innertube', id: 't1', name: 't1', length: 0.2, outerRadius: 0.014, thickness: 0.0005, radialPosition: 0.02, radialDirection: D(0) },
          { type: 'innertube', id: 't2', name: 't2', length: 0.2, outerRadius: 0.014, thickness: 0.0005, radialPosition: 0.02, radialDirection: D(120) },
          { type: 'innertube', id: 't3', name: 't3', length: 0.2, outerRadius: 0.014, thickness: 0.0005, radialPosition: 0.02, radialDirection: D(240) },
          { type: 'masscomponent', id: 'm1', name: 'm1', mass: 0.1, length: 0.03, radialPosition: 0.015, radialDirection: D(75) },
        ],
      }],
    }],
  } as unknown as RocketTree;

  const xmlOf = (t: RocketTree) => exportOrk({ name: t.name ?? 'Rocket', tree: t });
  const back = importOrk(xmlOf(tree)).tree.components;

  const CASES: Array<[string, string, number]> = [
    ['shroud', 'angleOffset', D(60)],
    ['bump', 'angleOffset', D(-30)],
    ['lug', 'angleOffset', D(45)],
    ['btn', 'angleOffset', D(90)],
    ['t2', 'radialDirection', D(120)],
    ['t3', 'radialDirection', D(240)],
    ['m1', 'radialDirection', D(75)],
  ];

  for (const [id, key, want] of CASES) {
    it(`${id}: ${key} survives the round trip`, () => {
      const n = find(back, id);
      expect(n, `${id} should still exist`).toBeDefined();
      expect(n![key] as number, `${id}.${key}`).toBeCloseTo(want, 6);
    });
  }

  it('keeps every split-cluster tube off the centreline', () => {
    for (const id of ['t1', 't2', 't3']) {
      expect(find(back, id)!['radialPosition'] as number, `${id} collapsed to the axis`)
        .toBeCloseTo(0.02, 9);
    }
    expect(find(back, 'm1')!['radialPosition'] as number).toBeCloseTo(0.015, 9);
  });

  it('never writes the old hard-coded 180 for a lug or button', () => {
    const xml = xmlOf(tree);
    // The literal that used to move every lug and button on save.
    expect(xml).not.toContain('<angleoffset method="relative">180.0</angleoffset>');
    expect(xml).not.toContain('<radialdirection>180.0</radialdirection>');
    // …and the real values are there, in DEGREES, as the format requires.
    expect(xml).toContain('<radialposition>0.02</radialposition>');
    expect(/<angleoffset method="relative">45\.0+<\/angleoffset>/.test(xml)).toBe(true);
    expect(/<radialdirection>120\.0+<\/radialdirection>/.test(xml)).toBe(true);
  });

  it('leaves an unset angle at zero rather than inventing one', () => {
    const plain = {
      name: 'Plain',
      components: [{
        type: 'stage', id: 's1', name: 's1',
        children: [{
          type: 'bodytube', id: 'b1', name: 'b1', length: 0.3, outerRadius: 0.02, thickness: 0.001,
          children: [{ type: 'launchlug', id: 'lug', name: 'lug', length: 0.03, outerRadius: 0.002, thickness: 0.0004 }],
        }],
      }],
    } as unknown as RocketTree;
    const lug = find(importOrk(xmlOf(plain)).tree.components, 'lug')!;
    // Absent, or present and zero — both mean "top of the drawing". What it
    // must NOT be is 180 degrees away from where the user left it.
    expect(typeof lug['angleOffset'] === 'undefined' || lug['angleOffset'] === 0).toBe(true);
  });
});

/**
 * v0.105 — the OTHER half of the same fact, and the half that was still
 * missing after v0.087 fixed the file round-trip.
 *
 * The values survived the file and reached both drawings, but the KERNEL
 * BRIDGE never called setRadialPosition/setRadialDirection, so every inner
 * tube and every mass object still flew on the centreline. Proof it was
 * genuinely absent rather than merely unused: those two symbols occurred ZERO
 * times in packages/engine/vendor/orkengine.mjs before this change and ten
 * times after — TeaVM had dead-code-eliminated methods nothing called.
 *
 * Rotational inertia is the discriminator. Moving mass off the roll axis
 * cannot change the total mass and barely moves the longitudinal CG, but it
 * raises the roll inertia by m*r^2 — so this is the number that proves the
 * offset reached the physics rather than only the picture.
 */
describe('a radial offset reaches the kernel, not just the drawing', () => {
  const design = (offsetM: number): RocketTree => ({
    name: 'radial',
    components: [{
      type: 'stage', id: 's', name: 'Stage',
      children: [{
        type: 'bodytube', id: 'bt', name: 'Body',
        length: 0.4, outerRadius: 0.04, thickness: 0.001,
        children: [
          {
            type: 'masscomponent', id: 'w', name: 'Ballast',
            mass: 0.25, length: 0.03, radius: 0.006,
            axialMethod: 'top', axialOffset: 0.1,
            radialPosition: offsetM, radialDirection: 0,
          } as ComponentNode,
        ],
      } as ComponentNode],
    } as ComponentNode],
  });

  it('raises roll inertia by the parallel-axis term, and scales as r²', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    const info = (r: number) => {
      resetEngine();
      return OrkRocket.buildTree(engineTree(design(r))).staticInfo();
    };
    const onAxis = info(0);
    const half = info(0.0125);
    const full = info(0.025);

    // Same rocket, same material: moving mass sideways cannot change how much
    // of it there is, and cannot change the inertia about a transverse axis.
    expect(full.mass).toBeCloseTo(onAxis.mass, 12);
    expect(full.longitudinalInertia).toBeCloseTo(onAxis.longitudinalInertia, 12);

    // MassObject.getComponentCG() carries the offset as shiftY/shiftZ, so the
    // WHOLE ROCKET's CG moves off the roll axis too. The roll inertia is
    // reported about that shifted CG, so the gain is the parallel-axis term
    // less what the composite centroid takes back:
    //     ΔIrr = m·r² − M·(m·r/M)² = m·r²·(1 − m/M)
    // 0.25 kg at 25 mm on a 0.3175 kg rocket: 1.5625e-4 × 0.2126 = 3.322e-5.
    const m = 0.25;
    const M = onAxis.mass;
    const predicted = (r: number) => m * r * r * (1 - m / M);
    expect(full.rotationalInertia - onAxis.rotationalInertia).toBeCloseTo(predicted(0.025), 8);
    expect(half.rotationalInertia - onAxis.rotationalInertia).toBeCloseTo(predicted(0.0125), 8);

    // And it is quadratic in the offset, which is the signature of a real
    // moment arm rather than a number that merely changed.
    const dFull = full.rotationalInertia - onAxis.rotationalInertia;
    const dHalf = half.rotationalInertia - onAxis.rotationalInertia;
    expect(dFull / dHalf).toBeCloseTo(4, 6);

    // Before v0.105 every one of these differences was exactly zero.
    expect(dHalf).toBeGreaterThan(0);
  });
});
