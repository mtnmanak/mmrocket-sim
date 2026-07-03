import type { ComponentNode, ComponentType, RocketTree } from '@online-openrocket/engine';
import { defaultParams, DISPLAY_NAME } from './schema.js';

/**
 * Immutable tree-editing helpers. Every node carries a unique editor id
 * (also used by the engine's setMotorById). All operations return new trees.
 */

let counter = 1;

export function freshId(): string {
  return `c${counter++}`;
}

export function makeNode(type: ComponentType): ComponentNode {
  return {
    type,
    id: freshId(),
    name: DISPLAY_NAME[type],
    ...defaultParams(type),
  } as ComponentNode;
}

export function findNode(tree: RocketTree, id: string): ComponentNode | null {
  const walk = (nodes: ComponentNode[]): ComponentNode | null => {
    for (const n of nodes) {
      if (n.id === id) return n;
      const hit = walk(n.children ?? []);
      if (hit) return hit;
    }
    return null;
  };
  return walk(tree.components);
}

export function findParent(tree: RocketTree, id: string): ComponentNode | 'stage' | null {
  if (tree.components.some((n) => n.id === id)) return 'stage';
  const walk = (nodes: ComponentNode[]): ComponentNode | null => {
    for (const n of nodes) {
      if ((n.children ?? []).some((c) => c.id === id)) return n;
      const hit = walk(n.children ?? []);
      if (hit) return hit;
    }
    return null;
  };
  return walk(tree.components);
}

export function updateNode(
  tree: RocketTree,
  id: string,
  patch: Partial<ComponentNode>,
): RocketTree {
  const walk = (nodes: ComponentNode[]): ComponentNode[] =>
    nodes.map((n) =>
      n.id === id
        ? ({ ...n, ...patch } as ComponentNode)
        : n.children
          ? ({ ...n, children: walk(n.children) } as ComponentNode)
          : n,
    );
  return { ...tree, components: walk(tree.components) };
}

export function removeNode(tree: RocketTree, id: string): RocketTree {
  const walk = (nodes: ComponentNode[]): ComponentNode[] =>
    nodes
      .filter((n) => n.id !== id)
      .map((n) => (n.children ? ({ ...n, children: walk(n.children) } as ComponentNode) : n));
  return { ...tree, components: walk(tree.components) };
}

/** Adds a child to the given parent id ('stage' = top level). */
export function addChild(tree: RocketTree, parentId: string | 'stage', child: ComponentNode): RocketTree {
  if (parentId === 'stage') {
    return { ...tree, components: [...tree.components, child] };
  }
  const walk = (nodes: ComponentNode[]): ComponentNode[] =>
    nodes.map((n) =>
      n.id === parentId
        ? ({ ...n, children: [...(n.children ?? []), child] } as ComponentNode)
        : n.children
          ? ({ ...n, children: walk(n.children) } as ComponentNode)
          : n,
    );
  return { ...tree, components: walk(tree.components) };
}

/** Moves a node up/down among its siblings. */
export function moveNode(tree: RocketTree, id: string, dir: -1 | 1): RocketTree {
  const shift = (nodes: ComponentNode[]): ComponentNode[] => {
    const idx = nodes.findIndex((n) => n.id === id);
    if (idx >= 0) {
      const to = idx + dir;
      if (to < 0 || to >= nodes.length) return nodes;
      const out = [...nodes];
      const [n] = out.splice(idx, 1);
      out.splice(to, 0, n!);
      return out;
    }
    return nodes.map((n) => (n.children ? ({ ...n, children: shift(n.children) } as ComponentNode) : n));
  };
  return { ...tree, components: shift(tree.components) };
}

/** All inner tubes flagged as motor mounts (for the motor panel). */
export function motorMounts(tree: RocketTree): ComponentNode[] {
  const out: ComponentNode[] = [];
  const walk = (nodes: ComponentNode[]) => {
    for (const n of nodes) {
      if (n.type === 'innertube' && n['motorMount'] === true) out.push(n);
      walk(n.children ?? []);
    }
  };
  walk(tree.components);
  return out;
}

/** The default (reference) rocket as a tree. */
export function defaultTree(): RocketTree {
  const nose = makeNode('nosecone');
  const body = { ...makeNode('bodytube'), length: 0.3, thickness: 0.0003, density: 950 } as ComponentNode;
  const fins = makeNode('trapezoidfinset');
  const mount = makeNode('innertube');
  const chute = makeNode('parachute');
  return {
    name: 'My Rocket',
    components: [nose, { ...body, children: [fins, mount, chute] } as ComponentNode],
  };
}
