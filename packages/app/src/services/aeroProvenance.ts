/** Provenance of a flight, independent of the user's current aero preference. */
export interface AeroProvenance {
  aeroModel?: 'classic' | 'supersonic' | 'auto-supersonic' | 'hybrid';
  rogersKbf?: boolean;
  /** Lower/upper blend bounds, in Mach. Absent means the band is unknown. */
  hybridBand?: readonly [number, number];
}

// BarrowmanCalculator.java M_LOW/M_HIGH. The app never calls setHybridBand;
// every app flight uses these kernel defaults. Stamp at flight time, not read time.
export const APP_HYBRID_BAND = [0.8, 1.2] as const;

export function isAeroModel(value: unknown): value is NonNullable<AeroProvenance['aeroModel']> {
  return value === 'classic' || value === 'supersonic' || value === 'auto-supersonic' || value === 'hybrid';
}

export function validHybridBand(value: unknown): value is readonly [number, number] {
  return Array.isArray(value) && value.length === 2
    && Number.isFinite(value[0]) && Number.isFinite(value[1])
    && value[0] >= 0 && value[0] < value[1];
}
