import { describe, expect, it } from 'vitest';
import { OrkRocket, type RocketTree } from './orkEngine.js';

/**
 * dragSweep per-component attribution regression (kernel bridge fix).
 * getForceAnalysis reports single-instance CD values while the rocket totals
 * multiply by active instance count — the bridge must do the same, or a
 * 4-fin design's rows under-sum the total by exactly 3x the fins row. The
 * bridge also keyed rows by display name, silently merging same-name parts.
 */

const fourFin: RocketTree = {
  name: 'FourFin',
  components: [
    { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' },
    {
      type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950,
      children: [
        { type: 'trapezoidfinset', finCount: 4, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
      ],
    },
  ],
};

describe('dragSweep per-component breakdown', () => {
  it('multi-fin component rows sum to the power-off total at every Mach', () => {
    const sweep = OrkRocket.buildTree(fourFin).dragSweep({ machMin: 0.2, machMax: 2.0, machStep: 0.3 });

    expect(sweep.components.length).toBe(3); // nose, tube, fins
    sweep.machs.forEach((_, i) => {
      const sum = sweep.components.reduce((acc, c) => acc + c.cd[i]!, 0);
      expect(sum).toBeCloseTo(sweep.powerOff.total[i]!, 9);
    });
  });

  it('same-name components stay separate rows with disambiguated names', () => {
    const sweep = OrkRocket.buildTree({
      name: 'TwinTube',
      components: [
        { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' },
        { type: 'bodytube', name: 'Body tube', length: 0.15, outerRadius: 0.012, thickness: 0.0003, density: 950 },
        {
          type: 'bodytube', name: 'Body tube', length: 0.15, outerRadius: 0.012, thickness: 0.0003, density: 950,
          children: [
            { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
          ],
        },
      ],
    }).dragSweep({ machMin: 0.3, machMax: 0.9, machStep: 0.3 });

    const names = sweep.components.map((c) => c.name);
    expect(names).toContain('Body tube');
    expect(names).toContain('Body tube (2)');

    // The disambiguated rows are real per-component data, not a merged +=.
    sweep.machs.forEach((_, i) => {
      const sum = sweep.components.reduce((acc, c) => acc + c.cd[i]!, 0);
      expect(sum).toBeCloseTo(sweep.powerOff.total[i]!, 9);
    });
  });

  it('a stage CD override becomes its own row so rows still sum to the total', () => {
    const stagedTree = (overrideSubcomponentsCD: boolean): RocketTree => ({
      name: 'StageOverride',
      components: [
        {
          type: 'stage', name: 'Sustainer', overrideCD: 0.31, overrideSubcomponentsCD,
          children: [
            { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' },
            {
              type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950,
              children: [
                { type: 'trapezoidfinset', finCount: 4, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
              ],
            },
          ],
        },
      ],
    });

    // Without <overridesubcomponents>: the override ADDS to the parts' drag,
    // so the sweep gets a "Sustainer" row on top of the component rows.
    const added = OrkRocket.buildTree(stagedTree(false)).dragSweep({ machMin: 0.2, machMax: 2.0, machStep: 0.3 });
    expect(added.components.map((c) => c.name)).toContain('Sustainer');
    const sustainer = added.components.find((c) => c.name === 'Sustainer')!;
    added.machs.forEach((_, i) => {
      expect(sustainer.cd[i]!).toBeCloseTo(0.31, 9);
      const sum = added.components.reduce((acc, c) => acc + c.cd[i]!, 0);
      expect(sum).toBeCloseTo(added.powerOff.total[i]!, 9);
    });

    // With <overridesubcomponents>: the override REPLACES the parts' drag —
    // their rows go to zero, the "Sustainer" row is the whole total.
    const replaced = OrkRocket.buildTree(stagedTree(true)).dragSweep({ machMin: 0.2, machMax: 2.0, machStep: 0.3 });
    replaced.machs.forEach((_, i) => {
      expect(replaced.powerOff.total[i]!).toBeCloseTo(0.31, 9);
      const sum = replaced.components.reduce((acc, c) => acc + c.cd[i]!, 0);
      expect(sum).toBeCloseTo(replaced.powerOff.total[i]!, 9);
    });
  });

  it('disambiguation never collides with a user-authored "(2)" name', () => {
    const sweep = OrkRocket.buildTree({
      name: 'AuthoredSuffix',
      components: [
        { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' },
        // User AUTHORED this name — the uniquer must not reuse it.
        { type: 'bodytube', name: 'Body tube (2)', length: 0.1, outerRadius: 0.012, thickness: 0.0003, density: 950 },
        { type: 'bodytube', name: 'Body tube', length: 0.1, outerRadius: 0.012, thickness: 0.0003, density: 950 },
        {
          type: 'bodytube', name: 'Body tube', length: 0.1, outerRadius: 0.012, thickness: 0.0003, density: 950,
          children: [
            { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
          ],
        },
      ],
    }).dragSweep({ machMin: 0.3, machMax: 0.9, machStep: 0.3 });

    const names = sweep.components.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length); // all display names unique
    expect(names).toContain('Body tube');
    expect(names).toContain('Body tube (2)'); // the authored one
    expect(names).toContain('Body tube (3)'); // second unnamed clash skips past it

    sweep.machs.forEach((_, i) => {
      const sum = sweep.components.reduce((acc, c) => acc + c.cd[i]!, 0);
      expect(sum).toBeCloseTo(sweep.powerOff.total[i]!, 9);
    });
  });
});
