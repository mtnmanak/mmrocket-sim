import type { ComponentNode, ComponentType, RocketTree } from '@online-openrocket/engine';
import { resolveAbsolutePositions } from './position.js';
import { defaultParams, DISPLAY_NAME, FIELDS } from './schema.js';

/**
 * Immutable tree-editing helpers. Every node carries a unique editor id
 * (also used by the engine's setMotorById). All operations return new trees.
 */

let counter = 1;

export function freshId(): string {
  return `c${counter++}`;
}

/**
 * Bumps the id counter past every `c<N>` id already in the tree. Restored
 * sessions and opened files carry ids minted by a PREVIOUS page load; without
 * reseeding, the first freshId() after a reload collides with them (duplicate
 * ids break selection, updateNode and setMotorById).
 */
function reseedIds(tree: RocketTree): void {
  const walk = (nodes: ComponentNode[]) => {
    for (const n of nodes) {
      const m = n.id ? /^c(\d+)$/.exec(n.id) : null;
      if (m) counter = Math.max(counter, Number(m[1]) + 1);
      walk(n.children ?? []);
    }
  };
  walk(tree.components);
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

/**
 * Post-Release-C invariant: tree.components is ALWAYS a list of stage nodes
 * (the desktop model — stage 0 on top, boosters after). Legacy flat trees
 * (pre-v0.009 sessions/files) are wrapped by normalizeTree at every load
 * boundary. The engine accepts both shapes.
 */
export function normalizeTree(tree: RocketTree): RocketTree {
  reseedIds(tree);
  tree = resolveAbsolutePositions(tree);
  if (tree.components.length === 0) {
    return { ...tree, components: [makeStage('Sustainer')] };
  }
  if (tree.components.every((n) => n.type === 'stage')) {
    // Already staged — just guarantee ids (older data may lack them).
    let changed = false;
    const components = tree.components.map((s) => {
      if (s.id) return s;
      changed = true;
      return { ...s, id: freshId() } as ComponentNode;
    });
    return changed ? { ...tree, components } : tree;
  }
  if (tree.components.some((n) => n.type === 'stage')) {
    // Mixed list (no importer produces this, but defend the invariant):
    // fold each loose node into the nearest preceding stage.
    const components: ComponentNode[] = [];
    for (const n of tree.components) {
      if (n.type === 'stage') {
        components.push(n.id ? n : ({ ...n, id: freshId() } as ComponentNode));
      } else {
        if (components.length === 0) components.push(makeStage('Sustainer'));
        const last = components[components.length - 1]!;
        components[components.length - 1] = {
          ...last,
          children: [...(last.children ?? []), n],
        } as ComponentNode;
      }
    }
    return { ...tree, components };
  }
  return {
    ...tree,
    components: [{ ...makeStage('Sustainer'), children: tree.components } as ComponentNode],
  };
}

export function makeStage(name: string): ComponentNode {
  return { type: 'stage', id: freshId(), name, children: [] } as ComponentNode;
}

/** The stage nodes, top (sustainer) first. */
export function stages(tree: RocketTree): ComponentNode[] {
  return tree.components.filter((n) => n.type === 'stage');
}

/**
 * Tree components as a stage-node list for the file exporters — legacy flat
 * trees (pre-v0.009 tests/back-compat callers) wrap into one implicit
 * Sustainer. Normalized app trees pass through unchanged.
 */
export function asStageNodes(tree: RocketTree): ComponentNode[] {
  return tree.components.every((c) => c.type === 'stage')
    ? tree.components
    : [{ type: 'stage', name: 'Sustainer', children: tree.components } as ComponentNode];
}

/** Appends a booster stage below the existing ones. */
export function addStage(tree: RocketTree): { tree: RocketTree; newId: string } {
  const n = stages(tree).length;
  const stage = makeStage(n === 0 ? 'Sustainer' : n === 1 ? 'Booster' : `Booster ${n}`);
  return { tree: { ...tree, components: [...tree.components, stage] }, newId: stage.id! };
}

/** Index of the stage containing the node (0 = sustainer), or -1. */
export function stageIndexOf(tree: RocketTree, id: string): number {
  const contains = (n: ComponentNode): boolean =>
    n.id === id || (n.children ?? []).some(contains);
  return tree.components.findIndex((s) => s.id === id || (s.children ?? []).some(contains));
}

export function findParent(tree: RocketTree, id: string): ComponentNode | 'stage' | null {
  // 'stage' now means "the rocket root" — only stage nodes live there.
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

/** Adds a child to the given parent id ('stage' = the FIRST stage, legacy). */
export function addChild(tree: RocketTree, parentId: string | 'stage', child: ComponentNode): RocketTree {
  if (parentId === 'stage') {
    const first = stages(tree)[0];
    if (!first) return { ...tree, components: [...tree.components, child] };
    parentId = first.id!;
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

function cloneSubtree(node: ComponentNode): ComponentNode {
  return {
    ...node,
    id: freshId(),
    children: node.children?.map(cloneSubtree),
  } as ComponentNode;
}

/**
 * Deep-copies a node (fresh ids throughout) and inserts the copy right after
 * the original among its siblings. Returns the new tree and the copy's id.
 */
export function duplicateNode(tree: RocketTree, id: string): { tree: RocketTree; newId: string | null } {
  let newId: string | null = null;
  const walk = (nodes: ComponentNode[]): ComponentNode[] => {
    const idx = nodes.findIndex((n) => n.id === id);
    if (idx >= 0) {
      const copy = cloneSubtree(nodes[idx]!);
      copy.name = nodes[idx]!.name ? `${nodes[idx]!.name} (copy)` : copy.name;
      newId = copy.id!;
      return [...nodes.slice(0, idx + 1), copy, ...nodes.slice(idx + 1)];
    }
    return nodes.map((n) => (n.children ? ({ ...n, children: walk(n.children) } as ComponentNode) : n));
  };
  return { tree: { ...tree, components: walk(tree.components) }, newId };
}

/** Applies a patch to EVERY node that carries the patched fields. */
export function updateAllNodes(tree: RocketTree, patch: Partial<ComponentNode>): RocketTree {
  const keys = Object.keys(patch);
  const walk = (nodes: ComponentNode[]): ComponentNode[] =>
    nodes.map((n) => {
      const applicable = keys.every((k) => FIELDS[n.type]?.some((f) => f.key === k));
      const next = applicable ? ({ ...n, ...patch } as ComponentNode) : n;
      return next.children ? ({ ...next, children: walk(next.children) } as ComponentNode) : next;
    });
  return { ...tree, components: walk(tree.components) };
}

/** The radius a component presents at its AFT end (for chain continuity). */
function aftRadiusOf(n: ComponentNode): number | null {
  if (typeof n['aftRadius'] === 'number') return n['aftRadius'] as number;
  if (typeof n['outerRadius'] === 'number') return n['outerRadius'] as number;
  return null;
}

/**
 * New components default to the specs of the component they follow: outer
 * diameter continues the airframe line, and material/finish carry over
 * (from the previous sibling, else the parent).
 */
export function inheritDefaults(
  node: ComponentNode,
  parent: ComponentNode | 'stage' | null,
  prevSibling: ComponentNode | null,
): ComponentNode {
  const src = prevSibling ?? (parent && parent !== 'stage' && parent.type !== 'stage' ? parent : null);
  if (!src) return node;
  const out: ComponentNode = { ...node };

  const fields = FIELDS[node.type] ?? [];
  for (const key of ['density', 'materialName', 'finish'] as const) {
    // materialName has no FIELDS entry; it travels with density — only copy
    // it onto types that can hold the matching density.
    const applies = key === 'materialName'
      ? fields.some((f) => f.key === 'density')
      : fields.some((f) => f.key === key);
    if (src[key] !== undefined && applies) {
      (out as Record<string, unknown>)[key] = src[key];
    }
  }

  // Airframe diameter continuity along the top-level chain.
  const srcAft = aftRadiusOf(src);
  if (srcAft !== null) {
    if (node.type === 'bodytube') out['outerRadius'] = srcAft;
    if (node.type === 'transition') out['foreRadius'] = srcAft;
  }
  // Tube walls: carry the previous tube's thickness.
  if (typeof src['thickness'] === 'number'
      && (node.type === 'bodytube' || node.type === 'innertube' || node.type === 'tubecoupler')
      && fields.some((f) => f.key === 'thickness')) {
    out['thickness'] = src['thickness'];
  }
  return out;
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

/** A blank design — one empty stage — for starting from scratch. */
export function emptyTree(): RocketTree {
  return { name: 'New Rocket', components: [makeStage('Sustainer')] };
}

/** The default (reference) rocket as a tree. */
export function defaultTree(): RocketTree {
  const nose = makeNode('nosecone');
  const body = { ...makeNode('bodytube'), length: 0.3, thickness: 0.0003, density: 950 } as ComponentNode;
  const fins = makeNode('trapezoidfinset');
  const mount = makeNode('innertube');
  const chute = makeNode('parachute');
  return normalizeTree({
    name: 'My Rocket',
    components: [nose, { ...body, children: [fins, mount, chute] } as ComponentNode],
  });
}
