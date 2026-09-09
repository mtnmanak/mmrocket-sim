import type { MountMotor, SavedConfig } from '../App.js';
import type { OrkExportFlightData } from './orkFile.js';
import { runCarriesNozzleStamp, runMatchesModel, type SimRun } from './simReport.js';

/**
 * WHICH stored flight results are allowed into a saved `.ork`, and what they
 * look like when they get there.
 *
 * Extracted from App.tsx on 2026-09-08 (docs/AUDIT.md's highest-value
 * extraction). It is 100 % pure — no React, no DOM, no engine handle — and it
 * had ZERO tests, because the only way the suite could reach it was to read
 * App.tsx as text. That inversion is the one `flightPipeline.ts` already
 * records about itself: moving a line failed CI while changing a value written
 * permanently into every user's saved history passed untouched.
 *
 * WHY THE RULES ARE STRICT. Desktop OpenRocket renders a `<flightdata>` block
 * indistinguishably from a result it computed itself — there is no "this came
 * from a stale run" affordance in that UI. So every refusal below is the same
 * judgement: an ABSENT number is honest and a stale one is not, and refusal is
 * the safe direction whenever a check cannot prove the run still describes the
 * design being written.
 */

/** The ten summary values desktop OpenRocket stores in `<flightdata>`. */
export function summaryOf(r: SimRun): OrkExportFlightData {
  return {
    maxAltitude: r.maxAltitude,
    maxVelocity: r.maxVelocity,
    maxAcceleration: r.maxAcceleration,
    maxMach: r.maxMach,
    timeToApogee: r.timeToApogee,
    flightTime: r.totalFlightTime,
    groundHitVelocity: r.groundHitVelocity,
    launchRodVelocity: r.rodExitVelocity,
    deploymentVelocity: r.velocityAtDeployment,
    optimumDelay: r.optimumDelayS,
  };
}

export interface FlightDataForExportInput {
  /** Newest first — the first qualifying run per configuration wins. */
  runs: readonly SimRun[];
  savedConfigs: readonly SavedConfig[];
  activeConfigId: string | null;
  /** The live working set, used for the ACTIVE configuration. */
  assigned: readonly [string, MountMotor][];
  /** Ids of the mounts that exist right now. */
  mountIds: readonly string[];
  /** `shortHash(physicsKey)` — the design as the runs stamped it. */
  designKey: string;
  /** `conditionsKeyOf(launch)`. */
  conditionsKey: string;
  /**
   * The aero model the design is on NOW. Typed as the union rather than
   * `string` so a caller cannot pass a mode `runMatchesModel` has never heard
   * of — the check would then silently refuse every run, which reads as "no
   * results to export" rather than as the bug it is.
   */
  model: { aeroMode: 'classic' | 'supersonic' | 'auto'; effectiveKbf: boolean; autoSupersonic: boolean };
  /** Whether ANY stage carries a nozzle exit diameter. */
  hasNozzle: boolean;
  /** The app's own motor-set key function, injected so this module stays pure. */
  motorSetKeyOf: (motors: [string, MountMotor][], hardwareDeltaKg: number) => string;
  hardwareDeltaKg: number;
}

export function flightDataForExport(
  input: FlightDataForExportInput,
): Record<string, OrkExportFlightData> {
  const {
    runs, savedConfigs, activeConfigId, assigned, mountIds,
    designKey, conditionsKey, model, hasNozzle, motorSetKeyOf, hardwareDeltaKg,
  } = input;
  const out: Record<string, OrkExportFlightData> = {};
  for (const r of runs) {
    // Newest-first, so the first qualifying run per config wins.
    if (!r.flightConfigId || out[r.flightConfigId]) continue;
    if (!savedConfigs.some((c) => c.id === r.flightConfigId)) continue;
    if (r.designKey !== designKey) continue;
    if (r.conditionsKey !== conditionsKey) continue;
    // The model too. Without this a run the app itself marks "flown on a
    // different model" would be written into the file as that configuration's
    // up-to-date result — the exact authoritative-looking wrong number this
    // guard exists to prevent. UNKNOWN (a run predating the field) is a refusal
    // here, as everywhere the numbers travel.
    if (runMatchesModel(r, model) !== true) continue;
    // And the kernel's own physics. A run of a nozzle-bearing design flown
    // before v0.119 carries no pressure-thrust stamp, and none of the three
    // keys above can see a kernel change.
    if (!runCarriesNozzleStamp(r, { hasNozzle, ...model })) continue;
    // The motor set is compared against the CONFIGURATION's own motors, not the
    // live working set: a user who has since switched configurations must still
    // be able to export the results of the others.
    const cfg = savedConfigs.find((c) => c.id === r.flightConfigId)!;
    // Filtered by the current mounts, the same predicate as `assigned`: since
    // the write-back (configSync) a configuration's `motors` is the working set
    // verbatim and can hold a stale id that the run's key — stamped from
    // `assigned` — never had. Refusal is the safe direction, but a needless one
    // loses that configuration's stored result from the file.
    const cfgMotors: [string, MountMotor][] = cfg.id === activeConfigId
      ? [...assigned]
      : Object.entries(cfg.motors).filter(([id]) => mountIds.includes(id));
    // The hardware term is the ACTIVE configuration's: a non-active
    // configuration's stored run keeps matching only if it flew with no
    // hardware, and refusal is the safe direction for numbers written into a
    // file — the same rule the model check above applies to UNKNOWN.
    if (r.motorSetKey !== motorSetKeyOf(cfgMotors, cfg.id === activeConfigId ? hardwareDeltaKg : 0)) continue;
    out[r.flightConfigId] = summaryOf(r);
  }
  return out;
}
