import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { assemblyInstanceCount, finCountOf, lineInstanceCount } from './counts.js';
import { buildPieces } from './pieces.js';
import { tubeFinRadius } from './tubefins.js';
import { finAnglesAmong, betweenFinAnglesAmong } from './mountAngle.js';
import {
  FIELDS, KERNEL_MAX_FINS, KERNEL_MAX_LINE_INSTANCES, MAX_ASSEMBLY_INSTANCES,
} from './schema.js';

/**
 * Counts are drawn the way the kernel flies them (audit 2026-09-22: "counts
 * read with no ceiling", and the fin count the kernel clamps to 8). Before this,
 * every renderer looped the raw stored number: a set of 12 fins was drawn as 12
 * and flown as 8, and a hostile count took the drawing down with it.
 */

const node = (o: Record<string, unknown>): ComponentNode => o as unknown as ComponentNode;

/** One body tube carrying `child`, in a one-stage tree. */
const onBody = (child: Record<string, unknown>): RocketTree => ({
  name: 'R',
  components: [{
    id: 's1', type: 'stage',
    children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: 0.012 },
      { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0005, children: [child] },
    ],
  }],
}) as unknown as RocketTree;

const keysOf = (tree: RocketTree, prefix: RegExp) =>
  buildPieces(tree).pieces.filter((p) => prefix.test(p.key)).length;

describe('finCountOf / lineInstanceCount / assemblyInstanceCount', () => {
  it('caps a fin count at the kernel\'s 8 and floors it at 1', () => {
    expect(finCountOf(node({ type: 'trapezoidfinset', finCount: 70_000 }))).toBe(KERNEL_MAX_FINS);
    expect(finCountOf(node({ type: 'tubefinset', finCount: 12 }))).toBe(8);
    expect(finCountOf(node({ type: 'freeformfinset', finCount: 0 }))).toBe(1);
    expect(finCountOf(node({ type: 'ellipticalfinset', finCount: -4 }))).toBe(1);
  });

  it('falls back to the bridge default when the count is absent or not a number', () => {
    expect(finCountOf(node({ type: 'trapezoidfinset' }))).toBe(3);
    expect(finCountOf(node({ type: 'tubefinset' }))).toBe(6);
    expect(finCountOf(node({ type: 'tubefinset', finCount: Number.NaN }))).toBe(6);
  });

  it('caps line instances at the bridge\'s 64 and assemblies at the app\'s ceiling', () => {
    expect(lineInstanceCount(node({ type: 'launchlug', instanceCount: 20_000 }))).toBe(KERNEL_MAX_LINE_INSTANCES);
    expect(lineInstanceCount(node({ type: 'railbutton' }))).toBe(1);
    expect(assemblyInstanceCount(node({ type: 'podset', instanceCount: 1e8 }))).toBe(MAX_ASSEMBLY_INSTANCES);
    expect(assemblyInstanceCount(node({ type: 'parallelstage' }))).toBe(2);
  });
});

describe('the drawings never show more than the kernel flies', () => {
  it('a 12-fin set draws 8 fins in 3D (the kernel clamps to 8)', () => {
    expect(keysOf(onBody({
      id: 'f1', type: 'trapezoidfinset', finCount: 12,
      rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003,
    }), /^fin\d/)).toBe(8);
  });

  it('a .rkt TubeCount of 100,000 draws 8 tubes, quickly (it took 19.3 s)', () => {
    const t0 = performance.now();
    const n = keysOf(onBody({ id: 't1', type: 'tubefinset', finCount: 100_000, length: 0.1, thickness: 0.0005 }), /^tubefin/);
    expect(n).toBe(8);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('a lug instancecount of 20,000 draws 64 lugs (it produced 2.0 M vertices)', () => {
    expect(keysOf(onBody({
      id: 'l1', type: 'launchlug', length: 0.05, outerRadius: 0.0022, thickness: 0.0003,
      instanceCount: 20_000, instanceSeparation: 0.001,
    }), /^lug/)).toBe(64);
    expect(keysOf(onBody({
      id: 'r1', type: 'railbutton', instanceCount: 20_000, instanceSeparation: 0.001,
    }), /^rbtn/)).toBe(64);
  });

  it('a pod ring past the ceiling draws the ceiling', () => {
    // 500, not a hostile 1e8: a regression must FAIL here, not hang the suite.
    const pods = (count: number) => keysOf(onBody({
      id: 'p1', type: 'podset', instanceCount: count, radiusOffset: 0, radiusMethod: 'relative',
      children: [{ id: 'pb', type: 'bodytube', length: 0.1, outerRadius: 0.005, thickness: 0.0005 }],
    }), /./);
    const perPod = pods(2) - pods(1);
    expect(perPod).toBeGreaterThan(0);
    expect(pods(500)).toBe(pods(1) + (MAX_ASSEMBLY_INSTANCES - 1) * perPod);
  });

  it('12 tube fins take the auto radius of the 8 the kernel flies', () => {
    const r12 = tubeFinRadius(node({ type: 'tubefinset', finCount: 12 }), 0.0124);
    const r8 = tubeFinRadius(node({ type: 'tubefinset', finCount: 8 }), 0.0124);
    expect(r12).toBe(r8);
    // The audit's figure: 15.37 mm OD flown, not the 8.66 mm the 12 printed.
    expect(2 * r12 * 1000).toBeCloseTo(15.37, 1);
  });

  it('the clock-angle helpers count 8 fins, not 12', () => {
    const set = node({ type: 'trapezoidfinset', finCount: 12 });
    expect(finAnglesAmong([set])).toHaveLength(8);
    expect(betweenFinAnglesAmong([set])).toHaveLength(8);
  });
});

describe('the schema offers no count the kernel will not fly', () => {
  it('every fin type\'s count slider stops at 8 (the tube-fin one ran to 12)', () => {
    for (const t of ['trapezoidfinset', 'ellipticalfinset', 'freeformfinset', 'tubefinset'] as const) {
      const f = FIELDS[t].find((x) => x.key === 'finCount')!;
      expect(f.smax, t).toBe(KERNEL_MAX_FINS);
    }
  });
});
