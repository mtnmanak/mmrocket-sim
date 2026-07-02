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
 * Engine-track decision (TeaVM transpile of the Java core vs. TS rewrite) is
 * Phase 0 — see docs/online-openrocket-plan.md. This package is the home for
 * the engine either way: as TS source, or as the typed wrapper around a
 * transpiled artifact.
 */

export const ENGINE_VERSION = '0.0.1';

/** Standard gravitational acceleration (m/s^2). */
export const G0 = 9.80665;

/** ISA sea-level conditions. */
export const ISA_SEA_LEVEL = {
  temperatureK: 288.15, // +15 °C
  pressurePa: 101325,
  lapseRateKPerM: -0.0065,
} as const;
