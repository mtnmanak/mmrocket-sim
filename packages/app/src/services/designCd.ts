import type { OrkRocket } from '@online-openrocket/engine';

/**
 * Reference Mach for the design-tab drag coefficient. Subsonic and well clear
 * of the transonic rise, so the number is stable while you edit — it is a
 * shape figure to compare designs and to watch while trimming a Cd override,
 * not a prediction for a particular flight.
 */
export const CD_REFERENCE_MACH = 0.3;

/**
 * The Design tab's Cd: power-off total from a one-point dragSweep at
 * CD_REFERENCE_MACH (angle of attack 0, the kernel's default atmosphere). App's
 * memo and the headless describe read the same call. Throws what the sweep
 * throws; each caller decides its own fallback.
 */
export function designCdOf(rocket: Pick<OrkRocket, 'dragSweep'>): number | null {
  return rocket.dragSweep({
    machMin: CD_REFERENCE_MACH, machMax: CD_REFERENCE_MACH, machStep: 1,
  }).powerOff.total[0] ?? null;
}
