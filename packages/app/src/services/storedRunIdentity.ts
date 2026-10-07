import type { SimRun } from './simReport.js';
import type { OrkExportFlightData } from './orkFile.js';
import { APP_HYBRID_BAND } from './aeroProvenance.js';
import type { EngineWarning } from '@online-openrocket/engine';

/** Add evidence without replacing a warning's existing structured payload.
 * Key/message identify the legacy warning; conflicting supplied metadata is
 * separate evidence, not permission to discard either warning. No text parsing.
 * Return the original array when nothing changed so repeat imports are no-ops.
 */
export function mergeStoredWarnings(stored: EngineWarning[] | undefined,
incoming: EngineWarning[] | undefined): EngineWarning[] | undefined {
  if (!incoming?.length) return stored;
  const merged = [...(stored ?? [])];
  let changed = false;
  for (const warning of incoming) {
    const at = merged.findIndex((old) => old.key === warning.key && old.message === warning.message
      && (old.priority === undefined || warning.priority === undefined || old.priority === warning.priority)
      && (old.quantity == null || warning.quantity == null
        || (old.quantity.kind === warning.quantity.kind && old.quantity.value === warning.quantity.value))
      && (old.sources == null || warning.sources == null
        || (Array.isArray(old.sources) && Array.isArray(warning.sources)
          && old.sources.length === warning.sources.length
          && old.sources.every((source, i) => {
            const other = warning.sources![i];
            return source === null ? other === null
              : other != null && source.id === other.id && source.name === other.name;
          }))));
    if (at === -1) {
      merged.push(warning);
      changed = true;
      continue;
    }
    const old = merged[at]!;
    // Keep unknown extension fields too, while existing evidence wins conflicts.
    let enriched = { ...old };
    for (const [key, value] of Object.entries(warning)) {
      if (value != null && (!Object.hasOwn(old, key) || (old as unknown as Record<string, unknown>)[key] == null)) {
        enriched = { ...enriched, [key]: value };
        changed = true;
      }
    }
    merged[at] = enriched;
  }
  return changed ? merged : stored;
}

/** Only the evidence carried by a saved .ork summary, including its source ID. */
export function summaryOf(r: SimRun): OrkExportFlightData {
  return {
    runId: r.importedRunId ?? r.id,
    ...(r.simWarnings !== undefined ? { simWarnings: r.simWarnings } : {}),
    ...(r.aeroModel ? { aeroModel: r.aeroModel } : {}),
    ...(r.rogersKbf !== undefined ? { rogersKbf: r.rogersKbf } : {}),
    ...(r.aeroModel === 'hybrid' && (r.hybridBand || !r.importedSummary)
      ? { hybridBand: r.hybridBand ?? APP_HYBRID_BAND } : {}),
    maxAltitude: r.maxAltitude, maxVelocity: r.maxVelocity,
    maxAcceleration: r.maxAcceleration, maxMach: r.maxMach,
    timeToApogee: r.timeToApogee, flightTime: r.totalFlightTime,
    groundHitVelocity: r.groundHitVelocity, launchRodVelocity: r.rodExitVelocity,
    deploymentVelocity: r.velocityAtDeployment, optimumDelay: r.optimumDelayS,
  };
}

/** Missing/non-finite values share the on-disk unknown value. No lossy hash. */
export function summaryFingerprint(configId: string | null | undefined, fd: OrkExportFlightData): string {
  return JSON.stringify([
    configId ?? null, fd.aeroModel, fd.rogersKbf, fd.hybridBand ?? null,
    fd.maxAltitude, fd.maxVelocity, fd.maxAcceleration, fd.maxMach,
    fd.timeToApogee, fd.flightTime, fd.groundHitVelocity, fd.launchRodVelocity,
    fd.deploymentVelocity, fd.optimumDelay,
  ]);
}

export function sameStoredFlight(a: SimRun, b: SimRun): boolean {
  return (a.importedRunId ?? a.id) === (b.importedRunId ?? b.id)
    && summaryFingerprint(a.flightConfigId, summaryOf(a)) === summaryFingerprint(b.flightConfigId, summaryOf(b));
}
