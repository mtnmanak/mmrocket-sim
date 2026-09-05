import type { IgnitionEvent, MotorSpec } from '@online-openrocket/engine';
import type { MountMotor } from '../App.js';
import {
  displayDesignation, findDbMotor, isHighPower, type MotorDbEntry,
} from './motorDb.js';
import type { OrkExportMotor, OrkMotorRef } from './orkFile.js';
import type { MotorMeta } from './simReport.js';
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
  // Plugged motors (Infinity delay) display the standard "-P" suffix.
  const delayTag = Number.isFinite(delay) ? String(delay) : 'P';
  const label = `${db.commonName}-${delayTag}`;
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

  const ignition: MountMotor['ignition'] = {
    event: (ref.ignitionEvent as IgnitionEvent | undefined) ?? 'automatic',
    delay: ref.ignitionDelay ?? 0,
  };
  const fileIdentity = fileMotorIdentity(ref);

  // RockSim refs carry no motor diameter (0) — match by designation only.
  const dbMatch = findDb(
    ref.designation,
    ref.diameter > 0 ? ref.diameter * 1000 : undefined,
    undefined,
    ref.manufacturer,
  );
  if (dbMatch) {
    try {
      const spec = await fetchSpec(dbMatch, ref.delay);
      const motor = mountMotorFromDb(dbMatch, spec, ref.delay, ignition, fileIdentity);
      const delayTag = Number.isFinite(ref.delay) ? String(ref.delay) : 'P';
      return {
        motor,
        note: `Motor: ${dbMatch.manufacturerAbbrev} ${displayDesignation(dbMatch.designation, dbMatch.manufacturerAbbrev)}-${delayTag} (loaded from the motor database).`,
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
    return { note: `Motor “${ref.designation}” is in the motor database but has no thrust curve — thrustcurve.org publishes none for it. Import its .eng/.rse via Browse motor database.` };
  }
  return { note: `Motor “${ref.designation}” isn't in the motor database — pick one via Browse motor database.` };
}
