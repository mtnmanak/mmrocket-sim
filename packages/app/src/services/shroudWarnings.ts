import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { shroudKernelName } from '../tree/treeModel.js';

/** Keep ambiguous sources: real fins must retain their accuracy warning. */
export function shroudWarningFilter(tree: RocketTree): (text: string) => boolean {
  const shrouds = new Set<string>();
  const fins = new Set<string>();
  const defaults: Partial<Record<ComponentNode['type'], string>> = {
    trapezoidfinset: '[TrapezoidFinSet.TrapezoidFinSet]',
    ellipticalfinset: '[EllipticalFinSet.Ellipticalfinset]',
    freeformfinset: '[FreeformFinSet.FreeformFinSet]',
  };
  const visit = (nodes: ComponentNode[]) => {
    for (const node of nodes) {
      if (node.type === 'fairing') shrouds.add(shroudKernelName(node));
      const fallback = defaults[node.type];
      if (fallback) fins.add(node.name?.trim() ? node.name : fallback);
      visit(node.children ?? []);
    }
  };
  visit(tree.components);
  for (const name of fins) shrouds.delete(name);
  return text => {
    const name = /^\[Warning\.THICK_FIN\]:\s*"([\s\S]*)"$/.exec(text)?.[1];
    return name === undefined || name.includes('"') || !shrouds.has(name);
  };
}
