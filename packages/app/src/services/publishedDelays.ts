/**
 * AeroTech's published MEASURED ejection delays — what the launch report shows
 * beside a delay the certification tests fired (Eric's ruling of 2026-09-08,
 * "yes" to the delay-time band).
 *
 * The flight fires a charge at exactly the delay it is given. A real one does
 * not: the F52C's certification letter measured its 5 s delay at 4.946, 4.507
 * and 5.158 s. `src/data/aerotechDelays.json` holds every such figure the
 * certification documents print motor by motor, keyed by the catalogue's
 * motorId, and is built by `scripts/extract-aerotech-delays.py` from the
 * local-only `docs/RCS Schematics` (it cannot run in CI; the JSON is committed,
 * as nozzles.json is).
 *
 * A band is shown only where the data has THIS motor at THIS delay: a delay the
 * tests did not fire (a drilled 7 s on a motor tested at 5, 8 and 12) or a
 * motor identified only by name gets nothing, never a neighbour's figure.
 */
import data from '../data/aerotechDelays.json';
import type { StoredDelay } from './autoDelaySolver.js';

interface DelayRow { nominalS: number; measuredS: number[] }
interface MotorRow { designation: string; manufacturer: string; document: string; url: string; delays: DelayRow[] }

const MOTORS: Readonly<Record<string, MotorRow>> = data.motors;

/** The manufacturer's page listing every certification document the figures come from. */
export const PUBLISHED_DELAYS_URL: string = data.publishedOn;

export interface PublishedDelayBand {
  designation: string;
  nominalS: number;
  /** The shortest and longest delay measured, as printed. */
  minS: number;
  maxS: number;
  /** How many motors were fired at this delay. */
  count: number;
  /** The certification document, as AeroTech publishes it. */
  url: string;
}

/**
 * The published measured band for a mount's motor at the delay it flew, or
 * null. `motorIdentity` is the mount's catalogue motorId (`delayMountsOf`); a
 * plugged or non-finite delay, or one the tests did not fire, has none.
 */
export function publishedDelayBand(motorIdentity: string, flown: StoredDelay): PublishedDelayBand | null {
  if (typeof flown !== 'number' || !Number.isFinite(flown)) return null;
  if (!Object.hasOwn(MOTORS, motorIdentity)) return null;
  const motor = MOTORS[motorIdentity]!;
  const row = motor.delays.find((d) => d.nominalS === flown);
  if (!row || row.measuredS.length === 0) return null;
  return {
    designation: motor.designation,
    nominalS: row.nominalS,
    minS: Math.min(...row.measuredS),
    maxS: Math.max(...row.measuredS),
    count: row.measuredS.length,
    url: motor.url,
  };
}

/**
 * "4.5–5.2 s (3 motors)". Rounded OUTWARD to a tenth of a second — the
 * shortest down, the longest up — so the band shown is never narrower than
 * the one measured. A single motor reads as its one figure, "5.4 s (1 motor)".
 */
export function formatDelayBand(b: Pick<PublishedDelayBand, 'minS' | 'maxS' | 'count'>): string {
  const motors = `${b.count} motor${b.count === 1 ? '' : 's'}`;
  if (b.count === 1 || b.minS === b.maxS) return `${b.minS.toFixed(1)} s (${motors})`;
  const lo = Math.floor(b.minS * 10) / 10;
  const hi = Math.ceil(b.maxS * 10) / 10;
  return `${lo.toFixed(1)}–${hi.toFixed(1)} s (${motors})`;
}
