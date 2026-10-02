import { fmtSi, type UnitSelection } from '../prefs/units.js';
import { stripDelay } from './motorMatch.js';
import type { PadMassText } from './padMassReconcile.js';
import type { StatedWeightText } from './statedLaunchWeight.js';

/**
 * THE WORDS A NOTE IS WRITTEN WITH, in the user's units — the formatters App
 * built in its body until 2026-10-01, moved here so the headless Launch
 * (services/simulateDesign.ts, simulateFile.ts) writes the import note and the
 * pad-mass note in the same words with no React mounted. They change the words
 * of a note and never a number: every caller passes the SI value it already
 * computed.
 */

/** A mass for a notice, in the user's unit ("7480 g"). */
export function massTextFor(units: UnitSelection): (kg: number) => string {
  return (kg: number) => `${fmtSi('mass', units.mass, kg)} ${units.mass}`;
}

/**
 * The unit-aware formatters services/statedLaunchWeight.ts asks for, in one
 * place — four call sites in App used to build them inline and any one of them
 * could have drifted into a different unit for the same sentence.
 */
export function statedWeightTextFor(units: UnitSelection): StatedWeightText {
  return {
    mass: massTextFor(units),
    length: (m: number) => `${fmtSi('length', units.length, m, 3)} ${units.length}`,
  };
}

/**
 * A motor label with its delay suffix stripped ("H220-14" / "H220-P" /
 * "H220 (auto delay)" → "H220"). The pad-mass field and the batch note name
 * the motor by this: the weighing belongs to the motor, not to its delay grain.
 * The rule is motorMatch's stripDelay, the one copy.
 */
export function baseLabel(label: string): string {
  return stripDelay(label);
}

/**
 * The words a pad-mass note is written with (services/padMassReconcile.ts):
 * the user's mass unit, and a motor named without its delay grain.
 */
export function padMassTextFor(units: UnitSelection): PadMassText {
  return { mass: massTextFor(units), motorName: baseLabel };
}
