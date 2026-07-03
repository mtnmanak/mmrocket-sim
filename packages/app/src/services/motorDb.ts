import type { TcMotor } from './thrustcurve.js';
import rawDb from '../data/motors.json';

/**
 * Bundled ThrustCurve motor summary database (metadata only — thrust curves
 * download on demand). Regenerate with scripts/fetch-motor-db.mjs.
 *
 * Diameter-class model: motors are grouped into nominal diameter classes by
 * snapping to the closest common casing size within a tolerance. 75 mm and
 * 76 mm are THE SAME class — real cases fall between and manufacturers round
 * differently (AeroTech says 75, Loki says 76). A mount fits every class at
 * or below its own (smaller motors ride in adapters); larger never fits.
 */

export interface MotorDbEntry extends TcMotor {
  /** 'SU' | 'reload' | 'hybrid' */
  type: string;
}

const db = rawDb as { generated: string; count: number; motors: MotorDbEntry[] };

export const MOTOR_DB: MotorDbEntry[] = db.motors;
export const MOTOR_DB_DATE: string = db.generated;

/** Common casing sizes (mm). 76 intentionally absent — it snaps to 75. */
const COMMON_CLASSES = [6, 13, 18, 24, 29, 38, 54, 75, 98, 132, 152];

/** How far a cataloged diameter may sit from a common size and still be that class. */
const SNAP_TOLERANCE_MM = 1.5;

/** Extra bore clearance when checking what fits a mount (tube IDs run oversize). */
const MOUNT_TOLERANCE_MM = 1.0;

/** Nominal diameter class for a cataloged motor diameter (mm). */
export function diameterClass(diameterMm: number): number {
  let best = -1;
  let bestDist = Infinity;
  for (const c of COMMON_CLASSES) {
    const d = Math.abs(diameterMm - c);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return bestDist <= SNAP_TOLERANCE_MM ? best : diameterMm;
}

/** Display label for a class — the 75 class covers both 75 and 76 mm casings. */
export function classLabel(cls: number): string {
  return cls === 75 ? '75/76' : String(cls);
}

/** All diameter classes present in the database, ascending. */
export function allClasses(motors: MotorDbEntry[] = MOTOR_DB): number[] {
  return [...new Set(motors.map((m) => diameterClass(m.diameter)))].sort((a, b) => a - b);
}

/** Classes that physically fit a mount with the given bore (inner diameter, mm). */
export function classesFittingMount(boreMm: number, motors: MotorDbEntry[] = MOTOR_DB): number[] {
  return allClasses(motors).filter((c) => c <= boreMm + MOUNT_TOLERANCE_MM);
}

export interface MotorFilter {
  /** Selected manufacturer abbrevs; empty set = all. */
  manufacturers: Set<string>;
  /** Selected diameter classes; empty set = all fitting classes. */
  classes: Set<number>;
  /** Mount bore (mm) — motors above this never show. */
  boreMm: number;
  includeOOP: boolean;
  /** Free-text match against designation / common name. */
  text: string;
}

export function filterMotors(filter: MotorFilter, motors: MotorDbEntry[] = MOTOR_DB): MotorDbEntry[] {
  const text = filter.text.trim().toLowerCase();
  const fitting = new Set(classesFittingMount(filter.boreMm, motors));
  return motors.filter((m) => {
    const cls = diameterClass(m.diameter);
    if (!fitting.has(cls)) return false;
    if (filter.classes.size > 0 && !filter.classes.has(cls)) return false;
    if (filter.manufacturers.size > 0 && !filter.manufacturers.has(m.manufacturerAbbrev)) return false;
    if (!filter.includeOOP && m.availability !== 'regular') return false;
    if (text
      && !m.designation.toLowerCase().includes(text)
      && !m.commonName.toLowerCase().includes(text)) return false;
    return true;
  });
}

export type MotorSortKey =
  | 'designation' | 'manufacturerAbbrev' | 'diameter' | 'length'
  | 'burnTimeS' | 'totImpulseNs' | 'avgThrustN' | 'totalWeightG';

export function sortMotors(
  motors: MotorDbEntry[],
  key: MotorSortKey,
  dir: 1 | -1,
): MotorDbEntry[] {
  return [...motors].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    const cmp = typeof av === 'string' && typeof bv === 'string'
      ? av.localeCompare(bv)
      : (Number(av) || 0) - (Number(bv) || 0);
    return cmp !== 0 ? cmp * dir : a.designation.localeCompare(b.designation);
  });
}

/** Manufacturers present among motors that fit the mount, with counts. */
export function manufacturersForMount(
  boreMm: number,
  includeOOP: boolean,
  motors: MotorDbEntry[] = MOTOR_DB,
): { abbrev: string; count: number }[] {
  const fitting = new Set(classesFittingMount(boreMm, motors));
  const counts = new Map<string, number>();
  for (const m of motors) {
    if (!fitting.has(diameterClass(m.diameter))) continue;
    if (!includeOOP && m.availability !== 'regular') continue;
    counts.set(m.manufacturerAbbrev, (counts.get(m.manufacturerAbbrev) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([abbrev, count]) => ({ abbrev, count }))
    .sort((a, b) => b.count - a.count || a.abbrev.localeCompare(b.abbrev));
}
