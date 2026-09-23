import type { TcMotor } from './thrustcurve.js';
import { lookupTable } from './xmlUtil.js';
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
 * of every exported query), so the import matcher and the quick picks see the
 * same motors as everything else. The browser and the batch runner pass their
 * OWN list, this one plus the imported EX motors, and each builds it from
 * `useCatalogue()` so it follows an overlay too; the batch built it from the
 * static MOTOR_DB until the 2026-09-22 audit, and flew the stale rows.
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
 * Average thrust over 80 N, or total impulse over 160 Ns.
 *
 * ⚠ THIS NO LONGER DECIDES IGNITION, and the name it used to be given here —
 * "the G80 rule" — is struck. Eric, 2026-09-18: *"that is NOT a real rule and
 * doesn't exist … The differentiation is in the propellant of the motor, not
 * its classification."* See isBlackPowder below, which is what ignition keys
 * off now.
 *
 * It still drives the chuteless-booster warning, where a threshold on what the
 * motor delivers is the right shape. Note the limit of that too: power class is
 * a property of the WHOLE ROCKET's total impulse, not of one stage's motor, so
 * this tests the stage in front of it and nothing wider. No clause number is
 * quoted here on purpose — the certification standard is paywalled and unread
 * in this repo, so the code states what it tests and not what it conforms to.
 */
export function isHighPower(m: { avgThrustN: number; totImpulseNs: number }): boolean {
  return m.avgThrustN > 80 || m.totImpulseNs > 160;
}

/**
 * Whether a motor burns black powder, which is the real line for whether the
 * stage below can light it off its ejection charge. A black powder grain takes
 * from the charge; a composite or hybrid needs an igniter, whatever its size.
 *
 * ⚠ WHAT THIS CAN AND CANNOT PROVE. It proves "black powder"; it CANNOT prove
 * "composite". Measured on the shipped catalogue (1,156 rows, 2026-09-19): 58
 * say `black powder`, 13 say the literal `composite`, and the other 64 distinct
 * propellant values are trade names — White Lightning, Blue Thunder, Skidmark —
 * that happen to be composites but are not labelled as such. And 223 rows
 * record NO propellant at all, 97 of them still in production, most being
 * Contrail and Hypertek hybrids. So a false result means "not recorded as black
 * powder", never "known to be composite". The caller decides what an unrecorded
 * propellant defaults to; see services/ignitionDefault.ts, which takes the
 * conservative side deliberately and says why.
 *
 * Case-insensitive and whitespace-tolerant even though all 58 rows are exactly
 * `black powder` today, so a catalogue refresh that recapitalises the field
 * cannot silently flip 58 motors onto electronics.
 */
export function isBlackPowder(m: { propInfo?: string }): boolean {
  return /black\s*powder/i.test((m.propInfo ?? '').trim());
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

/**
 * Does this catalogued motor fit a mount with that bore? Exactly the test
 * `filterMotors` applies per row, exposed for a caller holding ONE motor —
 * rather than a fifth hand-rolled copy of the same arithmetic, which is how a
 * 24 mm D12 came to be offered on the starter rocket's 18 mm mount while the
 * browser had always refused it (2026-09-21).
 */
export function fitsMount(
  boreMm: number, m: Pick<MotorDbEntry, 'diameter'>, motors: MotorDbEntry[] = getCatalogue(),
): boolean {
  return classesFittingMount(boreMm, motors).includes(diameterClass(m.diameter));
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
 *
 * The second group is the rest of that table (24.12, Manufacturer.java), added
 * in audit 2026-09-23: the prefix rule cannot reach them either, and a name
 * that pairs with nothing cannot steer a match at all. RockSim files write some
 * of them: four of the owner's files have a simulation naming Cesaroni's I170
 * under “CSR”, which resolved to AeroTech's 54 mm I170G, and eight Public
 * Missiles 54 mm designs name Hypertek's J150 and J250 under “HT”, which
 * resolved to Cesaroni's 38 mm J150 and AeroTech's J250FJ. The one-letter
 * names (A, E, H, K, P, Q) are left to the prefix rule, where every maker they
 * begin already pairs; an alias would pick one of them.
 *
 * A lookupTable, because the key is a FILE's manufacturer text: on a plain
 * object `constructor` reads back as a function (audit 2026-09-22 — inert
 * here only because the read is an `===` compare).
 */
const MANUFACTURER_ALIASES: Record<string, string> = lookupTable({
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
  // The rest of OpenRocket's table (see above).
  at: 'aerotech',
  arms: 'aerotech',
  atrms: 'aerotech',
  aerorms: 'aerotech',
  aerotrms: 'aerotech',
  arcs: 'aerotech',
  atrcs: 'aerotech',
  aerorcs: 'aerotech',
  aerotrcs: 'aerotech',
  rcsa: 'aerotech',
  rcsat: 'aerotech',
  rcsaero: 'aerotech',
  rcsaerot: 'aerotech',
  rcsaerotech: 'aerotech',
  aapogee: 'aerotech',
  atapogee: 'aerotech',
  aeroapogee: 'aerotech',
  aerotapogee: 'aerotech',
  isp: 'aerotech',
  ahr: 'alpha',
  aw: 'amw',
  animal: 'amw',
  cs: 'cesaroni',
  csr: 'cesaroni',
  pro38: 'cesaroni',
  abc: 'cesaroni',
  cr: 'contrail',
  em: 'ellis',
  gr: 'gorilla',
  ht: 'hypertek',
  kat: 'kba',
  kosdonbyaerotech: 'kba',
  lr: 'loki',
  publicmissileslimited: 'pml',
  prop: 'pp',
  propulsion: 'pp',
  rt: 'ratt',
  rtw: 'ratt',
  rr: 'roadrunner',
  sr: 'skyr',
  srs: 'skyr',
  wcr: 'wch',
  westcoast: 'wch',
  westcoasthybrid: 'wch',
});

const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

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
  const a = normName(fileName);
  // 'unknown' is our own reader's fallback and 'custom' our old writer's —
  // sentinels, not manufacturers, and they must never steer a match.
  if (!a || a === 'unknown' || a === 'custom') return false;
  const b = normName(abbrev);
  if (!b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a) || MANUFACTURER_ALIASES[a] === b;
}

/** The separators design files write a designation with. */
const SEPARATORS = /[-\s_/]+/;

/**
 * Does `short` begin `long` without cutting a number in two — does the cut
 * fall anywhere but between two digits? “g11” does not begin “g115-wt”; “h128”
 * begins “h128w”, “g115” begins “g115-wt”, and “h128w” begins “h128w14a” (a
 * delay glued to AeroTech's propellant letter, which the first form of this
 * guard refused: it barred ANY digit after the cut). A `short` with no digit
 * in it is no designation and begins nothing. See findDbMotor.
 */
function prefixWithoutSplit(short: string, long: string): boolean {
  if (!/\d/.test(short) || !long.startsWith(short)) return false;
  return !(/\d/.test(short.charAt(short.length - 1)) && /\d/.test(long.charAt(short.length)));
}

/**
 * A designation with its dashes, spaces and underscores dropped wherever they
 * do not stand between two digits, so the two spellings of one designation
 * compare equal: Loki's catalogue “M900-LR” and a RockSim file's “M900LR”,
 * “J-326-LR” and “J326LR”. “G115-13A” keeps its dash (as “-”), the only thing
 * between a G115 and a G11513. A SLASH is kept: AeroTech's “G79W/L” is the
 * single-use LMS motor, and “G79W-L” the RMS reload G79W at its long delay
 * (the nozzle database's own row, nozzle-db.test.mjs), so the two must not
 * compare equal.
 */
function loose(s: string): string {
  return s.replace(/[-\s_]+/g, (sep: string, at: number, all: string) =>
    (/\d/.test(all.charAt(at - 1)) && /\d/.test(all.charAt(at + sep.length)) ? '-' : ''));
}

/**
 * Propellant codes design files write after a common name — RockSim's
 * “G115-WT” and “L1395BS”, RASAero's “N2501-WH-P”, “M900LR” — mapped to the
 * propellants thrustcurve.org records for the rows (`propInfo`). Cesaroni's
 * catalogue designation carries the impulse and the delay (“141G115-13A”) but
 * not the propellant, so without this a file naming one matches nothing. A
 * code matches ANY maker's row catalogued with a propellant it names, so “CL”
 * also reads AeroTech's Classic and “SK” AMW's Skidmark (the owner's
 * “K1075-SK”, filed under Cesaroni, is AMW's 2245K1075-P: RockSim 11's own
 * motor list carries K1075SK under Animal Motor Works only, and neither it nor
 * thrustcurve.org has a Cesaroni K1075).
 *
 * CESARONI'S, pinned from the corpus, not from memory (audit 2026-09-23):
 * every code is written after a common name Cesaroni catalogues ONCE, so the
 * reference can mean only that row, and in every such reference the row's
 * propellant is the one listed here — bs 49 references, wh 48, rl 46, cl 45,
 * wt 43, sk 42, ss 41, im 31, vm 25, gr 17, my 13, cs 7, pk 6 (the owner's
 * RockSim collection and the tester uploads, 1,070 files). The references that
 * DISAGREE with their only row are left unmatched rather than flown on another
 * propellant: E31WH, F30WH, G65WH and G107WH name White where the row is White
 * Thunder, and M2505CL Classic where it is White Thunder.
 *
 * LOKI'S AND AMW'S, added in the review of that audit, are the codes their own
 * catalogue designations carry, and in every shipped row that has both the
 * code and a propellant the two agree: Loki's “G80-LW”, “H100-SF”, “M1650LC”
 * (20 Loki White rows, 11 Loki Red, 11 Spitfire, 9 Loki Blue, 7 Cocktail — one
 * of them LC — and 1 Ice Blue), AMW's “BB-54-1050”, “WT-54-1750” (White Wolf,
 * which AMW writes WT as well as WW, so “wt” names both). Without them a
 * common name the maker catalogues twice could only be guessed between, and
 * “M3000LR” under Loki, whose only M3000 is Loki White, would open on it.
 *
 * “G69-Classic” under Cesaroni is left unmatched too, though not by this
 * table: Cesaroni's only G69 is Skidmark, and findDbMotor keeps a reference
 * whose maker catalogues its common name to that maker (it resolved to SkyR's
 * 29 mm G69 hybrid until the review of the audit). “DT” (Dual Thrust) is read by
 * {@link namesPropellant}, not here: it is the second half of two catalogue
 * propellants, “Classic/Dual Thrust” and “Imax/Dual Thrust”, and no common
 * name carries both.
 *
 * Exported for the test that holds each name to the shipped catalogue — a
 * propellant thrustcurve.org renames would otherwise stop matching silently.
 */
export const PROPELLANT_CODES: Record<string, readonly string[]> = lookupTable({
  bs: ['Blue Streak'],
  cl: ['Classic'],
  cs: ['C-Star'],
  gr: ['Green3'],
  im: ['Imax'],
  my: ['Mellow'],
  pk: ['Pink'],
  rl: ['Red Lightning'],
  sk: ['Skidmark'],
  ss: ['Smoky Sam'],
  vm: ['Vmax'],
  wh: ['White'],
  wt: ['White Thunder', 'White Wolf'],
  // Loki's
  lw: ['Loki White'],
  lr: ['Loki Red'],
  lb: ['Loki Blue'],
  sf: ['Spitfire'],
  ct: ['Cocktail'],
  lc: ['Cocktail'],
  ib: ['Ice Blue'],
  // AMW's
  bb: ['Blue Baboon'],
  gg: ['Green Gorilla'],
  rr: ['Red Rhino'],
  st: ['Super Tiger'],
  ww: ['White Wolf'],
});

/**
 * Does `named` — what a file writes after a designation, lower-cased with its
 * separators gone — name this catalogue propellant? A code from
 * {@link PROPELLANT_CODES}, the name spelled out (“classic”, “vmax”, “c-star”),
 * or “dt” / “dual thrust” for either of Cesaroni's Dual Thrust propellants.
 */
function namesPropellant(named: string, propInfo: string): boolean {
  return (PROPELLANT_CODES[named]?.includes(propInfo) ?? false)
    || named === normName(propInfo)
    || ((named === 'dt' || named === 'dualthrust') && /\/dual thrust$/i.test(propInfo));
}

/** Every propellant name the catalogue carries, normalised; one set per catalogue array. */
const catalogPropellantNames = new WeakMap<MotorDbEntry[], Set<string>>();
function namesAnyPropellant(named: string, motors: MotorDbEntry[]): boolean {
  if (PROPELLANT_CODES[named] !== undefined || named === 'dt' || named === 'dualthrust') return true;
  let names = catalogPropellantNames.get(motors);
  if (!names) {
    names = new Set(motors.map((m) => normName(m.propInfo ?? '')).filter((n) => n !== ''));
    catalogPropellantNames.set(motors, names);
  }
  return names.has(named);
}

/** A delay token: “14a”, “7”, “p” (plugged). */
const isDelayToken = (t: string): boolean => t === 'p' || /^\d+[a-z]?$/.test(t);

/**
 * What a file's designation adds after the part of it that is this row's
 * catalogue designation (“h128w” in “h128w-14a”): only a delay; the row's own
 * propellant; a propellant the row is NOT catalogued with; or letters this
 * cannot read. A row with no propellant recorded can neither confirm nor
 * contradict one — Cesaroni's old H153 and I205 are the Classic reloads the
 * owner's files name as “H153-Classic” and “I205-Classic” — so a propellant
 * after it reads as unread, except on a hybrid, which burns no solid
 * propellant to name (“G69-Classic” is not SkyR's G69 hybrid). AeroTech's
 * S/M/L delays count as delays only after a separator — glued, “J280SS” would
 * read Kosdon's J280S as a J280S at an S delay.
 */
function readLeftover(rest: string, m: MotorDbEntry, motors: MotorDbEntry[]): 'delay' | 'agrees' | 'contradicts' | 'unread' {
  const glued = rest !== '' && !SEPARATORS.test(rest.charAt(0));
  const named = rest.split(SEPARATORS)
    .filter((t, i) => t !== '' && !isDelayToken(t) && !(/^[sml]$/.test(t) && !(glued && i === 0)))
    .join('');
  if (named === '') return 'delay';
  const prop = m.propInfo ?? '';
  // “white” agrees with AeroTech's White Lightning: a spelled-out word the
  // row's propellant begins with is the row's propellant written short.
  if (prop && (namesPropellant(named, prop) || (named.length >= 4 && normName(prop).startsWith(named)))) return 'agrees';
  if (!namesAnyPropellant(named, motors)) return 'unread';
  return prop || m.type === 'hybrid' ? 'contradicts' : 'unread';
}

/**
 * Does `want` name this row by its common name followed by the propellant the
 * row is catalogued with? “g115-wt” names Cesaroni's 141G115-13A (G115, White
 * Thunder); “h160-cl” names its 312H160-12A and not the 220H160-14A, both H160s
 * but Classic and Skidmark, 312 against 220 Ns. After the common name — which
 * may not be cut short of a digit — the delay tokens (“14a”, “p”) are dropped
 * and what is left must name the row's propellant ({@link namesPropellant}). A
 * suffix that names no propellant, or one this cannot read, matches nothing.
 */
function namesByCommonAndPropellant(want: string, m: MotorDbEntry): boolean {
  const common = m.commonName.toLowerCase();
  if (!common || !m.propInfo || !prefixWithoutSplit(common, want)) return false;
  const named = want.slice(common.length).split(SEPARATORS)
    .filter((t) => t !== '' && !isDelayToken(t))
    .join('');
  return named !== '' && namesPropellant(named, m.propInfo);
}

/** What {@link matchDbMotor} found, and how firmly. */
export interface DbMotorMatch {
  motor: MotorDbEntry;
  /**
   * How the designation matched (see findDbMotor): 0 exact, 1 a designation
   * with only a delay or the row's own propellant between them, 2 the common
   * name and the row's propellant, 3 a designation followed by letters nothing
   * could read, 4 the file's maker's only row of that common name, followed
   * by letters nothing could read.
   */
  tier: number;
  /**
   * Other rows that matched exactly as well — same tier, same standing with the
   * file's manufacturer, same fit to the delay it names — and are a different
   * motor (over 1.5 mm or 3 % of total impulse apart). The pick among them fell
   * to production status and catalogue order, which is a guess, and the open
   * says so (motorMatch).
   */
  rivals: MotorDbEntry[];
}

/**
 * Finds the bundled-DB motor a design file refers to, with how firmly it was
 * found. {@link findDbMotor} is this without the detail.
 */
export function matchDbMotor(
  designation: string,
  diameterMm?: number,
  motors: MotorDbEntry[] = getCatalogue(),
  manufacturer?: string,
): DbMotorMatch | null {
  const want = designation.trim().toLowerCase();
  if (!want) return null;
  const looseWant = loose(want);
  const tierOf = (m: MotorDbEntry): number => {
    const raw = m.designation.toLowerCase();
    const disp = displayDesignation(m.designation, m.manufacturerAbbrev).toLowerCase();
    if (raw === want || disp === want || loose(raw) === looseWant || loose(disp) === looseWant) return 0;
    // The file omitting the delay or propellant letter the catalog lists
    // ("I224" for "I224-15A", "h128" for "H128W") — never by cutting a number.
    if (prefixWithoutSplit(want, raw) || prefixWithoutSplit(want, disp)
      || m.commonName.toLowerCase() === want) return 1;
    // The file writing more than the catalog: read what it adds.
    const stem = [disp, raw].filter((d) => prefixWithoutSplit(d, want)).sort((a, b) => b.length - a.length)[0];
    const left = stem === undefined ? null : readLeftover(want.slice(stem.length), m, motors);
    if (left === 'delay' || left === 'agrees') return 1;
    if (namesByCommonAndPropellant(want, m)) return 2;
    if (left === 'unread') return 3;
    // Only ever reached for the file's own maker's rows (below).
    const common = m.commonName.toLowerCase();
    return common !== '' && prefixWithoutSplit(common, want)
      && readLeftover(want.slice(common.length), m, motors) === 'unread' ? 4 : -1;
  };
  // A maker that catalogues the common name keeps the reference (see findDbMotor).
  const stated = (m: MotorDbEntry): boolean => manufacturerMatches(manufacturer, m.manufacturerAbbrev);
  const claims = motors.some((m) => {
    const common = m.commonName.toLowerCase();
    return stated(m) && common !== '' && (common === want || prefixWithoutSplit(common, want));
  });
  const candidates = motors
    .filter((m) => (diameterMm === undefined || Math.abs(m.diameter - diameterMm) <= 1.5)
      && (!claims || stated(m)))
    .map((m) => ({ m, tier: tierOf(m) }))
    .filter(({ tier }) => tier >= 0 && (tier < 4 || claims));
  if (candidates.length === 0) return null;
  const delayNamed = want.split(SEPARATORS).slice(1).map((t) => /^(\d+)[a-z]?$/.exec(t)?.[1]).find(Boolean);
  const fitsDelay = (m: MotorDbEntry): boolean =>
    delayNamed !== undefined && (m.delays ?? '').split(',').map((d) => d.trim()).includes(delayNamed);
  const keyed = candidates.map(({ m, tier }) => ({ m, tier, maker: stated(m), delay: fitsDelay(m) }));
  keyed.sort((a, b) => a.tier - b.tier
    || Number(b.maker) - Number(a.maker)
    || Number(b.delay) - Number(a.delay)
    || Number(isAvailable(b.m)) - Number(isAvailable(a.m)));
  const best = keyed[0]!;
  const rivals = keyed.slice(1)
    .filter((k) => k.tier === best.tier && k.maker === best.maker && k.delay === best.delay
      && (Math.abs(k.m.diameter - best.m.diameter) > 1.5
        || Math.abs(k.m.totImpulseNs - best.m.totImpulseNs) > 0.03 * Math.max(k.m.totImpulseNs, best.m.totImpulseNs)))
    .map((k) => k.m);
  // A common name followed by letters nothing reads is taken only when it can
  // mean one motor: the maker's only row of that name. Two, and it is a guess
  // — even two with the same impulse: AMW's K700 is Black Bear and Blue Baboon.
  if (best.tier === 4 && keyed.some((k) => k !== best && k.tier === 4)) return null;
  return { motor: best.m, tier: best.tier, rivals };
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
 *
 * A PREFIX MAY NOT CUT A NUMBER IN TWO (audit 2026-09-23). The prefix tests
 * were bare `startsWith`, so RockSim's “G115-WT” — Cesaroni's 38 mm G115
 * White Thunder — began with AeroTech's “G11”, a 29 mm motor averaging 10 N.
 * Eight files in the owner's RockSim collection name it, and six opened on the
 * G11: Apogee's Katana-38mm.rkt flew to 0.2 m, where the G115 takes it to
 * 117.0 m (RockSim's own stored run: 129.2 m). The same shape sent CTI's
 * G118-BS and I800-Vmax, a J100 (to Loki's J1000) and a bare “H55” (to the
 * H550ST) to the wrong motor. So a prefix may not end between two digits
 * ({@link prefixWithoutSplit}); statedLaunchWeight's namesSameMotor carries
 * the same rule.
 *
 * With the bad match gone, “G115-WT” still has to find the G115 — and Cesaroni's
 * catalogue designation (“141G115-13A”) names the impulse and the delay but not
 * the propellant the file names it by. So a file may also name a row by its
 * common name plus that row's propellant ({@link namesByCommonAndPropellant}).
 * The propellant has to AGREE: without that, “H160-CL” took whichever Cesaroni
 * H160 came first — the Skidmark, 220 Ns against the Classic's 312 — and
 * “F36-BS” the Smoky Sam. namesSameMotor does NOT mirror this test: it is
 * catalogue-free and cannot read a row's propellant (see its docblock).
 *
 * THE ORDER, from the review of that change (same audit), best first:
 *
 *   0. the designation exactly, raw or display, or once the separators that
 *      stand between letters are dropped ({@link loose}) — Loki's “M900-LR”
 *      is a RockSim file's “M900LR”. That alone moves 393 lookups across the
 *      1,070-file corpus (the owner's RockSim collection, the tester uploads,
 *      the fixtures), 387 of them Loki's: 385 matched nothing, and in the
 *      six files naming “M900LR” it resolved to RATT's 64 mm M900 hybrid,
 *      +18 % impulse;
 *   1. a designation that differs by a delay alone (“I224-15A” / “I224”), or
 *      by the row's own propellant (“E6 Blue Thunder” / “E6”), or the common
 *      name alone;
 *   2. the common name and the row's propellant (“G115-WT”);
 *   3. a designation followed by letters nothing reads — makers' own suffixes
 *      mostly: Estes's 13 mm “A10T”, Ellis's “I150EM” — below 2, so it loses
 *      to any row the letters DO name (“K1000SK” is AMW's Skidmark K1000, not
 *      KBA's K1000S);
 *   4. the file's maker's ONLY row of a common name the designation begins
 *      with, the rest unread — “G80NBT” under AeroTech is its G80T. Only with
 *      the maker, and only when it has one such row: AMW's K700 is Black Bear
 *      and Blue Baboon at one impulse, and a guess between them is nothing.
 *
 * A designation followed by a propellant the row is not catalogued with is no
 * match: “F36-11A-BS” is not the Smoky Sam 41F36-11A, however well its first
 * seven characters agree, and “G69-Classic” is not SkyR's G69 hybrid.
 *
 * Within a rank the file's manufacturer, then a row whose delays include the
 * one the designation names (“H123-SK-14A”: only the 38 mm H123 lists 14 s),
 * then production status. And A MAKER THAT CATALOGUES THE COMMON NAME KEEPS
 * THE REFERENCE: when a row by the file's manufacturer has a common name the
 * designation begins with, other makers' rows are not candidates at all, even
 * an exact designation. “G69-Classic” filed under Cesaroni resolved to SkyR's
 * 29 mm G69 hybrid (236 g) in a simulation of five of the owner's files, where
 * RockSim's own stored masses for Zephyr.rkt put a motor of about 205 g
 * (Cesaroni's 38 mm G69 is 197 g); a bare “G69” under Cesaroni took SkyR's
 * too, its exact designation outranking Cesaroni's common name, and “J270”
 * under Hypertek took Ellis's.
 * A reference whose maker has that common name but no row it matches
 * (“G69-Classic”: Cesaroni's only G69 is Skidmark) is left unmatched — a
 * blank the open reports beats another maker's motor it does not. A maker
 * with no such common name (“K1075-SK” under Cesaroni) still falls through to
 * whoever has it, and the open says whose it loaded.
 */
export function findDbMotor(
  designation: string,
  diameterMm?: number,
  motors: MotorDbEntry[] = getCatalogue(),
  manufacturer?: string,
): MotorDbEntry | null {
  return matchDbMotor(designation, diameterMm, motors, manufacturer)?.motor ?? null;
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
 * Does this catalog ROW carry a usable loaded/propellant pair?
 *
 * thrustcurve.org's catalog is not uniformly populated. As of the bundled
 * snapshot, 146 of 1129 entries publish no loaded weight, 14 no propellant
 * weight, and Cesaroni 25E75-17A lists more propellant (104 g) than loaded
 * mass (52 g). Those produce NaN or negative motor masses, which used to reach
 * the kernel and blank the user's design with a raw BigInt error.
 *
 * It judges the catalogue row alone, and a row without a pair can still fly:
 * samplesToMotorSpec checks the masses that FLY, the data file's own when it
 * states a good pair (audit 2026-09-22 — 116 of the 157 such rows do). The
 * motor browser disables a row only when this is false AND its bundled file
 * has no pair either (MotorBrowser's fileMassed) — disabled rather than hidden,
 * because they are legitimate catalog entries and hiding them would make the
 * database look wrong.
 */
export function hasMassData(m: Pick<TcMotor, 'totalWeightG' | 'propWeightG'>): boolean {
  return (
    Number.isFinite(m.totalWeightG) &&
    Number.isFinite(m.propWeightG) &&
    m.propWeightG <= m.totalWeightG
  );
}
