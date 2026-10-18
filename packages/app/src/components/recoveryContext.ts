import { fmtFieldValue, siToUi } from '../prefs/units.js';

/**
 * A deployment altitude as the Deploy altitude box shows it: the user's
 * altitude unit (`prefs.units.altitude`) and the box's own digits, "400 ft" or
 * "121.92 m". Flight configurations and the RockSim reader's import note both
 * quote it through here, so the one figure reads the same in both places.
 */
export function deployAltitudeText(altM: number, distanceUnit: string): string {
  return `${fmtFieldValue(siToUi('altitude', distanceUnit, altM))} ${distanceUnit}`;
}
