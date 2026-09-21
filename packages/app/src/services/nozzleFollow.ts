import type { RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../App.js';
import { clusterCount } from '../tree/cluster.js';
import { findNode, kernelStageIdByNode, stages } from '../tree/treeModel.js';

/**
 * THE NOZZLE EXIT DIAMETER FOLLOWS THE MOTOR.
 *
 * Eric's ruling, 2026-09-13, and the two reports behind it:
 *
 *   "unloading the motor keeps the old exit diameter value — there is no motor
 *    loaded, how can there be an exit diameter?"
 *
 *   "loading a commercial motor that we know the exit diameter triggers a
 *    warning, but does not replace the value — this could be a big problem if
 *    the user does not see the warning ... I know that we said we would not
 *    over write a user's input into the "Nozzle Exit Diameter" field, but we
 *    have to also realize the info is per motor, not per rocket. So, if a user
 *    inputs a number into that field and then changes the motor, that field
 *    would have to change as well since the value they input was for the
 *    previous motor, not the one they just loaded."
 *
 * That SUPERSEDES the v0.122 rule that a typed value is never overwritten. The
 * old rule was right about where the number comes from and wrong about what it
 * belongs to: the exit diameter is a property of the NOZZLE, the nozzle comes
 * with the MOTOR, and the field lives on the stage only because that is where
 * the kernel charges it. A value left behind by the previous motor is not the
 * user's data about this one — it is a number about hardware that is no longer
 * in the rocket, and since v0.119 it buys thrust as the air thins, so it
 * overstates apogee for a flight nobody checked.
 *
 * WHAT THIS MODULE DOES NOT DECIDE: whether the motors changed. That is the
 * caller's job, and it matters — OPENING A FILE is not a motor change. A
 * RASAero or .ork file arrives with a nozzle AND the motor it was typed for,
 * and replacing it on load would throw away the one case the old rule was
 * written for (a tester's file gave the N1000W a 2.737 in exit where AeroTech's
 * drawing says 1.750). App seeds its per-stage record on first sight and acts
 * only on a CHANGE, so a load seeds and a motor swap fires.
 */

/** One stage and the motors currently loaded in it, cluster counts included. */
export interface StageMotors {
  stageId: string;
  stageName: string;
  /** In mount order. A cluster is ONE entry with `count` above 1. */
  motors: { mountId: string; motorId: string; count: number; label: string }[];
}

/**
 * Every stage in the tree with the motors loaded in it — including stages with
 * no motor at all, because "the motor was removed" is the change this whole
 * module exists to notice and a stage that vanished from the list would look
 * like one that never changed.
 *
 * `assigned` is App's own pairing, already filtered to mounts the tree still
 * has, so a stale record cannot name a stage. Joined by stage ID rather than
 * index for the reason `stageIdByNode` spells out.
 */
export function stageMotors(
  tree: RocketTree,
  assigned: readonly (readonly [string, MountMotor])[],
): StageMotors[] {
  // KERNEL ownership, not the app's grouping (2026-09-21). A mount inside a
  // parallel stage belongs to THAT stage for pressure thrust and power-on base
  // drag, so its exit area must not be summed into the serial stage hosting
  // it: the core was being credited a strap-on's nozzle, and only while the
  // core's own motor burned. A parallel stage is not in `stages(tree)`, so its
  // motors drop out of this list entirely — which is the honest outcome until
  // the field exists on a parallel stage (board: the parallel-stage nozzle).
  const stageOfNode = kernelStageIdByNode(tree);
  const byStage = new Map<string, StageMotors['motors']>();
  for (const [mountId, mm] of assigned) {
    const stageId = stageOfNode.get(mountId);
    if (stageId === undefined) continue;
    // An EX motor carries `exMotorId`, never `motorId` (MotorBrowser pins the
    // library entry that way so an .ork export names the right vendor). Reading
    // only `motorId` made every imported motor INVISIBLE here: the stage read
    // as empty, the panel said no motor was loaded, and a motor file's own
    // exit diameter could never reach the field. Since 2026-09-21 an EX motor
    // can publish an exit of its own, so it has to be in this list to do it.
    const motorId = mm.meta.motorId ?? mm.meta.exMotorId;
    if (typeof motorId !== 'string' || !motorId) continue;
    const list = byStage.get(stageId) ?? [];
    list.push({
      mountId,
      motorId,
      count: clusterCount(findNode(tree, mountId)?.['cluster'] as string | undefined),
      label: mm.label,
    });
    byStage.set(stageId, list);
  }
  const out: StageMotors[] = [];
  stages(tree).forEach((s, i) => {
    // A stage with no id cannot be named on either side of the join, and
    // `applyStageNozzles` could not write to it either.
    if (!s.id) return;
    out.push({
      stageId: s.id,
      stageName: s.name ?? `Stage ${i + 1}`,
      motors: (byStage.get(s.id) ?? []).sort((a, b) => a.mountId.localeCompare(b.mountId)),
    });
  });
  return out;
}

/**
 * A stage's motor loadout as one comparable string.
 *
 * The COUNT is part of it, not only the ids: turning a single motor into a
 * cluster of four changes the equivalent exit by a factor of two, and a key
 * that ignored the count would leave the stage flying one motor's nozzle for
 * four. Mount ids are in the key as well, so moving the same motor to a
 * different mount within the stage does not read as "unchanged" when the two
 * mounts have different cluster counts.
 */
export function stageMotorKey(s: StageMotors): string {
  return s.motors.map((m) => `${m.mountId}:${m.motorId}x${m.count}`).join('|');
}

/**
 * The SINGLE EQUIVALENT nozzle for a stage — exit AREAS summed, then back to a
 * diameter — or null when the stage has no motors or any of them has no
 * published figure.
 *
 * WHY THE SUM, and why this is a fix rather than a refinement. `schema.ts`
 * defines the field as "the single equivalent nozzle (sum the exit AREAS)" and
 * `nozzleCheck.ts` bounds it by `sqrt(sum of count x casing^2)` for exactly
 * that reason. The auto-fill added in v0.122 did neither: it took the FIRST
 * motor in the stage with a published figure and wrote that diameter in,
 * whatever the cluster count. A 4 x 29 mm cluster of I-motors was therefore
 * filled with ONE motor's exit — a quarter of the area the stage really has,
 * and so a quarter of the pressure-thrust term it should collect. The comment
 * beside it ("a cluster of identical motors is still one nozzle") was the
 * mistake: it is one EQUIVALENT nozzle, and an equivalent of four is twice the
 * diameter of one.
 *
 * NULL WHEN ANY MOTOR IS UNKNOWN, deliberately. A mixed stage where only one
 * motor has a published exit would otherwise be filled with a sum that is
 * short by the motors it could not see, and a number that is quietly too small
 * is worse than a blank field the user is asked to fill: the blank is visible.
 */
export function equivalentExitDiameterM(
  parts: readonly { count: number; exitDiameterM: number | null }[],
): number | null {
  if (parts.length === 0) return null;
  let area = 0;
  for (const p of parts) {
    if (p.exitDiameterM === null || !Number.isFinite(p.exitDiameterM) || p.exitDiameterM <= 0) return null;
    if (!Number.isFinite(p.count) || p.count < 1) return null;
    area += p.count * p.exitDiameterM * p.exitDiameterM;
  }
  return Math.sqrt(area);
}

/** What to do to one stage's nozzle now that its motors have changed. */
export type NozzleFollow =
  | { kind: 'set'; exitDiameterM: number }
  | { kind: 'clear'; previousLabel: string; previousM: number }
  | { kind: 'none' };

/**
 * 0.05 mm — the same slop the panel uses to decide whether a value "disagrees"
 * with the published one. Finer than any drawing states, coarse enough that a
 * value that went out to the box in millimetres and came back does not read as
 * a change worth writing.
 */
const SAME_M = 0.00005;

/**
 * THE WHOLE DECISION, for one stage whose motors have just changed.
 *
 * Pure, and separate from App, because the interesting part is not the
 * bookkeeping — it is WHEN the rule applies, and that has one case which is
 * easy to get wrong and impossible to see in a render.
 *
 * `hadMotorsBefore` is that case. Eric's rule is "the value they input was for
 * the PREVIOUS MOTOR", and if the stage had no previous motor then the value in
 * the field was never a motor's: it is a nozzle a file carried without one, or
 * a number typed before a motor was chosen. That is the user's own data about
 * the rocket in front of them, so nothing here touches it — the panel's
 * fill-an-empty-field and show-the-disagreement rules deal with it exactly as
 * they did before. Without this gate, opening a RASAero file that states a
 * nozzle but no resolvable motor and then loading the motor by hand would have
 * silently replaced the file's own number, which is the one outcome the
 * do-not-overwrite rule exists to prevent.
 */
export function followNozzle(input: {
  /** Did this stage hold a motor BEFORE the change? */
  hadMotorsBefore: boolean;
  /** What that motor was called, for the notice. */
  previousLabel: string;
  /** The stage's stored exit diameter (m), or null when the field is empty. */
  currentValueM: number | null;
  /** The equivalent published exit for the motors now loaded, or null. */
  publishedM: number | null;
}): NozzleFollow {
  const { hadMotorsBefore, previousLabel, currentValueM, publishedM } = input;
  if (!hadMotorsBefore) return { kind: 'none' };
  if (publishedM !== null) {
    if (currentValueM !== null && Math.abs(currentValueM - publishedM) <= SAME_M) return { kind: 'none' };
    return { kind: 'set', exitDiameterM: publishedM };
  }
  // Nothing published for what is loaded now, and what is in the field belongs
  // to what was loaded before. Clearing is the honest answer: blank turns the
  // pressure-thrust term and the power-on drag reduction off, which is what
  // "we do not know this motor's nozzle" means.
  if (currentValueM === null) return { kind: 'none' };
  return {
    kind: 'clear',
    previousLabel: previousLabel || 'the previous motor',
    previousM: currentValueM,
  };
}
