import { storedWarnings } from './storedWarnings.js';
import type { SimRun } from './simReport.js';
import type { OrkExportFlightData } from './orkFile.js';
import { APP_HYBRID_BAND } from './aeroProvenance.js';
import type { EngineWarning } from '@online-openrocket/engine';

/** JSON evidence equality, independent of object property insertion order. */
function sameEvidence(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((value, i) => sameEvidence(value, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every(key => Object.hasOwn(right, key) && sameEvidence(left[key], right[key]));
}

/** Multiset union of two records of ONE flight: retain the larger occurrence
 * count for identical evidence, upgrading compatible text-only occurrences.
 * Match exact evidence first, then missing fields, always one-to-one across the
 * original arrays. Never coalesce occurrences within either record. Conflicting
 * evidence (including future fields) stays separate; no message text parsing.
 * Return the stored array on no change so identical/older imports are no-ops.
 */
export function mergeStoredWarnings(stored: EngineWarning[] | undefined,
incoming: EngineWarning[] | undefined): EngineWarning[] | undefined {
  stored = storedWarnings(stored);
  incoming = storedWarnings(incoming);
  if (!incoming?.length) return stored;
  if (!stored?.length) return incoming;
  const matches = new Map<number, number>(); // stored occurrence -> incoming occurrence
  const exact = new Set<number>();
  const matchedIncoming = new Set<number>();
  incoming.forEach((warning, i) => {
    const at = stored.findIndex((old, j) => !matches.has(j) && sameEvidence(old, warning));
    if (at !== -1) {
      matches.set(at, i);
      exact.add(at);
      matchedIncoming.add(i);
    }
  });
  const compatible = (old: EngineWarning, warning: EngineWarning) =>
    old.key === warning.key && old.message === warning.message
      && Object.entries(warning).every(([key, value]) => {
        const previous = (old as unknown as Record<string, unknown>)[key];
        return previous == null || value == null || sameEvidence(previous, value);
      });
  // Reassign partial matches when necessary: a broad text-only occurrence must
  // not strand a later occurrence that has only one compatible counterpart.
  const match = (i: number, visited: Set<number>): boolean => {
    for (let j = 0; j < stored.length; j++) {
      if (exact.has(j) || visited.has(j) || !compatible(stored[j]!, incoming[i]!)) continue;
      visited.add(j);
      const previous = matches.get(j);
      if (previous === undefined || match(previous, visited)) {
        matches.set(j, i);
        return true;
      }
    }
    return false;
  };
  incoming.forEach((_warning, i) => {
    if (!matchedIncoming.has(i) && match(i, new Set())) matchedIncoming.add(i);
  });
  let changed = false;
  const merged = stored.map((old, j) => {
    const i = matches.get(j);
    if (i === undefined) return old;
    let enriched = old;
    for (const [key, value] of Object.entries(incoming[i]!)) {
      if (value != null && (old as unknown as Record<string, unknown>)[key] == null) {
        enriched = { ...enriched, [key]: value };
        changed = true;
      }
    }
    return enriched;
  });
  incoming.forEach((warning, i) => {
    if (!matchedIncoming.has(i)) {
      merged.push(warning);
      changed = true;
    }
  });
  return changed ? merged : stored;
}

/** Only the evidence carried by a saved .ork summary, including its source ID. */
export function summaryOf(r: SimRun): OrkExportFlightData {
  return {
    runId: r.importedRunId ?? r.id,
    ...(r.simWarnings !== undefined ? { simWarnings: storedWarnings(r.simWarnings) } : {}),
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
