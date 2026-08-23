import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { axialLength, offsetForStart } from '../tree/position.js';

/**
 * "Measured mass & CG" — turning what your scale and balance point say into a
 * real ballast component (issues-2026-08-23a.md §5; the owner asked for it and
 * asked that it be re-editable).
 *
 * The alternative is a stage-level mass and CG override with "use instead of
 * everything inside" ticked, which pins the whole rocket exactly and is what
 * desktop OpenRocket users do. It costs two things this does not:
 *
 *  - the per-component breakdown stops meaning anything, because the parts
 *    underneath contribute no mass at all; and
 *  - the diagnostic is gone — a pinned number tells you the answer but never
 *    that your build came out 60 g heavy.
 *
 * There is also a kernel wrinkle that favours real ballast: when a mass
 * override covers a subtree the children's mass is zeroed but their moments of
 * inertia are still summed in (MassCalculation.merge), so a pinned rocket
 * carries the rotational inertia of the parts underneath rather than of the
 * mass you pinned. Measured at 0.14% on apogee — nothing — but it is the
 * rotational behaviour (weathercocking, pitch oscillation, leaving the rod)
 * that inertia actually drives. Added mass is an ordinary component, so its
 * inertia is computed the ordinary way and the question does not arise.
 */

/** The name the inserted component always carries — the handle for re-editing. */
export const BUILD_ALLOWANCE_NAME = 'Build allowance';

/** Below this the measured and computed figures are treated as agreeing. */
const MASS_TOLERANCE_KG = 1e-4; // 0.1 g — finer than any hobby scale
const CG_TOLERANCE_M = 1e-4; // 0.1 mm

export type BallastSolution =
  /** The build matches the model closely enough that nothing need be added. */
  | { kind: 'matches' }
  /**
   * The rocket weighs what the model says but balances somewhere else — no
   * amount of ADDED mass can move the CG without also changing the total, so
   * the discrepancy is in how mass is distributed, not how much there is.
   */
  | { kind: 'cg-only'; cgErrorM: number }
  /**
   * The real rocket came out LIGHTER than the model. You cannot add negative
   * ballast: something in the design is modelled heavier than it was built.
   */
  | { kind: 'overweight-model'; excessKg: number }
  /**
   * A station exists, but it is off the rocket — ahead of the nose tip or
   * behind the tail. The mass and balance point you measured cannot both be
   * explained by adding mass anywhere, so the part masses are wrong in their
   * DISTRIBUTION.
   */
  | { kind: 'unreachable'; massKg: number; stationM: number; rocketLengthM: number }
  /** Add this much, here. */
  | { kind: 'ok'; massKg: number; stationM: number };

/**
 * Solves for the ballast that makes a computed rocket match a weighed one.
 *
 *   dm  = m_measured - m_computed
 *   x_b = (m_measured * x_measured - m_computed * x_computed) / dm
 *
 * Both CGs are measured from the nose tip, in metres, and both masses are the
 * AIRFRAME ONLY — no motor. (The owner's call: people weigh a build on the
 * bench with the motor out.)
 */
export function solveBallast(input: {
  computedMassKg: number;
  computedCgM: number;
  measuredMassKg: number;
  measuredCgM: number;
  rocketLengthM: number;
}): BallastSolution {
  const { computedMassKg, computedCgM, measuredMassKg, measuredCgM, rocketLengthM } = input;

  const deltaM = measuredMassKg - computedMassKg;
  const deltaCg = measuredCgM - computedCgM;

  if (Math.abs(deltaM) < MASS_TOLERANCE_KG) {
    return Math.abs(deltaCg) < CG_TOLERANCE_M
      ? { kind: 'matches' }
      : { kind: 'cg-only', cgErrorM: deltaCg };
  }
  if (deltaM < 0) return { kind: 'overweight-model', excessKg: -deltaM };

  const stationM = (measuredMassKg * measuredCgM - computedMassKg * computedCgM) / deltaM;
  if (stationM < 0 || stationM > rocketLengthM) {
    return { kind: 'unreachable', massKg: deltaM, stationM, rocketLengthM };
  }
  return { kind: 'ok', massKg: deltaM, stationM };
}

/**
 * Backs an existing allowance out of the computed figures, so re-editing
 * solves against the bare airframe rather than against the rocket it already
 * corrected. Without this, typing the same measured numbers twice would stack
 * a second correction on top of the first.
 *
 * `allowanceCgM` is the component's CG station from the nose tip (a mass
 * component's CG sits at its own midpoint, so it is positionX + length/2).
 */
export function withoutAllowance(
  computedMassKg: number,
  computedCgM: number,
  allowanceMassKg: number,
  allowanceCgM: number,
): { massKg: number; cgM: number } {
  const massKg = computedMassKg - allowanceMassKg;
  if (massKg <= MASS_TOLERANCE_KG) return { massKg: computedMassKg, cgM: computedCgM };
  return {
    massKg,
    cgM: (computedMassKg * computedCgM - allowanceMassKg * allowanceCgM) / massKg,
  };
}

/** The existing allowance, if this design already carries one. */
export function findAllowance(tree: RocketTree): ComponentNode | null {
  let found: ComponentNode | null = null;
  const walk = (nodes: ComponentNode[]) => {
    for (const n of nodes) {
      if (!found && n.type === 'masscomponent' && n.name === BUILD_ALLOWANCE_NAME) found = n;
      walk(n.children ?? []);
    }
  };
  walk(tree.components);
  return found;
}

export interface AllowancePlacement {
  /** Body component the ballast becomes a child of. */
  parentId: string;
  /** Parent-relative 'top' offset (m) for the component's FRONT face. */
  offset: number;
}

/**
 * Finds which body component contains an absolute axial station, and the
 * parent-relative offset that puts a component of `lengthM` there.
 *
 * A mass component's CG is its own midpoint (MassObject.getComponentCG), so
 * the component's FRONT must sit half its length ahead of the target station.
 * Positions are always emitted parent-relative 'top' — never 'absolute', which
 * the editor deliberately rewrites away (tree/position.ts).
 */
export function placeAtStation(
  tree: RocketTree,
  stationM: number,
  lengthM: number,
): AllowancePlacement | null {
  const CHAIN = new Set(['nosecone', 'bodytube', 'transition']);
  const wantFront = stationM - lengthM / 2;

  // Nose-to-tail chain across every stage, exactly as resolveAbsolutePositions
  // walks it: chain members stack sequentially and their own position field is
  // not used for layout.
  const chain: { node: ComponentNode; start: number; len: number }[] = [];
  let x = 0;
  for (const stage of tree.components) {
    const kids = stage.type === 'stage' ? stage.children ?? [] : [stage];
    for (const n of kids) {
      if (!CHAIN.has(n.type)) continue;
      const len = axialLength(n);
      chain.push({ node: n, start: x, len });
      x += len;
    }
  }
  if (chain.length === 0) return null;

  // The segment containing the component's front, clamped to the airframe so a
  // station just past a joint still lands somewhere sensible.
  const host = chain.find((c) => wantFront >= c.start && wantFront < c.start + c.len)
    ?? (wantFront < chain[0]!.start ? chain[0]! : chain[chain.length - 1]!);
  if (!host.node.id) return null;

  return {
    parentId: host.node.id,
    offset: offsetForStart('top', wantFront - host.start, lengthM, host.len),
  };
}
