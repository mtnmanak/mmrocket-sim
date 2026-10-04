import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { kernelNum } from './kernelDefaults.js';
import { numOpt } from './nodeNum.js';
import { noseEnds } from './tailCone.js';
import { resolveAssemblyRadius } from './assembly.js';
import { axialLength, positionOf, startFromPosition } from './position.js';

/** SymmetricComponent.DEFAULT_RADIUS, when there is no neighbour on that side. */
const DEFAULT_RADIUS = 0.025;
const symmetric = (n: ComponentNode) => ['bodytube', 'nosecone', 'transition'].includes(n.type);

/**
 * A drawing/export snapshot: absent transition ends remain automatic in the
 * source tree. Axial stages share a chain; each pod/booster has its own.
 */
export function resolveTransitionRadii(tree: RocketTree): RocketTree {
  const ends = new Map<ComponentNode, Partial<ComponentNode>>();
  const statedFace = (n: ComponentNode | null | undefined, side: 'fore' | 'aft'): number | undefined => {
    if (n === null) return undefined;
    if (!n) return DEFAULT_RADIUS;
    if (n.type === 'bodytube') return kernelNum(n, 'outerRadius');
    if (n.type === 'nosecone') return noseEnds(n, kernelNum(n, 'aftRadius'))[side];
    // Transition.getFront/RearAutoRadius refuses a mutually automatic end.
    return numOpt(n, `${side}Radius`);
  };
  const hasInlineChildren = (n: ComponentNode): boolean => {
    const radius = Math.max(statedFace(n, 'fore') ?? 0, statedFace(n, 'aft') ?? 0);
    return (n.children ?? []).some((asm) =>
      (asm.type === 'podset' || asm.type === 'parallelstage')
      && resolveAssemblyRadius(asm, radius) === 0
      && (asm.children ?? []).some(symmetric));
  };
  const face = (n: ComponentNode | null | undefined, side: 'fore' | 'aft'): number | undefined => {
    // The kernel can substitute a flush inline assembly's wider end, including
    // nested assemblies. Until that search is mirrored, do not claim this size.
    if (n && hasInlineChildren(n)) return undefined;
    return statedFace(n, side);
  };
  const register = (chain: ComponentNode[], owner?: ComponentNode | null) => {
    chain.forEach((n, i) => {
      if (n.type !== 'transition') return;
      const patch: Partial<ComponentNode> = {};
      if (numOpt(n, 'foreRadius') === undefined) patch['foreRadius'] = face(chain[i - 1] ?? owner, 'aft');
      if (numOpt(n, 'aftRadius') === undefined) {
        // getNextSymmetricComponent also searches the transition's own children.
        patch['aftRadius'] = hasInlineChildren(n) ? undefined : face(chain[i + 1], 'fore');
      }
      if (Object.keys(patch).length) ends.set(n, patch);
    });
  };
  register(tree.components.flatMap((n) => n.type === 'stage' ? n.children ?? [] : [n]).filter(symmetric));
  const assemblies = (nodes: ComponentNode[], parent?: ComponentNode) => {
    for (const n of nodes) {
      if (n.type === 'podset' || n.type === 'parallelstage') {
        let owner: ComponentNode | null | undefined;
        if (parent && symmetric(parent)) {
          const r = Math.max(statedFace(parent, 'fore') ?? 0, statedFace(parent, 'aft') ?? 0);
          if (resolveAssemblyRadius(n, r) === 0) {
            // An inline assembly starting ahead of its parent needs the
            // kernel's wider neighbour search; leave that end unresolved.
            owner = startFromPosition(positionOf(n), axialLength(n), axialLength(parent)) > 0 ? parent : null;
          }
        }
        register((n.children ?? []).filter(symmetric), owner);
      }
      assemblies(n.children ?? [], n);
    }
  };
  assemblies(tree.components);
  if (!ends.size) return tree;
  const copy = (nodes: ComponentNode[]): ComponentNode[] => nodes.map((n) => ({
    ...n, ...ends.get(n), ...(n.children ? { children: copy(n.children) } : {}),
  }));
  return { ...tree, components: copy(tree.components) };
}
