import { delayMountsOf, readDelay, resolutionMatches } from './autoDelaySolver.js';
import type { MountMotor, SavedConfig } from '../model/design.js';
import type { OrkExportFlightData } from './orkFile.js';
import { runCarriesNozzleStamp, runCarriesPhysicsRevision, runMatchesModel, type SimRun } from './simReport.js';
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
  /** Tree-only, so it also covers runs from inactive motor configurations. */
  requiresPhysicsRevision?: boolean;
  physicsRevisions?: readonly string[];
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
  // And the kernel's own physics: the v0.119 nozzle stamp and the K9/K15
  // revision. None of the three input keys can see a kernel change. Both
  // result export and Auto-delay reuse must pass these same guards.
  if (!runCarriesNozzleStamp(r, { hasNozzle, ...model })) return null;
  if (!runCarriesPhysicsRevision(r, input)) return null;
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

/** One complete qualifying run supplies every Auto delay in a configuration. */
export function flownAutoDelays(input: FlightDataForExportInput): Record<string, Record<string, number>> {
  const out = lookupTable<Record<string, number>>({});
  for (const r of input.runs) {
    const key = r.flightConfigId ?? '';
    if (key in out) continue;
    const motors = describedMotors(r, input);
    if (!motors || !resolutionMatches(r.delayResolution, delayMountsOf(motors))) continue;
    const autos = r.delayResolution.mounts.filter((m) => m.mode === 'auto');
    if (autos.length) out[key] = lookupTable(Object.fromEntries(autos.map((m) => [m.mountId, readDelay(m.flownDelay)])));
  }
  return out;
}

export function flightDataForExport(input: FlightDataForExportInput): Record<string, OrkExportFlightData> {
  const autoDelays = flownAutoDelays(input);
  const out = lookupTable<OrkExportFlightData>({});
  for (const r of input.runs) {
    if (!r.flightConfigId || out[r.flightConfigId]) continue;
    const motors = describedMotors(r, input);
    if (!motors) continue;
    if (r.delayResolution !== undefined) {
      if (!resolutionMatches(r.delayResolution, delayMountsOf(motors))) continue;
      if (!motors.every(([id, mm]) => {
        const named = mm.meta.autoDelay ? autoDelays[r.flightConfigId!]?.[id] ?? mm.spec.ejectionDelay : mm.spec.ejectionDelay;
        return readDelay(r.delayResolution!.mounts.find((m) => m.mountId === id)!.flownDelay) === named;
      })) continue;
    } else {
      // Legacy scalar evidence cannot establish that today's per-mount Auto settled.
      if (motors.some(([, mm]) => mm.meta.autoDelay)) continue;
      const primary = motors.find(([id]) => id === input.primaryMountOf(motors.map(([mount]) => mount)))?.[1];
      if (!primary || r.delayS !== primary.spec.ejectionDelay) continue;
    }
    out[r.flightConfigId] = summaryOf(r);
  }
  return out;
}
