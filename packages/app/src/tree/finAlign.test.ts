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

  it('a swept trapezoid collides out to its tip too (audit 2026-09-30)', () => {
    // Root 100, sweep 80, tip 50 mm: the tips run to 130 mm. A set at 110 mm
    // overlaps them in the 110-130 mm band; over the root chord alone the two
    // "did not overlap" and stayed on the same clock lines, fins colliding.
    const res = autoAlignFinSets(tree([
      straight({ id: 'a', finCount: 4, rootChord: 0.1, sweep: 0.08, tipChord: 0.05, position: { method: 'top', offset: 0 } }),
      straight({ id: 'b', finCount: 4, position: { method: 'top', offset: 0.11 } }),
    ]));
    expect(res.changes.length).toBe(1);
    expect(findNode(res.tree, 'b')!['rotation'] as number).toBeCloseTo(Math.PI / 4, 6);
  });

  it('a set swept FORWARD collides with the set ahead of its station', () => {
    // Sweep -30 mm at 100 mm: the tips reach forward to 70 mm, into a set
    // that ends at 90 mm.
    const res = autoAlignFinSets(tree([
      straight({ id: 'a', finCount: 4, rootChord: 0.05, position: { method: 'top', offset: 0.04 } }),
      straight({ id: 'b', finCount: 4, rootChord: 0.06, sweep: -0.03, tipChord: 0.05, position: { method: 'top', offset: 0.1 } }),
    ]));
    expect(res.changes.length).toBe(1);
    expect(findNode(res.tree, 'b')!['rotation'] as number).toBeCloseTo(Math.PI / 4, 6);
  });

  it('starts where the kernel puts it, not where the old max-x drawing did', () => {
    // 'bottom' on a 300 mm tube: the kernel's start is 300 − 90 = 210 mm; the
    // max-x frame said 300 − 120 = 180 mm. A 15 mm set at 190–205 mm overlaps
    // the old start and clears the real one, so nothing must rotate. Its sweep
    // and tip are stated: the kernel's defaults (20 and 30 mm) would put its
    // tip 35 mm past a 15 mm root, and the set out to 240 mm.
    const res = autoAlignFinSets(tree([
      overhang({ position: { method: 'bottom', offset: 0 } }),
      straight({ id: 'b', finCount: 4, rootChord: 0.015, sweep: 0.005, tipChord: 0.005,
        position: { method: 'top', offset: 0.19 } }),
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

  it('reads an absent position where the kernel flies the set: the bottom, offset 0', () => {
    // FinSet's own default is BOTTOM. Read as Top (until 2026-10-01), a set
    // with no position was checked for overlap at the front of the tube.
    const [a, b] = finSetSpan({ type: 'trapezoidfinset', rootChord: 0.06 } as ComponentNode, 0.3);
    expect(a).toBeCloseTo(0.24, 12);
    expect(b).toBeCloseTo(0.30, 12);
  });

  /**
   * The drawn span of a TRAPEZOID, and of any fin reaching forward of its
   * station (audit 2026-09-30). Only a freeform fin was allowed to overhang its
   * root, so a swept trapezoid whose tip runs past the root — finTab.ts says
   * that shape exists — and a set with a negative sweep or an outline point at
   * x < 0 were checked for collisions over the root chord alone.
   */
  it('a swept trapezoid reaches its tip: root 100, sweep 80, tip 50 mm spans 0-130 mm', () => {
    const swept = straight({ rootChord: 0.1, sweep: 0.08, tipChord: 0.05, position: { method: 'top', offset: 0 } });
    const [a, b] = finSetSpan(swept, 0.3);
    expect(a).toBeCloseTo(0, 12);
    expect(b).toBeCloseTo(0.13, 12);
  });

  it('a negative sweep reaches FORWARD of the station', () => {
    const forward = straight({ rootChord: 0.06, sweep: -0.03, tipChord: 0.05, position: { method: 'top', offset: 0.1 } });
    const [a, b] = finSetSpan(forward, 0.3);
    expect(a).toBeCloseTo(0.07, 12);
    expect(b).toBeCloseTo(0.16, 12);
    // A freeform outline with a point forward of the leading root corner.
    const raked = {
      type: 'freeformfinset', id: 'ff', points: [[0, 0], [-0.02, 0.04], [0.03, 0.04], [0.05, 0]],
      position: { method: 'top', offset: 0.1 },
    } as unknown as ComponentNode;
    const [c, d] = finSetSpan(raked, 0.3);
    expect(c).toBeCloseTo(0.08, 12);
    expect(d).toBeCloseTo(0.15, 12);
  });

  it('counts an overlap, and not two spans that only touch', () => {
    expect(spansOverlap([0, 0.1], [0.05, 0.2])).toBe(true);
    expect(spansOverlap([0.05, 0.2], [0, 0.1])).toBe(true);
    expect(spansOverlap([0, 0.1], [0.1, 0.2])).toBe(false);
    expect(spansOverlap([0, 0.1], [0.2, 0.3])).toBe(false);
  });
});
