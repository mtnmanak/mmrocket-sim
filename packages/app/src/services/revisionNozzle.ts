import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { nozzleStages } from '../tree/treeModel.js';

const isMount = (n: ComponentNode) =>
  (n.type === 'bodytube' || n.type === 'innertube') && n['motorMount'] === true;

/** Conservative tree-only predicate; does not await motors or published exits. */
export function affectsStrapOnNozzle(tree: RocketTree): boolean {
  const ownsMount = (nodes: ComponentNode[]): boolean => nodes.some((n) =>
    n.type !== 'parallelstage' && n.type !== 'stage'
    && (isMount(n) || ownsMount(n.children ?? [])));
  return nozzleStages(tree).some((s) => {
    const d = s['nozzleExitDiameter'];
    return s.type === 'parallelstage' && (
      (typeof d === 'number' && Number.isFinite(d) && d > 0) || ownsMount(s.children ?? []));
  });
}

/** Includes mixed/empty loadouts: ownership resets at every stage boundary. */
export function affectsPodsOnlyBase(tree: RocketTree): boolean {
  const walk = (nodes: ComponentNode[], inPod: boolean): boolean => nodes.some((n) => {
    if (n.type === 'parallelstage' || n.type === 'stage') return false;
    const pod = inPod || n.type === 'podset';
    return (pod && isMount(n)) || walk(n.children ?? [], pod);
  });
  return nozzleStages(tree).some((s) => walk(s.children ?? [], false));
}
