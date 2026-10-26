import { highestTier, withoutLines } from './importNotes.js';
import { overrideFor } from './flightState.js';
import type { MotorSpec, RocketTree } from '@online-openrocket/engine';
import { savedConfigLabel, type MountMotor, type SavedConfig } from '../model/design.js';
import { motorMounts, primaryMountOf } from '../tree/treeModel.js';
import { adoptsRefPadMass, assignMotorRecord } from './configSync.js';
import { ignitionDefaultFor } from './ignitionDefault.js';
import { attachedOf } from './importApply.js';
import type { HeldNote } from './notices.js';
import type { NoteTier } from '../components/Note.js';
import type { OrkMotorRef } from './orkFile.js';
import type { MotorMeta } from './simReport.js';
import { reconcileIncludedMotor, type StatedWeightText } from './statedLaunchWeight.js';
import { baseLabel } from './unitText.js';

interface MotorAssignmentInput {
  tree: RocketTree;
  targetMountId: string;
  label: string;
  spec: MotorSpec;
  meta: MotorMeta;
  refs: Record<string, OrkMotorRef>;
  savedConfigs: readonly SavedConfig[];
  activeConfigId: string | null;
  massText: (kg: number) => string;
  statedWeightText: StatedWeightText;
}

/**
 * Decisions only: App reads its live tree/references after the motor fetch and
 * applies these effects in order (audit 2026-10-11, S2-8). A RASAero correction
 * stays separate so its note wins over a pad-mass note, and a stale mark can
 * advance the tree without adding an invisible undo step.
 */
export function planMotorAssignment(input: MotorAssignmentInput) {
  const { tree, targetMountId, label, spec, meta, refs, savedConfigs, activeConfigId, massText, statedWeightText } = input;
  const fresh: MountMotor = { label, spec, meta,
    ignition: ignitionDefaultFor(tree, { mountId: targetMountId, propellant: meta.propellant }) };
  const droppedRef = overrideFor(refs, targetMountId);
  const { [targetMountId]: _dropped, ...remainingRefs } = refs;
  const repairedConfig = savedConfigs.find(c => c.id === activeConfigId && c.motorLoadoutRefusal);
  const repairNotice = repairedConfig ? {
    id: `motor-loadout-repaired:${repairedConfig.id}`,
    severity: 'warn' as const,
    text: `Your motor assignment replaces the ambiguous imported loadout for “${savedConfigLabel(repairedConfig)}”. `
      + 'Check all motor assignments before launching.',
  } : undefined;
  let padMassNote: string | undefined;
  // Each note's tier is set here, by the branch that writes it (D7 §4):
  // carrying the file's weighing over is a receipt; losing it is I16 Caution,
  // as the open's and the restore's own pad-mass-dropped lines are.
  let padMassTier: NoteTier | undefined;
  const adoptedKg = adoptsRefPadMass(droppedRef, spec.designation);
  if (adoptedKg !== undefined) {
    padMassNote = `The file's weighed pad mass (${massText(adoptedKg)}) was weighed with ${droppedRef!.designation},`
      + ` which is loaded now — it sits under ${baseLabel(label)} on this mount, and the line there says what`
      + ' it carries.';
    padMassTier = 'information';
  } else if (droppedRef && typeof droppedRef.padMassKg === 'number' && droppedRef.padMassKg > 0) {
    padMassNote = `The weighed pad mass in the file was weighed with ${droppedRef.designation}, which is not the`
      + ` motor now loaded — re-weigh with ${label} in.`;
    padMassTier = 'caution';
  }
  const reconciliation = reconcileIncludedMotor(tree, targetMountId, attachedOf(spec), statedWeightText);
  return { fresh, droppedRef, remainingRefs, repairedConfig, repairNotice, padMassNote, padMassTier,
    reconciliation,
    // The reconcile's own severity is its line's tier, the rule
    // reconcileAllIncludedMotors applies on the open and a switch (D7 I17).
    reconciliationTier: (reconciliation?.severity === 'warn' ? 'caution' : 'information') as NoteTier };
}

/** Re-derive the primary inside App's updater: two fetched picks can land in one flush. */
export function assignMotorRecords(
  prev: Record<string, MountMotor>, tree: RocketTree, targetMountId: string,
  plan: Pick<ReturnType<typeof planMotorAssignment>, 'fresh' | 'droppedRef' | 'remainingRefs'>,
): Record<string, MountMotor> {
  return assignMotorRecord(prev, targetMountId, plan.fresh, {
    tree,
    primaryMountId: primaryMountOf(tree, motorMounts(tree)
      .map((m) => m.id).filter((id): id is string => typeof id === 'string' && Object.hasOwn(prev, id))),
    droppedRef: plan.droppedRef,
    remainingRefs: plan.remainingRefs,
  });
}

/** Retire only this configuration's obsolete refusal, preserving the rest of the import note. */
export function retireLoadoutNote(prev: HeldNote | null, repairedConfig: SavedConfig): HeldNote | null {
  if (!prev) return prev;
  const text = prev.text.split('\n').filter(line => line !== repairedConfig.motorLoadoutRefusal).join('\n');
  if (!text) return null;
  // The group loses the same line; every other line keeps its tier.
  const group = prev.group && repairedConfig.motorLoadoutRefusal
    ? withoutLines(prev.group, new Set([repairedConfig.motorLoadoutRefusal])) : prev.group;
  return { ...prev, text, ...(group ? { group } : {}),
    ...(group && prev.severity === 'warn' && highestTier(group.lines) === 'information'
      && !group.lines.some(l => l.text.startsWith('Warning: this file uses format ')) ? { severity: 'info' } : {}) };
}
