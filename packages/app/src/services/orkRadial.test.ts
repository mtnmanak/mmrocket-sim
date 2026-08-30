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
