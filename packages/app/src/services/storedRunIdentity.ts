import type { SimRun } from './simReport.js';
import type { OrkExportFlightData } from './orkFile.js';
import { APP_HYBRID_BAND } from './aeroProvenance.js';

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
