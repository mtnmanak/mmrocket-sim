import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { clusterCount } from '../tree/cluster.js';
import { num } from '../tree/nodeNum.js';

const fins = new Set(['trapezoidfinset', 'ellipticalfinset', 'freeformfinset', 'tubefinset']);
const asymmetricParts = new Set(['fairing', 'protuberance', 'launchlug', 'railbutton']);

/**
 * Conservative eligibility for the true-CG roll correction, evaluated on the
 * saved run's tree. This is not a claim that its numerical result changed:
 * symmetric layouts and already-correct ballast are intentionally included.
 * Motor schedules, separation and overrides can destroy launch-time symmetry.
 */
export function affectsRollInertia(tree: RocketTree): boolean {
  const affected = (node: ComponentNode): boolean => {
    if (node.type === 'podset' || node.type === 'parallelstage') return true;
    if (num(node, 'radialPosition', 0) !== 0 || num(node, 'radiusOffset', 0) !== 0) return true;
    if (asymmetricParts.has(node.type)) return true;
    if (fins.has(node.type) && Math.trunc(num(node, 'finCount', node.type === 'tubefinset' ? 6 : 3)) <= 1) return true;
    if (node.type === 'innertube'
      && clusterCount(typeof node['cluster'] === 'string' ? node['cluster'] : undefined) > 1
      && num(node, 'clusterScale', 1) !== 0) return true;
    return node.children?.some(affected) ?? false;
  };
  return tree.components.some(affected);
}
