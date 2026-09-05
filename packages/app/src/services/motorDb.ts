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

/** The SHIPPED catalogue — what motors.json holds. Tests and the diff read this. */
export const MOTOR_DB: MotorDbEntry[] = db.motors;
export const MOTOR_DB_DATE: string = db.generated;

// ------------------------------------------------------------ the live overlay

/**
 * One row that thrustcurve.org has changed since the shipped catalogue was
 * generated, with the fields that differ, so the user can be TOLD — a changed
 * certified impulse moves an apogee, and silence about it is the failure class
 * this project spent 4–5 September on.
 */
export interface CatalogueChange {
  motorId: string;
  before: MotorDbEntry;
  after: MotorDbEntry;
  fields: string[];
}

/**
 * The difference between the shipped catalogue and thrustcurve.org as of
 * `fetchedAt`, fetched on the user's request from the motor browser and kept
 * in THIS BROWSER only — motors.json is never written by the app.
 *
 * Why an overlay and not a session flag (owner, 2026-09-05): a session-only
 * result means a design saved with a motor that exists only in the overlay
 * comes back "not in the database" the next morning. Persisted per browser,
 * and discarded automatically the moment a shipped motors.json is newer than
 * the base it was diffed against — a release supersedes it. Why not a second
 * permanent catalogue: the shipped file gets a human look at its diff at every
 * refresh; a live pull does not, so every overlay row is screened first and
 * the rejects are reported rather than applied.
 */
export interface CatalogueOverlay {
  /** MOTOR_DB_DATE this overlay was diffed against. Any other date → discard. */
  baseGenerated: string;
  /** ISO timestamp of the fetch. */
  fetchedAt: string;
  /** How many motors thrustcurve.org returned. */
  liveCount: number;
  added: MotorDbEntry[];
  changed: CatalogueChange[];
  /** motorIds in the shipped catalogue that thrustcurve.org no longer returns. */
  removed: string[];
  /** Live rows that failed the plausibility screen, with the reason. Never applied. */
  rejected: { entry: Partial<MotorDbEntry>; reason: string }[];
}

/**
 * The shipped catalogue with an overlay applied: changed rows replaced, added
 * rows appended, removed rows KEPT but marked out of production — a design may
 * still reference one, and "hidden by default but resolvable" is the honest
 * state for a motor thrustcurve.org has dropped. With no overlay it returns
 * `base` itself, so identity checks against MOTOR_DB (allClasses' fast path)
 * keep working.
 */
export function applyOverlay(base: MotorDbEntry[], overlay: CatalogueOverlay | null): MotorDbEntry[] {
  if (!overlay || (!overlay.added.length && !overlay.changed.length && !overlay.removed.length)) return base;
  const changed = new Map(overlay.changed.map((c) => [c.motorId, c.after]));
  const removed = new Set(overlay.removed);
  const out = base.map((m) => {
    const c = changed.get(m.motorId);
    if (c) return c;
    if (removed.has(m.motorId) && m.availability !== 'OOP') return { ...m, availability: 'OOP' };
    return m;
  });
  const have = new Set(out.map((m) => m.motorId));
  for (const a of overlay.added) if (!have.has(a.motorId)) out.push(a);
  return out;
}

let activeOverlay: CatalogueOverlay | null = null;
let effective: MotorDbEntry[] = MOTOR_DB;
const listeners = new Set<() => void>();

/**
 * THE catalogue every lookup in this module defaults to — the shipped rows plus
 * whatever overlay is active. Read at call time (it is the default parameter
 * of every exported query), so the import matcher, the browser, the batch
 * runner and the quick picks all see the same motors.
 */
export function getCatalogue(): MotorDbEntry[] {
  return effective;
}

export function getCatalogueOverlay(): CatalogueOverlay | null {
  return activeOverlay;
}

/** Installs (or clears) the overlay and tells every subscriber. */
export function setCatalogueOverlay(overlay: CatalogueOverlay | null): void {
  activeOverlay = overlay;
  effective = applyOverlay(MOTOR_DB, overlay);
  for (const fn of listeners) fn();
}

/** For useSyncExternalStore: fires after every setCatalogueOverlay. */
export function subscribeCatalogue(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Is this motor something you can buy today? thrustcurve.org's availability
 * field has THREE values — 'regular', 'occasional' and 'OOP' — and until v0.108
 * every filter here tested `!== 'regular'`, which put the 26 'occasional' motors
 * (Jambol's whole line, and Ultra's) behind the "include out-of-production"
 * checkbox and labelled them as discontinued. 'occasional' means produced
 * intermittently, not gone; only 'OOP' is out of production.
 */
export const isAvailable = (m: Pick<MotorDbEntry, 'availability'>): boolean =>
  m.availability !== 'OOP';

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
/**
 * The casing sizes people actually build around. Exported since v0.091: the
 * Scale dialog offers them as the motor-mount choices, because the nearest
 * size to a scaled bore is a recommendation rather than an answer (the owner's
 * case: a 4 in LOC IV upscaled to 7.51 in wants 75 mm by arithmetic and most
 * people would build 98). The database also holds 10.5, 20, 32, 64, 81 and
 * 161 mm classes; those are deliberately NOT offered - his ruling was "just
 * use common classes and custom, people can use custom for that".
 */
export const COMMON_CLASSES = [6, 13, 18, 24, 29, 38, 54, 75, 98, 132, 152];

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

/**
 * The nearest standard casing size to an arbitrary diameter (mm), with no
 * tolerance gate — unlike `diameterClass`, which answers "which class is this
 * CATALOGED motor in" and deliberately returns odd diameters unchanged so a
 * 10.5 mm or 161 mm motor keeps its own class.
 *
 * The Scale tool needs the other question: an 18 mm mount scaled by 2.27 has a
 * 40.9 mm bore, which is not a motor anybody sells, and the user has to be
 * offered the real size next to it (Apogee's own worked example — and their
 * answer there was 24 mm rather than the nearest 38, "quite a few engineering
 * decisions"). Ties round DOWN to the smaller class, since a mount that is
 * slightly too small can be opened out and one that is too big cannot.
 */
export function nearestCommonClass(diameterMm: number): number {
  let best = COMMON_CLASSES[0]!;
  let bestDist = Infinity;
  for (const c of COMMON_CLASSES) {
    const d = Math.abs(diameterMm - c);
    if (d < bestDist - 1e-9) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

/** Display label for a class — the 75 class covers both 75 and 76 mm casings. */
export function classLabel(cls: number): string {
  return cls === 75 ? '75/76' : String(cls);
}

/**
 * The default argument's answer, derived once.
 *
 * `MOTOR_DB` is a static import of 1,129 rows and the classes in it never
 * change, but `allClasses()` was rebuilding a map, a Set and a sort on every
 * call — and `classesFittingMount` calls it, which `previewMounts` calls once
 * per motored mount on every keystroke in the Scale dialog, on top of five
 * callers in the motor browser. Small (~0.04 ms a call) and pure waste.
 */
let defaultClasses: number[] | null = null;

/** All diameter classes present in the database, ascending. */
export function allClasses(motors: MotorDbEntry[] = getCatalogue()): number[] {
  if (motors === MOTOR_DB) {
    defaultClasses ??= [...new Set(motors.map((m) => diameterClass(m.diameter)))]
      .sort((a, b) => a - b);
    // A copy, so a caller that sorts or splices the result in place cannot
    // corrupt the cache for everyone else. Seventeen numbers; the scan of
    // 1,129 rows is the part worth not repeating.
    return defaultClasses.slice();
  }
  return [...new Set(motors.map((m) => diameterClass(m.diameter)))].sort((a, b) => a - b);
}

/** Classes that physically fit a mount with the given bore (inner diameter, mm). */
export function classesFittingMount(boreMm: number, motors: MotorDbEntry[] = getCatalogue()): number[] {
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
  /**
   * Inclusive windows on the catalog's own numbers; either end may be null for
   * "no bound". Burn time is seconds, impulse newton-seconds — the units the
   * table already shows, so a typed number means what it looks like.
   */
  burnS?: { min: number | null; max: number | null };
  impulseNs?: { min: number | null; max: number | null };
  /** Free-text match against designation / common name. */
  text: string;
}

/** Inclusive, and tolerant of a null bound. NaN in the data never passes. */
const inWindow = (v: number, w?: { min: number | null; max: number | null }): boolean => {
  if (!w || (w.min == null && w.max == null)) return true;
  if (!Number.isFinite(v)) return false;
  if (w.min != null && v < w.min - 1e-9) return false;
  if (w.max != null && v > w.max + 1e-9) return false;
  return true;
};

/** The burn-time and total-impulse span of the motors that fit this mount. */
export function rangesForMount(
  boreMm: number, includeOOP: boolean, motors: MotorDbEntry[] = getCatalogue(),
): { burnS: [number, number]; impulseNs: [number, number] } | null {
  const fitting = new Set(classesFittingMount(boreMm, motors));
  let b0 = Infinity; let b1 = -Infinity; let i0 = Infinity; let i1 = -Infinity;
  for (const m of motors) {
    if (!fitting.has(diameterClass(m.diameter))) continue;
    if (!includeOOP && !isAvailable(m)) continue;
    if (Number.isFinite(m.burnTimeS)) { b0 = Math.min(b0, m.burnTimeS); b1 = Math.max(b1, m.burnTimeS); }
    if (Number.isFinite(m.totImpulseNs)) { i0 = Math.min(i0, m.totImpulseNs); i1 = Math.max(i1, m.totImpulseNs); }
  }
  if (!Number.isFinite(b0) || !Number.isFinite(i0)) return null;
  return { burnS: [b0, b1], impulseNs: [i0, i1] };
}

/** A motor's impulse letter, from the catalog's own class field. */
export function impulseLetter(m: MotorDbEntry): string {
  const c = (m.impulseClass ?? '').trim().toUpperCase();
  return c ? c[0]! : '';
}

/** The impulse letters present among motors that fit this mount, in order. */
export function impulseClassesForMount(
  boreMm: number, includeOOP: boolean, motors: MotorDbEntry[] = getCatalogue(),
): { letter: string; count: number }[] {
  const fitting = new Set(classesFittingMount(boreMm, motors));
  const counts = new Map<string, number>();
  for (const m of motors) {
    if (!fitting.has(diameterClass(m.diameter))) continue;
    if (!includeOOP && !isAvailable(m)) continue;
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
  boreMm: number, includeOOP: boolean, motors: MotorDbEntry[] = getCatalogue(),
): { name: string; count: number }[] {
  const fitting = new Set(classesFittingMount(boreMm, motors));
  const counts = new Map<string, number>();
  for (const m of motors) {
    if (!fitting.has(diameterClass(m.diameter))) continue;
    if (!includeOOP && !isAvailable(m)) continue;
    const p = (m.propInfo ?? '').trim();
    if (!p) continue;
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function filterMotors(filter: MotorFilter, motors: MotorDbEntry[] = getCatalogue()): MotorDbEntry[] {
  const text = filter.text.trim().toLowerCase();
  const fitting = new Set(classesFittingMount(filter.boreMm, motors));
  return motors.filter((m) => {
    const cls = diameterClass(m.diameter);
    if (!fitting.has(cls)) return false;
    if (filter.classes.size > 0 && !filter.classes.has(cls)) return false;
    if (filter.manufacturers.size > 0 && !filter.manufacturers.has(m.manufacturerAbbrev)) return false;
    if (!filter.includeOOP && !isAvailable(m)) return false;
    if (filter.impulse && filter.impulse.size > 0 && !filter.impulse.has(impulseLetter(m))) return false;
    if (filter.propellants && filter.propellants.size > 0
      && !filter.propellants.has((m.propInfo ?? '').trim())) return false;
    // Lengths are millimetres in the catalog, metres in the app.
    if (filter.maxLengthM != null && m.length / 1000 > filter.maxLengthM + 1e-9) return false;
    if (!inWindow(m.burnTimeS, filter.burnS)) return false;
    if (!inWindow(m.totImpulseNs, filter.impulseNs)) return false;
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
 * Desktop-file manufacturer names that are NOT a prefix of our thrustcurve
 * abbreviation, so the generic prefix rule in {@link manufacturerMatches}
 * cannot pair them. Keys are normalized (lower-case, alphanumerics only).
 *
 * Only names that actually appear in OpenRocket's own Manufacturer table are
 * listed: an alias nobody writes is a liability, because a wrong one silently
 * steers a match to the wrong vendor's curve.
 */
const MANUFACTURER_ALIASES: Record<string, string> = {
  publicmissiles: 'pml',
  publicmissilesltd: 'pml',
  rcsrocketmotorcomponents: 'aerotech',
  aerotechrcs: 'aerotech',
  ctc: 'cesaroni',
  cti: 'cesaroni',
  westcoasthybrids: 'wch',
  propulsionpolymers: 'pp',
  rocketvision: 'rv',
  skyrippersystems: 'skyr',
  skyripper: 'skyr',
  animalmotorworks: 'amw',
  amwprox: 'amw',
};

const normMfr = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Does the manufacturer a design file names refer to this catalog entry's
 * vendor?
 *
 * The file carries desktop OpenRocket's full name ("Public Missiles Ltd.") and
 * the bundled catalog carries thrustcurve.org's abbreviation ("PML"), so exact
 * equality answers almost nothing. The prefix rule covers the common shape
 * ("Estes Industries" → "Estes", "Cesaroni Technology" → "Cesaroni"); the
 * alias table above covers the ones it cannot reach.
 *
 * Exported for tests — a mis-paired alias sends a flight to another vendor's
 * thrust curve, which is a wrong number, not a cosmetic slip.
 */
export function manufacturerMatches(fileName: string | undefined, abbrev: string): boolean {
  if (!fileName) return false;
  const a = normMfr(fileName);
  // 'unknown' is our own reader's fallback and 'custom' our old writer's —
  // sentinels, not manufacturers, and they must never steer a match.
  if (!a || a === 'unknown' || a === 'custom') return false;
  const b = normMfr(abbrev);
  if (!b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a) || MANUFACTURER_ALIASES[a] === b;
}

/**
 * Finds the bundled-DB motor a .ork file refers to. Desktop files store the
 * catalog designation (sometimes the display form, sometimes with prefixes),
 * so match raw designation, display designation, and common name — using the
 * file's motor diameter as a tiebreaker and preferring in-production entries.
 *
 * `manufacturer` (the file's own `<manufacturer>`) is OPTIONAL and ranks
 * BELOW the designation match but ABOVE the in-production tie-break. Without
 * it, 18 designation+diameter groups in the shipped catalog span more than one
 * vendor and the in-production entry always won: a Public Missiles G80T
 * resolved to AeroTech's (136.6 Ns against PML's 116.25 Ns — 17.5 % of total
 * impulse), and Apogee's E6/F10 resolved to AeroTech's. Omitting the argument
 * reproduces the old ordering exactly, so every existing caller is unchanged.
 */
export function findDbMotor(
  designation: string,
  diameterMm?: number,
  motors: MotorDbEntry[] = getCatalogue(),
  manufacturer?: string,
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
    || Number(manufacturerMatches(manufacturer, b.m.manufacturerAbbrev))
      - Number(manufacturerMatches(manufacturer, a.m.manufacturerAbbrev))
    || Number(isAvailable(b.m)) - Number(isAvailable(a.m)));
  return candidates[0]!.m;
}

/** Manufacturers present among motors that fit the mount, with counts. */
export function manufacturersForMount(
  boreMm: number,
  includeOOP: boolean,
  motors: MotorDbEntry[] = getCatalogue(),
): { abbrev: string; count: number }[] {
  const fitting = new Set(classesFittingMount(boreMm, motors));
  const counts = new Map<string, number>();
  for (const m of motors) {
    if (!fitting.has(diameterClass(m.diameter))) continue;
    if (!includeOOP && !isAvailable(m)) continue;
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
