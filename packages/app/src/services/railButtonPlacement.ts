import type { ComponentNode, ComponentPosition } from '@online-openrocket/engine';
import { axialLength, offsetForStart, startFromPosition } from '../tree/position.js';

/**
 * One-shot AUTO-PLACE for a rail button (Eric, 2026-08-31b): two buttons, the
 * aft one about an inch from the rocket's aft end, the forward one at the CG.
 * A button, not a mode — press it again after the CG moves, and typed values
 * always win afterwards. Kernel semantics: instance 0 is the FORWARD button
 * and instanceSeparation marches AFT, so the node itself is placed at the CG
 * and the separation reaches back.
 *
 * Moved out of PropertyPanel's render body (audit 2026-09-22, extractions
 * carried from 8 September) so the rule can be tested without a panel; the
 * panel keeps the words, and PropertyPanel.oneShots.test.tsx pins both.
 */

/** How far forward of the rocket's aft end the aft button goes: "about an inch". */
export const RAIL_BUTTON_AFT_GAP = 0.0254;
/** Two buttons closer than this (m) collide; the pair needs strictly more. */
const MIN_SPACING = 0.02;
/** Station tolerance (m) for "on this tube". */
const EPS = 1e-9;

export interface RailButtonPlacement {
  /** Whole-rocket stations (m from the nose tip) the forward and aft buttons want. */
  fwdX: number;
  aftX: number;
  /** Where the button's parent tube starts and ends, on the same axis. */
  parentStart: number;
  parentEnd: number;
  /** Both buttons land on this tube. */
  fits: boolean;
  /** They fit and do not collide: the button is live. */
  feasible: boolean;
  /** The one write that places them. */
  patch: { instanceCount: number; instanceSeparation: number; position: ComponentPosition };
}

/**
 * Where auto-place would put `button`'s pair, and whether it can.
 *
 * `positionX` is the station the KERNEL reports for the button
 * (ComponentInfo), and the parent's start is backed out of it with
 * axialLength — ZERO for a rail button, the kernel's own
 * (`RocketComponent.java:86`). Backing it out with the 25 mm `length`
 * fallback this used to hit overstated it by half that on the default
 * 'middle' method, and the offset written then put the forward button
 * 12.5 mm aft of the CG this feature exists to hit (25 mm on a
 * 'bottom'-anchored button, which is what the app's own .ork writer emits for
 * surface parts). No station at all takes the parent to start at the nose tip.
 *
 * Both buttons must land ON this tube. The CG and the aft end are WHOLE-ROCKET
 * stations, so on a multi-tube airframe the pair can easily want to sit outside
 * the tube the component belongs to — the forward button at a CG two tubes up,
 * say. Rather than emit a position the tube cannot hold, `fits` says so and the
 * panel's button stays off.
 */
export function railButtonPlacement(button: ComponentNode, at: {
  /** The whole rocket's length and CG (m) — StaticInfo's. */
  rocketLength: number;
  cg: number;
  /** The kernel's station for this button (m), when it has one. */
  positionX: number | undefined;
  /** The parent tube's length (m). */
  parentLength: number;
}): RailButtonPlacement {
  const pos = (button.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
  const aftX = at.rocketLength - RAIL_BUTTON_AFT_GAP;
  const fwdX = at.cg;
  const childLen = axialLength(button);
  const parentStart = (at.positionX ?? 0) - startFromPosition(pos, childLen, at.parentLength);
  const parentEnd = parentStart + at.parentLength;
  const fits = fwdX >= parentStart - EPS && aftX <= parentEnd + EPS;
  return {
    fwdX, aftX, parentStart, parentEnd, fits,
    feasible: aftX - fwdX > MIN_SPACING && fits, // buttons must not collide
    patch: {
      instanceCount: 2,
      instanceSeparation: aftX - fwdX,
      position: {
        method: pos.method,
        offset: offsetForStart(pos.method, fwdX - parentStart, childLen, at.parentLength),
      },
    },
  };
}

/** Which rule placed a NEW rail button's pair — see {@link newRailButtonPair}. */
export type NewPairRule = 'auto-place' | 'tube-middle' | 'tube-quarters';

/**
 * How many times {@link newRailButtonPair} presses Auto-place at most, and the
 * movement (m) under which it stops early. Each press re-reads the CG with the
 * pair where the last press put it; the pair's own mass moves the CG by a
 * small fraction of how far the pair moved, so the presses converge fast.
 * Measured on the starter rocket with no motor (2026-09-30): the second press
 * moved the pair 3.6 mm, the third 0.10 mm, the fourth 3 microns, and the
 * fifth found it settled — five builds for one add.
 */
export const NEW_PAIR_MAX_PRESSES = 6;
export const NEW_PAIR_SETTLED_M = 1e-7;

/**
 * A NEW rail button is a PAIR (Eric, 2026-09-30: "make new rail buttons
 * default to an auto-placed pair"). Since v0.144 a rail-button line guides the
 * rocket only while TWO of its stations are still on the rail, so the kernel's
 * one-button default — which a part added from the Add menu used to take —
 * flew with no guided distance at all.
 *
 * ONLY the Add menu calls this (services/addComponent.ts). The kernel-default
 * mirror stays one button (schema.ts BLANK_BY_TYPE), so a desktop file that
 * states or omits a count opens exactly as it did; a paste or a duplicate keeps
 * the source's own count and positions.
 *
 * `press(b)` is "📍 Auto-place rail buttons" pressed on the design with `b` in
 * it: {@link railButtonPlacement} fed the CG (the loaded CG when a motor is
 * loaded), the length and `b`'s kernel station from that design's build — or
 * null when that design does not build or the kernel has no station for `b`.
 *
 * The rule, first that applies:
 *
 *  1. 'auto-place' — the button is added as one, and Auto-place is pressed on
 *     it: exactly the old two-step "add, then press". The pair's own few grams
 *     then move the CG the forward button was put on (3.6 mm aft on the
 *     starter rocket), so it is pressed again, as its title tells a user to do "after the
 *     CG moves", until the pair stops moving (NEW_PAIR_SETTLED_M, at most
 *     NEW_PAIR_MAX_PRESSES presses). The result: pressing Auto-place on a
 *     new pair does not move it. A later press that auto-place refuses keeps the
 *     last placement it accepted.
 *  2. Otherwise — the design does not build, so there is no CG; the kernel has
 *     no station; or auto-place's own refusal on the first press (the pair would
 *     leave this tube, or the CG sits within an inch of the aft end) — the pair
 *     is placed on the TUBE alone, deterministically:
 *     'tube-middle' — forward button at the tube's middle, aft one an inch
 *       forward of the tube's aft end, whenever that leaves them more than
 *       auto-place's 20 mm apart (a tube longer than 90.8 mm);
 *     'tube-quarters' — on a shorter tube, at its quarter and three-quarter
 *       points: half the tube apart, both on it. The kernel counts two buttons
 *       as separate stations once they are more than 0.5 mm apart
 *       (SimulationStatus.secondStation), so this guides on any tube over 1 mm.
 *
 * Known limit (review, 2026-09-30): on a degenerate tube the fallback pair is not
 * a real pair — length 0 puts both buttons at one station (it flies as
 * 'single-button'), and below about 20 mm the two 9.7 mm buttons overlap. No
 * buildable rocket carries its rail buttons on such a tube; the kernel flies the
 * part either way and the launch report says when a line cannot guide.
 */
export function newRailButtonPair(
  button: ComponentNode,
  parentLength: number,
  press: ((b: ComponentNode) => RailButtonPlacement | null) | null,
): { rule: NewPairRule; patch: RailButtonPlacement['patch']; presses: number } {
  let placed: RailButtonPlacement['patch'] | null = null;
  let presses = 0;
  while (press && presses < NEW_PAIR_MAX_PRESSES) {
    const at = press(placed ? ({ ...button, ...placed } as ComponentNode) : button);
    if (!at || !at.feasible) break;
    presses++;
    const moved = placed
      ? Math.max(Math.abs(at.patch.position.offset - placed.position.offset),
        Math.abs(at.patch.instanceSeparation - placed.instanceSeparation))
      : Infinity;
    placed = at.patch;
    if (moved < NEW_PAIR_SETTLED_M) break;
  }
  if (placed) return { rule: 'auto-place', patch: placed, presses };
  const pos = (button.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
  const childLen = axialLength(button);
  const len = Number.isFinite(parentLength) && parentLength > 0 ? parentLength : 0;
  const middle = len - RAIL_BUTTON_AFT_GAP - len / 2 > MIN_SPACING;
  const fwd = middle ? len / 2 : len / 4;
  const aft = middle ? len - RAIL_BUTTON_AFT_GAP : (3 * len) / 4;
  return {
    rule: middle ? 'tube-middle' : 'tube-quarters',
    presses: 0,
    patch: {
      instanceCount: 2,
      instanceSeparation: aft - fwd,
      position: { method: pos.method, offset: offsetForStart(pos.method, fwd, childLen, len) },
    },
  };
}
