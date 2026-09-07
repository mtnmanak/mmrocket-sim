import type { ComponentNode, MotorSpec, RocketTree, StaticInfo } from '@online-openrocket/engine';
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
 *
 * ONE WEIGHT PER OBJECT THAT COMES DOWN, not one per rocket (2026-09-07). The
 * original note here said "the boosters are on the ground by apogee, so the
 * sustainer comes down alone" and stopped. That is true of the sustainer and
 * false as a general statement: a spent booster separates and comes down under
 * its OWN parachute, so the flyer has a second canopy to size and the app gave
 * them no number for it. `recoveryMassByStage` answers per separating object;
 * `recoveryMass` is the sustainer's entry, unchanged to the bit.
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
 * Does this stage come off the stack above it?
 *
 * Separation is a property of the LOWER stage — it separates FROM the stack
 * above (`schema.ts:376-377`, which is desktop's own rule) — and `'never'` is
 * a real shipped option on that field (`schema.ts:191`). The kernel honours it
 * (`StageSeparationConfiguration.isSeparationEvent` returns false), the `.ork`
 * reader imports it, and real files use it: `LEM-IV.ork` declares `ejection`
 * on the stage and then overrides SEVEN of its eight flight configurations to
 * `never`. Applying a configuration writes the value onto the stage node
 * (`App.tsx:2317-2337`), so the live tree already carries the answer for the
 * configuration the user is looking at.
 *
 * Absent means `'ejection'` — the kernel default, and the same fallback the
 * `.ork` writer applies (`orkFile.ts:1566`).
 */
function separatesFromStackAbove(stage: ComponentNode): boolean {
  const ev = stage['separationEvent'];
  return (typeof ev === 'string' ? ev : 'ejection') !== 'never';
}

/**
 * The stack partitioned into the objects that actually come down SEPARATELY,
 * each group top-most first, the sustainer's group first.
 *
 * A cut is made above every stage that separates; a stage that never separates
 * stays joined to the stage above it. So an ordinary two-stage rocket gives
 * `[[sustainer], [booster]]` — two canopies to buy — while the same design
 * with its booster set to `never` gives `[[sustainer, booster]]`, one object
 * of the full stack weight.
 *
 * Empty for a legacy flat tree that has no stage nodes at all; callers fall
 * back to the whole tree, which is what such a tree means.
 */
export function recoveryGroups(tree: RocketTree): ComponentNode[][] {
  const stageList = stages(tree);
  if (stageList.length === 0) return [];
  const groups: ComponentNode[][] = [[stageList[0]!]];
  for (let i = 1; i < stageList.length; i++) {
    const stage = stageList[i]!;
    if (separatesFromStackAbove(stage)) groups.push([stage]);
    else groups[groups.length - 1]!.push(stage);
  }
  return groups;
}

/**
 * The stage nodes that come down with the sustainer — the scope anything
 * describing "the rocket that lands" has to be read over.
 *
 * A legacy flat tree (no stage nodes) is its own scope.
 */
export function sustainerScope(tree: RocketTree): readonly ComponentNode[] {
  const groups = recoveryGroups(tree);
  return groups.length > 0 ? groups[0]! : tree.components;
}

/** One object that comes down on its own recovery device. */
export interface StageRecovery {
  /** The stage ids that stay joined, top-most first. */
  stageIds: string[];
  /** Their names, for the readout label — e.g. `['Sustainer']`, `['Booster']`. */
  stageNames: string[];
  /** True for the group carrying stage 0. Exactly one group has this. */
  isSustainer: boolean;
  /**
   * Resolved INDEPENDENTLY of the other groups: a booster whose motor
   * publishes no mass curve must not blank the sustainer's figure, which is
   * the number most users are actually reading.
   */
  mass: RecoveryMass;
}

/** Per-object recovery weights, or the one reason there are none. */
export type RecoveryByStage =
  | { state: 'ok'; groups: StageRecovery[] }
  | { state: 'no-motor' }
  | { state: 'unavailable'; reason: string };

/**
 * A recovery weight for every object that comes down under its own canopy.
 *
 * Nothing separates (single stage, or every booster set to `never`): the whole
 * rocket lands as one object and the exact answer is pad weight less what
 * burned — the same arithmetic this file has always used for a single stage,
 * now reached by the case that describes it rather than by counting stage
 * nodes. That is the fix for the `never` case: counting nodes subtracted every
 * booster's mass from a rocket that never dropped one, reporting a weight
 * LIGHTER than what comes down, which is the direction that undersizes a
 * canopy.
 *
 * Something separates: the sustainer's group is `massEmpty − Σ(sectionMass of
 * every stage that leaves)` plus its own motors' burnout mass — bit-for-bit
 * what shipped — and every other group is `Σ(its own sectionMass)` plus its
 * own motors' burnout mass, because a booster separates carrying its spent
 * casing.
 *
 * Separating strap-on boosters (`parallelstage`) are refused rather than
 * guessed: they live INSIDE the sustainer stage's subtree, so no stage-level
 * mass can separate them out, and their instanceCount is counted once by
 * `sectionMass` and N times by `massEmpty`.
 */
export function recoveryMassByStage(input: RecoveryMassInput): RecoveryByStage {
  const { tree, info, motors, sectionMass } = input;
  if (motors.length === 0) return { state: 'no-motor' };
  if (!Number.isFinite(info.mass) || !Number.isFinite(info.massEmpty)) {
    return { state: 'unavailable', reason: 'the design has no mass yet' };
  }

  if (hasParallelStage(tree)) {
    // A strap-on drops away like a booster stage but is modelled as a child of
    // the sustainer's airframe, so it is inside every stage-level mass here.
    return {
      state: 'unavailable',
      reason: 'strap-on boosters separate — the app cannot yet say what stays with the sustainer',
    };
  }

  /** Motors on this mount: the cluster count the rest of the app reads. */
  const countAt = (mountId: string): number =>
    clusterCount(findNode(tree, mountId)?.['cluster'] as string | undefined);

  const groups = recoveryGroups(tree);
  const label = (g: ComponentNode[]): Pick<StageRecovery, 'stageIds' | 'stageNames'> => ({
    stageIds: g.map((s) => s.id ?? ''),
    stageNames: g.map((s) => s.name ?? ''),
  });

  if (groups.length <= 1) {
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
    const only = groups[0] ?? [];
    return {
      state: 'ok',
      groups: [{ ...label(only), isSustainer: true, mass: finish(mass, info, false) }],
    };
  }

  /**
   * Burnout mass of every motor mounted inside this group of stages. `null`
   * when one of them publishes no mass column — "cannot answer" rather than a
   * guessed zero, because zero understates and understating is the unsafe
   * direction.
   */
  const burnoutIn = (stageIdx: ReadonlySet<number>): number | null => {
    let sum = 0;
    for (const [mountId, mm] of motors) {
      if (!stageIdx.has(stageIndexOf(tree, mountId))) continue;
      const burnout = motorBurnoutMass(mm.spec);
      if (burnout === null) return null;
      sum += burnout * countAt(mountId);
    }
    return sum;
  };

  /** Flat stage index of every stage node, so mounts can be attributed. */
  const indexOfStage = new Map<ComponentNode, number>();
  stages(tree).forEach((s, i) => indexOfStage.set(s, i));

  const out: StageRecovery[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]!;
    const isSustainer = gi === 0;
    const idx = new Set(group.map((s) => indexOfStage.get(s) ?? -1));

    // The sustainer is derived by SUBTRACTING what leaves rather than by
    // summing its own sections — see the header note on instanced pods. Every
    // other group is summed, which is the only thing available for it.
    let dry = isSustainer ? info.massEmpty : 0;
    let dryKnown = true;
    const contributing = isSustainer
      ? groups.slice(1).flat()
      : group;
    for (const stage of contributing) {
      const sm = stage.id ? sectionMass(stage.id) : null;
      if (sm === null || !Number.isFinite(sm)) { dryKnown = false; break; }
      dry += isSustainer ? -sm : sm;
    }
    if (!dryKnown) {
      out.push({
        ...label(group),
        isSustainer,
        mass: {
          state: 'unavailable',
          reason: isSustainer
            ? 'the booster stages’ masses are unavailable'
            : 'this stage’s mass is unavailable',
        },
      });
      continue;
    }

    const burnout = burnoutIn(idx);
    if (burnout === null) {
      out.push({
        ...label(group),
        isSustainer,
        mass: {
          state: 'unavailable',
          reason: isSustainer
            ? 'the sustainer motor carries no mass curve'
            : 'this stage’s motor carries no mass curve',
        },
      });
      continue;
    }

    out.push({ ...label(group), isSustainer, mass: finish(dry + burnout, info, true) });
  }
  return { state: 'ok', groups: out };
}

/**
 * The number to show beside "Mass (loaded)": the SUSTAINER's — the object the
 * rest of the app is describing when it says "the rocket".
 *
 * A thin read of `recoveryMassByStage` so the tile and the per-stage readout
 * can never disagree about the same rocket.
 */
export function recoveryMass(input: RecoveryMassInput): RecoveryMass {
  const byStage = recoveryMassByStage(input);
  if (byStage.state !== 'ok') return byStage;
  const sustainer = byStage.groups.find((g) => g.isSustainer);
  return sustainer
    ? sustainer.mass
    : { state: 'unavailable', reason: 'the design has no sustainer stage' };
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
      // `multiStage` now means "something separates", not "there is more than
      // one stage node" — a booster set to Never comes down attached, and the
      // single-object wording is the true one for it.
      return r.multiStage
        ? 'What comes down under the SUSTAINER’s recovery device: its dry mass plus its own '
          + 'motor casing at burnout. Every stage that separates comes down under its own chute '
          + 'and has its own weight — size those separately. Size this chute on this figure, '
          + 'not on pad weight.'
        : 'What comes down under the recovery device: the dry rocket plus the spent motor casing '
          + '(the propellant is gone by apogee). Size the chute on this, not on pad weight.';
  }
}
