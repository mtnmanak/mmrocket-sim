import type { MotorSpec } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import {
  displayDesignation, motorLabel, findDbMotor, isAvailable, isHighPower, manufacturerMatches, matchDbMotor, MOTOR_DB,
  type DbMotorMatch, type MotorDbEntry,
} from './motorDb.js';
import type { OrkExportMotor, OrkMotorRef } from './orkFile.js';
import type { MotorMeta } from './simReport.js';
import { knownIgnitionEvent } from './ignitionEvent.js';
import { bundleHasCurve, defaultDelay, delayOptions, fetchMotorSpec, NoPublishedCurveError } from './thrustcurve.js';
import { rocksimCurveNote } from './rocksimCurveNote.js';
import { E31_CONFLICT, G80_EQUIVALENT, isE31Conflict } from './motorMatchPolicy.js';
import { exToDbEntry, exToMotorSpec, loadExMotors, type ExMotor } from './exMotors.js';

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
  // Strip once: ROS-40 on Auto keeps -40, and AMW case impulses are not delays.
  return label.trim().replace(/(?: \(auto delay\)|-(?:\d{1,2}(?:\.\d+)?|P))$/i, '');
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
    ...(ref.exMotorId !== undefined ? { exMotorId: ref.exMotorId } : {}),
    ...(ref.exDefinition ? { exDefinition: ref.exDefinition } : {}),
    ...(ref.exMotorMissing ? { exMotorMissing: true as const } : {}),
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
    // written only when set, the same rule as orkExportMotors.toOrkMotor.
    ...(typeof ref.padMassKg === 'number' && ref.padMassKg > 0 ? { padMassKg: ref.padMassKg } : {}),
    // RockSim's "every delay", so a .rkt Save hands RockSim its −1 back.
    ...(ref.rktEveryDelay ? { rktEveryDelay: true as const } : {}),
  };
}

/** The result of resolving one file reference. */
export interface MotorMatchResult {
  /** @atestani TRF #162, Eric 2026-10-06: UI asks from match evidence, not warning text. */
  otherMaker?: { ref: OrkMotorRef; candidates: MotorDbEntry[] };
  motor?: MountMotor;
  /**
   * What happened, for the import note. The importer surfaces it only when
   * `motor` is absent: since 2026-09-05 a curve that cannot be had loads
   * nothing, so a loaded motor is always the database's own. (An
   * `approximated` flag for a built-in curve standing in was never set after
   * that ruling and went, audit 2026-09-22, Dead code row 577.)
   */
  note: string;
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
   * of the match — what the file said and what it loaded as — so it stays true
   * after the user loads another motor (the stale "Motor: … loaded" line Big
   * Dog reported was a claim about the mount, not about the open). `motor`
   * carries it too (MountMotor.openNote), so applying the configuration it
   * belongs to says it again.
   */
  openNote?: string;
}

/** Injection points, so the network and the catalog can be stubbed in tests. */
export interface MotorMatchDeps {
  findDb?: typeof findDbMotor;
  /** Keep match tiers, rivals and curve-equivalence policy on the chosen rows (2026-10-01). */
  catalogue?: MotorDbEntry[];
  exMotors?: ExMotor[];
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
  const label = motorLabel(db, delay, extraMeta);
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
  const db = findDb(designation, undefined, deps.catalogue, manufacturer);
  if (!db) return null;
  const spec = await fetchSpec(db, delay);
  return mountMotorFromDb(db, spec, delay, { event: 'automatic', delay: 0 });
}

/** @atestani TRF #162, Eric 2026-10-06: opening and the import dialog must agree. */
export function matchingExMotors(ref: OrkMotorRef, library: ExMotor[]): ExMotor[] {
  const maker = namedMaker(ref);
  return maker ? library.filter(ex =>
    ex.realManufacturer.trim().toLowerCase() === maker.toLowerCase()
    && (ex.designation.trim().toLowerCase() === ref.designation.trim().toLowerCase()
      || baseDesignation(ex.designation) === baseDesignation(ref.designation))
    && (!(ref.diameter > 0) || Math.abs(ex.diameter - ref.diameter * 1000) <= 0.5)) : [];
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
  if (ref.exMotorId !== undefined) {
    const ex = ref.exMotorMissing ? undefined : ref.exDefinition;
    if (!ex) return { note: `EX motor ${ref.designation}: its embedded definition is missing or refused; re-import the original .eng/.rse.`, missing: 'curve' };
    try {
      const db = exToDbEntry(ex);
      const spec = exToMotorSpec(ex, ref.delay);
      return {
        motor: mountMotorFromDb(db, spec, ref.delay, ignition, { exMotorId: ex.motorId }),
        note: `Motor: EX ${motorLabel(db, ref.delay)} (loaded from the embedded motor library).`,
      };
    } catch (error) {
      return { note: `EX motor ${ref.designation} could not be loaded: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // RockSim refs carry no motor diameter (0) — match by designation only.
  const diameterMm = ref.diameter > 0 ? ref.diameter * 1000 : undefined;
  let how = deps.findDb ? null : matchDbMotor(ref.designation, diameterMm, deps.catalogue, ref.manufacturer, ref.matchContext);
  let dbMatch = deps.findDb
    ? (ref.matchContext ? deps.findDb(ref.designation, diameterMm, undefined, ref.manufacturer, ref.matchContext)
      : deps.findDb(ref.designation, diameterMm, undefined, ref.manufacturer))
    : how?.motor ?? null;
  // @atestani, TRF #162, 2026-10-06: an imported curve for the named maker
  // beats another maker's catalogue guess, but never a same-maker match.
  const maker = namedMaker(ref);
  const exMatches = maker && (!dbMatch || namesOtherMaker(ref, dbMatch))
    ? matchingExMotors(ref, deps.exMotors ?? loadExMotors()) : [];
  if (exMatches.length === 1 && maker) {
    const ex = exMatches[0]!;
    try {
      const db = exToDbEntry(ex);
      const spec = exToMotorSpec(ex, ref.delay);
      return {
        motor: mountMotorFromDb(db, spec, ref.delay, ignition, { ...fileIdentity, exMotorId: ex.motorId }),
        note: `Motor “${ref.designation}”: loaded as your imported EX motor ${ex.realManufacturer.trim()} ${ex.designation} — the motor database has no ${maker} ${ref.designation}.`,
      };
    } catch (error) {
      return { note: `EX motor ${ref.designation} could not be loaded: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const exCandidatesNote = exMatches.length > 1
    ? ` Your imported EX motors include ${exMatches.length} that match it (${exMatches.map(ex => `${ex.realManufacturer.trim()} ${ex.designation} [${ex.motorId}]`).join('; ')}); pick one via Browse motor database.`
    : '';
  /** Why the curve could not be had, when it could not. */
  let failure: unknown = null;
  if (dbMatch) {
    try {
      let matchedDelay = ref.delay;
      let spec;
      if (how?.curveEquivalent) {
        const target = how.curveEquivalent;
        matchedDelay = ref.rktEveryDelay ? defaultDelay(target) ?? 0 : ref.delay;
        // The exception is activated by an actually usable curve, not a count
        // in metadata. Failure leaves the original missing-curve report intact.
        spec = await fetchSpec(target, matchedDelay);
        dbMatch = target;
        how = { motor: target, tier: how.tier, rivals: [], reason: G80_EQUIVALENT };
      } else spec = await fetchSpec(dbMatch, matchedDelay);
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
      const motor = mountMotorFromDb(dbMatch, spec, matchedDelay, ignition,
        ref.autoDelay ? { ...identity, autoDelay: true } : identity);
      const openNote = [(unconfirmedMatchNote(ref, dbMatch, how) ?? '') + exCandidatesNote, await rocksimCurveNote(ref, dbMatch, spec)]
        .filter(Boolean).join('\n') || undefined;
      return {
        motor: openNote ? { ...motor, openNote } : motor,
        ...(namesOtherMaker(ref, dbMatch) ? { otherMaker: {
          ref, candidates: [dbMatch, ...(how?.motor.motorId === dbMatch.motorId ? how.rivals : [])],
        } } : {}),
        note: `Motor: ${dbMatch.manufacturerAbbrev} ${motor.label} (loaded from the motor database).`,
        ...(openNote ? { openNote } : {}),
      };
    } catch (err) {
      // No curve to be had this time — reported below, never substituted.
      failure = err;
    }
  }

  // There is no fallback below the database, deliberately. Until 2026-09-05
  // three hand-written approximate curves stood in here (see the header), and
  // a motor that quietly flies the wrong curve is worse than one that says it
  // could not be loaded. With every published curve now shipped in the bundle
  // (thrustcurve.ts bundledSimFiles) "none exists" is reached only for the ~80
  // catalogued motors thrustcurve.org has no simulator file for at all — and
  // it is SAID only when that is known: thrustcurve.org answered so
  // (NoPublishedCurveError), or the motor is one of the shipped catalogue's and
  // the shipped bundle, loaded, has nothing for it. Any other failure — offline
  // with a motor the catalogue check added since, a bundle chunk that would not
  // load, a timeout — is not that, and the note repeats the reason instead
  // (audit 2026-09-30): it said "publishes none" for every one, and a user
  // went looking for a file they did not need.
  if (dbMatch) {
    if (failure instanceof NoPublishedCurveError || await shippedWithoutCurve(dbMatch)) {
      return {
        note: `Motor “${ref.designation}” is in the motor database but has no thrust curve — thrustcurve.org publishes none for it. Import its .eng/.rse via Browse motor database.${exCandidatesNote}`,
        missing: 'curve',
      };
    }
    return {
      note: `Motor “${ref.designation}” is in the motor database, but its thrust curve could not be loaded: ${
        failure instanceof Error ? failure.message : String(failure)}${exCandidatesNote}`,
    };
  }
  return { note: `Motor “${ref.designation}” ${isE31Conflict(ref.designation)
    ? E31_CONFLICT : 'matched no motor in the motor database — pick one via Browse motor database.'}${exCandidatesNote}`, missing: 'database' };
}

/**
 * A motor of the SHIPPED catalogue that the shipped bundle — every curve
 * thrustcurve.org published for that catalogue — loaded and has nothing for:
 * it had no curve when this version was built, which holds with no network.
 * Not a motor the catalogue check added since (it is missing from the bundle
 * because it is newer, not because it has none), and not when the bundle
 * itself did not load (bundleHasCurve's null).
 */
async function shippedWithoutCurve(db: MotorDbEntry): Promise<boolean> {
  return MOTOR_DB.some((m) => m.motorId === db.motorId) && (await bundleHasCurve(db.motorId)) === false;
}

/** A manufacturer a file actually names — not empty, and not our reader's or writer's sentinel. */
function namedMaker(ref: OrkMotorRef): string | null {
  const m = ref.manufacturer?.trim();
  return m && !/^(unknown|custom)$/i.test(m) ? m : null;
}

/** Does the file name a maker, and one that is not this row's? */
export function namesOtherMaker(ref: OrkMotorRef, db: MotorDbEntry): boolean {
  return namedMaker(ref) !== null && !manufacturerMatches(ref.manufacturer, db.manufacturerAbbrev);
}

/**
 * A catalogue row as the open note names it: maker, designation, size, impulse,
 * propellant. The diameter to a tenth of a millimetre, not as stored: ten rows
 * carry float noise (Jambol's and Ultra's 13.000000000000002 mm), and the note
 * printed it (second review of audit 2026-09-23). The RAW designation when
 * another row in the same note would read the same — AeroTech's HP-H45W and
 * H45W both display as “H45W”, and the note named “AeroTech H45W” twice.
 */
export function describeRow(m: MotorDbEntry, all: readonly MotorDbEntry[] = [m]): string {
  const facts = [`${Number(m.diameter.toFixed(1))} mm`, `${Math.round(m.totImpulseNs * 10) / 10} Ns`,
    ...(m.propInfo ? [m.propInfo] : []), ...(isAvailable(m) ? [] : ['out of production'])];
  const shown = displayDesignation(m.designation, m.manufacturerAbbrev);
  const twin = all.some((o) => o !== m && o.manufacturerAbbrev === m.manufacturerAbbrev
    && displayDesignation(o.designation, o.manufacturerAbbrev) === shown);
  return `${m.manufacturerAbbrev} ${twin ? m.designation : shown} (${facts.join(', ')})`;
}

/**
 * One open note for a motor that `mounts` mounts carry — a cluster built as
 * separate mounts — said once, with the count (the rule the .rkt reader's
 * sentinel notes follow): PELTZER_Swarm_JR.rkt's twelve F32 mounts gave twelve
 * identical three-sentence warnings. Every note {@link unconfirmedMatchNote}
 * writes opens with `Motor “<designation>”`, and the count goes after it.
 */
export function withMountCount(note: string, mounts: number): string {
  return mounts > 1 ? note.replace(/^(Motor “[^”]*”)/, `$1 (${mounts} mounts)`) : note;
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
  if (!other && !unread && !oopGuess && rivals.length === 0 && !firm?.reason) return undefined;
  const named = [db, ...rivals];
  const row = describeRow(db, named);
  const opened = other
    ? `Motor “${ref.designation}”: the file names ${namedMaker(ref)!}, but it loaded as ${row} — the motor the database matched to it.`
    : unread
      ? `Motor “${ref.designation}” matched no motor in the database exactly; it loaded as the closest, ${row}.`
      : oopGuess
        ? `Motor “${ref.designation}”: the file names no manufacturer, and it loaded as ${row} — the motor the database matched to it.`
        : `Motor “${ref.designation}” loaded as ${row}.`;
  const shown = rivals.slice(0, 3).map((r) => describeRow(r, named));
  const more = rivals.length > shown.length ? `; and ${rivals.length - shown.length} more` : '';
  const also = rivals.length === 0 ? ''
    : /^j360[- _]*sk$/i.test(ref.designation.trim())
      ? ` Another catalogue motor is a plausible alternative for this incomplete identity: ${shown.join('; ')}${more}.`
      : ` ${rivals.length === 1 ? 'Another motor matches' : `${rivals.length} other motors match`} it as well: ${shown.join('; ')}${more}.`;
  return `${opened}${also}${firm?.reason ? ` ${firm.reason}` : ''} Check it is the motor you fly, or pick another via Browse motor database.`;
}
