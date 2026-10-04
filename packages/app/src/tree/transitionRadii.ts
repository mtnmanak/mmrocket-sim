import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { kernelNum } from './kernelDefaults.js';
import { num, numOpt } from './nodeNum.js';
import { noseEnds } from './tailCone.js';
import { isAssembly } from './assembly.js';
import { axialLength, positionOf, startFromPosition } from './position.js';

/** SymmetricComponent.DEFAULT_RADIUS, when there is no neighbour on that side. */
const DEFAULT_RADIUS = 0.025;
const symmetric = (n: ComponentNode) => ['bodytube', 'nosecone', 'transition'].includes(n.type);
const assembly = (n: ComponentNode) => n.type === 'stage' || isAssembly(n.type);
// MathUtil.equals(value, 0), including its near-zero half-epsilon rule.
const zero = (value: number) => Math.abs(value) < 5e-9;

/**
 * A drawing/export snapshot: absent transition ends remain automatic in the
 * source tree. Mirrors SymmetricComponent's inline neighbour/flush sleeve search.
 */
export function resolveTransitionRadii(tree: RocketTree): RocketTree {
  const ends = new Map<ComponentNode, Partial<ComponentNode>>();
  const statedFace = (n: ComponentNode | undefined, side: 'fore' | 'aft'): number | undefined => {
    if (!n) return DEFAULT_RADIUS;
    if (n.type === 'bodytube') return kernelNum(n, 'outerRadius');
    if (n.type === 'nosecone') return noseEnds(n, kernelNum(n, 'aftRadius'))[side];
    // Transition.getFront/RearAutoRadius refuses a mutually automatic end.
    return numOpt(n, `${side}Radius`);
  };
  const parents = new Map<ComponentNode, ComponentNode>();
  const relative = new Map<ComponentNode, number>();
  const lengths = new Map<ComponentNode, number>();
  const length = (n: ComponentNode): number => n.type === 'stage'
    ? (n.children ?? []).reduce((sum, c) => sum + (assembly(c) || symmetric(c) ? length(c) : 0), 0)
    : axialLength(n);
  // Also accept the unwrapped main chain used by geometry callers.
  const root: ComponentNode = { type: 'stage', children: tree.components.map((n) =>
    n.type === 'stage' ? n : { type: 'stage', children: [n] }) };
  const index = (n: ComponentNode, start: number) => {
    lengths.set(n, length(n));
    let x = 0;
    for (const child of n.children ?? []) {
      parents.set(child, n);
      let rel = x;
      if (!assembly(n)) {
        const pos = positionOf(child);
        rel = pos.method === 'absolute' ? pos.offset - start : startFromPosition(pos, length(child), length(n));
        // RocketComponent.setAxialOffset snaps position.x; AFTER chains do not.
        if (Math.abs(rel) < 1e-6) rel = 0;
      }
      relative.set(child, rel);
      index(child, start + rel);
      if (symmetric(child) || child.type === 'stage') x += length(child);
    }
  };
  index(root, 0);
  const offset = (n: ComponentNode, side: 'fore' | 'aft'): number => {
    const parent = parents.get(n);
    const top = relative.get(n) ?? 0;
    const parentLength = parent && parent !== root ? lengths.get(parent)! : 0;
    const value = side === 'fore' ? top : top + (lengths.get(n)! - parentLength);
    // PodSet.getAxialOffset additionally snaps the returned offset.
    return n.type === 'podset' && Math.abs(value) < 1e-8 ? 0 : value;
  };
  const automatic = (n: ComponentNode) => n.type === 'transition'
    && (numOpt(n, 'foreRadius') === undefined || numOpt(n, 'aftRadius') === undefined);
  const onAxis = (parent: ComponentNode): boolean => {
    if (!isAssembly(parent.type)) return true;
    const host = parents.get(parent);
    // inline() passes the symmetric CHILD to RadiusMethod, not the assembly:
    // that child is not RadiusPositionable, so its radius is not added.
    const method = String(parent['radiusMethod'] ?? 'relative').toLowerCase();
    if (method === 'coaxial') return true;
    const radius = (method === 'surface' ? 0 : num(parent, 'radiusOffset', 0)) + (method !== 'free'
      && host?.type === 'bodytube' ? kernelNum(host, 'outerRadius') : 0);
    return zero(radius);
  };
  const inline = (n: ComponentNode, candidate: ComponentNode): boolean => {
    const parent = parents.get(n)!;
    const candidateParent = parents.get(candidate)!;
    if (parent === candidateParent) return true;
    if (!onAxis(parent)) return false;
    if (isAssembly(candidateParent.type)) {
      // The kernel refuses this dependency even for a FREE radius of zero.
      if (parents.get(candidateParent) === n && automatic(n)) return false;
      return onAxis(candidateParent);
    }
    return true;
  };
  const flush = (parent: ComponentNode, candidate: ComponentNode, side: 'fore' | 'aft', extra = 0): ComponentNode => {
    let best = candidate;
    for (const asm of (parent.children ?? []).filter(assembly)) {
      const kids = asm.children ?? [];
      const child = side === 'fore' ? kids[0] : kids[kids.length - 1];
      if (!child || !symmetric(child) || !inline(parent, child)) continue;
      const deviation = extra + offset(asm, side);
      const radius = statedFace(child, side);
      if (zero(deviation) && radius !== undefined && radius > (statedFace(best, side) ?? 0)) best = child;
      // A non-flush sleeve can contain another sleeve whose offset cancels it.
      best = flush(child, best, side, deviation);
    }
    return best;
  };
  const neighbour = (n: ComponentNode, side: 'fore' | 'aft'): ComponentNode | undefined => {
    const parent = parents.get(n);
    const grand = parent && parents.get(parent);
    if (!parent || !grand) return undefined;
    const step = side === 'fore' ? -1 : 1;
    const groups = grand.children ?? [];
    let j = (parent.children ?? []).indexOf(n) + step;
    for (let i = groups.indexOf(parent); i >= 0 && i < groups.length; i += step) {
      const group = groups[i]!;
      const kids = group.children ?? [];
      if (assembly(group)) {
        for (; j >= 0 && j < kids.length; j += step) {
          const candidate = kids[j]!;
          if (symmetric(candidate) && inline(n, candidate)) {
            return flush(candidate, candidate, side === 'fore' ? 'aft' : 'fore');
          }
        }
      }
      j = side === 'fore' ? (groups[i - 1]?.children?.length ?? 0) - 1 : 0;
    }
    if (side === 'fore' && symmetric(grand) && inline(n, grand)) {
      return offset(parent, 'fore') + offset(n, 'fore') > 0 ? grand : neighbour(grand, side);
    }
    if (side === 'aft') {
      for (const asm of (n.children ?? []).filter(assembly)) {
        for (const child of asm.children ?? []) {
          if (symmetric(child) && inline(n, child)) {
            return offset(parent, 'aft') + offset(n, 'aft') < 0 ? child : neighbour(child, side);
          }
        }
      }
    }
    return undefined;
  };
  for (const n of parents.keys()) {
    if (n.type !== 'transition') continue;
    const patch: Partial<ComponentNode> = {};
    for (const side of ['fore', 'aft'] as const) {
      if (numOpt(n, `${side}Radius`) === undefined) {
        patch[`${side}Radius`] = statedFace(neighbour(n, side), side === 'fore' ? 'aft' : 'fore');
      }
    }
    if (Object.keys(patch).length) ends.set(n, patch);
  }
  if (!ends.size) return tree;
  const copy = (nodes: ComponentNode[]): ComponentNode[] => nodes.map((n) => ({
    ...n, ...ends.get(n), ...(n.children ? { children: copy(n.children) } : {}),
  }));
  return { ...tree, components: copy(tree.components) };
}
