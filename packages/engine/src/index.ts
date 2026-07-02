/**
 * Online OpenRocket — simulation engine package.
 *
 * ENGINE INVARIANTS (mirroring OpenRocket's info.openrocket.core):
 *  - All internal quantities are pure SI: meters, kilograms, seconds, newtons.
 *  - All internal angles are RADIANS. Degrees appear only at the file-format
 *    boundary (.ork stores some angles in degrees) and the UI boundary.
 *  - Rocket orientation is tracked as a quaternion, never Euler angles.
 *  - Numerical integration: RK4 with adaptive time step (error ~O(dt^4)).
 *  - Aerodynamics: Extended Barrowman method (CP, normal force, drag).
 *  - Atmosphere: International Standard Atmosphere (sea level +15 °C,
 *    -6.5 °C/km lapse, 101325 Pa), base configurable to launch-site altitude.
 *  - After recovery deployment the simulation drops from 6DOF to 3DOF
 *    (position only); parachute Cd defaults to 0.8 referenced to canopy area.
 *
 * Engine track (decided in Phase 0, validated in P1.1–P1.4): the REAL
 * OpenRocket physics kernel, carved from info.openrocket.core and compiled
 * to JS by TeaVM, differentially tested against the JVM. See engine-java/.
 * This package is the typed wrapper around that artifact.
 */

export {
  OrkRocket,
  resetEngine,
  type ComponentNode,
  type ComponentPosition,
  type ComponentType,
  type FlightEvent,
  type FlightResult,
  type FlightSeries,
  type FlightSummary,
  type MotorSpec,
  type NoseShape,
  type RocketSpec,
  type RocketTree,
  type SimulationOptions,
  type StaticInfo,
} from './orkEngine.js';

export const ENGINE_VERSION = '0.0.1';

/** Standard gravitational acceleration (m/s^2). */
export const G0 = 9.80665;

/** ISA sea-level conditions. */
export const ISA_SEA_LEVEL = {
  temperatureK: 288.15, // +15 °C
  pressurePa: 101325,
  lapseRateKPerM: -0.0065,
} as const;
