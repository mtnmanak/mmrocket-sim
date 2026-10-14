import type { ComponentNode, RocketTree } from '@online-openrocket/engine';

/** C-B20: view state only; never remove nodes from the physical tree. */
export function hiddenPartIds(tree: RocketTree, hiddenIds?: ReadonlySet<string>): ReadonlySet<string> {
  const result = new Set<string>();
  if (!hiddenIds?.size) return result;
  const walk = (nodes: readonly ComponentNode[], inherited = false): void => {
    for (const node of nodes) {
      const hidden = inherited || (!!node.id && hiddenIds.has(node.id));
      if (hidden && node.id) result.add(node.id);
      walk(node.children ?? [], hidden);
    }
  };
  walk(tree.components);
  return result;
}

/** Showing a child also shows its ancestors; separately hidden siblings stay hidden. */
export function togglePartVisibility(tree: RocketTree, hiddenIds: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const pathTo = (nodes: readonly ComponentNode[], path: string[]): string[] | null => {
    for (const node of nodes) {
      const next = node.id ? [...path, node.id] : path;
      if (node.id === id) return next;
      const found = pathTo(node.children ?? [], next);
      if (found) return found;
    }
    return null;
  };
  const path = pathTo(tree.components, []);
  if (!path) return hiddenIds;
  const next = new Set(hiddenIds);
  if (path.some(part => hiddenIds.has(part))) {
    for (const part of path) next.delete(part);
  } else {
    next.add(id);
  }
  return next;
}
