import type { FlightResult } from '@online-openrocket/engine';
import type { LaunchConditions } from './launchConditions.js';
import { fmtSi } from '../prefs/units.js';

/** Only rising on-guide segments; retained so editable batch criteria need no new flight. */
export interface RailProfile {
  /** [initial speed m/s, final speed m/s, initial travel m, final travel m]. */
  segments: [number, number, number, number][];
  railM: number;
  /** Null when the effective guide was clamped to zero: the offset is unknown. */
  offsetM: number | null;
  allowance: boolean;
  thrustEnded: boolean;
}

export type RailNeeded =
  | { status: 'reached'; travelM: number; railM: number }
  | { status: 'not-reached'; railM: number }
  | { status: 'thrust-ended'; railM: number };

/**
 * exp3/model.ts and exp3/REPORT.md (2026-10-02): FIRST upward on-guide
 * speed crossing, inverse linear speed-versus-distance interpolation;
 * distance = hypot(Pl, altitude). No extrapolation and no extra simulation.
 * OrkEngine.java's launchGuide call reports effectiveLaunchRodLength;
 * physical rail = travel + (entered rail - effective length). A zero
 * effective length has a clamped/unknown offset, so cannot supply a number.
 */
export function railProfileFromFlight(result: FlightResult, launch: LaunchConditions): RailProfile | undefined {
  const railM = launch.launchRodLengthM;
  const guideM = result.effectiveLaunchRodLength;
  if (!Number.isFinite(railM) || guideM == null || !Number.isFinite(guideM)
    || guideM < 0 || guideM > railM || result.events.some((e) => e.type === 'SIM_ABORT')
    || result.branches?.some((b) => b.events.some((e) => e.type === 'SIM_ABORT'))) return undefined;
  if (guideM === 0) return { segments: [], railM, offsetM: null,
    allowance: launch.launchGuideAllowance !== false, thrustEnded: false };
  const s = result.series;
  const rod = result.events.find((e) => e.type === 'LAUNCHROD')?.time ?? Infinity;
  const apogee = result.events.find((e) => e.type === 'APOGEE')?.time ?? Infinity;
  const segments: RailProfile['segments'] = [];
  let lastOnGuide = 0;
  for (let i = 1; i < s.time.length; i++) {
    const t0 = s.time[i - 1]!, t1 = s.time[i]!;
    if (t1 > rod) break; // never use a free-flight sample
    const h0 = s.altitude[i - 1]!, h1 = s.altitude[i]!;
    const v0 = s.velocity[i - 1]!, v1 = s.velocity[i]!;
    const p0 = s['Pl']?.[i - 1] ?? 0, p1 = s['Pl']?.[i] ?? 0;
    // Missing samples/gaps cannot establish a FIRST crossing or non-reachability.
    if (![t0, t1, h0, h1, v0, v1, p0, p1].every(Number.isFinite)
      || t1 <= t0 || t1 - t0 > Math.max(launch.timeStepS ?? 0.05, 0.001) + 1e-12) return undefined;
    const d0 = Math.hypot(p0, h0), d1 = Math.hypot(p1, h1);
    if (d0 >= guideM) break;
    lastOnGuide = d1 > guideM && d1 > d0 ? t0 + (guideM - d0) / (d1 - d0) * (t1 - t0) : t1;
    // Confinement can continue past apogee until burnout; only the upward
    // crossing search ends at apogee, not the evidence of remaining guided.
    if (t1 > apogee || h1 <= h0 || d1 <= d0 || v1 <= v0) continue;
    // The LAUNCHROD sample can overshoot the physical guide within its step.
    // Clip that segment at the actual guide end before inverting it.
    const fraction = Math.min(1, (guideM - d0) / (d1 - d0));
    segments.push([v0, v0 + fraction * (v1 - v0), d0, Math.min(d1, guideM)]);
  }
  if (lastOnGuide === 0) return undefined;
  const burnouts = result.events.filter((e) => e.type === 'BURNOUT');
  const lastBurnout = burnouts.length ? Math.max(...burnouts.map((e) => e.time)) : Infinity;
  // A first burnout alone is insufficient for a cluster or staged flight.
  // Only a completed final burn observed while guided establishes this limit.
  const thrustEnded = lastBurnout <= lastOnGuide && s.time.some((t) => t > lastBurnout)
    && s.thrust.every((v, i) => s.time[i]! <= lastBurnout || (Number.isFinite(v) && v <= 0))
    && !result.events.some((e) => e.type === 'IGNITION' && e.time > lastBurnout);
  return { segments, railM, offsetM: launch.launchGuideAllowance === false ? 0 : railM - guideM,
    allowance: launch.launchGuideAllowance !== false, thrustEnded };
}

export function railNeeded(profile: RailProfile | undefined, threshold: number): RailNeeded | undefined {
  // Saved runs predate this field; malformed persisted data is not a measurement.
  if (!profile || !Array.isArray(profile.segments) || !Number.isFinite(threshold) || threshold < 0
    || !Number.isFinite(profile.railM)) return undefined;
  if (profile.offsetM === null) return { status: 'not-reached', railM: profile.railM };
  if (!Number.isFinite(profile.offsetM)) return undefined;
  if (threshold === 0) return { status: 'reached', travelM: 0, railM: profile.offsetM };
  for (const segment of profile.segments) {
    if (!Array.isArray(segment) || segment.length !== 4 || !segment.every(Number.isFinite)) return undefined;
    const [v0, v1, d0, d1] = segment;
    if (v0 < threshold && v1 >= threshold) {
      const travelM = d0 + (threshold - v0) / (v1 - v0) * (d1 - d0);
      return { status: 'reached', travelM, railM: travelM + profile.offsetM };
    }
  }
  return { status: profile.thrustEnded ? 'thrust-ended' : 'not-reached', railM: profile.railM };
}

export function railNeededCell(profile: RailProfile | undefined, threshold: number, lengthUnit: string): string {
  const needed = railNeeded(profile, threshold);
  if (!needed) return '';
  if (needed.status === 'reached') return fmtSi('length', lengthUnit, needed.railM, 1);
  return needed.status === 'thrust-ended' ? 'Cannot reach: thrust ended'
    : `Not reached within ${fmtSi('length', lengthUnit, needed.railM, 1)} ${lengthUnit}`;
}

export function railNeededHeader(threshold: number, velocityUnit: string, lengthUnit: string): string {
  return `Rail for ${fmtSi('velocity', velocityUnit, threshold)} ${velocityUnit} (${lengthUnit})`;
}

export function railNeededLine(profile: RailProfile | undefined, threshold: number, lengthUnit: string, velocityUnit: string): string | null {
  const needed = railNeeded(profile, threshold);
  if (!needed) return null;
  const speed = `${fmtSi('velocity', velocityUnit, threshold)} ${velocityUnit}`;
  const length = (m: number) => `${fmtSi('length', lengthUnit, m, 1)} ${lengthUnit}`;
  const allowance = `Guide-position allowance ${profile!.allowance ? 'on' : 'off'}.`;
  if (needed.status === 'thrust-ended') return `Cannot reach ${speed} on the guide: thrust ended before reaching that speed. ${allowance}`;
  if (needed.status === 'not-reached') return `Did not reach ${speed} within ${length(needed.railM)} of rail; a longer rail has not been simulated. ${allowance}`;
  return `Reaches ${speed} after ${length(needed.travelM)} of guide travel (${length(needed.railM)} of rail, `
    + (profile!.allowance ? 'allowing for where the launch lugs/rail buttons sit).' : 'guide-position allowance off).');
}
