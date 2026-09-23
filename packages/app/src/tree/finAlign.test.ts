import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { autoAlignFinSets, finSetSpan, spansOverlap } from './finAlign.js';
import { findNode } from './treeModel.js';

const tree = (children: ComponentNode[]): RocketTree => ({
  name: 'a',
  components: [{
    type: 'stage', id: 's1',
    children: [{
      type: 'bodytube', id: 'b1', length: 0.3, outerRadius: 0.049,
      children,
    } as ComponentNode],
  } as ComponentNode],
});

const tubes = (params: Record<string, unknown> = {}): ComponentNode => ({
  type: 'tubefinset', id: 'tf', finCount: 6, length: 0.1,
  position: { method: 'bottom', offset: 0 }, ...params,
} as ComponentNode);

const straight = (params: Record<string, unknown> = {}): ComponentNode => ({
  type: 'trapezoidfinset', id: 'fin', finCount: 3, rootChord: 0.06, height: 0.04,
  position: { method: 'bottom', offset: 0 }, ...params,
} as ComponentNode);

describe('autoAlignFinSets (issue 2026-08-05e: one-click interleave)', () => {
  it('rotates 3 straight fins between 6 tube fins (Ultra Neon case) — 30°', () => {
    const res = autoAlignFinSets(tree([tubes(), straight()]));
    expect(res.changes.length).toBe(1);
    expect(findNode(res.tree, 'fin')!['rotation'] as number).toBeCloseTo(Math.PI / 6, 6);
    // The first set keeps its rotation.
    expect(findNode(res.tree, 'tf')!['rotation']).toBeUndefined();
  });

  it('two 4-fin sets interleave at 45°', () => {
    const res = autoAlignFinSets(tree([
      straight({ id: 'a', finCount: 4 }),
      straight({ id: 'b', finCount: 4 }),
    ]));
    expect(findNode(res.tree, 'b')!['rotation'] as number).toBeCloseTo(Math.PI / 4, 6);
  });

  it('leaves axially separated sets alone', () => {
    const res = autoAlignFinSets(tree([
      tubes(),
      straight({ position: { method: 'top', offset: 0 } }), // 0–0.06 vs tubes 0.2–0.3
    ]));
    expect(res.changes.length).toBe(0);
    expect(findNode(res.tree, 'fin')!['rotation']).toBeUndefined();
  });

  it('is idempotent — a second run reports nothing to do', () => {
    const first = autoAlignFinSets(tree([tubes(), straight()]));
    const second = autoAlignFinSets(first.tree);
    expect(second.changes.length).toBe(0);
  });

  it('respects an equally-clear existing rotation (already interleaved)', () => {
    const res = autoAlignFinSets(tree([tubes(), straight({ rotation: Math.PI / 6 })]));
    expect(res.changes.length).toBe(0);
  });
});

/**
 * The overlap test uses TWO lengths for a freeform fin (2026-09-07): the
 * kernel's root chord to find where the set STARTS, the outline's furthest-aft
 * x to find where it ENDS. Ninja-shaped fin, scaled down: root chord 90 mm,
 * tip trailing corner overhanging to 120 mm.
 */
describe('autoAlignFinSets — a freeform fin with an overhanging tip', () => {
  const overhang = (params: Record<string, unknown> = {}): ComponentNode => ({
    type: 'freeformfinset', id: 'ff', finCount: 4,
    points: [[0, 0], [0.12, 0.04], [0.10, 0.01], [0.09, 0]],
    position: { method: 'top', offset: 0 }, ...params,
  } as ComponentNode);

  it('still collides out to the tip — the overhang is real geometry', () => {
    // ff spans 0–0.12 (extent), the second set 0.10–0.16: they overlap only
    // because the tip reaches past the 90 mm root chord.
    const res = autoAlignFinSets(tree([
      overhang(),
      straight({ id: 'b', finCount: 4, position: { method: 'top', offset: 0.10 } }),
    ]));
    expect(res.changes.length).toBe(1);
    expect(findNode(res.tree, 'b')!['rotation'] as number).toBeCloseTo(Math.PI / 4, 6);
  });

  it('starts where the kernel puts it, not where the old max-x drawing did', () => {
    // 'bottom' on a 300 mm tube: the kernel's start is 300 − 90 = 210 mm; the
    // max-x frame said 300 − 120 = 180 mm. A 15 mm set at 190–205 mm overlaps
    // the old start and clears the real one, so nothing must rotate.
    const res = autoAlignFinSets(tree([
      overhang({ position: { method: 'bottom', offset: 0 } }),
      straight({ id: 'b', finCount: 4, rootChord: 0.015, position: { method: 'top', offset: 0.19 } }),
    ]));
    expect(res.changes.length).toBe(0);
    expect(findNode(res.tree, 'b')!['rotation']).toBeUndefined();
  });
});

/**
 * The span and overlap test the one-click alignment and the RockSim
 * importer's de-collision now share (they were two copies until audit
 * 2026-09-22). Both callers' own tests above and in rocksimFile.test.ts ride
 * on these; this pins the shared pieces directly.
 */
describe('finSetSpan / spansOverlap', () => {
  it('stations a set by the kernel length and extends it to the drawn outline', () => {
    // Bottom-aligned 60 mm root on a 300 mm tube: 240-300 mm.
    const [a, b] = finSetSpan(straight(), 0.3);
    expect(a).toBeCloseTo(0.24, 12);
    expect(b).toBeCloseTo(0.30, 12);
    // A freeform tip overhanging its 50 mm root by 20 mm, top-aligned at 10 mm:
    // stationed by the root, colliding out to the tip.
    const overhang = {
      type: 'freeformfinset', id: 'ff', points: [[0, 0], [0.07, 0.04], [0.05, 0]],
      position: { method: 'top', offset: 0.01 },
    } as unknown as ComponentNode;
    const [c, d] = finSetSpan(overhang, 0.3);
    expect(c).toBeCloseTo(0.01, 12);
    expect(d).toBeCloseTo(0.08, 12);
  });

  it('reads an absent position as top, offset 0', () => {
    expect(finSetSpan({ type: 'trapezoidfinset', rootChord: 0.06 } as ComponentNode, 0.3)[0]).toBe(0);
  });

  it('counts an overlap, and not two spans that only touch', () => {
    expect(spansOverlap([0, 0.1], [0.05, 0.2])).toBe(true);
    expect(spansOverlap([0.05, 0.2], [0, 0.1])).toBe(true);
    expect(spansOverlap([0, 0.1], [0.1, 0.2])).toBe(false);
    expect(spansOverlap([0, 0.1], [0.2, 0.3])).toBe(false);
  });
});
