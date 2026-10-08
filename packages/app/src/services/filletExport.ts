import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { num, numOpt } from '../tree/nodeNum.js';

/** These formats can carry mass figures, but neither writer carries fillet inputs. */
export function filletExportNotes(tree: RocketTree, format: '.rkt' | '.CDX1'): string[] {
  const hasFillets = (nodes: ComponentNode[]): boolean => nodes.some((node) =>
    (['trapezoidfinset', 'ellipticalfinset', 'freeformfinset'].includes(node.type)
    && (num(node, 'filletRadius', 0) > 0
      || (numOpt(node, 'filletDensity') !== undefined && num(node, 'filletDensity', 680) !== 680)
      || (typeof node['filletMaterialName'] === 'string' && node['filletMaterialName'] !== 'Cardboard')))
    || hasFillets(node.children ?? []));
  return hasFillets(tree.components)
    ? [`Fin fillet radius and material are not saved in ${format}; recalculated mass and CG may change. Save a .ork file to keep them.`]
    : [];
}
