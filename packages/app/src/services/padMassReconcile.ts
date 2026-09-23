import type { RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { findNode } from '../tree/treeModel.js';
import type { migrateLegacyPadMass } from './configSync.js';
import { LEGACY_PAD_MASS_KEY, type HardwareMassResult } from './hardwareMass.js';
import type { HeldNote } from './notices.js';
import type { OrkMotorRef } from './orkFile.js';

/**
 * WHAT BECAME OF A WEIGHED PAD MASS AT RESTORE — the decisions, and the
 * sentences that say so, behind the notice bar's `pad-mass-moved` entry.
 *
 * v0.116 and v0.117 stored the weighed pad mass (motor in) beside the Measured
 * box's two airframe figures; from v0.118 it rides on the primary mount's
 * motor record, because a pad weight is one rocket with one motor set in it.
 * Such a session is migrated at restore onto the primary's record under the
 * `'legacy'` key (configSync.migrateLegacyPadMass), and the first build then
 * checks the value against the motor now loaded. And since the 2026-09-22
 * audit (row 356) a session saved with a pod or strap-on motor picked before
 * the core's has its weighing moved onto the core's record
 * (treeModel.padMassOntoRankedPrimary).
 *
 * Extracted from App.tsx in the 2026-09-22 audit (row 501, extraction #7 of
 * 8 September): a four-way migration branch whose copy no test could assert
 * while it sat inside a component's effect and state initializer.
 * App.render.test.tsx mounts App on a v0.117 session for the two commonest
 * outcomes; padMassReconcile.test.ts covers every branch.
 */

/** The unit-aware words a note is written with — App's, so the user's unit. */
export interface PadMassText {
  /** A mass in the user's unit ("7480 g"). */
  mass: (kg: number) => string;
  /** A motor named without its delay grain ("H220", not "H220-14"): the weighing belongs to the motor. */
  motorName: (label: string) => string;
}

/**
 * The note the RESTORE already knows how to write, before any build: a v0.117
 * pad mass with no motor to belong to (dropped), or a weighing the core-first
 * ranking moved to another record — so the value is not seen to jump from one
 * card to another unexplained. Null when neither happened.
 */
export function restoredPadMassNote(
  legacy: Pick<ReturnType<typeof migrateLegacyPadMass>, 'outcome' | 'kg'> | null,
  ranked: { from?: string; to?: string; kg?: number } | null,
  { tree, motors, text }: { tree: RocketTree; motors: Record<string, MountMotor>; text: PadMassText },
): HeldNote | null {
  if (legacy?.outcome === 'dropped' && typeof legacy.kg === 'number') {
    return {
      severity: 'warn',
      text: `The weighed pad mass you entered before this version (${text.mass(legacy.kg)}) had no motor loaded`
        + ' to belong to and was not kept. Weigh the rocket with the motor in and type it under that'
        + ' motor on Motors & Launch.',
    };
  }
  if (ranked?.from && ranked.to && typeof ranked.kg === 'number') {
    const from = motors[ranked.from];
    const to = motors[ranked.to];
    return {
      severity: 'info',
      text: `The weighed pad mass (${text.mass(ranked.kg)}) now sits under ${to ? text.motorName(to.label) : 'another motor'}`
        + ` on ${findNode(tree, ranked.to)?.name ?? 'its mount'}, not under`
        + ` ${from ? text.motorName(from.label) : 'the motor'} on ${findNode(tree, ranked.from)?.name ?? 'its mount'}:`
        + ' the weighed hardware now rides with the core\'s motor ahead of a pod\'s or a strap-on\'s, where it used'
        + ' to ride with whichever was picked first. The value itself is unchanged.',
    };
  }
  return null;
}

/** What the build knows, and the rocket it was built from. */
export interface LegacyPadMassInput {
  /** What the build derived from the pad mass (`built.hardware`); null with no build. */
  hardware: HardwareMassResult | null;
  primaryMountId: string | null;
  /**
   * The primary as the FILE sees it — among the assigned motors AND the
   * unmatched references (App's `filePrimaryMountId`).
   */
  filePrimaryMountId: string | null;
  motors: Record<string, MountMotor>;
  unmatchedRefs: Record<string, OrkMotorRef>;
  tree: RocketTree;
  /** The set identity a re-keyed weighing is keyed to (App's `currentSetKey`). */
  currentSetKey: string;
  text: PadMassText;
}

/** What to do about a legacy pad mass, once a build has judged it. */
export type LegacyPadMassStep =
  /** Delete both pad-mass keys from the primary's record, and say why. */
  | { kind: 'drop'; mountId: string; note: HeldNote }
  /** Keep the value, keyed to the set now loaded, and say where it went. */
  | { kind: 'rekey'; mountId: string; key: string; note: HeldNote };

/**
 * Reconciling a LEGACY pad mass — what makes v0.116's screenshots impossible.
 * A value keyed 'legacy' (a v0.116/v0.117 session, or a bare-form .ork attached
 * at open) reaches the build with no set key, so `hardware` is the
 * arithmetic's verdict on it against the motor now loaded, while the field
 * renders BLANK. After that first build: accepted (ok, or a motor with no mass
 * curve to separate it from) → the record is re-keyed to the current set and
 * the note says where it went; refused → the keys are deleted and the note
 * names the value and the motor, so nothing is ever shown refused under a
 * number that looks live.
 *
 * Null — nothing to do yet — with no build, no primary, no legacy value on the
 * primary's record, or a verdict of 'none' for any reason but a missing mass
 * curve: 'no-motor' (the kernel refused the primary's curve) stays pending, and
 * the next build that accepts a motor decides.
 */
export function reconcileLegacyPadMass(input: LegacyPadMassInput): LegacyPadMassStep | null {
  const { hardware: h, primaryMountId, filePrimaryMountId, text } = input;
  if (!h || !primaryMountId) return null;
  const rec = input.motors[primaryMountId];
  if (!rec || rec.padMassWeighedWith !== LEGACY_PAD_MASS_KEY || typeof rec.padMassKg !== 'number') return null;
  const kg = rec.padMassKg;
  const name = text.motorName(rec.label);
  // The file's primary is a reference the app could not load (a v0.117
  // session with the sustainer unmatched and the booster loaded): the field
  // is withheld on that card and the export gate keeps the reference's
  // slot, so a value placed here would be flown, invisible, and absent from
  // the saved file. Dropped with a notice, like a refusal (2026-09-08 review).
  if (filePrimaryMountId !== primaryMountId) {
    const fileRef = filePrimaryMountId ? input.unmatchedRefs[filePrimaryMountId] : undefined;
    const where = (filePrimaryMountId && findNode(input.tree, filePrimaryMountId)?.name) ?? 'a removed mount';
    return {
      kind: 'drop',
      mountId: primaryMountId,
      note: {
        severity: 'warn',
        text: `The weighed pad mass you entered before this version (${text.mass(kg)}) could not be placed: the`
          + ` motor the file names on ${where} (${fileRef?.designation ?? 'unknown'}) is not loaded, so the app`
          + ' cannot tell which motors it was weighed with. Load that motor, or re-weigh with the motors you'
          + ' have in and type it under the top motor on Motors & Launch.',
      },
    };
  }
  if (h.state === 'implausible') {
    return {
      kind: 'drop',
      mountId: primaryMountId,
      note: {
        severity: 'warn',
        text: h.reason === 'negative'
          ? `The weighed pad mass entered before this version (${text.mass(kg)}) was not kept: it is lighter`
            + ` than the dry rocket plus the catalogue ${name}, so it was weighed with a different motor.`
            + ' Re-weigh with this motor in and type it under it on Motors & Launch.'
          : `The weighed pad mass entered before this version (${text.mass(kg)}) was not kept: against the`
            + ` catalogue ${name} it would carry more hardware than the airframe itself. Re-weigh with this`
            + ' motor in and type it under it on Motors & Launch.',
      },
    };
  }
  if (h.state === 'ok' || (h.state === 'none' && h.why === 'no-mass-curve')) {
    return {
      kind: 'rekey',
      mountId: primaryMountId,
      key: input.currentSetKey,
      note: {
        severity: 'info',
        text: `The weighed pad mass you entered in the Measured mass & CG box (${text.mass(kg)}) now belongs`
          + ` to the motor it was weighed with: it sits under ${name} on Motors & Launch, and the line there`
          + ' says what it carries. If that is not the motor you weighed with, clear it and re-weigh.'
          + (h.state === 'none'
            ? ` ${name} carries no mass curve, so nothing is carried until a motor with one is loaded.`
            : ''),
      },
    };
  }
  return null;
}
