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
