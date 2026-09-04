import type { MotorSpec, RocketTree, StaticInfo } from '@online-openrocket/engine';
import { clusterCount } from '../tree/cluster.js';
import { findNode, hasParallelStage, stageIndexOf, stages } from '../tree/treeModel.js';

/**
 * RECOVERY WEIGHT — the mass that actually comes down under the recovery
 * device, which is neither of the two masses this app used to show.
 *
 * "Mass (empty)" is the bare structure and "Mass (loaded)" is what sits on the
 * pad; the number a parachute is sized against is between them — dry structure
 * PLUS the SPENT motor casing, because the propellant is gone by apogee.
 *
 * This is not a rounding-error distinction. The owner's Wildman only
 * reproduced its measured drogue descent rate at the simulation's own landing
 * mass of 8.786 kg, not at the 11.7 kg pad weight he had loaded — a 33 %
 * error in the one number a chute is chosen on, and descent rate goes as
 * sqrt(m), so that is ~15 % on the rate itself. Sizing a main off pad weight
 * buys a canopy that is too small in exactly the direction that breaks
 * airframes.
 *
 * Kernel facts this rests on, all re-measured against the shipped
 * orkengine.mjs rather than assumed (see recoveryMass.test.ts, which asserts
 * every one of them through the real kernel):
 *
 *  - `StaticInfo.mass` is the LOADED mass and is cluster-aware: a 4-ring mount
 *    with one motor spec adds four motors' worth of mass. So the propellant we
 *    subtract has to be multiplied by the same cluster count, or the two halves
 *    of the subtraction disagree.
 *  - `componentInfo(stageId).mass` is exactly 0 — a stage carries no mass of
 *    its own — but `componentInfo(stageId).sectionMass` is the stage's whole
 *    DRY subtree, motors excluded, and the per-stage sectionMasses sum to
 *    `massEmpty` to the last bit. That is what makes the multi-stage answer
 *    computable at all.
 *  - `sectionMass` walks the tree structurally, so an off-axis assembly with
 *    instanceCount > 1 is counted ONCE while `massEmpty` counts every instance.
 *    Deriving the sustainer as `massEmpty − Σ(booster sectionMass)` rather than
 *    as `sectionMass(sustainer)` puts that discrepancy where it can only bite a
 *    design with an instanced POD on a BOOSTER stage — the sustainer's own pods
 *    come out right, which is the case that exists.
 */

/** What to put on screen. Never a bare number: the absent cases have reasons. */
export type RecoveryMass =
  /** A motor is loaded and the number is trustworthy. `mass` is kg. */
  | { state: 'ok'; mass: number; multiStage: boolean }
  /** No motor anywhere — the owner's explicit rule: show no figure at all. */
  | { state: 'no-motor' }
  /** We know the number would be the mass of no real object. `reason` is UI copy. */
  | { state: 'unavailable'; reason: string };

/**
 * Propellant burned over the whole curve (kg): the motor's first mass sample
 * minus its last. Zero — not an error — for a curve with fewer than two
 * samples or a flat mass column, so a motor whose published file carries no
 * mass data falls back to counting its FULL mass as coming down. That errs
 * heavy, which is the safe direction for choosing a canopy.
 */
export function motorPropellantMass(spec: Pick<MotorSpec, 'masses'>): number {
  const m = spec.masses;
  if (!Array.isArray(m) || m.length < 2) return 0;
  const first = m[0]!;
  const last = m[m.length - 1]!;
  if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
  return Math.max(0, first - last);
}

/**
 * Motor mass at burnout (kg) — the casing, liner and closures that stay
 * bolted in. Null when the curve carries no mass column at all, which the
 * multi-stage path treats as "cannot answer" rather than guessing zero: zero
 * would understate the sustainer, and understating is the unsafe direction.
 */
export function motorBurnoutMass(spec: Pick<MotorSpec, 'masses'>): number | null {
  const m = spec.masses;
  if (!Array.isArray(m) || m.length === 0) return null;
  const last = m[m.length - 1]!;
  return Number.isFinite(last) ? Math.max(0, last) : null;
}

export interface RecoveryMassInput {
  tree: RocketTree;
  /** Whole-rocket static analysis for the CURRENT motor set. */
  info: Pick<StaticInfo, 'mass' | 'massEmpty'>;
  /** [mount node id, motor] for every mount that currently holds a motor. */
  motors: ReadonlyArray<readonly [string, { spec: MotorSpec }]>;
  /**
   * `OrkRocket.componentInfo(id).sectionMass`, or null when the kernel cannot
   * answer for that id. A callback so this stays a pure function and the
   * caller owns the kernel handle and its try/catch.
   */
  sectionMass: (componentId: string) => number | null;
}

/**
 * The number to show beside "Mass (loaded)".
 *
 * Single stage (the overwhelming majority, and where chute choice matters
 * most): loaded mass minus every motor's propellant. Exact.
 *
 * Serial multi-stage: the boosters are on the ground by apogee, so the
 * sustainer comes down alone and the honest number is the SUSTAINER's dry
 * mass plus its own motors' burnout mass. Emphatically not "the whole stack
 * minus propellant", which is the mass of nothing that ever exists.
 *
 * Separating strap-on boosters (`parallelstage`) are refused rather than
 * guessed: they live INSIDE the sustainer stage's subtree, so no stage-level
 * mass can separate them out, and their instanceCount is counted once by
 * `sectionMass` and N times by `massEmpty`.
 */
export function recoveryMass(input: RecoveryMassInput): RecoveryMass {
  const { tree, info, motors, sectionMass } = input;
  if (motors.length === 0) return { state: 'no-motor' };
  if (!Number.isFinite(info.mass) || !Number.isFinite(info.massEmpty)) {
    return { state: 'unavailable', reason: 'the design has no mass yet' };
  }

  /** Motors on this mount: the cluster count the rest of the app reads. */
  const countAt = (mountId: string): number =>
    clusterCount(findNode(tree, mountId)?.['cluster'] as string | undefined);

  const stageList = stages(tree);

  if (hasParallelStage(tree)) {
    // A strap-on drops away like a booster stage but is modelled as a child of
    // the sustainer's airframe, so it is inside every stage-level mass here.
    return {
      state: 'unavailable',
      reason: 'strap-on boosters separate — the app cannot yet say what stays with the sustainer',
    };
  }

  if (stageList.length <= 1) {
    // Nothing separates: everything on the pad, less what burned.
    let mass = info.mass;
    for (const [mountId, mm] of motors) {
      mass -= motorPropellantMass(mm.spec) * countAt(mountId);
    }
    // Cannot come down lighter than the bare structure. This is the guard for
    // a motor the kernel REFUSED (see App's motorFailures): the mass we are
    // subtracting propellant from would then never have included that motor,
    // and the answer would come out below the dry rocket — light, which is the
    // direction that undersizes a canopy.
    if (mass < info.massEmpty - 1e-9) {
      return { state: 'unavailable', reason: 'a loaded motor’s mass is not in the design' };
    }
    return finish(mass, info, false);
  }

  // --- serial multi-stage: the sustainer comes down alone ---
  // massEmpty − Σ(booster sectionMass) rather than sectionMass(sustainer):
  // see the header note on instanced pods.
  let dry = info.massEmpty;
  for (let i = 1; i < stageList.length; i++) {
    const id = stageList[i]!.id;
    const sm = id ? sectionMass(id) : null;
    if (sm === null || !Number.isFinite(sm)) {
      return { state: 'unavailable', reason: 'the booster stages’ masses are unavailable' };
    }
    dry -= sm;
  }

  let mass = dry;
  for (const [mountId, mm] of motors) {
    // Stage 0 is the sustainer. A booster's spent casing lands with the
    // booster, not under this rocket's chute.
    if (stageIndexOf(tree, mountId) !== 0) continue;
    const burnout = motorBurnoutMass(mm.spec);
    if (burnout === null) {
      return { state: 'unavailable', reason: 'the sustainer motor carries no mass curve' };
    }
    mass += burnout * countAt(mountId);
  }
  return finish(mass, info, true);
}

/**
 * Last gate. A recovery weight that is not a positive number, or that exceeds
 * the pad weight, is arithmetic that has gone wrong somewhere upstream — show
 * nothing rather than a figure a user would size hardware against.
 */
function finish(
  mass: number, info: Pick<StaticInfo, 'mass'>, multiStage: boolean,
): RecoveryMass {
  if (!Number.isFinite(mass) || mass <= 0 || mass > info.mass + 1e-9) {
    return { state: 'unavailable', reason: 'the masses in this design do not add up' };
  }
  return { state: 'ok', mass, multiStage };
}

/**
 * The tooltip the tile carries, so the "why is this lighter than my pad
 * weight" question is answered in place rather than on the forum.
 */
export function recoveryMassTitle(r: RecoveryMass): string {
  switch (r.state) {
    case 'no-motor':
      return 'Load a motor — recovery weight is the dry rocket plus the spent motor casing, '
        + 'so it cannot be known until the motor is chosen.';
    case 'unavailable':
      return `Recovery weight is unavailable: ${r.reason}.`;
    default:
      return r.multiStage
        ? 'What comes down under the recovery device: the SUSTAINER’s dry mass plus its own '
          + 'motor casing at burnout. The boosters have already separated. Size the chute on this, '
          + 'not on pad weight.'
        : 'What comes down under the recovery device: the dry rocket plus the spent motor casing '
          + '(the propellant is gone by apogee). Size the chute on this, not on pad weight.';
  }
}
