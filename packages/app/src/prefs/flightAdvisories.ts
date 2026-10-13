/** N007/N010: personal advice only. SI inputs never reach the simulator. */
export interface FlightAdvisories {
  maxAirspeedMs?: number;
  maxMach?: number;
  armingAltitudeM?: number;
  armingCautionBandM?: number;
}

export function normalizeFlightAdvisories(value: unknown): FlightAdvisories | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const out: FlightAdvisories = {};
  for (const key of ['maxAirspeedMs', 'maxMach', 'armingAltitudeM', 'armingCautionBandM'] as const) {
    const v = input[key];
    const min = key === 'maxAirspeedMs' || key === 'maxMach' ? Number.MIN_VALUE : 0;
    if (typeof v === 'number' && Number.isFinite(v) && v >= min) out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
