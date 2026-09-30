import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { numOrNull } from './nodeNum.js';
import { findNode, motorMounts, stageIndexOf, stages, updateNode } from './treeModel.js';

/** SI metres, shared by the browser and Batch. Zero is a real limit. */
export function motorLengthLimit(mount: ComponentNode | null | undefined): number | null {
  const value = mount ? numOrNull(mount, 'maxMotorLength') : null;
  return value !== null && value >= 0 ? value : null;
}

export interface LegacyMotorLengths {
  motorLengthLimitsMigrated?: boolean;
  maxMotorLengthByStage?: Record<string, number | null>;
  maxMotorLengthM?: number | null;
}

/** Read old session keys once; an empty stage map suppresses older fallbacks. */
export function legacyStageLimits(tree: RocketTree, session: LegacyMotorLengths | null, filterLimit: number | null): Record<string, number | null> {
  if (!session || session.motorLengthLimitsMigrated) return {};
  if (session.maxMotorLengthByStage) return session.maxMotorLengthByStage;
  const value = 'maxMotorLengthM' in session ? session.maxMotorLengthM ?? null : filterLimit;
  return value === null ? {} : Object.fromEntries(stages(tree).map((s) => [s.id!, value]));
}

/** Preserve a mount's own setting; never edit the restored tree in place. */
export function migrateMotorLengths(tree: RocketTree, limits: Record<string, number | null>): RocketTree {
  let result = tree;
  const stageList = stages(tree);
  for (const mount of motorMounts(tree)) {
    const value = limits[stageList[stageIndexOf(tree, mount.id!)]?.id ?? ''];
    if (value == null || !Number.isFinite(value) || value < 0) continue;
    if (motorLengthLimit(findNode(tree, mount.id!)) !== null) continue;
    result = updateNode(result, mount.id!, { maxMotorLength: value });
  }
  return result;
}

export function motorLengthLossNotes(tree: RocketTree, format: string): string[] {
  return motorMounts(tree).some((m) => motorLengthLimit(m) !== null)
    ? [`Maximum motor length settings are not saved in ${format}. Save a .ork file to keep them.`]
    : [];
}
