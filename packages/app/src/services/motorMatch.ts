import type { MotorSpec } from '@online-openrocket/engine';
import type { MountMotor } from '../App.js';
import {
  displayDesignation, findDbMotor, isHighPower, type MotorDbEntry,
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
 * A motor designation or picker label with its delay removed, case kept:
 * "H220-14", "H220-P", "H220-p" and the picker's "H220 (auto delay)" are all
 * "H220"; "I224-15A" is left whole (a delay with a propellant letter is NOT a
 * bare delay).
 *
 * THE ONE COPY of the rule (audit 2026-09-22, Dead code row 575). There were
 * three: this module's (tested, but called by nothing in production), the
 * catalogue overlay's private copy of the same regex, and App's baseLabel,
 * which had drifted: case-sensitive and untrimmed, so "H220-p" kept its "-p",
 * while the overlay's copy never knew "(auto delay)", so a changed motor flown
 * on auto delay was never named as loaded. App's labels and the overlay's
 * matcher both call this now.
 */
export function stripDelay(label: string): string {
  return label.trim().replace(/ \(auto delay\)$/, '').replace(/-(\d+(?:\.\d+)?|P)$/i, '');
}

/**
 * `stripDelay`, lower-cased: the key two spellings of one motor share
 * ("C6-5" and "C6" are both "c6"). The catalogue overlay matches on it.
 */
export function baseDesignation(designation: string): string {
  return stripDelay(designation).toLowerCase();
}

/**
 * The file's own motor identity, carried on the meta so a later Save writes it
 * back verbatim and the desktop's matcher resolves it silently (digest tier).
 * 'unknown' is our reader's fallback and 'custom' our old writer's — both are
 * sentinels, not manufacturers, and must not be re-exported.
 */
function fileMotorIdentity(ref: OrkMotorRef): Partial<MotorMeta> {
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
  /**
   * What happened, for the import note. The importer surfaces it only when
   * `motor` is absent: since 2026-09-05 a curve that cannot be had loads
   * nothing, so a loaded motor is always the database's own. (An
   * `approximated` flag for a built-in curve standing in was never set after
   * that ruling and went, audit 2026-09-22, Dead code row 577.)
   */
  note: string;
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
  const dbMatch = findDb(
    ref.designation,
    ref.diameter > 0 ? ref.diameter * 1000 : undefined,
    undefined,
    ref.manufacturer,
  );
  if (dbMatch) {
    try {
      const spec = await fetchSpec(dbMatch, ref.delay);
      // A reference flagged for auto delay (the RockSim reader's "every delay"
      // on a motor that lists no numeric delay) starts on "Auto (optimal)",
      // exactly as the motor browser starts a fresh pick of it: flown first at
      // `ref.delay`, then re-flown at the optimum (flightRunner.flyLaunch).
      const motor = mountMotorFromDb(dbMatch, spec, ref.delay, ignition,
        ref.autoDelay ? { ...fileIdentity, autoDelay: true } : fileIdentity);
      const delayTag = ref.autoDelay ? ' (auto delay)'
        : `-${Number.isFinite(ref.delay) ? String(ref.delay) : 'P'}`;
      return {
        motor,
        note: `Motor: ${dbMatch.manufacturerAbbrev} ${displayDesignation(dbMatch.designation, dbMatch.manufacturerAbbrev)}${delayTag} (loaded from the motor database).`,
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
