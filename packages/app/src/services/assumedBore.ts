import type { RocketTree } from '@online-openrocket/engine';
import { numOpt } from '../tree/nodeNum.js';

/** Released RASAero imports invented a 2 mm wall before recording its origin. */
export function recoverAssumedBores(tree: RocketTree, rasaeroOrigin: boolean): RocketTree {
  if (!rasaeroOrigin) return tree;
  const marked = (nodes: RocketTree['components']): boolean => nodes.some(n =>
    typeof n['boreAssumed'] === 'boolean' || marked(n.children ?? []));
  // A marked design already records provenance. Unmarked siblings can be
  // measured tubes added later, even when their wall happens to be 2 mm.
  if (marked(tree.components)) return tree;
  const mark = (nodes: RocketTree['components']): RocketTree['components'] => nodes.map(n => ({ ...n,
    // An explicit false records the user's measured wall, including 2 mm.
    ...(n.type === 'bodytube' && n['boreAssumed'] === undefined && numOpt(n, 'thickness') === 0.002 ? { boreAssumed: true } : {}),
    ...(n.children ? { children: mark(n.children) } : {}),
  }));
  return { ...tree, components: mark(tree.components) };
}
