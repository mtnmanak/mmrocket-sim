import { boundedWarningEvidence, createStoredWarningCache, MAX_WARNING_FIELDS, restoredWarnings, storedWarnings, type StoredWarningCache } from './storedWarnings.js';
import type { SimRun } from './simReport.js';
import type { OrkExportFlightData } from './orkFile.js';
import { APP_HYBRID_BAND } from './aeroProvenance.js';
import type { EngineWarning } from '@online-openrocket/engine';

export const MAX_WARNING_MERGE_WORK = 4_194_304;
const warningMergeExhausted = new Error('Warning merge work exhausted');
type WarningFields = Map<string, { value: unknown; canonical: number }>;

/** One counter for all warning pairs in an import, including persistence. */
export interface WarningMergeBudget {
  remaining: number;
  spend(): void;
  /** Updated from each result, never by walking the accumulated evidence. */
  rowCounts: Map<string, number>;
  skippedCopies: Map<string, number>;
  /** Planner results can be persisted without paying for the same merge twice. */
  preparedUpdates: Map<string, { before: EngineWarning[] | undefined; after: EngineWarning[] | undefined }>;
  evidence: StoredWarningCache;
  evidenceKeys: WeakMap<object, string>;
  fields: WeakMap<EngineWarning, WarningFields>;
  valueIds: Map<string, number>;
  groups: WeakMap<EngineWarning, number>;
  warningIds: WeakMap<EngineWarning, number>;
}

export function createWarningMergeBudget(): WarningMergeBudget {
  return {
    remaining: MAX_WARNING_MERGE_WORK,
    rowCounts: new Map(), skippedCopies: new Map(), preparedUpdates: new Map(),
    evidence: createStoredWarningCache(), evidenceKeys: new WeakMap(), fields: new WeakMap(),
    valueIds: new Map(), groups: new WeakMap(), warningIds: new WeakMap(),
    spend() {
      if (this.remaining <= 0) throw warningMergeExhausted;
      this.remaining--;
    },
  };
}

/** Read only the incoming copy before admission; the stored row is untouched on
 * refusal. The size charge covers its normalization/indexing and every pair.
 * Reading/repairing each incoming payload is linear in that payload's own size.
 */
export function mergeImportedWarnings(rowId: string, stored: EngineWarning[] | undefined,
incoming: EngineWarning[] | undefined, work: WarningMergeBudget): EngineWarning[] | undefined {
  incoming = restoredWarnings(incoming, work.evidence);
  const r = work.rowCounts.get(rowId) ?? stored?.length ?? 0;
  const i = incoming?.length ?? 0;
  if (!i) return stored;
  const cost = MAX_WARNING_FIELDS * (r + i) + MAX_WARNING_FIELDS * r * i;
  if (cost > work.remaining) {
    work.remaining = 0;
    work.skippedCopies.set(rowId, (work.skippedCopies.get(rowId) ?? 0) + 1);
    return stored;
  }
  work.remaining -= cost;
  // Partial-search counters are a second guard, separate from the prepaid
  // import budget. No traversal of stored occurs before the admission above.
  const search = createWarningMergeBudget();
  search.evidence = work.evidence;
  search.evidenceKeys = work.evidenceKeys;
  search.fields = work.fields;
  search.valueIds = work.valueIds;
  search.groups = work.groups;
  search.warningIds = work.warningIds;
  const merged = mergeStoredWarnings(stored, incoming, search);
  work.rowCounts.set(rowId, merged?.length ?? 0);
  return merged;
}

export function warningMergeNotes(work: WarningMergeBudget): string[] {
  return [...work.skippedCopies].map(([id, count]) => `Stored flight “${id}”: ${count} later ${count === 1 ? 'copy of this flight carried warnings that were' : 'copies of this flight carried warnings that were'} not merged because the warning merge work limit was reached.`);
}

/** Object insertion order is not evidence; array order and primitive types are. */
function evidenceKey(value: unknown, cache: WeakMap<object, string>): string {
  if (value !== null && typeof value === 'object') {
    const cached = cache.get(value);
    if (cached !== undefined) return cached;
    const row = value as Record<string, unknown>;
    const key = Array.isArray(value) ? `[${value.map(child => evidenceKey(child, cache)).join(',')}]`
      : `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${evidenceKey(row[key], cache)}`).join(',')}}`;
    cache.set(value, key);
    return key;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Multiset union of two records of ONE flight: retain the larger occurrence
 * count for identical evidence, upgrading compatible text-only occurrences.
 * Match exact evidence first, then missing fields, always one-to-one across the
 * original arrays. Never coalesce occurrences within either record. Conflicting
 * evidence (including future fields) stays separate; no message text parsing.
 * Return the stored array on no change so identical/older imports are no-ops.
 */
export function mergeStoredWarnings(stored: EngineWarning[] | undefined,
incoming: EngineWarning[] | undefined,
work: WarningMergeBudget = createWarningMergeBudget()): EngineWarning[] | undefined {
  // Bound the union before another duplicate summary feeds it back into this
  // merge. Use the same critical-warning fallback and note as saved storage.
  const overBudget = (stored && !boundedWarningEvidence(stored, work.evidence)) || (incoming && !boundedWarningEvidence(incoming, work.evidence));
  if (overBudget) return restoredWarnings(stored === incoming ? stored : [...(stored ?? []), ...(incoming ?? [])], work.evidence);
  stored = storedWarnings(stored, work.evidence);
  incoming = storedWarnings(incoming, work.evidence);
  if (!incoming?.length) return stored;
  if (!stored?.length) return incoming;
  const matches = new Map<number, number>(); // stored occurrence -> incoming occurrence
  const exact = new Set<number>();
  const matchedIncoming = new Set<number>();
  const exactPool = new Map<number, number[]>();
  const partialPool = new Map<number, number[]>();
  // Intern once per original payload. Subsequent indexing and pair checks
  // compare numbers, rather than re-hashing/comparing long evidence strings.
  const intern = (evidence: string) => {
    let id = work.valueIds.get(evidence);
    if (id === undefined) { id = work.valueIds.size; work.valueIds.set(evidence, id); }
    return id;
  };
  const warningId = (warning: EngineWarning) => {
    let id = work.warningIds.get(warning);
    if (id === undefined) { id = intern(evidenceKey(warning, work.evidenceKeys)); work.warningIds.set(warning, id); }
    return id;
  };
  // Canonicalize nested values once, not once for each candidate. The field
  // cap bounds pair checks by F even when one field carries large evidence.
  const fieldsOf = (warning: EngineWarning) => {
    let fields = work.fields.get(warning);
    if (!fields) {
      fields = new Map(Object.entries(warning).map(([key, value]) => {
        return [key, { value, canonical: intern(evidenceKey(value, work.evidenceKeys)) }] as const;
      }));
      work.fields.set(warning, fields);
    }
    return fields;
  };
  const storedFields = new Map<number, ReturnType<typeof fieldsOf>>();
  const incomingFields = new Map<number, ReturnType<typeof fieldsOf>>();
  const groupKey = (warning: EngineWarning) => {
    let key = work.groups.get(warning);
    if (key === undefined) { key = intern(JSON.stringify([warning.key, warning.message])); work.groups.set(warning, key); }
    return key;
  };
  stored.forEach((warning, j) => {
    const key = warningId(warning);
    const pool = exactPool.get(key) ?? [];
    pool.push(j);
    exactPool.set(key, pool);
    if (work.remaining > 0) {
      const group = groupKey(warning);
      const candidates = partialPool.get(group) ?? [];
      candidates.push(j);
      partialPool.set(group, candidates);
    }
  });
  // Pop in original occurrence order without repeatedly shifting arrays.
  for (const pool of exactPool.values()) pool.reverse();
  incoming.forEach((warning, i) => {
    const at = exactPool.get(warningId(warning))?.pop();
    if (at !== undefined) {
      matches.set(at, i);
      exact.add(at);
      matchedIncoming.add(i);
    }
  });
  const compatible = (j: number, i: number) => {
    work.spend();
    let oldFields = storedFields.get(j);
    if (!oldFields) { oldFields = fieldsOf(stored[j]!); storedFields.set(j, oldFields); }
    let newFields = incomingFields.get(i);
    if (!newFields) { newFields = fieldsOf(incoming[i]!); incomingFields.set(i, newFields); }
    for (const [key, field] of newFields) {
      work.spend();
      const previous = oldFields.get(key);
      if (previous?.value != null && field.value != null && previous.canonical !== field.canonical) return false;
    }
    return true;
  };
  // Cache compatibility during rerouting, including incompatible pairs, so
  // augmenting paths do not repeatedly walk potentially large details.
  const adjacency = new Map<number, number[]>();
  const candidatesFor = (i: number): number[] => {
    let candidates = adjacency.get(i);
    if (!candidates) {
      candidates = (partialPool.get(groupKey(incoming[i]!)) ?? [])
        .filter(j => {
          work.spend(); // Every scanned candidate, even exact or incompatible.
          return !exact.has(j) && compatible(j, i);
        });
      adjacency.set(i, candidates);
    }
    return candidates;
  };
  // Explore each candidate edge at most once across ALL reroutes. Restarting
  // an earlier occurrence's cursor for every search made dense search cubic.
  // Visit in the original depth-first order; if an explored edge would need
  // reconsideration, retain the unproven incoming occurrence separately.
  const nextCandidate = new Map<number, number>();
  const match = (start: number): boolean => {
    const stack = [{ i: start, through: -1 }];
    const visited = new Set<number>();
    while (stack.length) {
      work.spend(); // DFS step, including exhausted frames and visited slots.
      const frame = stack[stack.length - 1]!;
      const candidates = candidatesFor(frame.i);
      const next = nextCandidate.get(frame.i) ?? 0;
      if (next === candidates.length) { stack.pop(); continue; }
      const j = candidates[next]!;
      nextCandidate.set(frame.i, next + 1);
      if (visited.has(j)) continue;
      visited.add(j);
      const previous = matches.get(j);
      if (previous === undefined) {
        const path: [number, number][] = [[j, frame.i]];
        for (let at = stack.length - 1; at > 0; at--) {
          work.spend(); // Charge rerouting before committing any assignments.
          path.push([stack[at]!.through, stack[at - 1]!.i]);
        }
        for (const [storedAt, incomingAt] of path) matches.set(storedAt, incomingAt);
        return true;
      }
      stack.push({ i: previous, through: j });
    }
    return false;
  };
  try {
    for (let i = 0; i < incoming.length && work.remaining > 0; i++) {
      if (!matchedIncoming.has(i) && match(i)) matchedIncoming.add(i);
    }
  } catch (error) {
    if (error !== warningMergeExhausted) throw error;
    // A search only commits assignments once a complete path is found. Keep
    // every unproven occurrence separate when a comparison spends the budget.
  }
  let changed = false;
  const merged = stored.map((old, j) => {
    const i = matches.get(j);
    if (i === undefined || exact.has(j)) return old;
    const additions: [string, unknown][] = [];
    for (const [key, value] of Object.entries(incoming[i]!)) {
      if (value != null && (!Object.hasOwn(old, key) || (old as unknown as Record<string, unknown>)[key] == null)) {
        additions.push([key, value]);
        changed = true;
      }
    }
    // One object construction, using data properties even for a future field
    // named __proto__. Object.assign would invoke that name's legacy setter.
    return additions.length ? Object.fromEntries([...Object.entries(old), ...additions]) as EngineWarning : old;
  });
  incoming.forEach((warning, i) => {
    if (!matchedIncoming.has(i)) {
      merged.push(warning);
      changed = true;
    }
  });
  // Two individually valid arrays can also exceed the budget when combined.
  return !changed ? stored : boundedWarningEvidence(merged, work.evidence) ? merged : restoredWarnings(merged, work.evidence);
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

/**
 * The configuration identity a later open of the same file proves for an
 * already-stored imported summary (RES-1c): `flightConfig` is the verified
 * label of THIS row's configuration id, or undefined when the open proves
 * nothing. A row that is already verified, or carries no configuration id,
 * is left alone.
 */
export function verifiesStoredRow(stored: SimRun, flightConfig: string | undefined):
  Pick<SimRun, 'flightConfig' | 'importedConfigVerified'> | null {
  if (flightConfig === undefined || !stored.importedSummary || stored.importedConfigVerified === true
    || !stored.flightConfigId) return null;
  return { flightConfig, importedConfigVerified: true };
}
