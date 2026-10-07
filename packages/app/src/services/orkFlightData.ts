import { delayMountsOf, readDelay, resolutionMatchesPolicy, type DelayResolution } from './autoDelaySolver.js';
import type { MountMotor, SavedConfig } from '../model/design.js';
import type { OrkImportResult, OrkExportFlightData } from './orkFile.js';
import { expectedDelayMountsOf, motorDataKeyOf, motorDataKeysMatch, runCarriesNozzleStamp, runCarriesPhysicsRevision, runMatchesModel, type SimRun } from './simReport.js';
import { lookupTable } from './xmlUtil.js';
import { summaryOf, summaryFingerprint } from './storedRunIdentity.js';
export { summaryOf } from './storedRunIdentity.js';
import { MAX_RUNS } from './simStore.js';

/** File-owned evidence, independent of the global history's dedup/cap/Undo.
 * Array position and name identify the source simulation within this document.
 * Keep this snapshot with the opened design, including across edits/reloads;
 * replace it on every Open and clear it on New. Never infer it from history.
 */
export type ImportedSummaryDocument = Required<Pick<OrkImportResult, 'name' | 'storedSimulations'>>;

export function summaryDocument(imported: Pick<OrkImportResult, 'name'>
  & Partial<Pick<OrkImportResult, 'storedSimulations'>>): ImportedSummaryDocument | undefined {
  return imported.storedSimulations?.length
    ? structuredClone({ name: imported.name, storedSimulations: imported.storedSimulations }) : undefined;
}

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
 * design being written. Imported file summaries are a separate preservation
 * path: the writer marks them OUTDATED, never up-to-date or replayable.
 */

/**
 * Restore only what the file actually knows. No replay/design/kernel stamps:
 * an imported summary cannot prove it matches the rebuilt rocket or motors.
 * NaN numeric placeholders render as unknown and persist as null, like older
 * run-history rows. In particular, the import time is NOT the flight time.
 */
export function importedSummaryRuns(imported: Pick<OrkImportResult, 'name'>
  & Partial<Pick<OrkImportResult, 'storedSimulations' | 'configs'>>,
existingRuns: readonly SimRun[] = []): SimRun[] {
  return planSummaryImport(imported, existingRuns).runs;
}

interface SummaryImportPlan {
  runs: SimRun[];
  /** Local identity for each considered file row, including duplicate rows. */
  summaryIds: string[];
  total: number;
}

export function summaryImportCounts(plan: SummaryImportPlan, saved: readonly SimRun[]) {
  const ids = new Set(saved.map((run) => run.id));
  const added = plan.runs.filter((run) => ids.has(run.id)).length;
  const kept = plan.summaryIds.filter((id) => ids.has(id)).length;
  return { added, alreadySaved: kept - added, notKept: plan.total - kept };
}

export function planSummaryImport(imported: Pick<OrkImportResult, 'name'>
  & Partial<Pick<OrkImportResult, 'storedSimulations' | 'configs'>>,
existingRuns: readonly SimRun[] = []): SummaryImportPlan {
  const ids = new Map<string, string>();
  const identities = new Map<string, string>();
  const fingerprints = new Map<string, string>();
  const identity = (id: string, fingerprint: string) => JSON.stringify([id, fingerprint]);
  for (const run of existingRuns) {
    const fingerprint = summaryFingerprint(run.flightConfigId, summaryOf(run));
    ids.set(run.id, fingerprint);
    identities.set(identity(run.importedRunId ?? run.id, fingerprint), run.id);
    fingerprints.set(fingerprint, run.id);
  }
  const simulations = imported.storedSimulations ?? [];
  const summaryIds: string[] = [];
  // Resolve identities in file order, then choose additions using free slots.
  // Existing history never moves or loses a row to an import.
  const runs = simulations.flatMap((sim): SimRun[] => {
    const fd = sim.data;
    const fingerprint = summaryFingerprint(sim.configId, fd);
    const duplicate = fd.runId ? identities.get(identity(fd.runId, fingerprint))
      ?? (ids.get(fd.runId) === fingerprint ? fd.runId : undefined)
      : fingerprints.get(fingerprint);
    if (duplicate !== undefined) {
      summaryIds.push(duplicate);
      return [];
    }
    let id = fd.runId ?? `ork-summary-v1:${fingerprint}`;
    // IDs are file-supplied, not globally unique. Preserve both conflicting
    // reports, and retain the source ID so subsequent opens recognize the pair.
    if (ids.has(id)) {
      const base = `ork-summary-conflict-v1:${identity(id, fingerprint)}`;
      id = base;
      for (let suffix = 1; ids.has(id); suffix++) id = `${base}:${suffix}`;
    }
    ids.set(id, fingerprint);
    identities.set(identity(fd.runId ?? id, fingerprint), id);
    fingerprints.set(fingerprint, id);
    summaryIds.push(id);
    const config = imported.configs?.find((c) => c.id === sim.configId);
    // A configuration and its conditions describe the design on disk, not
    // necessarily this historical flight. No per-run motor/conditions snapshot
    // is stored in the tag, so leave those fields unknown, including on resave.
    return [{
      id, when: NaN, rocket: imported.name,
      importedSummary: true,
      ...(fd.runId ? { importedRunId: fd.runId } : {}),
      motor: '', manufacturer: '', motorDiameterMm: NaN,
      delayS: NaN,
      flightConfig: config?.name ?? sim.name,
      ...(sim.configId ? { flightConfigId: sim.configId } : {}),
      aeroModel: fd.aeroModel,
      ...(fd.rogersKbf !== undefined ? { rogersKbf: fd.rogersKbf } : {}),
      ...(fd.hybridBand ? { hybridBand: fd.hybridBand } : {}),
      maxAltitude: fd.maxAltitude ?? NaN, maxVelocity: fd.maxVelocity ?? NaN,
      maxAcceleration: fd.maxAcceleration ?? NaN, maxMach: fd.maxMach ?? NaN,
      timeToApogee: fd.timeToApogee ?? NaN, totalFlightTime: fd.flightTime ?? NaN,
      groundHitVelocity: fd.groundHitVelocity ?? NaN,
      rodExitVelocity: fd.launchRodVelocity ?? null,
      velocityAtDeployment: fd.deploymentVelocity ?? null,
      optimumDelayS: fd.optimumDelay ?? null, recommendedDelayS: null,
      timeToBurnout: null, timeToRodDeparture: null, thrustToWeightAtRod: null,
      launchMass: null, rodExitAoa: null, launchCG: null, launchCP: null,
      launchStaticMarginCal: null, altitudeAtDeployment: null,
      landingRate: null, safeLandingRate: null, safeLiftoffSpeed: null,
      safeThrustToWeight: null, safeDeployment: null, staticMarginOk: null, weathercockRisk: null,
      windAvg: NaN, execMs: NaN,
      comments: 'Summary imported from .ork; historical motor, delay, launch conditions, flight date, safety assessment and replay evidence are unknown.',
      commentLevels: ['info'],
    }];
  });
  return { runs: runs.slice(0, Math.max(0, MAX_RUNS - existingRuns.length)), summaryIds, total: simulations.length };
}

export interface FlightDataForExportInput {
  /** Historical fallback belongs exclusively to this opened document. */
  importedDocument?: ImportedSummaryDocument;
  /** Newest first — the first qualifying run per configuration wins. */
  runs: readonly SimRun[];
  savedConfigs: readonly SavedConfig[];
  activeConfigId: string | null;
  /** The live working set, used for the ACTIVE configuration. */
  assigned: readonly [string, MountMotor][];
  /**
   * The build's refusals: mounts of the working set Launch left off the
   * rocket (App's `refusedMountIds`). Known for the ACTIVE configuration only,
   * because App builds no other.
   */
  refusedMountIds?: readonly string[];
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
  model: { aeroMode: 'classic' | 'supersonic' | 'auto' | 'hybrid'; effectiveKbf: boolean; autoSupersonic: boolean };
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

/** What a stored run says about the configuration it names. */
interface DescribedMotors {
  /** Every motor of the configuration: what its key covers and the file names. */
  motors: [string, MountMotor][];
  /** Complete evidence checked against the same expected vector as design matching. */
  resolution: DelayResolution;
}

/**
 * The motors a stored run flew, read from the configuration it names — when
 * the run still describes that configuration: this design, these conditions,
 * this model and kernel, these motors and delay policies. null for a run that
 * does not. A run with no configuration id
 * describes the working set of a design that has none (`activeConfigId`
 * null); `flightDataForExport` writes no such run, `flownAutoDelays` reads one.
 */
function describedMotors(r: SimRun, input: FlightDataForExportInput): DescribedMotors | null {
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
  if (r.motorDataKey !== undefined && r.motorDataKey !== motorDataKeyOf(cfgMotors)) return null;
  if (!motorDataKeysMatch(r.motorDataKeys, Object.fromEntries(cfgMotors.map(m => [m[0], motorDataKeyOf([m])])))) return null;
  const resolution = r.delayResolution;
  // Only the active configuration has known build refusals. Unknown ignition
  // events are refused in every configuration by the shared expected-vector rule.
  if (!resolutionMatchesPolicy(resolution, expectedDelayMountsOf(cfgMotors, active ? input.refusedMountIds : undefined))) return null;
  return { motors: cfgMotors, resolution };
}

/** One complete qualifying run supplies every Auto delay in a configuration. */
export function flownAutoDelays(input: FlightDataForExportInput): Record<string, Record<string, number>> {
  const out = lookupTable<Record<string, number>>({});
  for (const r of input.runs) {
    // Create/Delete can change ownership without changing the working set.
    // Reuse only Auto evidence, through all the same match guards; never
    // reassign historical results or revive a deleted configuration's result.
    const keys = [r.flightConfigId ?? ''];
    if (input.activeConfigId !== null && input.activeConfigId !== keys[0]) keys.push(input.activeConfigId);
    else if (r.flightConfigId && input.activeConfigId === null
        && !input.savedConfigs.some(c => c.id === r.flightConfigId)) keys.push('');
    for (const key of keys) {
      if (key in out) continue;
      const described = describedMotors({ ...r, flightConfigId: key || undefined }, input);
      if (!described) continue;
      const autos = described.resolution.mounts.filter((m) => m.mode === 'auto');
      if (autos.length) out[key] = lookupTable(Object.fromEntries(autos.map((m) => [m.mountId, readDelay(m.flownDelay)])));
    }
  }
  return out;
}

export function flightDataForExport(input: FlightDataForExportInput): Record<string, OrkExportFlightData> {
  const autoDelays = flownAutoDelays(input);
  const out = lookupTable<OrkExportFlightData>({});
  for (const r of input.runs) {
    if (!r.flightConfigId || out[r.flightConfigId]) continue;
    const described = describedMotors(r, input);
    if (!described) continue;
    const { motors, resolution } = described;
    // Against EVERY motor, not the ones that flew: the file names a refused
    // motor too, and desktop OpenRocket would show a flight without it as the
    // result of a configuration with it. So for a configuration with a
    // refused motor the file names the delays its Auto flew (flownAutoDelays)
    // and carries no flight data.
    if (!resolutionMatchesPolicy(resolution, delayMountsOf(motors))) continue;
    if (!motors.every(([id, mm]) => {
      const named = mm.meta.autoDelay ? autoDelays[r.flightConfigId!]?.[id] ?? mm.spec.ejectionDelay : mm.spec.ejectionDelay;
      return readDelay(resolution.mounts.find((m) => m.mountId === id)!.flownDelay) === named;
    })) continue;
    out[r.flightConfigId] = summaryOf(r);
  }
  // Preserve imported historical summaries only as a fallback for a surviving
  // configuration. They establish no design/kernel match and no Auto delays.
  // Eligible app flights above retain precedence, regardless of history order.
  for (const sim of input.importedDocument?.storedSimulations ?? []) {
    if (!sim.configId || out[sim.configId]
      || !input.savedConfigs.some((c) => c.id === sim.configId)) continue;
    out[sim.configId] = { ...sim.data, importedSummary: true };
  }
  return out;
}
