import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { autoAlignFinSets } from './finAlign.js';
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
