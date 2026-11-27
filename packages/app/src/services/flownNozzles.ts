import type { RocketTree } from '@online-openrocket/engine';
import { numOrNull } from '../tree/nodeNum.js';
import { applyStageNozzles, findNode } from '../tree/treeModel.js';
import { equivalentExitDiameterM, type StageMotors } from './nozzleFollow.js';
import type { AeroState } from './designDerivation.js';

export type PublishedExitLookup = (motorId: string) => number | null | undefined;

/** A failed catalogue chunk matters only to a stage whose EX exits are usable. */
export function nozzleLoadAffectsFlight(
  tree: RocketTree, loadout: readonly StageMotors[], lookup: PublishedExitLookup,
  aero: Pick<AeroState, 'aeroMode' | 'effectiveKbf'>,
): boolean {
  if (aero.aeroMode === 'classic' && !aero.effectiveKbf) return false;
  return loadout.some(stage => {
    const node = findNode(tree, stage.stageId);
    return node !== null && numOrNull(node, 'nozzleExitDiameter') === null
      && stage.motors.some(m => !m.motorId.startsWith('ex:'))
      && stage.motors.every(m => !m.motorId.startsWith('ex:') || lookup(m.motorId) != null);
  });
}

/** Resolve automatic exits on a flight copy only. Never persist this tree. */
export function withFlownNozzles<T extends RocketTree>(
  tree: T, loadout: readonly StageMotors[], publishedExitM: PublishedExitLookup,
): { tree: T; unresolved: boolean } {
  const updates: Record<string, number> = Object.create(null) as Record<string, number>;
  let unresolved = false;
  for (const stage of loadout) {
    const node = findNode(tree, stage.stageId);
    if (!node || numOrNull(node, 'nozzleExitDiameter') !== null || stage.motors.length === 0) continue;
    const exit = equivalentExitDiameterM(stage.motors.map(motor => {
      const diameter = publishedExitM(motor.motorId);
      if (diameter === undefined) unresolved = true;
      return { count: motor.count, exitDiameterM: diameter ?? null };
    }));
    if (exit !== null) updates[stage.stageId] = exit;
  }
  return { tree: Object.keys(updates).length ? applyStageNozzles(tree, updates) as T : tree, unresolved };
}
