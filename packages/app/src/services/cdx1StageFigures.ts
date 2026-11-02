import { OrkRocket, type MotorSpec, type RocketTree } from '@online-openrocket/engine';
import { asStageNodes, engineTree } from '../tree/treeModel.js';
import { resolveTransitionRadii } from '../tree/transitionRadii.js';

export interface Cdx1StageFigures { mass: number; cg: number }

/** Cumulative loaded figures, measured from the nose, just as SimulationHandler inverts them. */
export function cdx1StageFigures(
  tree: RocketTree, motors: Readonly<Record<string, MotorSpec>>, full: Cdx1StageFigures,
): Cdx1StageFigures[] {
  // Resolve against the intact stack: removing a lower stage can resize an
  // automatic transition above it, changing the mass we meant to measure.
  const stages = asStageNodes(resolveTransitionRadii(engineTree(tree)));
  return stages.map((_, i) => {
    if (i === stages.length - 1) return full;
    const components = stages.slice(0, i + 1);
    const ids = new Set<string>();
    const walk = (nodes: typeof components) => { for (const n of nodes) {
      if (n.id) ids.add(n.id);
      walk(n.children ?? []);
    } };
    walk(components);
    // Do not reset the engine here: the Design page's live handle still belongs to it.
    const rocket = OrkRocket.buildTree({ ...tree, components });
    for (const [id, spec] of Object.entries(motors)) if (ids.has(id)) rocket.setMotorById(id, spec);
    const info = rocket.staticInfo();
    return { mass: info.mass, cg: info.cg };
  });
}
