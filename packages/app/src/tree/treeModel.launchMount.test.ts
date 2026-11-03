import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { launchMountOf, makeNode, motorMounts, mountMotorCount } from './treeModel.js';

const mount = (): ComponentNode => ({ ...makeNode('innertube'), motorMount: true });
const stage = (...children: ComponentNode[]): ComponentNode => ({ ...makeNode('stage'), children });
const treeOf = (...components: ComponentNode[]): RocketTree => ({ components });
const ids = (tree: RocketTree) => motorMounts(tree).map((m) => m.id!);

describe('launchMountOf', () => {
  it('selects a single-stage mount', () => {
    const m = mount();
    const tree = treeOf(stage(m));
    expect(launchMountOf(tree, ids(tree))).toBe(m.id);
  });
  it('selects the bottom-most stage with a mount', () => {
    const upper = mount(), lower = mount();
    const tree = treeOf(stage(upper), stage(lower));
    expect(launchMountOf(tree, ids(tree))).toBe(lower.id);
  });
  it.each(['podset', 'parallelstage'] as const)('prefers the core to a %s in the booster', (type) => {
    const upper = mount(), core = mount(), satellite = mount();
    const tree = treeOf(stage(upper), stage({ ...makeNode(type), instanceCount: 2,
      children: [{ ...makeNode('bodytube'), children: [satellite] }] }, core));
    expect(launchMountOf(tree, ids(tree))).toBe(core.id);
  });
  it('prefers a pod to a strap-on when there is no core mount', () => {
    const pod = mount(), strap = mount();
    const tree = treeOf(stage({ ...makeNode('parallelstage'), children: [strap] },
      { ...makeNode('podset'), children: [pod] }));
    expect(launchMountOf(tree, ids(tree))).toBe(pod.id);
  });
  it('selects one cluster mount with three positions', () => {
    const m = { ...mount(), cluster: '3-row' };
    const tree = treeOf(stage(m));
    expect(mountMotorCount(tree, m.id!)).toBe(3);
    expect(launchMountOf(tree, ids(tree))).toBe(m.id);
  });
  it('returns null for no mounts or deleted ids', () => {
    const tree = treeOf(stage());
    expect(launchMountOf(tree, [])).toBeNull();
    expect(launchMountOf(tree, ['deleted'])).toBeNull();
  });
  it('uses the upper mount when the booster has none', () => {
    const upper = mount();
    const tree = treeOf(stage(upper), stage());
    expect(launchMountOf(tree, ids(tree))).toBe(upper.id);
  });
  it('keeps given order for equal ranks and accepts an iterable', () => {
    const a = mount(), b = mount();
    const tree = treeOf(stage(a, b));
    expect(launchMountOf(tree, new Set(['deleted', b.id!, a.id!]))).toBe(b.id);
  });
});
