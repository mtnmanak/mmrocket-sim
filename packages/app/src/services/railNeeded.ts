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
  /** The kernel's flown guide decision; absent on older saved profiles. */
  guideKind?: FlightResult['launchGuideReason'];
  thrustEnded: boolean;
}

export type RailNeeded =
  | { status: 'reached'; travelM: number; railM: number }
  | { status: 'not-reached'; railM: number }
  | { status: 'undetermined'; railM: number }
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
    allowance: launch.launchGuideAllowance !== false, guideKind: result.launchGuideReason, thrustEnded: false };
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
    allowance: launch.launchGuideAllowance !== false, guideKind: result.launchGuideReason, thrustEnded };
}

export function railNeeded(profile: RailProfile | undefined, threshold: number): RailNeeded | undefined {
  // Saved runs predate this field; malformed persisted data is not a measurement.
  if (!profile || !Array.isArray(profile.segments) || !Number.isFinite(threshold) || threshold < 0
    || !Number.isFinite(profile.railM)) return undefined;
  if (profile.offsetM === null) return { status: 'undetermined', railM: profile.railM };
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

export function railNeededCell(profile: RailProfile | undefined, threshold: number, lengthUnit: string,
  measure: 'rail' | 'travel' = 'rail'): string {
  return railNeededResultCell(railNeeded(profile, threshold), profile, lengthUnit, measure);
}

export function railNeededResultCell(needed: RailNeeded | undefined, profile: RailProfile | undefined,
  lengthUnit: string, measure: 'rail' | 'travel' = 'rail'): string {
  if (!needed) return '';
  if (needed.status === 'undetermined') return 'Cannot be determined: no guided travel';
  if (needed.status === 'reached') return fmtSi('length', lengthUnit, measure === 'travel' ? needed.travelM : needed.railM, 1);
  const limitM = measure === 'travel' ? availableTravel(profile!) : needed.railM;
  return needed.status === 'thrust-ended' ? 'Cannot reach: thrust ended'
    : `Not reached within ${fmtSi('length', lengthUnit, limitM, 1)} ${lengthUnit}`;
}

export function railNeededHeader(threshold: number, velocityUnit: string, lengthUnit: string,
  measure: 'rail' | 'travel' = 'rail'): string {
  return `${measure === 'travel' ? 'Travel' : 'Rail'} for ${fmtSi('velocity', velocityUnit, threshold)} ${velocityUnit} (${lengthUnit})`;
}

function availableTravel(profile: RailProfile): number {
  return profile.offsetM === null ? 0 : profile.railM - profile.offsetM;
}

export function railNeededLine(profile: RailProfile | undefined, threshold: number, lengthUnit: string, velocityUnit: string,
  legacyGuideKind?: FlightResult['launchGuideReason']): string | null {
  const needed = railNeeded(profile, threshold);
  if (!needed || !profile) return null;
  const speed = `${fmtSi('velocity', velocityUnit, threshold)} ${velocityUnit}`;
  const length = (m: number) => `${fmtSi('length', lengthUnit, m, 1)} ${lengthUnit}`;
  const kind = profile.allowance ? profile.guideKind ?? legacyGuideKind : 'off';
  const rocketTravel = kind === 'off' || kind === 'none' || kind === 'single-button';
  const buttons = kind === 'buttons' || kind === 'mixed-buttons';
  const lug = kind === 'lug' || kind === 'mixed-lug';
  const launcher = lug ? 'rod' : 'rail';
  // SimulationStatus.buttonGuidePosition / secondStation selects the aft edge
  // of the second-from-aft station on the chosen rail line, not among all buttons.
  const point = buttons ? 'the bottom edge of the second rail button up from the tail on the line the rail runs through (the upper button on a two-button rocket)'
    : lug ? 'the bottom of the lowest launch lug' : 'the guide point recorded for this flight';
  const reference = rocketTravel ? 'of travel of the rocket itself' : `of travel, measured from ${point}`;
  const pad = kind === 'single-button' ? 'A single button station cannot hold the rocket straight.' : rocketTravel
    ? `${kind === 'off' ? 'Guide-position allowance is off.' : 'No launch guide is fitted.'}`
      + (needed.status === 'undetermined' ? '' : ' The rail figure equals the travel of the rocket itself.')
    : `At the pad, measure the usable ${launcher} from ${buttons ? 'that button edge' : lug ? 'that lug edge' : 'that guide point'} to the end of the ${launcher}.`
      + (kind === 'mixed-lug' || kind === 'mixed-buttons' ? ` With both lugs and buttons fitted, the app used the shorter travel (${lug ? 'lug' : 'buttons'}).` : '')
      + (!kind ? ' This older run did not record the guide kind; re-launch to identify the measuring point.' : '');
  if (needed.status === 'thrust-ended') return `Cannot reach ${speed}: thrust ended before reaching that speed while still guided. `
    + `The simulated limit was ${length(availableTravel(profile))} ${reference} (${length(profile.railM)} of ${launcher} if the tail sits at the bottom of the ${launcher}). ${pad}`;
  // A zero effective length cannot reveal the guide-to-tail offset. In
  // particular a single station provides no guided crossing to measure.
  if (needed.status === 'undetermined') return `Did not reach ${speed}: the simulation provided no guided travel${rocketTravel ? '' : ` (measured from ${point})`} on the entered ${length(profile.railM)} ${launcher}. `
    + `No required travel or ${launcher} length can be determined. ${pad}`;
  if (needed.status === 'not-reached') {
    return `Did not reach ${speed} within ${length(availableTravel(profile))} ${reference} `
      + `(${length(needed.railM)} of ${launcher} if the tail sits at the bottom of the ${launcher}); a longer ${launcher} has not been simulated. ${pad}`;
  }
  return `Reaches ${speed} after ${length(needed.travelM)} ${reference} `
    + `(${length(needed.railM)} of ${launcher} if the tail sits at the bottom of the ${launcher}). ${pad}`;
}
