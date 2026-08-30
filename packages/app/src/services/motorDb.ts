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

/**
 * Display form of a motor designation (the owner's cleanup rules):
 * - Cesaroni catalogs the total impulse in front of the real designation
 *   ("381I224-15A" is the I224-15A) — strip the leading digits.
 * - AeroTech/Loki sometimes prepend "HP-" ("HP-I140W") — strip it.
 * The RAW designation stays the identity for .ork files and API calls;
 * this is a display/report transform only.
 */
export function displayDesignation(designation: string, manufacturer?: string): string {
  let d = designation.replace(/^HP-/i, '');
  if (manufacturer === 'Cesaroni') d = d.replace(/^\d+(?=[A-O]\d)/, '');
  return d;
}

/**
 * High-power line — the owner's G80 rule, which matches certification: high power
 * ⇔ average thrust > 80 N or total impulse > 160 Ns. The G80 itself is
 * low/mid. Drives staging defaults (electronics-timed HPR sustainers) and
 * booster-recovery warnings (HPR boosters MUST have active recovery).
 */
export function isHighPower(m: { avgThrustN: number; totImpulseNs: number }): boolean {
  return m.avgThrustN > 80 || m.totImpulseNs > 160;
}

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
  /** Selected impulse classes ("A".."O"), uppercase; empty set = all. */
  impulse?: Set<string>;
  /** Selected propellant names; empty/absent = all. */
  propellants?: Set<string>;
  /** Mount bore (mm) — motors above this never show. */
  boreMm: number;
  includeOOP: boolean;
  /**
   * Longest motor the airframe has room for (m), when the filter is asked to
   * enforce it. Null/absent = no length filtering; over-length motors are
   * flagged in the table either way.
   */
  maxLengthM?: number | null;
  /** Free-text match against designation / common name. */
  text: string;
}

/** A motor's impulse letter, from the catalog's own class field. */
export function impulseLetter(m: MotorDbEntry): string {
  const c = (m.impulseClass ?? '').trim().toUpperCase();
  return c ? c[0]! : '';
}

/** The impulse letters present among motors that fit this mount, in order. */
export function impulseClassesForMount(
  boreMm: number, includeOOP: boolean, motors: MotorDbEntry[] = MOTOR_DB,
): { letter: string; count: number }[] {
  const fitting = new Set(classesFittingMount(boreMm, motors));
  const counts = new Map<string, number>();
  for (const m of motors) {
    if (!fitting.has(diameterClass(m.diameter))) continue;
    if (!includeOOP && m.availability !== 'regular') continue;
    const l = impulseLetter(m);
    if (!l) continue;
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([letter, count]) => ({ letter, count }))
    .sort((a, b) => a.letter.localeCompare(b.letter));
}

/** The propellant names present among motors that fit this mount. */
export function propellantsForMount(
  boreMm: number, includeOOP: boolean, motors: MotorDbEntry[] = MOTOR_DB,
): { name: string; count: number }[] {
  const fitting = new Set(classesFittingMount(boreMm, motors));
  const counts = new Map<string, number>();
  for (const m of motors) {
    if (!fitting.has(diameterClass(m.diameter))) continue;
    if (!includeOOP && m.availability !== 'regular') continue;
    const p = (m.propInfo ?? '').trim();
    if (!p) continue;
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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
    if (filter.impulse && filter.impulse.size > 0 && !filter.impulse.has(impulseLetter(m))) return false;
    if (filter.propellants && filter.propellants.size > 0
      && !filter.propellants.has((m.propInfo ?? '').trim())) return false;
    // Lengths are millimetres in the catalog, metres in the app.
    if (filter.maxLengthM != null && m.length / 1000 > filter.maxLengthM + 1e-9) return false;
    if (text
      && !m.designation.toLowerCase().includes(text)
      && !displayDesignation(m.designation, m.manufacturerAbbrev).toLowerCase().includes(text)
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
  // The Motor column shows the DISPLAY designation, so sort what's shown
  // (Cesaroni's raw "381I224" would otherwise order by impulse prefix).
  const val = (m: MotorDbEntry) => key === 'designation'
    ? displayDesignation(m.designation, m.manufacturerAbbrev)
    : m[key];
  return [...motors].sort((a, b) => {
    const av = val(a);
    const bv = val(b);
    const cmp = typeof av === 'string' && typeof bv === 'string'
      ? av.localeCompare(bv)
      : (Number(av) || 0) - (Number(bv) || 0);
    return cmp !== 0 ? cmp * dir : a.designation.localeCompare(b.designation);
  });
}

/**
 * Finds the bundled-DB motor a .ork file refers to. Desktop files store the
 * catalog designation (sometimes the display form, sometimes with prefixes),
 * so match raw designation, display designation, and common name — using the
 * file's motor diameter as a tiebreaker and preferring in-production entries.
 */
export function findDbMotor(
  designation: string,
  diameterMm?: number,
  motors: MotorDbEntry[] = MOTOR_DB,
): MotorDbEntry | null {
  const want = designation.trim().toLowerCase();
  if (!want) return null;
  const rank = (m: MotorDbEntry): number => {
    const raw = m.designation.toLowerCase();
    const disp = displayDesignation(m.designation, m.manufacturerAbbrev).toLowerCase();
    if (raw === want || disp === want) return 0;
    // Delay-suffix tolerance: "I224-15A" in the file vs "I224" cataloged, or
    // the file omitting the delay the catalog lists.
    if (raw.startsWith(want) || disp.startsWith(want)
      || want.startsWith(disp) || m.commonName.toLowerCase() === want) return 1;
    return -1;
  };
  const candidates = motors
    .map((m) => ({ m, r: rank(m) }))
    .filter(({ m, r }) => r >= 0
      && (diameterMm === undefined || Math.abs(m.diameter - diameterMm) <= 1.5));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.r - b.r
    || Number(b.m.availability === 'regular') - Number(a.m.availability === 'regular'));
  return candidates[0]!.m;
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

/**
 * Can this catalog entry actually be simulated?
 *
 * thrustcurve.org's catalog is not uniformly populated. As of the bundled
 * snapshot, 146 of 1129 entries publish no loaded weight, 14 no propellant
 * weight, and Cesaroni 25E75-17A lists more propellant (104 g) than loaded
 * mass (52 g). Those produce NaN or negative motor masses, which used to reach
 * the kernel and blank the user's design with a raw BigInt error. The UI uses
 * this to disable such rows rather than hide them — they are legitimate catalog
 * entries, and hiding them would make the database look wrong.
 */
export function hasMassData(m: Pick<TcMotor, 'totalWeightG' | 'propWeightG'>): boolean {
  return (
    Number.isFinite(m.totalWeightG) &&
    Number.isFinite(m.propWeightG) &&
    m.propWeightG <= m.totalWeightG
  );
}
