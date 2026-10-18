import type { FlightResult } from '@online-openrocket/engine';
import { completedRecoveryEvents, type RecoveryEvent } from './recoveryMass.js';
import { runMatchesDesign, type DesignMatchKey, type SimRun } from './simReport.js';

/** Use the latest matching flight, never an older successful flight over a newer failed one. */
export function matchingRecoveryEvents(
  runs: readonly SimRun[], key: DesignMatchKey,
  flightFor: (id: string) => FlightResult | undefined,
): readonly RecoveryEvent[] | undefined {
  // Keep recorded separations/burnouts across atmosphere-only revisions;
  // all design, model, motor, delay, nozzle and tree-revision checks still apply.
  const run = runs.filter((r) => !r.importedSummary && runMatchesDesign(r, key, { includeModelRevisions: false }))
    .reduce<SimRun | undefined>((latest, r) => !latest || r.when > latest.when ? r : latest, undefined);
  if (!run) return undefined;
  const flight = flightFor(run.id);
  if (flight) return completedRecoveryEvents(flight);
  const events = run.recoveryEvents;
  // Saved runs are untrusted JSON; malformed evidence is not a completed flight.
  return Array.isArray(events) && events.every((e) => e && Number.isFinite(e.time)
    && (e.type === 'STAGE_SEPARATION' ? typeof e.sourceId === 'string'
      : e.type === 'BURNOUT' && typeof (e.motorMountId ?? e.sourceId) === 'string')) ? events : undefined;
}
