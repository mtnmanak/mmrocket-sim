import type { MountMotor, SavedConfig } from '../App.js';
import type { OrkExportFlightData } from './orkFile.js';
import { runCarriesNozzleStamp, runMatchesModel, type SimRun } from './simReport.js';
import { lookupTable } from './xmlUtil.js';

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
  /**
   * simReport's `motorSetKeyOf` — the SAME function Launch stamps a run with.
   * Passed in rather than imported so a test can hand each configuration a key
   * of its own and exercise one rule at a time.
   */
  motorSetKeyOf: (motors: [string, MountMotor][], hardwareDeltaKg: number) => string;
  hardwareDeltaKg: number;
  /**
   * treeModel's `primaryMountOf` over the tree as it stands: the mount whose
   * motor a run's `delayS` describes. Passed in so this module needs no tree.
   */
  primaryMountOf: (mountIds: readonly string[]) => string | null;
}

/**
 * The motors a stored run flew, read from the configuration it names — when
 * the run still describes that configuration as it stands in every way but
 * its delay: this design, these conditions, this model and kernel, these
 * motors. null for a run that does not. A run with no configuration id
 * describes the working set of a design that has none (`activeConfigId`
 * null); `flightDataForExport` writes no such run, `flownAutoDelays` reads one.
 */
function describedMotors(r: SimRun, input: FlightDataForExportInput): [string, MountMotor][] | null {
  const {
    savedConfigs, activeConfigId, assigned, mountIds, designKey, conditionsKey, model, hasNozzle,
    motorSetKeyOf, hardwareDeltaKg,
  } = input;
  const cfg = r.flightConfigId ? savedConfigs.find((c) => c.id === r.flightConfigId) : undefined;
  if (r.flightConfigId ? !cfg : activeConfigId !== null) return null;
  if (r.designKey !== designKey) return null;
  if (r.conditionsKey !== conditionsKey) return null;
  // The model too. Without this a run the app itself marks "flown on a
  // different model" would be written into the file as that configuration's
  // up-to-date result — the exact authoritative-looking wrong number this
  // guard exists to prevent. UNKNOWN (a run predating the field) is a refusal
  // here, as everywhere the numbers travel.
  if (runMatchesModel(r, model) !== true) return null;
  // And the kernel's own physics. A run of a nozzle-bearing design flown
  // before v0.119 carries no pressure-thrust stamp, and none of the three
  // keys above can see a kernel change.
  if (!runCarriesNozzleStamp(r, { hasNozzle, ...model })) return null;
  // The motor set is compared against the CONFIGURATION's own motors, not the
  // live working set: a user who has since switched configurations must still
  // be able to export the results of the others.
  //
  // Filtered by the current mounts, the same predicate as `assigned`: since
  // the write-back (configSync) a configuration's `motors` is the working set
  // verbatim and can hold a stale id that the run's key — stamped from
  // `assigned` — never had. Refusal is the safe direction, but a needless one
  // loses that configuration's stored result from the file.
  const active = !cfg || cfg.id === activeConfigId;
  const cfgMotors: [string, MountMotor][] = active
    ? [...assigned]
    : Object.entries(cfg.motors).filter(([id]) => mountIds.includes(id));
  // The hardware term is the ACTIVE configuration's: a non-active
  // configuration's stored run keeps matching only if it flew with no
  // hardware, and refusal is the safe direction for numbers written into a
  // file — the same rule the model check above applies to UNKNOWN.
  if (r.motorSetKey !== motorSetKeyOf(cfgMotors, active ? hardwareDeltaKg : 0)) return null;
  return cfgMotors;
}

/**
 * WHAT AN AUTO-DELAY PRIMARY FLEW, per configuration (`''` for a design with
 * none) — the delay a Save writes for it (seam review of audit 2026-09-22).
 *
 * Auto (optimal) is this app's own setting; neither a .ork nor a .rkt can hold
 * it, and a Save wrote the motor's PROVISIONAL first-flight delay: the
 * longest listed, or 0 s for a motor that lists no numeric delay: on the
 * Cheetah probe a KBA G135R, loaded on Auto from RockSim's −1, flew 11 s and
 * deployed at 0.87 m/s, and reopened from either file at 0 s, deploying at
 * burnout at 250.9 m/s. Auto flies the rounded optimum (flightRunner.flyLaunch),
 * so the delay its newest flight of the design as it stands flew AT that
 * optimum is what it flies, and so what the file says; a primary with no such
 * flight gets no entry, and the Save says so instead. A flag of this app's own
 * in the .ork was the other way, and was not taken: desktop OpenRocket warns on
 * an element it does not know and would still fly the provisional delay.
 *
 * AT THAT OPTIMUM, NOT ANY DELAY (review of the seam fixes). A run's motor-set
 * key carries the spec delay and not the Auto flag (motorSetKeyOf), and
 * ticking Auto changes nothing else, so a C6 flown at a fixed 3 s and then put
 * on Auto matched as its flight, and was saved at 3 s "the delay its last
 * flight here flew", where Auto flies it at 5 s. `recommendedDelayS` is the
 * run's rounded optimum — the kernel's coast to apogee from burnout, computed
 * past an early deployment (BasicEventSimulationEngine's computeCoastTime), so
 * the delay flown does not move it — and a run that flew it flew what Auto
 * flies, whether Auto was ticked or the same delay typed. A true Auto flight
 * whose re-flown optimum rounds the other way (its optimum within the
 * integrator's noise of a half second) is passed over: the Save then says it
 * has no flight, the safe direction.
 */
export function flownAutoDelays(input: FlightDataForExportInput): Record<string, number> {
  const out = lookupTable<number>({});
  for (const r of input.runs) {
    const key = r.flightConfigId ?? '';
    // Newest-first: the first run that still describes the design is the one.
    if (key in out) continue;
    const cfgMotors = describedMotors(r, input);
    if (!cfgMotors) continue;
    const primaryId = input.primaryMountOf(cfgMotors.map(([id]) => id));
    const primary = cfgMotors.find(([id]) => id === primaryId)?.[1];
    if (primary?.meta.autoDelay === true && Number.isFinite(r.delayS) && r.delayS === r.recommendedDelayS) {
      out[key] = r.delayS;
    }
  }
  return out;
}

export function flightDataForExport(
  input: FlightDataForExportInput,
): Record<string, OrkExportFlightData> {
  const { runs, primaryMountOf } = input;
  // What each auto-delay primary's <delay> will say (App writes the same).
  const autoDelays = flownAutoDelays(input);
  // No prototype: keyed by configuration id, file-sourced text. A default id
  // of `constructor` found Object there, was skipped as already written, and
  // saved as notsimulated (audit 2026-09-22).
  const out = lookupTable<OrkExportFlightData>({});
  for (const r of runs) {
    // Newest-first, so the first qualifying run per config wins.
    if (!r.flightConfigId || out[r.flightConfigId]) continue;
    const cfgMotors = describedMotors(r, input);
    if (!cfgMotors) continue;
    // And the delay the run FLEW. The key carries each motor's SPEC delay —
    // never an auto-delay optimum, which is only known after flying
    // (simReport's motorSetKeyOf). So an auto-delay run matched its
    // configuration and its flight was written under a delay it never flew:
    // measured on the starter rocket on the default model (classic + Kbf;
    // audit 2026-09-22), an Estes C6 set to 3 s that auto flew at 5 s went into
    // the file deploying at 3.81 m/s, where the 3 s motor the file named
    // deploys at 16.81 m/s. The run's `delayS` is the PRIMARY's — the only
    // mount auto delay writes — so it is read against the delay the file's
    // <delay> names for this configuration's own primary: its spec delay, or,
    // on Auto, the one its newest flight flew (flownAutoDelays), which is now
    // what the file says.
    const primaryId = primaryMountOf(cfgMotors.map(([id]) => id));
    const primary = cfgMotors.find(([id]) => id === primaryId)?.[1];
    if (!primary) continue;
    const named = primary.meta.autoDelay === true
      ? autoDelays[r.flightConfigId] ?? primary.spec.ejectionDelay : primary.spec.ejectionDelay;
    if (r.delayS !== named) continue;
    out[r.flightConfigId] = summaryOf(r);
  }
  return out;
}
