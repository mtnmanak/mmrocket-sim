import { MAX_DIMENSION_M } from './schema.js';

/** Null selects automatic sizing; a finite stated exit is bounded in metres. */
export function boundedNozzleDiameter(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_DIMENSION_M) : null;
}
