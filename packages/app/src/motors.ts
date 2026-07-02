import type { MotorSpec } from '@online-openrocket/engine';

/**
 * Built-in motors for the MVP (approximate Estes-class thrust curves defined
 * as explicit data points). P1.7 replaces/augments these with live
 * thrustcurve.org data. All SI.
 */
export const BUILT_IN_MOTORS: Record<string, MotorSpec> = {
  'A8-3': {
    designation: 'A8-3',
    diameter: 0.018,
    length: 0.07,
    times: [0, 0.05, 0.15, 0.25, 0.45, 0.5],
    thrusts: [0, 9.5, 4.0, 3.0, 2.6, 0],
    masses: [0.0163, 0.0158, 0.0148, 0.014, 0.0131, 0.013],
    cgX: 0.035,
    ejectionDelay: 3,
  },
  'B6-4': {
    designation: 'B6-4',
    diameter: 0.018,
    length: 0.07,
    times: [0, 0.08, 0.2, 0.4, 0.7, 0.8, 0.85],
    thrusts: [0, 11.5, 5.5, 5.0, 4.7, 4.2, 0],
    masses: [0.0195, 0.0188, 0.0176, 0.0164, 0.0147, 0.0141, 0.014],
    cgX: 0.035,
    ejectionDelay: 4,
  },
  'C6-5': {
    designation: 'C6-5',
    diameter: 0.018,
    length: 0.07,
    times: [0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0],
    thrusts: [0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0],
    masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132],
    cgX: 0.035,
    ejectionDelay: 5,
  },
};
