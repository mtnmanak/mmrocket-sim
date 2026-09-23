import type { MotorSpec } from '@online-openrocket/engine';
import type { MountMotor } from '../App.js';
import {
  displayDesignation, findDbMotor, isAvailable, isHighPower, manufacturerMatches, matchDbMotor,
  type DbMotorMatch, type MotorDbEntry,
} from './motorDb.js';
import type { OrkExportMotor, OrkMotorRef } from './orkFile.js';
import type { MotorMeta } from './simReport.js';
import { knownIgnitionEvent } from './ignitionEvent.js';
import { delayOptions, fetchMotorSpec } from './thrustcurve.js';

/**
 * Resolving ONE motor reference out of a design file to something the kernel
 * can fly. Lifted out of App.tsx because it decides WHICH MOTOR a file flies —
 * the numbers on screen and in the .ork written back out — and inside a
 * component closure it could not be reached by a test at all.
 *
 * The precedence used to be built-ins first, matched on
 * `key.startsWith(ref.designation)` alone. That is a prefix test over three
 * hand-written 18 mm Estes approximations, so `'C6-5'.startsWith('C6')` fired
 * on essentially every Estes-class file and returned before the shipped
 * 1,129-motor database was ever consulted. Measured against the built-ins'
 * own curves (trapezoidal integral) and the shipped catalog:
 *
 *   - Apogee C6 (13 mm, 9.98 Ns) flew the 18 mm built-in at 10.40 Ns, and was
 *     re-exported at 18 mm / 70 mm because the writer takes the substituted
 *     spec's dimensions.
 *   - Estes C6 (8.82 Ns) flew at 10.40 Ns — 18 % high on total impulse.
 *   - Estes A8 (2.50 Ns) flew the built-in A8-3 at 1.89 Ns — 24 % LOW.
 *
 * The scope, stated exactly because the first account of it was too broad:
 * three designations (A8, B6, C6, at any delay — every file format writes the
 * designation bare), on the FILE-IMPORT path only (.ork, .rkt, .CDX1, share
 * links), for every maker of those motors. Browse motor database always used
 * the real data.
 *
 * v0.105 (2026-09-04) put the database first and kept the built-ins as an
 * offline fallback. v0.107 (2026-09-05) removed them: the owner's ruling was
 * that fixing the precedence while leaving invented data in the app was the
 * wrong fix. Offline is now served by shipping every published curve
 * (thrustcurve.ts bundledSimFiles), and there is no fallback below the
 * database — a motor that cannot be loaded is reported, never substituted.
 */

/**
 * A designation with any trailing delay suffix removed: "C6-5" → "c6",
 * "H220-P" → "h220", "I224-15A" → "i224-15a" (a delay with a propellant letter
 * is NOT a bare delay and is left alone). Written for the old built-in match
 * and kept because the test that pins the delay grammar is still worth having.
 */
export function baseDesignation(designation: string): string {
  return designation.trim().replace(/-(\d+(?:\.\d+)?|P)$/i, '').toLowerCase();
}

/**
 * The file's own motor identity, carried on the meta so a later Save writes it
 * back verbatim and the desktop's matcher resolves it silently (digest tier).
 * 'unknown' is our reader's fallback and 'custom' our old writer's — both are
 * sentinels, not manufacturers, and must not be re-exported.
 */
export function fileMotorIdentity(ref: OrkMotorRef): Partial<MotorMeta> {
  return {
    ...(ref.manufacturer && ref.manufacturer !== 'unknown' && ref.manufacturer !== 'custom'
      ? { orkManufacturer: ref.manufacturer } : {}),
    ...(ref.motorType ? { orkType: ref.motorType } : {}),
    ...(ref.digest ? { orkDigest: ref.digest } : {}),
  };
}

/**
 * A motor reference nothing matched, in the shape the .ork writer takes.
 *
 * Written back VERBATIM. Before this the reference was reduced to its
 * designation string at import and the rest — manufacturer, diameter, length,
 * delay, ignition and the `<digest>` that is desktop's silent-match tier —
 * was dropped, so pressing Save .ork emitted that configuration with no motor
 * on the mount at all and the user's only copy of the reference was gone.
 */
export function refToExportMotor(ref: OrkMotorRef): OrkExportMotor {
  return {
    designation: ref.designation,
    ...(ref.manufacturer && ref.manufacturer !== 'unknown' && ref.manufacturer !== 'custom'
      ? { manufacturer: ref.manufacturer } : {}),
    ...(ref.motorType ? { type: ref.motorType } : {}),
    ...(ref.digest ? { digest: ref.digest } : {}),
    diameter: ref.diameter,
    length: ref.length,
    delay: ref.delay,
    ...(ref.ignitionEvent ? { ignitionEvent: ref.ignitionEvent } : {}),
    ...(ref.ignitionDelay !== undefined ? { ignitionDelay: ref.ignitionDelay } : {}),
    // A pad mass the file left on an unmatched primary (v0.118) goes back out
    // with it, so Save cannot lose a number the user weighed; the key is
    // written only when set, the same rule as App's toExportMotor.
    ...(typeof ref.padMassKg === 'number' && ref.padMassKg > 0 ? { padMassKg: ref.padMassKg } : {}),
    // RockSim's "every delay", so a .rkt Save hands RockSim its −1 back.
    ...(ref.rktEveryDelay ? { rktEveryDelay: true as const } : {}),
  };
}

/** The result of resolving one file reference. */
export interface MotorMatchResult {
  motor?: MountMotor;
  /** What happened, for the import note. */
  note: string;
  /**
   * True when `motor` is a built-in APPROXIMATION standing in for a database
   * motor whose published curve could not be fetched. The caller surfaces this
   * one even though a motor was loaded: substituting a hand-written curve for
   * the manufacturer's is a numbers change, and silence about it is the defect
   * this whole module exists to close. Always absent since 2026-09-05 — there
   * is no approximation left to load — and kept on the type only so a stored
   * result from an older session still typechecks.
   */
  approximated?: boolean;
  /**
   * Why nothing loaded, when nothing did: the catalogue has no such motor, or
   * has it with no thrust curve anywhere. For a sentence that has to say it
   * without the note's "pick one via Browse motor database" — the wrong advice
   * when the file has another configuration that flies (importApply.planImport).
   */
  missing?: 'database' | 'curve';
  /**
   * Said at the open even though a motor loaded, because the match was not a
   * confirmed one ({@link unconfirmedMatchNote}): another maker's motor than
   * the file names, one of several that match equally well, or an
   * out-of-production row for a file that names no maker. Worded as a record
   * of the open — what the file said and what it opened on — so it stays true
   * after the user loads another motor (the stale "Motor: … loaded" line Big
   * Dog reported was a claim about the mount, not about the open).
   */
  openNote?: string;
}

/** Injection points, so the network and the catalog can be stubbed in tests. */
export interface MotorMatchDeps {
  findDb?: typeof findDbMotor;
  fetchSpec?: (motor: MotorDbEntry, ejectionDelay: number) => Promise<MotorSpec>;
}

/**
 * A catalogue motor with its curve loaded, shaped the way App keeps a mounted
 * motor. Shared by the importer below, the default motor a new design starts
 * with (App.tsx) and the quick-pick list (MotorPicker.tsx) — one place builds
 * the meta, so the three cannot drift.
 */
export function mountMotorFromDb(
  db: MotorDbEntry,
  spec: MotorSpec,
  delay: number,
  ignition: MountMotor['ignition'],
  extraMeta: Partial<MotorMeta> = {},
): MountMotor {
  // Plugged motors (Infinity delay) display the standard "-P" suffix, and an
  // auto-delay motor the browser's own "(auto delay)" — `delay` is then only
  // its provisional first flight (MotorBrowser.load).
  const delayTag = Number.isFinite(delay) ? String(delay) : 'P';
  const label = extraMeta.autoDelay
    ? `${db.commonName} (auto delay)`
    : `${db.commonName}-${delayTag}`;
  return {
    label,
    spec,
    meta: {
      label,
      manufacturer: db.manufacturerAbbrev,
      availableDelays: delayOptions(db),
      type: db.type,
      propellant: db.propInfo,
      motorCase: db.caseInfo,
      highPower: isHighPower(db),
      motorId: db.motorId,
      ...extraMeta,
    },
    ignition,
  };
}

/**
 * Loads a named catalogue motor — "Estes" "C6" at a 5 s delay — with its
 * published curve. null when the catalogue has no such motor; throws when it
 * has the motor but no curve can be had (no bundled file and no network).
 */
export async function loadCatalogueMotor(
  manufacturer: string,
  designation: string,
  delay: number,
  deps: MotorMatchDeps = {},
): Promise<MountMotor | null> {
  const findDb = deps.findDb ?? findDbMotor;
  const fetchSpec = deps.fetchSpec ?? fetchMotorSpec;
  const db = findDb(designation, undefined, undefined, manufacturer);
  if (!db) return null;
  const spec = await fetchSpec(db, delay);
  return mountMotorFromDb(db, spec, delay, { event: 'automatic', delay: 0 });
}

/**
 * Matches ONE imported motor reference against the shipped motor database
 * (published curves, manufacturer-aware). Returns the loaded motor (absent when
 * nothing matched) and the note describing what happened; the caller decides
 * whether the note surfaces (applied config) or waits (presets).
 */
export async function matchImportedMotor(
  ref: OrkMotorRef,
  deps: MotorMatchDeps = {},
): Promise<MotorMatchResult> {
  const findDb = deps.findDb ?? findDbMotor;
  const fetchSpec = deps.fetchSpec ?? fetchMotorSpec;

  // Never cast: an event none of the five reached the build verbatim, which put
  // the motor on the handle and then refused it (audit 2026-09-22). The .ork
  // reader already maps one to AUTOMATIC with a note; this is the backstop for
  // a reference from anywhere else, and AUTOMATIC is where desktop
  // OpenRocket's reader leaves a mount whose value it ignores.
  const ignition: MountMotor['ignition'] = {
    event: knownIgnitionEvent(ref.ignitionEvent) ?? 'automatic',
    delay: ref.ignitionDelay ?? 0,
  };
  const fileIdentity = fileMotorIdentity(ref);

  // RockSim refs carry no motor diameter (0) — match by designation only.
  const diameterMm = ref.diameter > 0 ? ref.diameter * 1000 : undefined;
  const dbMatch = findDb(ref.designation, diameterMm, undefined, ref.manufacturer);
  if (dbMatch) {
    try {
      const spec = await fetchSpec(dbMatch, ref.delay);
      // The file's maker is written back beside the row's designation only when
      // it IS the row's maker (review of audit 2026-09-23): "Cesaroni Technology
      // Inc." beside AMW's "2245K1075-P" names no motor, and desktop OpenRocket
      // filters on the maker strictly (ThrustCurveMotorSetDatabase.findMotors),
      // so a Save wrote a motor desktop cannot find. The row's own maker goes
      // out instead (App: `orkManufacturer ?? manufacturer`).
      const identity: Partial<MotorMeta> = { ...fileIdentity };
      if (namesOtherMaker(ref, dbMatch)) delete identity.orkManufacturer;
      // A reference flagged for auto delay (the RockSim reader's "every delay"
      // on a motor that lists no numeric delay) starts on "Auto (optimal)",
      // exactly as the motor browser starts a fresh pick of it: flown first at
      // `ref.delay`, then re-flown at the optimum (flightRunner.flyLaunch).
      const motor = mountMotorFromDb(dbMatch, spec, ref.delay, ignition,
        ref.autoDelay ? { ...identity, autoDelay: true } : identity);
      const delayTag = ref.autoDelay ? ' (auto delay)'
        : `-${Number.isFinite(ref.delay) ? String(ref.delay) : 'P'}`;
      const openNote = unconfirmedMatchNote(ref, dbMatch,
        matchDbMotor(ref.designation, diameterMm, undefined, ref.manufacturer));
      return {
        motor,
        note: `Motor: ${dbMatch.manufacturerAbbrev} ${displayDesignation(dbMatch.designation, dbMatch.manufacturerAbbrev)}${delayTag} (loaded from the motor database).`,
        ...(openNote ? { openNote } : {}),
      };
    } catch {
      // No curve to be had — reported below, never substituted.
    }
  }

  // There is no fallback below the database, deliberately. Until 2026-09-05
  // three hand-written approximate curves stood in here (see the header), and
  // a motor that quietly flies the wrong curve is worse than one that says it
  // could not be loaded. With every published curve now shipped in the bundle
  // (thrustcurve.ts bundledSimFiles) this branch is reached only for the ~80
  // catalogued motors thrustcurve.org has no simulator file for at all.
  if (dbMatch) {
    return {
      note: `Motor “${ref.designation}” is in the motor database but has no thrust curve — thrustcurve.org publishes none for it. Import its .eng/.rse via Browse motor database.`,
      missing: 'curve',
    };
  }
  return { note: `Motor “${ref.designation}” matched no motor in the motor database — pick one via Browse motor database.`, missing: 'database' };
}

/** A manufacturer a file actually names — not empty, and not our reader's or writer's sentinel. */
function namedMaker(ref: OrkMotorRef): string | null {
  const m = ref.manufacturer?.trim();
  return m && !/^(unknown|custom)$/i.test(m) ? m : null;
}

/** Does the file name a maker, and one that is not this row's? */
function namesOtherMaker(ref: OrkMotorRef, db: MotorDbEntry): boolean {
  return namedMaker(ref) !== null && !manufacturerMatches(ref.manufacturer, db.manufacturerAbbrev);
}

/** A catalogue row as the open note names it: maker, designation, size, impulse, propellant. */
function describeRow(m: MotorDbEntry): string {
  const facts = [`${m.diameter} mm`, `${Math.round(m.totImpulseNs * 10) / 10} Ns`,
    ...(m.propInfo ? [m.propInfo] : []), ...(isAvailable(m) ? [] : ['out of production'])];
  return `${m.manufacturerAbbrev} ${displayDesignation(m.designation, m.manufacturerAbbrev)} (${facts.join(', ')})`;
}

/**
 * The open's sentence for a motor that loaded but was not CONFIRMED by the
 * file (review of audit 2026-09-23): the file names another maker than the
 * row's (“K1075-SK” filed under Cesaroni opens on AMW's Skidmark K1075); the
 * file's name runs on past the maker's common name in letters the matcher
 * cannot read (“G80NBT” under AeroTech opens on the G80T, AeroTech's only
 * G80); other rows match exactly as well (“H123-SK”: Cesaroni's 29 mm and
 * 38 mm Skidmark H123); or the file names no maker and the row, matched short of its full
 * designation, is out of production (“H55” opens on AeroTech's H55W). Until
 * then each of those loaded in silence — the import note reports only motor
 * problems, and the mount card shows a common name and a delay.
 *
 * `how` is the matcher's own account of the pick; it is used only when it
 * picked this same row, so a stubbed lookup (tests) gets the maker check alone.
 */
export function unconfirmedMatchNote(
  ref: OrkMotorRef, db: MotorDbEntry, how: DbMotorMatch | null,
): string | undefined {
  const firm = how && how.motor.motorId === db.motorId ? how : null;
  const other = namesOtherMaker(ref, db);
  // Tier 4 only: the maker's only row of a common name, the rest unread. A
  // full designation with letters after it (tier 3) is left silent — in the
  // corpus those are makers' own suffixes, Estes's “A10T” (13 mm), Quest's
  // “A6Q”, Ellis's “I150EM”, RATT's “H70H”, and 48 files would have opened
  // with a warning (55 sentences) for motors they name correctly.
  const unread = firm?.tier === 4;
  const oopGuess = namedMaker(ref) === null && !isAvailable(db) && (firm?.tier ?? 0) > 0;
  const rivals = firm?.rivals ?? [];
  if (!other && !unread && !oopGuess && rivals.length === 0) return undefined;
  const opened = other
    ? `Motor “${ref.designation}”: the file names ${namedMaker(ref)!}, but it opened on ${describeRow(db)} — the motor the database matched to it.`
    : unread
      ? `Motor “${ref.designation}” matched no motor in the database exactly; it opened on the closest, ${describeRow(db)}.`
      : oopGuess
        ? `Motor “${ref.designation}”: the file names no manufacturer, and it opened on ${describeRow(db)} — the motor the database matched to it.`
        : `Motor “${ref.designation}” opened on ${describeRow(db)}.`;
  const shown = rivals.slice(0, 3).map(describeRow);
  const more = rivals.length > shown.length ? `; and ${rivals.length - shown.length} more` : '';
  const also = rivals.length === 0 ? ''
    : ` ${rivals.length === 1 ? 'Another motor matches' : `${rivals.length} other motors match`} it as well: ${shown.join('; ')}${more}.`;
  return `${opened}${also} Check it is the motor you fly, or pick another via Browse motor database.`;
}
