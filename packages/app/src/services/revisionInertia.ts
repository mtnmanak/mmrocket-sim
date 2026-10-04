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
/**
 * Whether anything in the tree can drive roll: a fin set with a nonzero cant.
 * Roll torque in the kernel comes only from fin cant, and roll damping only from
 * a roll rate, so a flight with no canted fin never rolls and its trajectory
 * does not depend on the roll inertia at all — only the reported Ir does. The
 * saved-run revision for the true-CG roll inertia is gated on this, so v0.143
 * runs on uncanted designs are not sent back for a Launch that changes nothing.
 */
export function hasRollForcing(tree: RocketTree): boolean {
  const canted = (node: ComponentNode): boolean =>
    (fins.has(node.type) && num(node, 'cant', 0) !== 0) || (node.children?.some(canted) ?? false);
  return tree.components.some(canted);
}

export function affectsRollInertia(tree: RocketTree): boolean {
  const affected = (node: ComponentNode): boolean => {
    if (node.type === 'podset' || node.type === 'parallelstage') return true;
    if ((node.type === 'innertube' || node.type === 'masscomponent')
      && num(node, 'radialPosition', 0) !== 0) return true;
    if (num(node, 'radiusOffset', 0) !== 0) return true;
    if (asymmetricParts.has(node.type)) return true;
    if (fins.has(node.type) && Math.trunc(num(node, 'finCount', node.type === 'tubefinset' ? 6 : 3)) <= 1) return true;
    if (node.type === 'innertube'
      && clusterCount(typeof node['cluster'] === 'string' ? node['cluster'] : undefined) > 1
      && num(node, 'clusterScale', 1) !== 0) return true;
    return node.children?.some(affected) ?? false;
  };
  return tree.components.some(affected);
}
