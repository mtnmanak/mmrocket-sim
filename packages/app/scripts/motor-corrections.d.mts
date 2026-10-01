/**
 * Type surface of motor-corrections.mjs for the app, which imports it so that a
 * live thrustcurve.org row carrying a figure the shipped catalogue corrects is
 * corrected the same way before it is compared (catalogueOverlay.ts). tsconfig
 * has no allowJs, so the .mjs needs this beside it. Declarations only — keep in
 * step with the .mjs; motor-corrections.test.mjs fails when they part.
 */
export interface MotorCorrectionSource {
  /** Who publishes the figure: the manufacturer, or the certifying body. */
  by: string;
  url: string;
  /** The figure as that document prints it. */
  says: string;
  /** ISO date the source was read. */
  read: string;
}

export interface MotorCorrection {
  motorId: string;
  manufacturer: string;
  designation: string;
  fields: Readonly<Record<string, { bad: number; good: number }>>;
  why: string;
  sources: readonly MotorCorrectionSource[];
}

export const MOTOR_CORRECTIONS: readonly MotorCorrection[];

export function correctMotorRow<T extends { motorId?: unknown }>(row: T): T;

export function applyMotorCorrections<T extends { motorId?: unknown }>(motors: readonly T[]): {
  motors: T[];
  applied: string[];
  already: string[];
  unexpected: string[];
  missing: string[];
};
