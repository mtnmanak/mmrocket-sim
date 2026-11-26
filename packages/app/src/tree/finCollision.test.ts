import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { finCollisionFor } from './finCollision.js';
import * as solidContext from './solidContext.js';
import * as finRoot from './finRoot.js';
import { autoAlignFinSets } from './finAlign.js';
import { findNode } from './treeModel.js';
import { KERNEL_DEFAULT_FIN_POINTS } from './kernelDefaults.js';

afterEach(() => vi.restoreAllMocks());

it.each([
  { label: 'transition', parent: { type: 'transition' as const, foreRadius: 0.02, aftRadius: 0.05 }, a: {} },
  { label: 'nose cone without a fin id', parent: { type: 'nosecone' as const }, a: { id: undefined } },
  { label: 'pod', parent: { type: 'podset' as const }, a: {} },
  { label: 'unknown radius', parent: { outerRadius: NaN }, a: {} },
  { label: 'absolute position', parent: {}, a: { position: { method: 'absolute' as const, offset: 0 } } },
  { label: 'missing freeform points', parent: {}, a: { type: 'freeformfinset' as const } },
  { label: 'default freeform points', parent: {}, a: { type: 'freeformfinset' as const,
    points: KERNEL_DEFAULT_FIN_POINTS.map(([x, y]) => [x, y]) } },
  { label: 'invalid dimension', parent: {}, a: { height: NaN } },
  { label: 'crossed freeform', parent: {}, a: { type: 'freeformfinset' as const,
    points: [[0, 0], [0.08, 0.04], [0.02, 0.04], [0.1, 0]] } },
  { label: 'cancelling lobes', parent: {}, a: { type: 'freeformfinset' as const,
    points: [[0, 0], [0.025, 0.04], [0.05, 0], [0.12, -0.10], [0.07, 0]] } },
  { label: 'gap between lobes', parent: {}, a: { type: 'freeformfinset' as const,
    points: [[0, 0], [0.02, 0.04], [0.04, 0], [0.16, 0], [0.18, 0.04], [0.20, 0]] } },
])('returns unknown for $label and keeps span-based alignment', ({ label, parent: fields, a: fieldsA }) => {
  const a: ComponentNode = { type: 'trapezoidfinset', id: 'a', rootChord: 0.1, height: 0.04,
    finCount: 3, position: { method: 'top', offset: 0 }, ...fieldsA };
  const b: ComponentNode = { type: 'trapezoidfinset', id: 'b', rootChord: 0.1, height: 0.04,
    finCount: 3, position: { method: 'top', offset: 0 } };
  const parent: ComponentNode = { type: 'bodytube', id: 'body', length: 0.3, outerRadius: 0.05,
    children: [a, b], ...fields };
  const tree: RocketTree = { components: [parent] };
  const budget = { comparisons: 0, limit: 10000 };
  expect(finCollisionFor(tree, parent)(a, b, budget)).toBeUndefined();
  expect(budget.comparisons).toBeLessThanOrEqual(budget.limit);
  // Unsupported parent types/invalid dimensions can be excluded by isFinSet;
  // the valid multi-lobe, missing-points and absolute cases must still align.
  if (['cancelling lobes', 'gap between lobes', 'missing freeform points', 'absolute position'].includes(label)) {
    expect(findNode(autoAlignFinSets(tree).tree, 'b')!['rotation']).toBeCloseTo(Math.PI / 3, 10);
  }
});

it.each([
  { type: 'trapezoidfinset' as const, rootChord: 0 },
  { type: 'trapezoidfinset' as const, rootChord: 5e-8 },
  { type: 'freeformfinset' as const, points: [[0, 0], [0.02, 0.05], [0.07, 0.05], [0, 0]] },
].flatMap(fields => [true, false].map(meets => ({ fields, meets }))))('keeps both root endpoints when seating a nearly closed outline %j', ({ fields, meets }) => {
  const a: ComponentNode = { id: 'a', finCount: 3, rotation: 0, tipChord: 0.05, sweep: 0.02,
    height: 0.05, thickness: 0.003, crossSection: 'rounded',
    position: { method: 'top', offset: 0 }, ...fields };
  const b: ComponentNode = { type: 'freeformfinset', id: 'b', finCount: 3, rotation: 0,
    // The low triangle meets only the spurious edge made by lowering A's
    // trailing tip onto the body. The actual tip passes well above it.
    points: meets ? [[0, 0], [-0.04, 0.045], [0.01, 0]] : [[0, 0], [0.005, 0.01], [0.01, 0]],
    thickness: 0.003, crossSection: 'airfoil',
    position: { method: 'top', offset: meets ? 0.1 : 0.05 } };
  const parent: ComponentNode = { type: 'bodytube', id: 'body', length: 0.3, outerRadius: 0.05,
    children: [a, b] };
  const tree: RocketTree = { components: [parent] };
  expect(finCollisionFor(tree, parent)(a, b, { comparisons: 0, limit: 1000 })).toBe(meets);
  const aligned = autoAlignFinSets(tree);
  if (meets) expect(findNode(aligned.tree, 'b')!['rotation']).toBeCloseTo(Math.PI / 3, 10);
  else {
    expect(aligned.changes).toEqual([]);
    expect(aligned.tree).toBe(tree);
  }
});

it('keeps a valid three-point freeform whose last point nearly closes on its first', () => {
  // Codex r3 (FA1): the mesh helper drops the closing point and returns null
  // for this outline; the collision check must still see the planform.
  const a: ComponentNode = { type: 'freeformfinset', id: 'a', finCount: 3, rotation: 0, thickness: 0.003,
    crossSection: 'rounded', points: [[0, 0], [0.1, 0.05], [5e-8, 0]], position: { method: 'top', offset: 0 } };
  const b: ComponentNode = { type: 'trapezoidfinset', id: 'b', finCount: 3, rotation: 0, thickness: 0.003,
    crossSection: 'airfoil', rootChord: 0.04, tipChord: 0.02, sweep: 0, height: 0.05,
    position: { method: 'top', offset: 0.04 } };
  const parent: ComponentNode = { type: 'bodytube', id: 'body', length: 0.3, outerRadius: 0.05, children: [a, b] };
  const tree: RocketTree = { components: [parent] };
  expect(finCollisionFor(tree, parent)(a, b, { comparisons: 0, limit: 1000 })).toBe(true);
  expect(findNode(autoAlignFinSets(tree).tree, 'b')!['rotation']).toBeCloseTo(Math.PI / 3, 10);
});

it('uses the body tube surface directly and reuses each outline across sibling comparisons', () => {
  const context = vi.spyOn(solidContext, 'solidContextFor');
  const seat = vi.spyOn(finRoot, 'finOnMount');
  const fins: ComponentNode[] = ['a', 'b', 'c'].map(id => ({
    type: 'trapezoidfinset', id, rootChord: 0.1, tipChord: 0.05, height: 0.05, sweep: 0.02,
  }));
  const parent: ComponentNode = { type: 'bodytube', id: 'body', length: 1, outerRadius: 0.05, children: fins };
  const tree: RocketTree = { components: [parent] };
  const meet = finCollisionFor(tree, parent);
  const budget = { comparisons: 0, limit: 1000 };
  expect(meet(fins[0]!, fins[1]!, budget)).toBe(true);
  expect(meet(fins[0]!, fins[2]!, budget)).toBe(true);
  expect(meet(fins[1]!, fins[2]!, budget)).toBe(true);
  expect(context).not.toHaveBeenCalled();
  expect(seat).toHaveBeenCalledTimes(3);
});

it('reserves quadratic edge work before entering the intersection loop', () => {
  const fins: ComponentNode[] = ['a', 'b'].map(id => ({ type: 'tubefinset', id, length: 0.1, outerRadius: 0.01 }));
  const parent: ComponentNode = { type: 'bodytube', length: 1, outerRadius: 0.05, children: fins };
  const meet = finCollisionFor({ components: [parent] }, parent);
  // Four edges each: one pair visit + 16 edge pairs + 16 linear-walk steps.
  expect(meet(fins[0]!, fins[1]!, { comparisons: 0, limit: 32 })).toBeUndefined();
  expect(meet(fins[0]!, fins[1]!, { comparisons: 0, limit: 33 })).toBe(true);
});

it('checks a triangular trapezoid (zero tip chord) by its outline instead of falling back', () => {
  // agy r4 (FA1): finPlanformPoints repeats the tip of a zero-tip-chord fin;
  // that must not send a separated pair back to the old span rule.
  const a: ComponentNode = { type: 'trapezoidfinset', id: 'a', finCount: 3, rotation: 0,
    rootChord: 0.15, tipChord: 0, sweep: 0.22, height: 0.10, position: { method: 'top', offset: 0 } };
  const b: ComponentNode = { type: 'trapezoidfinset', id: 'b', finCount: 3, rotation: 0,
    rootChord: 0.10, tipChord: 0.05, sweep: 0.02, height: 0.02, position: { method: 'top', offset: 0.18 } };
  const parent: ComponentNode = { type: 'bodytube', id: 'body', length: 0.6, outerRadius: 0.05, children: [a, b] };
  const tree: RocketTree = { components: [parent] };
  expect(finCollisionFor(tree, parent)(a, b, { comparisons: 0, limit: 100_000 })).toBe(false);
  expect(autoAlignFinSets(tree).changes).toEqual([]);
});
