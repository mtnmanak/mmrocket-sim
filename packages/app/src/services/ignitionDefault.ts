import type { IgnitionEvent, RocketTree } from '@online-openrocket/engine';
import { findParent, stageIndexOf, stages } from '../tree/treeModel.js';
import { isBlackPowder } from './motorDb.js';

/**
 * WHAT LIGHTS AN UPPER-STAGE MOTOR — the default this app gives a motor the
 * moment it is assigned to a mount.
 *
 * ⚠ THIS REPLACED A POWER-CLASS TEST, and the rule it replaced was wrong.
 * Through v0.134 a motor dropped into the sustainer of a staged rocket was
 * given electronics-timed ignition if it was "high power" (over 80 N average
 * or 160 Ns). Eric struck that on 2026-09-18, in his own words:
 *
 *   "It is NOT a high-power vs. low/mid-power question. The differentiation is
 *    in the propellant of the motor, not its classification. A black powder
 *    motor can be ignited from the booster's ejection charge, but a composite
 *    motor can NOT. So, MANY low and mid power motors that are composites still
 *    require electronic ignition."
 *
 * Two further things he pointed out, both of which the old rule got wrong in
 * the same breath: a black powder cluster can exceed the high-power thresholds
 * and still light off an ejection charge; and power class is a property of the
 * WHOLE ROCKET's total impulse, not of one stage's motor — four stacked F-15s
 * make a high-power rocket out of four low-power stages, and every one of those
 * stages is still lit by the charge below it.
 *
 * So the question is only ever: can the charge below light this grain?
 */
export interface IgnitionDefaultInput {
  /** The mount the motor is being assigned to. */
  mountId: string;
  /** The propellant name from the catalogue, if it records one. */
  propellant?: string;
}

/**
 * The default ignition for a newly assigned motor. Pure, so it can be tested;
 * App calls it at assignment time only, and never rewrites a stored design.
 */
export function ignitionDefaultFor(
  tree: RocketTree,
  { mountId, propellant }: IgnitionDefaultInput,
): { event: IgnitionEvent; delay: number } {
  const automatic = { event: 'automatic' as IgnitionEvent, delay: 0 };

  /*
   * A strap-on is a LAUNCH stage, whatever it hangs off. The kernel makes any
   * active parallel stage a launch stage (ParallelStage.isLaunchStage), so its
   * motor resolves to LAUNCH under AUTOMATIC and a burnout-keyed default there
   * would be wrong — both before this change and after it. Same walk
   * flightPipeline uses to name a parallel branch.
   */
  let p = findParent(tree, mountId);
  while (p && p !== 'stage') {
    if (p.type === 'parallelstage') return automatic;
    p = p.id ? findParent(tree, p.id) : null;
  }

  /*
   * EVERY stage above the launch stage, not only the top one. A three-stage
   * rocket's middle stage is lit by the stage below exactly as the sustainer
   * is, and used to be given `automatic` whatever it burned. Index 0 is the
   * TOP stage, so the launch stage is the last one.
   */
  const idx = stageIndexOf(tree, mountId);
  const aboveLaunchStage = idx >= 0 && idx < stages(tree).length - 1;
  if (!aboveLaunchStage) return automatic;

  // Black powder takes from the charge below; anything else needs an igniter.
  if (isBlackPowder({ propInfo: propellant })) return automatic;

  /*
   * UNKNOWN PROPELLANT LANDS HERE DELIBERATELY. 223 of the catalogue's 1,156
   * rows record no propellant at all (2026-09-19), 97 of them still in
   * production and most of those Contrail and Hypertek hybrids — which need an
   * igniter in any case. So does every motor imported from a .eng or .rse file:
   * neither format has a field for one. The two wrong answers do not cost the
   * same:
   *
   *  - guess `automatic` on a motor that is really composite and the app flies
   *    a sustainer burn the hardware cannot produce, and nothing in the report
   *    contradicts it;
   *  - guess `burnout` on one that really is black powder and the sustainer
   *    lights a second late — visible in the plot, and one dropdown to fix.
   *
   * So an unrecorded propellant is treated as needing an igniter.
   */
  return { event: 'burnout', delay: 1 };
}
